/**
 * Worker-side orchestrator: owns the device, the frame loop and all GPU state.
 *
 * Frame loop contract (§2, §6):
 *   - A frame renders only when a dirty flag is set. Otherwise the loop goes to
 *     sleep: no rAF, no canvas texture, no GPU submission, no allocation.
 *   - Input wakes it via the InputRing's SLEEPING flag (one message per wake)
 *     or via any API message.
 */
import { GraphError } from "../api/errors";
import type { BenchmarkOptions, BenchmarkResult, CameraView, GraphCaps, RGBA } from "../api/types";
import { INPUT, type InputRing, type InputRecord } from "../bridge/InputRing";
import type { InitOptions } from "../bridge/protocol";
import { STATE_SLOT } from "../bridge/SharedState";
import { Camera2D } from "../camera/Camera2D";
import { CameraPath } from "../camera/CameraPath";
import { Controls } from "../camera/Controls";
import { GraphStore, type EdgeArrays, type NodeArrays } from "../data/GraphStore";
import { createContractLayouts } from "../gpu/BindLayouts";
import { readCaps } from "../gpu/Caps";
import { createGpu, type Gpu } from "../gpu/Device";
import { FrameGraph, type FrameContext } from "../gpu/FrameGraph";
import { FrameUniform, type FrameInputs } from "../gpu/FrameUniform";
import { GraphBuffers } from "../gpu/GraphBuffers";
import { PermuteKernels } from "../gpu/PermuteKernels";
import { Profiler, type ProfileSample } from "../gpu/Profiler";
import { LABEL_CONSTANTS } from "../data/Layouts";
import { LabelAtlas } from "../labels/LabelAtlas";
import { LabelLayout } from "../labels/LabelLayout";
import { EDGE_DEBUG_MODES, EdgeCullPass } from "../passes/EdgeCullPass";
import { LabelDrawPass } from "../passes/LabelDrawPass";
import { LabelPass } from "../passes/LabelPass";
import { EdgeGeometryPass } from "../passes/EdgeGeometryPass";
import { EdgeSortPass } from "../passes/EdgeSortPass";
import { NodeGeometryPass } from "../passes/NodeGeometryPass";
import { SortPass } from "../passes/SortPass";
import { TransformCullPass } from "../passes/TransformCullPass";
import { UploadPass } from "../passes/UploadPass";
import { Benchmark } from "./Benchmark";
import { Dirty } from "./Dirty";
import { Telemetry } from "./Telemetry";

export interface EngineInit {
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  pixelRatio: number;
  ring: InputRing | null;
  state: Float64Array;
  options: InitOptions;
  gpu: GPU | undefined;
  requestFrame: (cb: (t: number) => void) => void;
  onError: (e: GraphError, fatal: boolean) => void;
  onBenchmark: (id: number, result: BenchmarkResult, transfer: ArrayBuffer[]) => void;
}

interface Passes {
  cull: TransformCullPass;
  nodes: NodeGeometryPass;
  edges: EdgeGeometryPass;
  edgeCull: EdgeCullPass;
  labels: LabelPass;
}

const CPU_EMA = 0.1;
const DEFAULT_WARMUP_FRAMES = 10;
const FIT_PADDING_CSS_PX = 24;

/** Straight-alpha RGBA in 0..1 to an rgba8unorm word (R in the low byte). */
function packRgbaTuple(c: RGBA): number {
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (q(c[0]) | (q(c[1]) << 8) | (q(c[2]) << 16) | (q(c[3]) << 24)) >>> 0;
}

export class Engine {
  readonly caps: GraphCaps;
  private readonly camera = new Camera2D();
  private readonly controls = new Controls();
  private readonly frameGraph: FrameGraph;
  private readonly frameUniform: FrameUniform;
  private readonly telemetry: Telemetry;
  private readonly context: GPUCanvasContext;
  private readonly frameCtx: FrameContext;
  private readonly frameInputs: FrameInputs;
  private readonly submitList: GPUCommandBuffer[] = [];
  private readonly inputRec: InputRecord = { type: 0, t: 0, x: 0, y: 0, dx: 0, dy: 0, buttons: 0, mods: 0 };
  private readonly applyInput = (rec: InputRecord): void => this.input(rec);
  private readonly startTime = performance.now();

  private dirty = Dirty.RESIZE;
  private framePending = false;
  /** performance.now() of the previous tick, for the zoom glide. */
  private lastTickMs = 0;
  private frameIndex = 0;
  private renderedFrames = 0;
  private cpuMsAvg = 0;
  private destroyed = false;
  private pixelRatio: number;
  /** Node count the cull buffers are sized for; -1 forces a check. */
  private reservedFor = -1;
  /** Edge count the edge cull buffers are sized for; -1 forces a check. */
  private reservedEdgesFor = -1;
  private bench: Benchmark | null = null;
  private benchTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    private readonly gpu: Gpu,
    private readonly store: GraphStore,
    private readonly graph: GraphBuffers,
    private readonly profiler: Profiler,
    frameGraph: FrameGraph,
    private readonly passes: Passes,
    layouts: ReturnType<typeof createContractLayouts>,
    private readonly init: EngineInit,
    private readonly labelAtlas: LabelAtlas,
    private readonly labelLayout: LabelLayout,
  ) {
    const { device, format } = gpu;
    this.frameGraph = frameGraph;
    this.caps = readCaps(gpu.adapter, device, init.ring !== null, profiler.slotNames);

    this.context = init.canvas.getContext("webgpu") as GPUCanvasContext;
    this.context.configure({ device, format, alphaMode: "opaque" });

    this.frameUniform = new FrameUniform(device, layouts.frame);
    graph.flush(); // create the (empty) graph buffers + bind group
    this.telemetry = new Telemetry(init.state);
    profiler.onSample = this.onProfileSample;

    this.controls.enabled = init.options.controls;
    this.pixelRatio = init.pixelRatio;
    this.frameCtx = {
      frameBindGroup: this.frameUniform.bindGroup,
      graphBindGroup: graph.bindGroup,
      nodeCount: 0,
      edgeCount: 0,
      dirty: 0,
    };
    this.frameInputs = {
      camera: this.camera,
      pixelRatio: init.pixelRatio,
      time: 0,
      frameIndex: 0,
      pointerX: -1,
      pointerY: -1,
      nodeCount: 0,
      edgeCount: 0,
      nodeScale: init.options.nodeScale,
      edgeWidth: init.options.edgeWidth,
      edgeColor: packRgbaTuple(init.options.edgeColor),
      flags: 0,
    };

    // Labels: the GPU finds candidates, placement runs here when they arrive.
    passes.labels.onResult = (nodes, edges) => {
      const c = this.camera;
      if (this.labelLayout.place(nodes, edges, this.store, c.viewportW, c.viewportH, this.pixelRatio)) this.dirty |= Dirty.LABEL_QUERY;
      this.markDirty(Dirty.LABELS);
    };
    passes.labels.requestQuery = () => this.markDirty(Dirty.LABEL_QUERY);

    this.setBackground(init.options.background);
    this.resize(init.width, init.height, init.pixelRatio);

    device.lost.then((info) => {
      if (this.destroyed) return;
      init.onError(new GraphError("device-lost", `GPU device lost (${info.reason}): ${info.message}`), true);
    });
    device.addEventListener("uncapturederror", (ev) => {
      init.onError(new GraphError("internal", (ev as GPUUncapturedErrorEvent).error.message), false);
    });
  }

  static async create(init: EngineInit): Promise<Engine> {
    const gpu = await createGpu(init.gpu);
    const { device, format } = gpu;
    const layouts = createContractLayouts(device);
    const profiler = new Profiler(device, device.features.has("timestamp-query"));
    const frameGraph = new FrameGraph(profiler);
    const store = new GraphStore();
    const kernels = await PermuteKernels.create(device);
    const graph = new GraphBuffers(device, layouts.graph, store, kernels);
    const edgeOpts = {
      directed: init.options.directedEdges,
      maxOverdraw: init.options.edgeMaxOverdraw,
      minLengthPx: init.options.edgeMinLengthPx,
      debug: Math.max(0, EDGE_DEBUG_MODES.indexOf(init.options.edgeDebug)),
    };
    const [sort, cull, nodes, edgeSort, edgeCull, edges] = await Promise.all([
      SortPass.create(device, layouts, graph, store.bounds),
      TransformCullPass.create(device, layouts, init.options.lodTargetPx),
      NodeGeometryPass.create(device, format, layouts),
      EdgeSortPass.create(device, graph, store.bounds),
      EdgeCullPass.create(device, layouts, edgeOpts),
      EdgeGeometryPass.create(device, format, layouts, edgeOpts),
    ]);
    // Compute runs in stage order: upload, node sort, edge sort, node cull, edge cull.
    frameGraph.addCompute(new UploadPass(graph));
    frameGraph.addCompute(sort);
    frameGraph.addCompute(edgeSort);
    frameGraph.addCompute(cull);
    frameGraph.addCompute(edgeCull);
    const labelAtlas = new LabelAtlas(device);
    const labelLayout = new LabelLayout(device, labelAtlas, { sizeCssPx: init.options.labelSize, max: init.options.labelMax });
    const [labels, labelDraw] = await Promise.all([
      LabelPass.create(device, layouts, store, graph, cull, edgeCull, {
        lodTargetPx: init.options.lodTargetPx,
        labelSizeCssPx: init.options.labelSize,
      }),
      LabelDrawPass.create(device, format, layouts, labelLayout, labelAtlas),
    ]);
    frameGraph.addCompute(labels);
    frameGraph.addRender(edges);
    frameGraph.addRender(nodes);
    frameGraph.addRender(labelDraw);
    return new Engine(gpu, store, graph, profiler, frameGraph, { cull, nodes, edges, edgeCull, labels }, layouts, init, labelAtlas, labelLayout);
  }

  // ---- API (called from worker message dispatch) ----------------------------

  resize(width: number, height: number, pixelRatio: number): void {
    const max = this.caps.maxTextureDimension2D;
    const w = Math.max(1, Math.min(max, Math.round(width)));
    const h = Math.max(1, Math.min(max, Math.round(height)));
    this.init.canvas.width = w;
    this.init.canvas.height = h;
    this.camera.setViewport(w, h);
    this.pixelRatio = pixelRatio;
    this.passes.labels.pixelRatio = pixelRatio;
    this.markDirty(Dirty.RESIZE);
  }

  setNodes(count: number, arrays: NodeArrays): void {
    this.store.setNodes(count, arrays);
    this.labelLayout.clear(); // nodes are renumbered, and edges with them
    this.markDirty(Dirty.TOPOLOGY);
  }

  setEdges(count: number, arrays: EdgeArrays): void {
    this.store.setEdges(count, arrays);
    this.labelLayout.clear(LABEL_CONSTANTS.LABEL_KIND_EDGE); // edges are re-sorted
    this.markDirty(Dirty.EDGES);
  }

  /** Label text per node, in the user's order; empty clears. */
  setNodeLabels(labels: string[]): void {
    this.store.nodeLabels = labels.length > 0 ? labels : null;
    this.labelLayout.clear(LABEL_CONSTANTS.LABEL_KIND_NODE);
    this.markDirty(Dirty.LABEL_QUERY | Dirty.LABELS);
  }

  /** Label text per edge, in the user's order; empty clears. */
  setEdgeLabels(labels: string[]): void {
    const store = this.store;
    store.edgeLabels = labels.length > 0 ? labels : null;
    const keep = store.edgeLabels !== null;
    this.graph.keepEdgeOrder = keep;
    if (!keep) this.graph.setEdgeOrder(null);
    // Labels need sorted edge -> user edge, kept only by a sort that knew: sort again.
    else if (!this.graph.edgeOrder && store.edgeCount > 0) store.reloadEdges();
    this.labelLayout.clear(LABEL_CONSTANTS.LABEL_KIND_EDGE);
    this.markDirty(Dirty.EDGES | Dirty.LABEL_QUERY | Dirty.LABELS);
  }

  updatePositions(start: number, data: Float32Array): void {
    this.store.updatePositions(start, data);
    this.markDirty(Dirty.POSITIONS);
  }

  updateColor(index: number, rgba: number): void {
    this.store.updateColor(index, rgba);
    this.markDirty(Dirty.STYLE);
  }

  setView(view: Partial<CameraView>): void {
    this.controls.cancelZoom();
    this.camera.setView(view);
    this.markDirty(Dirty.CAMERA);
  }

  fit(padding: number): void {
    this.controls.cancelZoom();
    this.camera.fit(this.store.bounds, padding * this.pixelRatio);
    this.markDirty(Dirty.CAMERA);
  }

  setBackground(c: RGBA): void {
    this.frameGraph.setClearColor(c[0], c[1], c[2], c[3]);
    this.markDirty(Dirty.CLEAR_COLOR);
  }

  setNodeScale(v: number): void {
    this.frameInputs.nodeScale = v;
    this.markDirty(Dirty.STYLE);
  }

  requestRender(): void {
    this.markDirty(Dirty.FORCED);
  }

  /** Play `opts.path` one step per rendered frame and record per-frame timings. */
  benchmark(id: number, opts: BenchmarkOptions): void {
    if (this.bench) throw new GraphError("invalid-argument", "A benchmark is already running");
    const fitZoom = this.camera.fitZoom(this.store.bounds, FIT_PADDING_CSS_PX * this.pixelRatio);
    const path = new CameraPath(opts.path, opts.frames, this.store.bounds, fitZoom);
    this.bench = new Benchmark(id, path, opts.warmup ?? DEFAULT_WARMUP_FRAMES, this.profiler.slotNames);
    this.markDirty(Dirty.CAMERA);
  }

  /** Apply one input record (from the ring or the postMessage fallback). */
  input(rec: InputRecord): void {
    if (this.controls.apply(rec, this.camera)) this.dirty |= Dirty.CAMERA;
    if (rec.type === INPUT.POINTER_MOVE || rec.type === INPUT.POINTER_LEAVE) {
      // pointerPx only feeds picking/hover shaders (M8); it does not force a frame yet.
      this.frameInputs.pointerX = this.controls.pointerX;
      this.frameInputs.pointerY = this.controls.pointerY;
    }
  }

  wake(): void {
    if (this.framePending || this.destroyed) return;
    this.framePending = true;
    this.init.requestFrame(this.tick);
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.benchTimer);
    this.passes.cull.destroy();
    this.passes.edgeCull.destroy();
    this.passes.labels.destroy();
    this.labelLayout.destroy();
    this.labelAtlas.destroy();
    this.profiler.destroy();
    this.graph.destroy();
    this.frameUniform.destroy();
    this.context.unconfigure();
    this.gpu.device.destroy();
  }

  // ---- frame loop -------------------------------------------------------------

  private markDirty(flags: number): void {
    this.dirty |= flags;
    this.wake();
  }

  private readonly tick = (): void => {
    this.framePending = false;
    if (this.destroyed) return;
    const t0 = performance.now();

    const ring = this.init.ring;
    if (ring) ring.drain(this.inputRec, this.applyInput);

    // Advance the zoom glide before deciding whether the frame is idle: while a
    // glide is in flight it keeps the loop awake, and when it settles the frame
    // is skipped exactly as before.
    const dt = this.lastTickMs === 0 ? 0 : (t0 - this.lastTickMs) / 1000;
    this.lastTickMs = t0;
    if (dt > 0 && this.controls.advance(dt, this.camera)) this.dirty |= Dirty.CAMERA;
    if (this.labelLayout.animate(t0)) this.dirty |= Dirty.LABELS;

    const bench = this.bench;
    const benchFrame = bench !== null && bench.driving;
    if (benchFrame) {
      bench.beforeFrame(this.camera);
      this.dirty |= Dirty.CAMERA;
    }

    if (this.dirty === 0) {
      // Idle: skip the frame entirely (§6). Sleep unless input raced in.
      if (!ring || ring.trySleep()) return;
      this.wake();
      return;
    }

    const uploaded = this.graph.flush();
    const nodeCount = this.reserveNodes();
    const edgeCount = this.reserveEdges();

    const fi = this.frameInputs;
    fi.time = (t0 - this.startTime) / 1000;
    fi.frameIndex = this.frameIndex;
    fi.pixelRatio = this.pixelRatio;
    fi.nodeCount = nodeCount;
    fi.edgeCount = edgeCount;
    this.frameUniform.write(fi);

    const ctx = this.frameCtx;
    ctx.graphBindGroup = this.graph.bindGroup;
    ctx.nodeCount = nodeCount;
    ctx.edgeCount = edgeCount;
    ctx.dirty = this.dirty;
    this.passes.edges.perEdgeStyle = this.store.hasEdgeStyles;
    this.passes.edges.perEdgeColor = this.store.hasEdgeColors;

    const device = this.gpu.device;
    const encoder = device.createCommandEncoder();
    this.profiler.beginFrame();
    this.labelLayout.upload();
    this.frameGraph.execute(encoder, this.context.getCurrentTexture().createView(), ctx);
    this.passes.labels.recordReadback(encoder);
    this.profiler.endFrame(
      encoder,
      this.frameIndex,
      nodeCount > 0 ? this.passes.cull.outputs!.scratch : null,
      edgeCount > 0 ? this.passes.edgeCull.outputs!.scratch : null,
    );
    this.submitList[0] = encoder.finish();
    device.queue.submit(this.submitList);
    this.profiler.afterSubmit();
    this.passes.labels.afterSubmit();
    this.graph.afterSubmit();

    const cpuMs = performance.now() - t0;
    if (benchFrame) bench.afterFrame(this.frameIndex, t0, cpuMs);
    this.dirty = 0;
    this.frameIndex++;
    this.renderedFrames++;
    this.cpuMsAvg = this.renderedFrames === 1 ? cpuMs : this.cpuMsAvg + (cpuMs - this.cpuMsAvg) * CPU_EMA;
    this.publishState(cpuMs, uploaded ? this.graph.lastUploadBytes : 0);
    if (bench && !bench.driving) this.scheduleBenchCheck();

    // One more tick to pick up input that arrived during this frame; it sleeps if there is none.
    this.wake();
  };

  /** Size the cull buffers for the current node count; returns the drawable count. */
  private reserveNodes(): number {
    const n = this.store.nodeCount;
    if (n !== this.reservedFor) {
      try {
        const retire = (b: GPUBuffer) => this.graph.retireAfterSubmit(b);
        this.passes.cull.reserve(n, retire);
        this.passes.nodes.bind(this.passes.cull.outputs!);
        this.reservedFor = n;
      } catch (e) {
        this.reservedFor = n;
        this.init.onError(e instanceof GraphError ? e : new GraphError("internal", String(e)), false);
        this.passes.cull.outputs = null;
      }
    }
    return this.passes.cull.outputs ? n : 0;
  }

  /** Size the edge buffers for the current edge count; returns the drawable count. */
  private reserveEdges(): number {
    const e = this.store.edgeCount;
    if (e !== this.reservedEdgesFor) {
      this.reservedEdgesFor = e;
      try {
        this.passes.edgeCull.reserve(e, (b) => this.graph.retireAfterSubmit(b));
        this.passes.edges.bind(this.passes.edgeCull.outputs!);
      } catch (err) {
        this.init.onError(err instanceof GraphError ? err : new GraphError("internal", String(err)), false);
        this.passes.edgeCull.outputs = null;
      }
    }
    return this.passes.edgeCull.outputs ? e : 0;
  }

  private readonly onProfileSample = (s: ProfileSample): void => {
    this.telemetry.onSample(s, this.profiler.droppedFrames);
    if (this.bench) {
      this.bench.onSample(s);
      this.finishBenchIfComplete();
    }
  };

  private scheduleBenchCheck(): void {
    clearTimeout(this.benchTimer);
    this.benchTimer = setTimeout(() => this.finishBenchIfComplete(), 2100);
  }

  private finishBenchIfComplete(): void {
    const b = this.bench;
    if (!b || !b.complete) return;
    clearTimeout(this.benchTimer);
    this.bench = null;
    const result = b.result({
      nodeCount: this.store.nodeCount,
      viewport: [this.camera.viewportW, this.camera.viewportH],
      adapter: this.caps.adapter,
      timestampQuery: this.caps.timestampQuery,
    });
    this.init.onBenchmark(b.id, result, b.transferables());
  }

  private publishState(cpuMs: number, uploadBytes: number): void {
    const s = this.init.state;
    const c = this.camera;
    s[STATE_SLOT.FRAME_INDEX] = this.frameIndex;
    s[STATE_SLOT.RENDERED_FRAMES] = this.renderedFrames;
    s[STATE_SLOT.CPU_MS_LAST] = cpuMs;
    s[STATE_SLOT.CPU_MS_AVG] = this.cpuMsAvg;
    s[STATE_SLOT.NODE_COUNT] = this.store.nodeCount;
    s[STATE_SLOT.EDGE_COUNT] = this.store.edgeCount;
    s[STATE_SLOT.VIEWPORT_W] = c.viewportW;
    s[STATE_SLOT.VIEWPORT_H] = c.viewportH;
    s[STATE_SLOT.CAMERA_X] = c.x;
    s[STATE_SLOT.CAMERA_Y] = c.y;
    s[STATE_SLOT.CAMERA_ZOOM] = c.zoom;
    s[STATE_SLOT.CAMERA_ROTATION] = c.rotation;
    s[STATE_SLOT.UPLOAD_BYTES] = uploadBytes;
    s[STATE_SLOT.GPU_BYTES] = this.gpu.memory.bytes;
  }
}

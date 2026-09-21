/**
 * Main-thread facade (§17). Every setter is synchronous and cheap: it posts to
 * the render worker and returns. The main thread never touches the GPU.
 */
import { InputRing } from "../bridge/InputRing";
import type { FromWorker, ToWorker } from "../bridge/protocol";
import { createStateBuffer, STATE_SLOT } from "../bridge/SharedState";
import { errorFromCode, GraphError, UnsupportedError } from "./errors";
import { PointerInput, type InputSink } from "./PointerInput";
import type {
  BenchmarkOptions,
  BenchmarkResult,
  CameraView,
  CopyOption,
  GraphCaps,
  GraphEvents,
  GraphOptions,
  GraphStats,
  EdgeData,
  NodeData,
  RGBA,
} from "./types";

const DEFAULT_BACKGROUND: RGBA = [0.04, 0.04, 0.06, 1];
/** Dim blue-grey: visible against the default background without fighting the nodes. */
const DEFAULT_EDGE_COLOR_RGBA: RGBA = [0.24, 0.27, 0.31, 0.4];
/** Sampled-node spacing, device px, chosen by eye in Storybook. */
const DEFAULT_LOD_TARGET_PX = 2.5;
/** Overdraw a crowded area of edges is thinned to: dense enough to read as solid at usual alphas. */
const DEFAULT_EDGE_MAX_OVERDRAW = 6;
/** CSS px: shorter edges do not read as lines. */
const DEFAULT_EDGE_MIN_LENGTH_PX = 6;
const DEFAULT_LABEL_SIZE = 12;
/** Enough to name what matters on screen without covering it. */
const DEFAULT_LABEL_MAX = 300;
const DEFAULT_FIT_PADDING = 24;

type Listener<K extends keyof GraphEvents> = (payload: GraphEvents[K]) => void;

export class Graph {
  /**
   * Create an engine bound to `canvas`. The canvas is transferred to a render
   * worker; afterwards it can no longer be drawn to from the main thread.
   */
  static async create(canvas: HTMLCanvasElement, options: GraphOptions = {}): Promise<Graph> {
    if (typeof navigator === "undefined" || !("gpu" in navigator)) {
      throw new UnsupportedError("webgpu-unavailable", "WebGPU is not available in this browser.");
    }
    if (typeof canvas.transferControlToOffscreen !== "function") {
      throw new UnsupportedError("offscreen-canvas-unavailable", "OffscreenCanvas is not supported in this browser.");
    }

    const shared = typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated === true;
    const ring = shared ? InputRing.create() : null;
    const state = createStateBuffer(shared);
    const pixelRatio = options.pixelRatio ?? globalThis.devicePixelRatio ?? 1;
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "vhult-graph" });

    const { width, height } = canvasDeviceSize(canvas, pixelRatio);
    const offscreen = canvas.transferControlToOffscreen();
    const init: ToWorker = {
      t: "init",
      canvas: offscreen,
      width,
      height,
      pixelRatio,
      ring: ring ? ring.buffer : null,
      state: shared ? (state.buffer as SharedArrayBuffer) : null,
      options: {
        background: options.background ?? DEFAULT_BACKGROUND,
        controls: options.controls ?? true,
        nodeScale: options.nodeScale ?? 1,
        edgeWidth: options.edgeWidth ?? 1,
        edgeColor: options.edgeColor ?? DEFAULT_EDGE_COLOR_RGBA,
        directedEdges: options.directedEdges ?? false,
        edgeMaxOverdraw: Math.max(0, options.edgeMaxOverdraw ?? DEFAULT_EDGE_MAX_OVERDRAW),
        edgeMinLengthPx: Math.max(0, options.edgeMinLengthPx ?? DEFAULT_EDGE_MIN_LENGTH_PX),
        edgeDebug: options.edgeDebug ?? "off",
        labelSize: Math.max(1, options.labelSize ?? DEFAULT_LABEL_SIZE),
        labelMax: Math.max(0, Math.floor(options.labelMax ?? DEFAULT_LABEL_MAX)),
        lodTargetPx: Math.max(0, options.lodTargetPx ?? DEFAULT_LOD_TARGET_PX),
      },
    };

    const caps = await new Promise<GraphCaps>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<FromWorker>) => {
        const m = ev.data;
        if (m.t === "ready") resolve(m.caps);
        else if (m.t === "error" && m.fatal) {
          worker.terminate();
          reject(errorFromCode(m.code, m.message));
        }
      };
      worker.onerror = (ev) => {
        worker.terminate();
        reject(new GraphError("internal", `Render worker failed to start: ${ev.message}`));
      };
      worker.postMessage(init, [offscreen]);
    });

    return new Graph(canvas, worker, caps, ring, state, pixelRatio, options.autoResize ?? true);
  }

  readonly camera = {
    /** Fit all nodes in view, `padding` in CSS px. */
    fit: (padding = DEFAULT_FIT_PADDING): void => this.send({ t: "fit", padding }),
    setView: (view: Partial<CameraView>): void => this.send({ t: "view", view }),
    /** Last view rendered by the worker (≤ 1 frame stale). */
    getView: (): CameraView => ({
      x: this.state[STATE_SLOT.CAMERA_X]!,
      y: this.state[STATE_SLOT.CAMERA_Y]!,
      zoom: this.state[STATE_SLOT.CAMERA_ZOOM]!,
      rotation: this.state[STATE_SLOT.CAMERA_ROTATION]!,
    }),
  };

  private nodeCount = 0;
  private edgeCount = 0;
  private destroyed = false;
  private benchSeq = 0;
  private benchPending: { id: number; resolve: (r: BenchmarkResult) => void; reject: (e: Error) => void } | null = null;
  private readonly listeners: { [K in keyof GraphEvents]: Set<Listener<K>> } = { error: new Set() };
  private readonly pointer: PointerInput;
  private readonly resizeObserver: ResizeObserver | null = null;

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly worker: Worker,
    readonly caps: GraphCaps,
    ring: InputRing | null,
    private readonly state: Float64Array,
    private pixelRatio: number,
    autoResize: boolean,
  ) {
    worker.onmessage = this.onMessage;
    worker.onerror = (ev) => this.emitError(new GraphError("internal", ev.message));

    const sink: InputSink = ring
      ? (type, t, x, y, dx, dy, buttons, mods) => {
          ring.push(type, t, x, y, dx, dy, buttons, mods);
          if (ring.claimWake()) this.worker.postMessage({ t: "wake" } satisfies ToWorker);
        }
      : (type, t, x, y, dx, dy, buttons, mods) => this.send({ t: "input", r: [type, t, x, y, dx, dy, buttons, mods] });
    this.pointer = new PointerInput(canvas, sink, () => this.pixelRatio);

    if (autoResize && typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.onResize);
      try {
        this.resizeObserver.observe(canvas, { box: "device-pixel-content-box" });
      } catch {
        this.resizeObserver.observe(canvas);
      }
    }
  }

  // ---- data ---------------------------------------------------------------------

  /** Bulk-load nodes. The fastest path: arrays are transferred, uploaded via mappedAtCreation. */
  setNodes(data: NodeData, opts?: CopyOption): void {
    const n = data.count;
    if (!Number.isInteger(n) || n < 0) throw new GraphError("invalid-argument", "setNodes: count must be a non-negative integer");
    const transfer: Transferable[] = [];
    const positions = data.positions && take(data.positions, n * 2, "positions", opts, transfer);
    const colors = data.colors && take(asWords(data.colors), n, "colors", opts, transfer);
    const sizes = data.sizes && take(data.sizes, n, "sizes", opts, transfer);
    this.nodeCount = n;
    this.send({ t: "nodes", count: n, positions, colors, sizes }, transfer);
  }

  /**
   * Bulk-load edges. `indices` holds source/target NODE INDICES interleaved.
   *
   * Edges are tied to the node indices that were current when they were set:
   * a later `setNodes` that changes the node count invalidates them, so set
   * nodes first, then edges.
   */
  setEdges(data: EdgeData, opts?: CopyOption): void {
    const n = data.count;
    if (!Number.isInteger(n) || n < 0) throw new GraphError("invalid-argument", "setEdges: count must be a non-negative integer");
    const transfer: Transferable[] = [];
    const indices = data.indices && take(data.indices, n * 2, "indices", opts, transfer);
    const styles = data.styles && take(data.styles, n, "styles", opts, transfer);
    const colors = data.colors && take(data.colors, n * 2, "colors", opts, transfer);
    this.edgeCount = n;
    this.send({ t: "edges", count: n, indices, styles, colors }, transfer);
  }

  /**
   * Label text per node, in the order of `setNodes` (empty or missing = no
   * label). Only as many as fit are shown, bigger nodes first. Pass `[]` to
   * remove every node label.
   */
  setNodeLabels(labels: readonly (string | null | undefined)[]): void {
    this.send({ t: "nodeLabels", labels: Array.from(labels, (s) => s ?? "") });
  }

  /**
   * Label text per edge, in the order of `setEdges`. An edge label is shown
   * only where its text fits along the edge and overlaps no other label. Pass
   * `[]` to remove every edge label.
   */
  setEdgeLabels(labels: readonly (string | null | undefined)[]): void {
    this.send({ t: "edgeLabels", labels: Array.from(labels, (s) => s ?? "") });
  }

  /** Change the node count; existing data is preserved prefix-wise, new nodes get defaults. */
  setNodeCount(count: number): void {
    this.setNodes({ count });
  }

  setNodePositions(positions: Float32Array, opts?: CopyOption): void {
    this.setNodes({ count: this.nodeCount, positions }, opts);
  }

  setNodeColors(colors: Uint32Array | Uint8Array, opts?: CopyOption): void {
    this.setNodes({ count: this.nodeCount, colors }, opts);
  }

  setNodeSizes(sizes: Float32Array, opts?: CopyOption): void {
    this.setNodes({ count: this.nodeCount, sizes }, opts);
  }

  /** Partial update of positions for nodes `start .. start + data.length / 2`. Dirty-range tracked. */
  updateNodePositions(start: number, data: Float32Array, opts?: CopyOption): void {
    if (start < 0 || start + (data.length >> 1) > this.nodeCount) {
      throw new GraphError("invalid-argument", "updateNodePositions: range exceeds node count");
    }
    const transfer: Transferable[] = [];
    const d = take(data, data.length, "data", opts, transfer);
    this.send({ t: "updatePositions", start, data: d }, transfer);
  }

  /** `rgba` is a packed rgba8unorm word (see `packRgba`). */
  updateNodeColor(index: number, rgba: number): void {
    this.send({ t: "updateColor", index, rgba: rgba >>> 0 });
  }

  // ---- style ---------------------------------------------------------------------

  setBackground(rgba: RGBA): void {
    this.send({ t: "background", rgba });
  }

  setNodeScale(value: number): void {
    this.send({ t: "nodeScale", value });
  }

  // ---- lifecycle -----------------------------------------------------------------

  /** Manual resize in CSS px (only needed with `autoResize: false`). */
  resize(cssWidth: number, cssHeight: number): void {
    this.send({ t: "resize", width: cssWidth * this.pixelRatio, height: cssHeight * this.pixelRatio, pixelRatio: this.pixelRatio });
  }

  /** Force one frame, e.g. for external animation drivers. */
  requestRender(): void {
    this.send({ t: "render" });
  }

  /**
   * Play a camera path one step per rendered frame and record per-frame CPU,
   * GPU (total and per pass), frame interval and visible counts. Frame N always
   * shows the same view, so runs are comparable across machines and commits.
   * Rendering is continuous while it runs; one benchmark at a time.
   */
  benchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
    if (this.benchPending) return Promise.reject(new GraphError("invalid-argument", "A benchmark is already running"));
    if (options.path.length === 0 || !(options.frames > 0)) {
      return Promise.reject(new GraphError("invalid-argument", "benchmark: path needs ≥ 1 key and frames > 0"));
    }
    const id = ++this.benchSeq;
    return new Promise<BenchmarkResult>((resolve, reject) => {
      this.benchPending = { id, resolve, reject };
      this.send({ t: "benchmark", id, options: { path: options.path.map((k) => ({ ...k })), frames: options.frames, warmup: options.warmup } });
    });
  }

  /** Copy the latest frame stats into `out` (allocation-free when `out` is reused). */
  readStats(out: GraphStats = {} as GraphStats): GraphStats {
    const s = this.state;
    out.frameIndex = s[STATE_SLOT.FRAME_INDEX]!;
    out.renderedFrames = s[STATE_SLOT.RENDERED_FRAMES]!;
    out.cpuMs = s[STATE_SLOT.CPU_MS_LAST]!;
    out.cpuMsAvg = s[STATE_SLOT.CPU_MS_AVG]!;
    out.nodeCount = s[STATE_SLOT.NODE_COUNT]!;
    out.edgeCount = s[STATE_SLOT.EDGE_COUNT]!;
    out.viewportWidth = s[STATE_SLOT.VIEWPORT_W]!;
    out.viewportHeight = s[STATE_SLOT.VIEWPORT_H]!;
    out.uploadBytes = s[STATE_SLOT.UPLOAD_BYTES]!;
    out.gpuBytes = s[STATE_SLOT.GPU_BYTES]!;
    out.pixelRatio = this.pixelRatio;
    out.gpuMs = s[STATE_SLOT.GPU_MS_AVG]!;
    out.visibleNodes = s[STATE_SLOT.VISIBLE_NODES]!;
    out.visibleEdges = s[STATE_SLOT.VISIBLE_EDGES]!;
    out.passMs ??= {};
    const slots = this.caps.profilerSlots;
    for (let k = 0; k < slots.length; k++) out.passMs[slots[k]!] = s[STATE_SLOT.SLOT_MS_BASE + k]!;
    return out;
  }

  on<K extends keyof GraphEvents>(event: K, fn: Listener<K>): () => void {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  /** Release the worker, the GPU device and all listeners. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.send({ t: "destroy" });
    this.destroyed = true;
    this.benchPending?.reject(new GraphError("destroyed", "Graph destroyed during benchmark"));
    this.benchPending = null;
    this.pointer.dispose();
    this.resizeObserver?.disconnect();
    // The worker closes itself after releasing the device; terminate as a backstop.
    setTimeout(() => this.worker.terminate(), 1000);
  }

  // ---- internals -----------------------------------------------------------------

  private send(msg: ToWorker, transfer?: Transferable[]): void {
    if (this.destroyed) throw new GraphError("destroyed", "Graph has been destroyed");
    this.worker.postMessage(msg, transfer ?? []);
  }

  private readonly onMessage = (ev: MessageEvent<FromWorker>): void => {
    const m = ev.data;
    switch (m.t) {
      case "error":
        this.emitError(errorFromCode(m.code, m.message));
        return;
      case "state":
        this.state.set(m.data);
        return;
      case "benchmark": {
        const p = this.benchPending;
        if (p && p.id === m.id) {
          this.benchPending = null;
          p.resolve(m.result);
        }
        return;
      }
      case "destroyed":
        this.worker.terminate();
        return;
    }
  };

  private readonly onResize = (entries: ResizeObserverEntry[]): void => {
    const e = entries[entries.length - 1]!;
    // The exact device-pixel box is only valid when rendering at the native ratio.
    const dp = this.pixelRatio === globalThis.devicePixelRatio ? e.devicePixelContentBoxSize?.[0] : undefined;
    const width = dp ? dp.inlineSize : Math.round(e.contentRect.width * this.pixelRatio);
    const height = dp ? dp.blockSize : Math.round(e.contentRect.height * this.pixelRatio);
    this.pointer.refreshRect();
    if (!this.destroyed) this.send({ t: "resize", width, height, pixelRatio: this.pixelRatio });
  };

  private emitError(err: Error): void {
    if (this.listeners.error.size === 0) console.error(err);
    for (const fn of this.listeners.error) fn(err);
  }
}

function canvasDeviceSize(canvas: HTMLCanvasElement, pixelRatio: number): { width: number; height: number } {
  const r = canvas.getBoundingClientRect();
  return { width: Math.max(1, Math.round(r.width * pixelRatio)), height: Math.max(1, Math.round(r.height * pixelRatio)) };
}

function asWords(colors: Uint32Array | Uint8Array): Uint32Array {
  if (colors instanceof Uint32Array) return colors;
  if (colors.byteOffset % 4 === 0 && colors.length % 4 === 0) {
    return new Uint32Array(colors.buffer, colors.byteOffset, colors.length / 4);
  }
  throw new GraphError("invalid-argument", "colors: Uint8Array must be 4-byte aligned RGBA");
}

function isDetached(buf: ArrayBufferLike): boolean {
  const d = (buf as ArrayBuffer & { detached?: boolean }).detached;
  return d === true;
}

/**
 * Validate length, then either copy or mark the backing buffer for transfer.
 * Transfer detaches the WHOLE backing buffer, including other views over it.
 */
function take<T extends Float32Array | Uint32Array>(arr: T, expected: number, name: string, opts: CopyOption | undefined, transfer: Transferable[]): T {
  if (isDetached(arr.buffer)) {
    throw new GraphError("detached-array", `${name}: array is detached (it was transferred earlier). Pass { copy: true } to keep using it.`);
  }
  if (arr.length !== expected) {
    throw new GraphError("invalid-argument", `${name}: expected length ${expected}, got ${arr.length}`);
  }
  if (opts?.copy) {
    const c = arr.slice() as T;
    transfer.push(c.buffer as ArrayBuffer);
    return c;
  }
  const isShared = typeof SharedArrayBuffer !== "undefined" && arr.buffer instanceof SharedArrayBuffer;
  if (!isShared && !transfer.includes(arr.buffer as ArrayBuffer)) transfer.push(arr.buffer as ArrayBuffer);
  return arr;
}

/**
 * LABEL_PLACE, GPU half: find the few thousand label candidates among millions
 * of nodes and edges, and hand them to the worker for placement (LabelLayout).
 *
 *   label.nodes  1 workgroup / chunk the node cull listed (indirect): drawn
 *                nodes at least `nodeMinSize` big (transform_cull.wgsl)
 *   label.edges  1 thread / drawn edge (indirect): edges long enough on screen
 *                for text, midpoint on screen (label_edges.wgsl)
 *   label.map    engine / sorted index -> the user's index (label_map.wgsl)
 *
 * The records are copied to a mappable buffer and read 1-3 frames later; one
 * read is in flight at a time. The size and length thresholds are fed back from
 * what each read found, so the biggest few thousand pass whatever the zoom.
 */
import type { GraphStore } from "../data/GraphStore";
import { EDGE_CONSTANTS, LABEL_CONSTANTS, LABEL_RECORD } from "../data/Layouts";
import { Dirty } from "../engine/Dirty";
import type { ContractLayouts } from "../gpu/BindLayouts";
import { Stage, type ComputeNode, type FrameContext } from "../gpu/FrameGraph";
import type { GraphBuffers } from "../gpu/GraphBuffers";
import { createShaderModule } from "../gpu/ShaderModules";
import type { Candidates } from "../labels/LabelLayout";
import type { EdgeCullPass } from "./EdgeCullPass";
import type { TransformCullPass } from "./TransformCullPass";

const { LABEL_NODE_CAPACITY, LABEL_EDGE_CAPACITY, LABEL_HEADER_WORDS } = LABEL_CONSTANTS;
const RECORD_WORDS = LABEL_RECORD.size / 4;
const NODE_BYTES = (LABEL_HEADER_WORDS + LABEL_NODE_CAPACITY * RECORD_WORDS) * 4;
const EDGE_BYTES = (LABEL_HEADER_WORDS + LABEL_EDGE_CAPACITY * RECORD_WORDS) * 4;
/** A node must be drawn at least this wide to be labelled, CSS px of radius. */
const MIN_NODE_RADIUS_CSS_PX = 1.5;
/** Shortest edge worth offering for a label, in node-label heights. */
const MIN_EDGE_LEN_IN_LABEL_HEIGHTS = 3;

export class LabelPass implements ComputeNode {
  readonly stage = Stage.LABEL_PLACE;
  readonly phases = ["label.nodes", "label.edges", "label.map"] as const;
  readonly runsOn =
    Dirty.TOPOLOGY | Dirty.POSITIONS | Dirty.CAMERA | Dirty.STYLE | Dirty.STATE | Dirty.RESIZE | Dirty.EDGES | Dirty.LABEL_QUERY;

  /** Fresh candidates, 1-3 frames after the frame that found them. */
  onResult: (nodes: Candidates, edges: Candidates) => void = () => {};
  /** Ask for another query (a threshold moved, or a query was skipped). */
  requestQuery: () => void = () => {};
  pixelRatio = 1;

  private readonly nodeBuf: GPUBuffer;
  private readonly edgeBuf: GPUBuffer;
  private readonly readback: GPUBuffer;
  private readonly params: GPUBuffer;
  private readonly nodeCap: GPUBuffer;
  private readonly edgeCap: GPUBuffer;
  private readonly paramData = new Float32Array(4);
  private readonly zeros = new Uint32Array(LABEL_HEADER_WORDS);
  private doNodes = false;
  private doEdges = false;
  private ran = false;
  private scheduled = false;
  private inFlight = false;
  private pendingQuery = false;
  private nodeMinSize = 0;
  private edgeMinLenPx = 0;

  private constructor(
    private readonly device: GPUDevice,
    private readonly store: GraphStore,
    private readonly graph: GraphBuffers,
    private readonly nodeCull: TransformCullPass,
    private readonly edgeCull: EdgeCullPass,
    private readonly layouts: { node: GPUBindGroupLayout; edge: GPUBindGroupLayout; map: GPUBindGroupLayout },
    private readonly empty: GPUBindGroup,
    private readonly nodePipe: GPUComputePipeline,
    private readonly edgePipe: GPUComputePipeline,
    private readonly mapPipe: GPUComputePipeline,
    private readonly labelSizeCssPx: number,
  ) {
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.nodeBuf = device.createBuffer({ label: "labels/nodeCandidates", size: NODE_BYTES, usage: storage });
    this.edgeBuf = device.createBuffer({ label: "labels/edgeCandidates", size: EDGE_BYTES, usage: storage });
    this.readback = device.createBuffer({ label: "labels/readback", size: NODE_BYTES + EDGE_BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.params = device.createBuffer({ label: "labels/params", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const cap = (n: number) => {
      const b = device.createBuffer({ label: "labels/capacity", size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
      new Uint32Array(b.getMappedRange())[0] = n;
      b.unmap();
      return b;
    };
    this.nodeCap = cap(LABEL_NODE_CAPACITY);
    this.edgeCap = cap(LABEL_EDGE_CAPACITY);
  }

  static async create(
    device: GPUDevice,
    layouts: ContractLayouts,
    store: GraphStore,
    graph: GraphBuffers,
    nodeCull: TransformCullPass,
    edgeCull: EdgeCullPass,
    opts: { lodTargetPx: number; labelSizeCssPx: number },
  ): Promise<LabelPass> {
    const [cullModule, edgeModule, mapModule] = await Promise.all([
      createShaderModule(device, "passes/transform_cull.wgsl"),
      createShaderModule(device, "passes/label_edges.wgsl"),
      createShaderModule(device, "passes/label_map.wgsl"),
    ]);
    const e = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    const bgl = {
      // Binding 0 is the node cull's state buffer, declared read_write there.
      node: device.createBindGroupLayout({ label: "group2/label-nodes", entries: [e(0, "storage"), e(4, "storage"), e(5, "uniform")] }),
      edge: device.createBindGroupLayout({
        label: "group2/label-edges",
        entries: [e(0, "read-only-storage"), e(1, "read-only-storage"), e(2, "read-only-storage"), e(3, "read-only-storage"), e(4, "storage"), e(5, "uniform")],
      }),
      map: device.createBindGroupLayout({ label: "label-map", entries: [e(0, "storage"), e(1, "read-only-storage"), e(2, "uniform")] }),
    };
    const emptyLayout = device.createBindGroupLayout({ label: "empty", entries: [] });
    const pipe = (module: GPUShaderModule, entryPoint: string, groups: GPUBindGroupLayout[], constants?: Record<string, number>) =>
      device.createComputePipelineAsync({
        label: `labels/${entryPoint}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: groups }),
        compute: { module, entryPoint, constants },
      });
    const [nodePipe, edgePipe, mapPipe] = await Promise.all([
      // Same LOD as the node cull, or labels would go to nodes it does not draw.
      pipe(cullModule, "label_nodes", [layouts.frame, layouts.graph, bgl.node], { LOD_TARGET_PX: opts.lodTargetPx }),
      pipe(edgeModule, "label_edges", [layouts.frame, emptyLayout, bgl.edge]),
      pipe(mapModule, "label_map", [bgl.map]),
    ]);
    const empty = device.createBindGroup({ layout: emptyLayout, entries: [] });
    return new LabelPass(device, store, graph, nodeCull, edgeCull, bgl, empty, nodePipe, edgePipe, mapPipe, opts.labelSizeCssPx);
  }

  active(ctx: FrameContext): boolean {
    const wantNodes = this.store.nodeLabels !== null && ctx.nodeCount > 0;
    const wantEdges = this.store.edgeLabels !== null && ctx.edgeCount > 0 && this.graph.edgeOrder !== null;
    if (!wantNodes && !wantEdges) return false;
    if (this.inFlight) {
      this.pendingQuery = true; // the view moved while a read was in flight: look again after it
      return false;
    }
    return true;
  }

  prepare(ctx: FrameContext): void {
    this.doNodes = this.store.nodeLabels !== null && ctx.nodeCount > 0 && this.nodeCull.outputs !== null;
    this.doEdges = this.store.edgeLabels !== null && ctx.edgeCount > 0 && this.edgeCull.outputs !== null && this.graph.edgeOrder !== null;
    const floor = MIN_EDGE_LEN_IN_LABEL_HEIGHTS * this.labelSizeCssPx * this.pixelRatio;
    this.edgeMinLenPx = Math.max(this.edgeMinLenPx, floor);
    this.paramData.set([this.nodeMinSize, MIN_NODE_RADIUS_CSS_PX * this.pixelRatio, this.edgeMinLenPx, 0]);
    const q = this.device.queue;
    q.writeBuffer(this.params, 0, this.paramData);
    // Counters start at zero: ordered before this frame's commands by the queue.
    q.writeBuffer(this.nodeBuf, 0, this.zeros);
    q.writeBuffer(this.edgeBuf, 0, this.zeros);
    this.ran = this.doNodes || this.doEdges;
  }

  phaseActive(phase: number): boolean {
    return phase === 0 ? this.doNodes : phase === 1 ? this.doEdges : this.doNodes || this.doEdges;
  }

  encodePhase(phase: number, pass: GPUComputePassEncoder, ctx: FrameContext): void {
    const g = this.graph;
    const group = (layout: GPUBindGroupLayout, buffers: [number, GPUBuffer][]) =>
      this.device.createBindGroup({ layout, entries: buffers.map(([binding, buffer]) => ({ binding, resource: { buffer } })) });
    switch (phase) {
      case 0: {
        const cull = this.nodeCull;
        pass.setPipeline(this.nodePipe);
        pass.setBindGroup(0, ctx.frameBindGroup);
        pass.setBindGroup(1, ctx.graphBindGroup);
        pass.setBindGroup(2, group(this.layouts.node, [[0, cull.outputs!.scratch], [4, this.nodeBuf], [5, this.params]]));
        pass.dispatchWorkgroupsIndirect(cull.dispatch, 0);
        return;
      }
      case 1: {
        const out = this.edgeCull.outputs!;
        pass.setPipeline(this.edgePipe);
        pass.setBindGroup(0, ctx.frameBindGroup);
        pass.setBindGroup(1, this.empty);
        pass.setBindGroup(
          2,
          group(this.layouts.edge, [
            [0, out.scratch],
            [1, out.list],
            [2, g.buffers.edgeIdx],
            [3, g.buffers.nodePos],
            [4, this.edgeBuf],
            [5, this.params],
          ]),
        );
        pass.dispatchWorkgroupsIndirect(out.scratch, EDGE_CONSTANTS.EDGE_SCRATCH_LABEL_DISPATCH * 4);
        return;
      }
      case 2:
        pass.setPipeline(this.mapPipe);
        if (this.doNodes) {
          pass.setBindGroup(0, group(this.layouts.map, [[0, this.nodeBuf], [1, g.order], [2, this.nodeCap]]));
          pass.dispatchWorkgroups(Math.ceil(LABEL_NODE_CAPACITY / 256));
        }
        if (this.doEdges) {
          pass.setBindGroup(0, group(this.layouts.map, [[0, this.edgeBuf], [1, g.edgeOrder!], [2, this.edgeCap]]));
          pass.dispatchWorkgroups(Math.ceil(LABEL_EDGE_CAPACITY / 256));
        }
        return;
    }
  }

  /** Copy this frame's candidates out, if it found any. Call after the frame graph. */
  recordReadback(encoder: GPUCommandEncoder): void {
    if (!this.ran) return;
    this.ran = false;
    encoder.copyBufferToBuffer(this.nodeBuf, 0, this.readback, 0, NODE_BYTES);
    encoder.copyBufferToBuffer(this.edgeBuf, 0, this.readback, NODE_BYTES, EDGE_BYTES);
    this.scheduled = true;
  }

  /** Call right after `queue.submit`. */
  afterSubmit(): void {
    if (!this.scheduled) return;
    this.scheduled = false;
    this.inFlight = true;
    this.readback.mapAsync(GPUMapMode.READ).then(
      () => this.read(),
      () => (this.inFlight = false), // device lost / destroyed
    );
  }

  destroy(): void {
    for (const b of [this.nodeBuf, this.edgeBuf, this.readback, this.params, this.nodeCap, this.edgeCap]) b.destroy();
  }

  private read(): void {
    const words = new Uint32Array(this.readback.getMappedRange()).slice();
    this.readback.unmap();
    this.inFlight = false;
    const take = (at: number, cap: number): Candidates & { found: number } => {
      const found = words[at]!;
      const count = Math.min(found, cap);
      const first = at + LABEL_HEADER_WORDS;
      return {
        found,
        count,
        u32: words.subarray(first, first + count * RECORD_WORDS),
        f32: new Float32Array(words.buffer, first * 4, count * RECORD_WORDS),
      };
    };
    const nodes = take(0, LABEL_NODE_CAPACITY);
    const edges = take(NODE_BYTES / 4, LABEL_EDGE_CAPACITY);

    // Keep the thresholds where the biggest few thousand pass: halfway down
    // when there were too many, looser when there were few.
    let moved = false;
    if (this.doNodes) {
      const next = feedback(this.nodeMinSize, nodes, LABEL_NODE_CAPACITY, 0);
      moved ||= next !== this.nodeMinSize;
      this.nodeMinSize = next;
    }
    if (this.doEdges) {
      const floor = MIN_EDGE_LEN_IN_LABEL_HEIGHTS * this.labelSizeCssPx * this.pixelRatio;
      const next = feedback(this.edgeMinLenPx, edges, LABEL_EDGE_CAPACITY, floor);
      moved ||= next !== this.edgeMinLenPx;
      this.edgeMinLenPx = next;
    }

    this.onResult(nodes, edges);
    if (moved || this.pendingQuery) {
      this.pendingQuery = false;
      this.requestQuery();
    }
  }
}

/**
 * The next threshold on priority. Too many candidates: the median of those
 * collected, which lands the next count well inside capacity. Few: halve,
 * down to `floor`. Otherwise leave it, so a still view settles.
 */
function feedback(threshold: number, c: Candidates & { found: number }, cap: number, floor: number): number {
  if (c.found > cap) {
    const p = new Float32Array(c.count);
    for (let k = 0; k < c.count; k++) p[k] = c.f32[k * RECORD_WORDS + 2]!;
    p.sort();
    return Math.max(floor, p[p.length >> 1]!);
  }
  if (c.found < cap / 4 && threshold > floor) {
    const half = threshold / 2;
    return half <= floor * 1.01 || half < 1e-6 ? floor : half;
  }
  return threshold;
}

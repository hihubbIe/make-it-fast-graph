/**
 * GPU residency of the graph data (@group(1)) and every path that writes it (§5.5).
 *
 * Node buffers are kept in ENGINE order (Morton order after the first sort) so
 * every per-frame pass reads spatially coherent memory. Two tables map between
 * orders: `order[engine] = user`, `rank[user] = engine`. The CPU never needs them:
 *
 * - Bulk load (node count changed): upload in user order via `mappedAtCreation`,
 *   order/rank = identity, then SORT permutes on the GPU.
 * - Whole-channel replace (same count): upload in user order to a temp buffer,
 *   GPU-gather it into engine order.
 * - Partial updates: per-range writeBuffer into a staging buffer, then one
 *   scatter_update dispatch through `rank` per channel. Never a full re-upload.
 *
 * Edge channels are only ever replaced whole, always in the user's order;
 * EDGE_SORT then turns them into engine-indexed, sorted buffers in place
 * (`adoptSortedEdges`). A node re-sort renumbers the nodes, so it re-uploads
 * the edges from the CPU mirror and they are sorted again from scratch.
 *
 * Buffers replaced during a frame are retired and destroyed after submit.
 */
import type { GraphStore } from "../data/GraphStore";
import { DirtyRanges } from "../data/DirtyRanges";
import { GRAPH_BINDINGS, GRAPH_BUFFER_WORDS, type GraphBufferName } from "../data/Layouts";
import type { PermuteKernels, ScatterSlot } from "./PermuteKernels";

/** Smallest buffer we create: bindings need non-zero size, vec2 arrays need ≥ 8 B. */
const MIN_BUFFER_BYTES = 16;

export const NODE_CHANNELS = ["nodePos", "nodeStyle", "nodeSize", "nodeColor", "nodeState"] as const satisfies readonly GraphBufferName[];
type NodeChannel = (typeof NODE_CHANNELS)[number];
const isNodeChannel = (n: GraphBufferName): n is NodeChannel => (NODE_CHANNELS as readonly string[]).includes(n);

const USAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;

interface ScatterJob {
  name: NodeChannel;
  total: number;
  ranges: number;
}

export class GraphBuffers {
  readonly buffers = {} as Record<GraphBufferName, GPUBuffer>;
  /** order[engine index] = user index. */
  order!: GPUBuffer;
  /** rank[user index] = engine index. */
  rank!: GPUBuffer;
  /** @group(1) bind group; rebuilt whenever a buffer is swapped. */
  bindGroup!: GPUBindGroup;
  /** Node positions changed wholesale: engine order must be rebuilt by SORT. */
  needsSort = false;
  /** Edge channels hold the user's order (fresh upload): EDGE_SORT must run. */
  edgesUnsorted = false;
  /**
   * edgeOrder[sorted edge] = the user's edge index, kept from the last EDGE_SORT
   * while edge labels need it (their text is in the user's order); else null.
   */
  edgeOrder: GPUBuffer | null = null;
  /** Keep `edgeOrder` at the next sort (set by the engine). */
  keepEdgeOrder = false;
  /** Bytes uploaded by the last flush. */
  lastUploadBytes = 0;

  private nodeCount = -1;
  private orderIsIdentity = true;
  private readonly gathers: { name: NodeChannel; userOrder: GPUBuffer }[] = [];
  private readonly scatters: ScatterJob[] = [];
  private readonly slots: Record<NodeChannel, ScatterSlot>;
  private readonly rangeTable = new Uint32Array(DirtyRanges.CAPACITY * 2);
  private readonly retired: GPUBuffer[] = [];

  constructor(
    private readonly device: GPUDevice,
    private readonly layout: GPUBindGroupLayout,
    private readonly store: GraphStore,
    private readonly kernels: PermuteKernels,
  ) {
    this.slots = Object.fromEntries(NODE_CHANNELS.map((n) => [n, kernels.createScatterSlot(n)])) as Record<NodeChannel, ScatterSlot>;
  }

  /** GPU work queued by `flush` that must be encoded this frame. */
  get hasPendingWork(): boolean {
    return this.gathers.length > 0 || this.scatters.length > 0;
  }

  /** CPU side of the upload: create/fill buffers and stage partial updates. */
  flush(): boolean {
    if (!this.store.dirty) return false;
    const store = this.store;
    let bytes = 0;
    let rebind = false;

    if (store.nodeCount !== this.nodeCount) {
      // Topology change: every node channel arrives in user order.
      this.nodeCount = store.nodeCount;
      this.retire(this.order, this.rank);
      this.order = this.identity("order", this.nodeCount);
      this.rank = this.identity("rank", this.nodeCount);
      this.orderIsIdentity = true;
      this.needsSort = this.nodeCount > 0;
      bytes += this.nodeCount * 8;
    }
    // A sort is coming (topology, or positions replaced wholesale): the edges on
    // the GPU are indexed by the old numbering, so bring back the user's copy.
    if ((this.needsSort || store.channels.nodePos.realloc) && store.edgeCount > 0) store.reloadEdges();

    for (const b of GRAPH_BINDINGS) {
      const name = b.name;
      const ch = store.channels[name];
      if (ch.realloc) {
        const filled = this.createFilled(name, ch.data);
        bytes += ch.data.byteLength;
        if (isNodeChannel(name) && !this.orderIsIdentity) {
          this.gathers.push({ name, userOrder: filled }); // permuted on the GPU in encode()
        } else {
          this.retire(this.buffers[name]);
          this.buffers[name] = filled;
          rebind = true;
        }
        if (name === "nodePos") this.needsSort = this.nodeCount > 0;
        if (name === "edgeIdx") this.edgesUnsorted = true;
        ch.realloc = false;
        ch.dirty.clear();
        continue;
      }
      const d = ch.dirty;
      // Only node channels take partial updates; edges are replaced whole.
      if (d.isEmpty || !isNodeChannel(name)) continue;
      bytes += this.stageScatter(name, ch.data, ch.words, d);
      d.clear();
    }

    if (rebind || !this.bindGroup) this.rebind();
    store.markClean();
    this.lastUploadBytes = bytes;
    return true;
  }

  /** GPU side of the upload: permute replaced channels, apply partial updates. */
  encode(pass: GPUComputePassEncoder): void {
    for (const g of this.gathers) {
      const words = GRAPH_BUFFER_WORDS[g.name];
      const dst = this.device.createBuffer({ label: g.name, size: g.userOrder.size, usage: USAGE });
      const params = this.kernels.gather(pass, this.order, g.userOrder, dst, this.nodeCount, words);
      this.retire(g.userOrder, this.buffers[g.name], params);
      this.buffers[g.name] = dst;
    }
    if (this.gathers.length > 0) this.rebind();
    this.gathers.length = 0;

    for (const s of this.scatters) {
      this.kernels.scatter(pass, this.slots[s.name], this.rank, this.buffers[s.name], s.total, s.ranges, GRAPH_BUFFER_WORDS[s.name]);
    }
    this.scatters.length = 0;
  }

  /**
   * Re-order every node channel by `perm` (perm[newEngine] = oldEngine) and
   * update order/rank. Called by SORT inside its compute pass.
   */
  permute(pass: GPUComputePassEncoder, perm: GPUBuffer): void {
    const n = this.nodeCount;
    for (const name of NODE_CHANNELS) {
      const src = this.buffers[name];
      const dst = this.device.createBuffer({ label: name, size: src.size, usage: USAGE });
      const params = this.kernels.gather(pass, perm, src, dst, n, GRAPH_BUFFER_WORDS[name]);
      this.retire(src, params);
      this.buffers[name] = dst;
    }
    const order = this.device.createBuffer({ label: "order", size: this.order.size, usage: USAGE });
    const rank = this.device.createBuffer({ label: "rank", size: this.rank.size, usage: USAGE });
    const params = this.kernels.compose(pass, perm, this.order, order, rank, n);
    this.retire(this.order, this.rank, params);
    this.order = order;
    this.rank = rank;
    this.orderIsIdentity = false;
    this.needsSort = false;
    this.rebind();
  }

  /**
   * Replace the edge channels with their sorted form: `edgeIdx` gathered from
   * `engineIdx` (engine endpoints, user order), styles and colours gathered
   * from themselves, all through `perm` (perm[sorted] = user). Channels the
   * user never supplied stay as their placeholder.
   */
  adoptSortedEdges(pass: GPUComputePassEncoder, perm: GPUBuffer, engineIdx: GPUBuffer, edgeCount: number): void {
    const jobs: [GraphBufferName, GPUBuffer][] = [["edgeIdx", engineIdx]];
    if (this.store.hasEdgeStyles) jobs.push(["edgeStyle", this.buffers.edgeStyle]);
    if (this.store.hasEdgeColors) jobs.push(["edgeColor", this.buffers.edgeColor]);
    for (const [name, src] of jobs) {
      const dst = this.device.createBuffer({ label: name, size: src.size, usage: USAGE });
      const params = this.kernels.gather(pass, perm, src, dst, edgeCount, GRAPH_BUFFER_WORDS[name]);
      this.retire(this.buffers[name], params);
      this.buffers[name] = dst;
    }
    this.edgesUnsorted = false;
    this.rebind();
  }

  /** Replace the kept edge order (null drops it). */
  setEdgeOrder(order: GPUBuffer | null): void {
    if (order !== this.edgeOrder) this.retire(this.edgeOrder ?? undefined);
    this.edgeOrder = order;
  }

  /** Queue buffers used by this frame's commands for destruction after submit. */
  retireAfterSubmit(...buffers: GPUBuffer[]): void {
    this.retire(...buffers);
  }

  /** Destroy buffers replaced during the frame. Call after `queue.submit`. */
  afterSubmit(): void {
    for (const b of this.retired) b.destroy();
    this.retired.length = 0;
  }

  destroy(): void {
    this.afterSubmit();
    for (const b of GRAPH_BINDINGS) this.buffers[b.name]?.destroy();
    this.order?.destroy();
    this.rank?.destroy();
    this.edgeOrder?.destroy();
    for (const s of Object.values(this.slots)) {
      s.params.destroy();
      s.ranges.destroy();
      s.upload?.destroy();
    }
  }

  // ---- internals ----------------------------------------------------------------

  /** Copy dirty user-order ranges into the channel's staging buffer; returns bytes. */
  private stageScatter(name: NodeChannel, data: Uint32Array | Float32Array, words: number, d: DirtyRanges): number {
    const slot = this.slots[name];
    let total = 0;
    for (let r = 0; r < d.count; r++) total += d.end(r) - d.start(r);
    const bytes = total * words * 4;
    if (!slot.upload || slot.upload.size < bytes) {
      if (slot.upload) this.retire(slot.upload);
      slot.upload = this.device.createBuffer({ label: `${name}/upload`, size: Math.max(MIN_BUFFER_BYTES, Math.ceil(bytes * 1.5 / 16) * 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }
    const queue = this.device.queue;
    let prefix = 0;
    for (let r = 0; r < d.count; r++) {
      const start = d.start(r);
      const count = d.end(r) - start;
      queue.writeBuffer(slot.upload, prefix * words * 4, data, start * words, count * words);
      this.rangeTable[r * 2] = start;
      this.rangeTable[r * 2 + 1] = prefix;
      prefix += count;
    }
    queue.writeBuffer(slot.ranges, 0, this.rangeTable, 0, d.count * 2);
    this.scatters.push({ name, total, ranges: d.count });
    return bytes + d.count * 8;
  }

  private createFilled(label: string, data: Uint32Array | Float32Array): GPUBuffer {
    const size = Math.max(MIN_BUFFER_BYTES, Math.ceil(data.byteLength / 16) * 16);
    const buffer = this.device.createBuffer({ label, size, usage: USAGE, mappedAtCreation: true });
    if (data.byteLength > 0) {
      new Uint32Array(buffer.getMappedRange(0, data.byteLength)).set(new Uint32Array(data.buffer, data.byteOffset, data.length));
    }
    buffer.unmap();
    return buffer;
  }

  private identity(label: string, n: number): GPUBuffer {
    const size = Math.max(MIN_BUFFER_BYTES, Math.ceil((n * 4) / 16) * 16);
    const buffer = this.device.createBuffer({ label, size, usage: USAGE, mappedAtCreation: true });
    const words = new Uint32Array(buffer.getMappedRange());
    for (let i = 0; i < n; i++) words[i] = i;
    buffer.unmap();
    return buffer;
  }

  private retire(...buffers: (GPUBuffer | undefined)[]): void {
    for (const b of buffers) if (b) this.retired.push(b);
  }

  private rebind(): void {
    this.bindGroup = this.device.createBindGroup({
      label: "group1/graph",
      layout: this.layout,
      entries: GRAPH_BINDINGS.map((b) => ({ binding: b.binding, resource: { buffer: this.buffers[b.name] } })),
    });
  }
}

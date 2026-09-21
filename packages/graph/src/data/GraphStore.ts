/**
 * Worker-side SoA mirrors of every graph buffer (§5), with dirty tracking.
 *
 * Mirrors are the arrays transferred from the main thread (zero copy) — they
 * double as the source for device-lost recovery (M9). The GPU never sees
 * strings or objects; node identity is the index.
 */
import { DirtyRanges } from "./DirtyRanges";
import { DEFAULT_NODE_STYLE, GRAPH_BINDINGS, GRAPH_BUFFER_WORDS, type GraphBufferName } from "./Layouts";
import { packNodeSizes, toHalfBits } from "./Pack";

export interface Channel {
  /** CPU mirror, `elementCount * words` 32-bit words. */
  data: Uint32Array | Float32Array;
  /** 32-bit words per element. */
  readonly words: number;
  /** Dirty element ranges awaiting upload. */
  readonly dirty: DirtyRanges;
  /** Element count changed: the GPU buffer must be recreated. */
  realloc: boolean;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface NodeArrays {
  positions?: Float32Array;
  colors?: Uint32Array;
  sizes?: Float32Array;
}

export interface EdgeArrays {
  indices?: Uint32Array;
  styles?: Uint32Array;
  colors?: Uint32Array;
}

export const DEFAULT_NODE_COLOR = 0xffffa04a; // rgba(74, 160, 255, 255)
export const DEFAULT_NODE_SIZE = 4;

export class GraphStore {
  nodeCount = 0;
  edgeCount = 0;
  /** Per-edge style words were supplied; otherwise every edge uses the global width. */
  hasEdgeStyles = false;
  /** Per-edge colours were supplied; otherwise every edge uses the global tint. */
  hasEdgeColors = false;
  /** Label text per node / edge, in the user's order; null when none were set. */
  nodeLabels: readonly string[] | null = null;
  edgeLabels: readonly string[] | null = null;
  readonly channels: Readonly<Record<GraphBufferName, Channel>>;
  /** World-space AABB of node positions; recomputed on bulk position writes. */
  readonly bounds: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private anyDirty = false;

  constructor() {
    const channels = {} as Record<GraphBufferName, Channel>;
    for (const b of GRAPH_BINDINGS) {
      const words = GRAPH_BUFFER_WORDS[b.name];
      const data = b.name === "nodePos" ? new Float32Array(0) : new Uint32Array(0);
      channels[b.name] = { data, words, dirty: new DirtyRanges(), realloc: true };
    }
    this.channels = channels;
    this.anyDirty = true;
  }

  get dirty(): boolean {
    return this.anyDirty;
  }

  /** Called by GraphBuffers once everything has been flushed. */
  markClean(): void {
    this.anyDirty = false;
  }

  /**
   * Bulk replace node data. `count` is authoritative; missing arrays are filled
   * with defaults (or preserved prefix-wise when the count is unchanged).
   */
  setNodes(count: number, arrays: NodeArrays): void {
    const resized = count !== this.nodeCount;
    this.nodeCount = count;
    const ch = this.channels;

    if (arrays.positions) this.replace(ch.nodePos, arrays.positions);
    else if (resized) this.replace(ch.nodePos, resizeF32(ch.nodePos.data as Float32Array, count * 2, 0));

    if (arrays.colors) this.replace(ch.nodeColor, arrays.colors);
    else if (resized) this.replace(ch.nodeColor, resizeU32(ch.nodeColor.data as Uint32Array, count, DEFAULT_NODE_COLOR));

    if (arrays.sizes) this.replace(ch.nodeSize, packNodeSizes(arrays.sizes, new Uint32Array(count)));
    else if (resized) this.replace(ch.nodeSize, resizeU32(ch.nodeSize.data as Uint32Array, count, toHalfBits(DEFAULT_NODE_SIZE)));

    if (resized) {
      this.replace(ch.nodeStyle, resizeU32(ch.nodeStyle.data as Uint32Array, count, DEFAULT_NODE_STYLE));
      this.replace(ch.nodeState, resizeU32(ch.nodeState.data as Uint32Array, count, 0));
    }

    if (arrays.positions || resized) this.computeBounds();
  }

  /**
   * Bulk replace edge data. Endpoints arrive as USER node indices and stay that
   * way here: the GPU maps them to engine order and sorts the list itself
   * (EdgeSortPass), so this never has to know about either order.
   */
  setEdges(count: number, arrays: EdgeArrays): void {
    const resized = count !== this.edgeCount;
    this.edgeCount = count;
    const ch = this.channels;

    if (arrays.indices) this.replace(ch.edgeIdx, arrays.indices);
    else if (resized) this.replace(ch.edgeIdx, resizeU32(ch.edgeIdx.data as Uint32Array, count * 2, 0));

    // Uniform edges upload NOTHING for style or colour: the shader variant that
    // reads them is not compiled, and the buffers stay at their minimum size.
    // At 30M edges that is 360 MB not allocated, which matters on an iGPU.
    this.hasEdgeStyles = arrays.styles !== undefined;
    this.hasEdgeColors = arrays.colors !== undefined;
    this.replace(ch.edgeStyle, arrays.styles ?? new Uint32Array(0));
    this.replace(ch.edgeColor, arrays.colors ?? new Uint32Array(0));
  }

  /**
   * Re-upload every edge channel from these mirrors, which are still in the
   * user's order. Needed whenever the nodes are renumbered: the GPU copies hold
   * sorted, engine-indexed edges that are only valid for the old numbering.
   */
  reloadEdges(): void {
    for (const ch of [this.channels.edgeIdx, this.channels.edgeStyle, this.channels.edgeColor]) {
      ch.dirty.clear();
      ch.realloc = true;
    }
    this.anyDirty = true;
  }

  /** Partial position update: `data` holds xy pairs for nodes `start..`. */
  updatePositions(start: number, data: Float32Array): void {
    const pos = this.channels.nodePos;
    const count = data.length >> 1;
    if (start + count > this.nodeCount) throw new RangeError("updatePositions: range exceeds node count");
    (pos.data as Float32Array).set(data, start * 2);
    this.markRange(pos, start, start + count);
  }

  updateColor(index: number, rgba: number): void {
    const ch = this.channels.nodeColor;
    ch.data[index] = rgba;
    this.markRange(ch, index, index + 1);
  }

  /**
   * Whole-array replacement always recreates the GPU buffer: `mappedAtCreation`
   * is the fastest bulk path (§5.5), faster than a full-size writeBuffer.
   */
  private replace(ch: Channel, data: Uint32Array | Float32Array): void {
    ch.data = data;
    ch.dirty.clear();
    ch.realloc = true;
    this.anyDirty = true;
  }

  private markRange(ch: Channel, start: number, end: number): void {
    ch.dirty.add(start, end);
    this.anyDirty = true;
  }

  private computeBounds(): void {
    const p = this.channels.nodePos.data as Float32Array;
    const b = this.bounds;
    if (this.nodeCount === 0) {
      b.minX = b.minY = b.maxX = b.maxY = 0;
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0, n = this.nodeCount * 2; i < n; i += 2) {
      const x = p[i]!;
      const y = p[i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    b.minX = minX;
    b.minY = minY;
    b.maxX = maxX;
    b.maxY = maxY;
  }
}

function resizeU32(prev: Uint32Array, length: number, fill: number): Uint32Array {
  const next = new Uint32Array(length);
  next.set(prev.length <= length ? prev : prev.subarray(0, length));
  if (prev.length < length) next.fill(fill, prev.length);
  return next;
}

function resizeF32(prev: Float32Array, length: number, fill: number): Float32Array {
  const next = new Float32Array(length);
  next.set(prev.length <= length ? prev : prev.subarray(0, length));
  if (prev.length < length && fill !== 0) next.fill(fill, prev.length);
  return next;
}

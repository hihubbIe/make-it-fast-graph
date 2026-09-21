/**
 * GPU profiler (§18.1): timestamp queries around every pass, resolved into a
 * small ring of mappable buffers and read 1–3 frames later. Never waits on the
 * GPU inside a frame (pitfall #9).
 *
 * The same readback also carries the per-bucket draw counts, so visible-node
 * counts are available even without `timestamp-query`.
 */
import { ENGINE_CONSTANTS } from "../data/Layouts";

// 32: nodes take 12 and edges 7, leaving room for labels and halos (M8).
// Kept at 32 so `ranMask` stays inside a 32-bit int.
export const MAX_PROFILE_SLOTS = 32;
const RING_SIZE = 4;
// resolveQuerySet writes at 256-B aligned offsets, so round the timestamp
// region up rather than assuming the slot count happens to land on 256.
const TIMESTAMP_BYTES = Math.ceil((MAX_PROFILE_SLOTS * 2 * 8) / 256) * 256;
const COUNTS_OFFSET = TIMESTAMP_BYTES;
const COUNTS_BYTES = ENGINE_CONSTANTS.NUM_BUCKETS * 4 * 4; // drawIndirect args per bucket
/** The edge cull writes one drawIndirect arg block; its instanceCount is the drawn edge count. */
const EDGE_COUNTS_OFFSET = COUNTS_OFFSET + COUNTS_BYTES;
const EDGE_COUNTS_BYTES = 16;
const READBACK_BYTES = EDGE_COUNTS_OFFSET + EDGE_COUNTS_BYTES;

export interface ProfileSample {
  frameIndex: number;
  /** First pass begin → last pass end, ms. NaN without timestamp-query. */
  gpuTotalMs: number;
  /** Per slot duration in ms; NaN when the slot did not run or timing is unavailable. */
  slotMs: Float64Array;
  /** Instances drawn per bucket. */
  bucketCounts: Uint32Array;
  /** Edge instances drawn after the edge cull (whole chunks of 1024). */
  edgeCount: number;
}

interface RingEntry {
  buffer: GPUBuffer;
  busy: boolean;
  frameIndex: number;
  ranMask: number;
  hasCounts: boolean;
  hasEdgeCounts: boolean;
  onMapped: () => void;
}

export class Profiler {
  readonly timestamps: boolean;
  readonly slotNames: string[] = [];
  /** Called from the map callback, 1–3 frames after the frame ran. */
  onSample: (s: ProfileSample) => void = () => {};

  private readonly querySet: GPUQuerySet | null = null;
  private readonly resolveBuffer: GPUBuffer | null = null;
  private readonly ring: RingEntry[] = [];
  private readonly writes: (GPURenderPassTimestampWrites | undefined)[] = [];
  private ranMask = 0;
  private scheduled: RingEntry | null = null;
  private readonly sample: ProfileSample = {
    frameIndex: 0,
    gpuTotalMs: NaN,
    slotMs: new Float64Array(MAX_PROFILE_SLOTS),
    bucketCounts: new Uint32Array(ENGINE_CONSTANTS.NUM_BUCKETS),
    edgeCount: 0,
  };
  /** Frames whose readback was skipped because the ring was full. */
  droppedFrames = 0;

  constructor(
    private readonly device: GPUDevice,
    timestampQuery: boolean,
  ) {
    this.timestamps = timestampQuery;
    if (timestampQuery) {
      this.querySet = device.createQuerySet({ label: "profiler", type: "timestamp", count: MAX_PROFILE_SLOTS * 2 });
      this.resolveBuffer = device.createBuffer({
        label: "profiler/resolve",
        size: TIMESTAMP_BYTES,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
    }
    for (let k = 0; k < RING_SIZE; k++) {
      const entry: RingEntry = {
        buffer: device.createBuffer({ label: `profiler/readback${k}`, size: READBACK_BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
        busy: false,
        frameIndex: 0,
        ranMask: 0,
        hasCounts: false,
        hasEdgeCounts: false,
        onMapped: () => this.read(entry),
      };
      this.ring.push(entry);
    }
  }

  /** Register a timed slot (one per pass). Returns its index. */
  register(name: string): number {
    if (this.slotNames.length >= MAX_PROFILE_SLOTS) throw new Error("Profiler: too many slots");
    const slot = this.slotNames.length;
    this.slotNames.push(name);
    this.writes.push(
      this.querySet ? { querySet: this.querySet, beginningOfPassWriteIndex: slot * 2, endOfPassWriteIndex: slot * 2 + 1 } : undefined,
    );
    return slot;
  }

  /** Timestamp writes for a pass descriptor (undefined without timestamp-query). Marks the slot as run. */
  timestampWrites(slot: number): GPURenderPassTimestampWrites | undefined {
    this.ranMask |= 1 << slot;
    return this.writes[slot];
  }

  beginFrame(): void {
    this.ranMask = 0;
    this.scheduled = null;
  }

  /**
   * Record the readback copies at the end of the frame's command stream.
   * `drawArgs` / `edgeDrawArgs` are the node and edge state buffers (draw args
   * live at their start), or null.
   */
  endFrame(encoder: GPUCommandEncoder, frameIndex: number, drawArgs: GPUBuffer | null, edgeDrawArgs: GPUBuffer | null): void {
    let entry: RingEntry | null = null;
    for (let k = 0; k < RING_SIZE; k++) {
      if (!this.ring[k]!.busy) {
        entry = this.ring[k]!;
        break;
      }
    }
    if (!entry) {
      this.droppedFrames++;
      return;
    }
    if (this.querySet && this.resolveBuffer && this.ranMask !== 0) {
      encoder.resolveQuerySet(this.querySet, 0, this.slotNames.length * 2, this.resolveBuffer, 0);
      encoder.copyBufferToBuffer(this.resolveBuffer, 0, entry.buffer, 0, this.slotNames.length * 16);
    }
    if (drawArgs) encoder.copyBufferToBuffer(drawArgs, 0, entry.buffer, COUNTS_OFFSET, COUNTS_BYTES);
    if (edgeDrawArgs) encoder.copyBufferToBuffer(edgeDrawArgs, 0, entry.buffer, EDGE_COUNTS_OFFSET, EDGE_COUNTS_BYTES);
    entry.busy = true;
    entry.frameIndex = frameIndex;
    entry.ranMask = this.ranMask;
    entry.hasCounts = drawArgs !== null;
    entry.hasEdgeCounts = edgeDrawArgs !== null;
    this.scheduled = entry;
  }

  /** Call right after `queue.submit`. */
  afterSubmit(): void {
    const e = this.scheduled;
    if (!e) return;
    this.scheduled = null;
    e.buffer.mapAsync(GPUMapMode.READ).then(e.onMapped, () => {
      e.busy = false; // device lost / destroyed
    });
  }

  destroy(): void {
    this.querySet?.destroy();
    this.resolveBuffer?.destroy();
    for (const e of this.ring) e.buffer.destroy();
  }

  private read(e: RingEntry): void {
    const words = new Uint32Array(e.buffer.getMappedRange());
    const s = this.sample;
    s.frameIndex = e.frameIndex;
    s.slotMs.fill(NaN);
    let first = Infinity;
    let last = -Infinity;
    if (this.timestamps) {
      for (let slot = 0; slot < this.slotNames.length; slot++) {
        if ((e.ranMask & (1 << slot)) === 0) continue;
        const w = slot * 4; // two u64 = four u32 words per slot
        const begin = words[w]! + words[w + 1]! * 4294967296;
        const end = words[w + 2]! + words[w + 3]! * 4294967296;
        if (end <= begin) continue; // quantized to zero or not written
        s.slotMs[slot] = (end - begin) / 1e6;
        if (begin < first) first = begin;
        if (end > last) last = end;
      }
    }
    s.gpuTotalMs = last > first ? (last - first) / 1e6 : NaN;
    const c = COUNTS_OFFSET / 4;
    for (let b = 0; b < ENGINE_CONSTANTS.NUM_BUCKETS; b++) s.bucketCounts[b] = e.hasCounts ? words[c + b * 4 + 1]! : 0;
    s.edgeCount = e.hasEdgeCounts ? words[EDGE_COUNTS_OFFSET / 4 + 1]! : 0;
    e.buffer.unmap();
    e.busy = false;
    this.onSample(s);
  }
}

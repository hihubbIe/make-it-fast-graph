/**
 * Worker-side benchmark recorder. Drives a CameraPath one step per rendered
 * frame and records per-frame CPU, frame interval, GPU (total + per pass) and
 * visible counts. GPU samples arrive 1–3 frames late; the run completes when
 * every recorded frame has its sample or a deadline passes.
 */
import type { BenchmarkResult } from "../api/types";
import type { Camera2D } from "../camera/Camera2D";
import type { CameraPath } from "../camera/CameraPath";
import type { ProfileSample } from "../gpu/Profiler";

/** Wait at most this long for late GPU samples after the last frame. */
const SAMPLE_DEADLINE_MS = 2000;

export class Benchmark {
  private readonly cpuMs: Float64Array;
  private readonly intervalMs: Float64Array;
  private readonly gpuMs: Float64Array;
  private readonly slotMs: Float64Array[];
  private readonly visible: Float64Array;
  private readonly visibleEdges: Float64Array;
  private step = 0;
  private firstFrameIndex = -1;
  private lastT0 = NaN;
  private pendingSamples = 0;
  private deadline = Infinity;

  constructor(
    readonly id: number,
    private readonly path: CameraPath,
    private readonly warmup: number,
    private readonly slotNames: readonly string[],
  ) {
    const n = path.frames;
    this.cpuMs = new Float64Array(n).fill(NaN);
    this.intervalMs = new Float64Array(n).fill(NaN);
    this.gpuMs = new Float64Array(n).fill(NaN);
    this.visible = new Float64Array(n).fill(NaN);
    this.visibleEdges = new Float64Array(n).fill(NaN);
    this.slotMs = slotNames.map(() => new Float64Array(n).fill(NaN));
  }

  /** True while path frames remain to be rendered. */
  get driving(): boolean {
    return this.step < this.warmup + this.path.frames;
  }

  /** Position the camera for the frame about to render. */
  beforeFrame(camera: Camera2D): void {
    this.path.apply(Math.max(0, this.step - this.warmup), camera);
  }

  afterFrame(frameIndex: number, t0: number, cpuMs: number): void {
    const k = this.step - this.warmup;
    this.step++;
    if (k < 0) return;
    if (k === 0) this.firstFrameIndex = frameIndex;
    this.cpuMs[k] = cpuMs;
    if (k > 0) this.intervalMs[k] = t0 - this.lastT0;
    this.lastT0 = t0;
    this.pendingSamples++;
    if (!this.driving) this.deadline = performance.now() + SAMPLE_DEADLINE_MS;
  }

  onSample(s: ProfileSample): void {
    if (this.firstFrameIndex < 0) return;
    const k = s.frameIndex - this.firstFrameIndex;
    if (k < 0 || k >= this.path.frames) return;
    this.pendingSamples--;
    this.gpuMs[k] = s.gpuTotalMs;
    for (let slot = 0; slot < this.slotMs.length; slot++) this.slotMs[slot]![k] = s.slotMs[slot]!;
    let visible = 0;
    for (let b = 0; b < s.bucketCounts.length; b++) visible += s.bucketCounts[b]!;
    this.visible[k] = visible;
    this.visibleEdges[k] = s.edgeCount;
  }

  /** Recording finished and samples are in (or the deadline passed). */
  get complete(): boolean {
    return !this.driving && (this.pendingSamples <= 0 || performance.now() >= this.deadline);
  }

  result(
    meta: Omit<
      BenchmarkResult,
      "frames" | "warmup" | "cpuMs" | "intervalMs" | "gpuMs" | "passMs" | "visibleNodes" | "visibleEdges"
    >,
  ): BenchmarkResult {
    const passMs: Record<string, Float64Array> = {};
    this.slotNames.forEach((name, slot) => (passMs[name] = this.slotMs[slot]!));
    return {
      ...meta,
      frames: this.path.frames,
      warmup: this.warmup,
      cpuMs: this.cpuMs,
      intervalMs: this.intervalMs,
      gpuMs: this.gpuMs,
      passMs,
      visibleNodes: this.visible,
      visibleEdges: this.visibleEdges,
    };
  }

  /** Buffers to transfer with the result message. */
  transferables(): ArrayBuffer[] {
    return [this.cpuMs, this.intervalMs, this.gpuMs, this.visible, this.visibleEdges, ...this.slotMs].map(
      (a) => a.buffer as ArrayBuffer,
    );
  }
}

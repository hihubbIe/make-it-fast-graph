/**
 * Rolling GPU statistics published to the shared state block. Browsers quantize
 * timestamps (§3 #7), so values are averaged over a window of ≥ 30 samples.
 */
import { STATE_SLOT } from "../bridge/SharedState";
import { MAX_PROFILE_SLOTS, type ProfileSample } from "../gpu/Profiler";

const WINDOW = 30;

/** Mean over the last WINDOW samples; NaN samples (pass did not run) age out real ones. */
class Rolling {
  private readonly values = new Float64Array(WINDOW).fill(NaN);
  private head = 0;
  private valid = 0;
  private sum = 0;

  push(v: number): void {
    const old = this.values[this.head]!;
    if (!Number.isNaN(old)) {
      this.sum -= old;
      this.valid--;
    }
    this.values[this.head] = v;
    if (!Number.isNaN(v)) {
      this.sum += v;
      this.valid++;
    }
    this.head = (this.head + 1) % WINDOW;
  }

  get mean(): number {
    return this.valid === 0 ? NaN : this.sum / this.valid;
  }
}

export class Telemetry {
  private readonly total = new Rolling();
  private readonly slots = Array.from({ length: MAX_PROFILE_SLOTS }, () => new Rolling());

  constructor(private readonly state: Float64Array) {
    state.fill(NaN, STATE_SLOT.SLOT_MS_BASE, STATE_SLOT.SLOT_MS_BASE + MAX_PROFILE_SLOTS);
    state[STATE_SLOT.GPU_MS_AVG] = NaN;
  }

  onSample(s: ProfileSample, droppedFrames: number): void {
    const st = this.state;
    this.total.push(s.gpuTotalMs);
    st[STATE_SLOT.GPU_MS_AVG] = this.total.mean;
    for (let k = 0; k < MAX_PROFILE_SLOTS; k++) {
      const r = this.slots[k]!;
      r.push(s.slotMs[k]!);
      st[STATE_SLOT.SLOT_MS_BASE + k] = r.mean;
    }
    let visible = 0;
    for (let b = 0; b < s.bucketCounts.length; b++) visible += s.bucketCounts[b]!;
    st[STATE_SLOT.VISIBLE_NODES] = visible;
    st[STATE_SLOT.VISIBLE_EDGES] = s.edgeCount;
    st[STATE_SLOT.PROFILER_DROPPED] = droppedFrames;
  }
}

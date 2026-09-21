/**
 * Single-producer / single-consumer ring of fixed 32-byte input records over a
 * SharedArrayBuffer (§6). Producer = main thread, consumer = render worker.
 *
 * Record: { type u32, t f32, x f32, y f32, dx f32, dy f32, buttons u32, mods u32 }
 *
 * The header also carries a SLEEPING flag: the worker sets it when it stops its
 * frame loop; the producer clears it (CAS) after pushing and, if it was set,
 * sends a single wake message. No polling, no Atomics.wait anywhere.
 */

export const INPUT = {
  POINTER_DOWN: 1,
  POINTER_MOVE: 2,
  POINTER_UP: 3,
  POINTER_LEAVE: 4,
  WHEEL: 5,
} as const;

export const MOD = {
  SHIFT: 1,
  CTRL: 2,
  ALT: 4,
  META: 8,
} as const;

/** Decoded record; one instance is reused by the consumer. */
export interface InputRecord {
  type: number;
  t: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  buttons: number;
  mods: number;
}

const HEADER_WORDS = 4; // head, tail, sleeping, reserved
const HEAD = 0;
const TAIL = 1;
const SLEEPING = 2;
const RECORD_WORDS = 8;

export class InputRing {
  static readonly CAPACITY = 512; // power of two

  static create(): InputRing {
    const bytes = (HEADER_WORDS + InputRing.CAPACITY * RECORD_WORDS) * 4;
    return new InputRing(new SharedArrayBuffer(bytes));
  }

  private readonly header: Int32Array;
  private readonly f32: Float32Array;
  private readonly u32: Uint32Array;
  private readonly mask = InputRing.CAPACITY - 1;

  constructor(readonly buffer: SharedArrayBuffer) {
    this.header = new Int32Array(buffer, 0, HEADER_WORDS);
    const base = HEADER_WORDS * 4;
    this.f32 = new Float32Array(buffer, base, InputRing.CAPACITY * RECORD_WORDS);
    this.u32 = new Uint32Array(buffer, base, InputRing.CAPACITY * RECORD_WORDS);
  }

  // ---- producer --------------------------------------------------------------

  /**
   * Append a record. Returns false (record dropped) when the ring is full,
   * which only happens if the worker has stalled for CAPACITY events.
   */
  push(type: number, t: number, x: number, y: number, dx: number, dy: number, buttons: number, mods: number): boolean {
    const tail = Atomics.load(this.header, TAIL);
    const head = Atomics.load(this.header, HEAD);
    if (tail - head >= InputRing.CAPACITY) return false;
    const o = (tail & this.mask) * RECORD_WORDS;
    this.u32[o] = type;
    this.f32[o + 1] = t;
    this.f32[o + 2] = x;
    this.f32[o + 3] = y;
    this.f32[o + 4] = dx;
    this.f32[o + 5] = dy;
    this.u32[o + 6] = buttons;
    this.u32[o + 7] = mods;
    Atomics.store(this.header, TAIL, tail + 1); // publish
    return true;
  }

  /** Clear the sleeping flag; true if the consumer was asleep and needs a wake. */
  claimWake(): boolean {
    return Atomics.compareExchange(this.header, SLEEPING, 1, 0) === 1;
  }

  // ---- consumer --------------------------------------------------------------

  get isEmpty(): boolean {
    return Atomics.load(this.header, HEAD) === Atomics.load(this.header, TAIL);
  }

  /** Drain all pending records into `fn`. `rec` is reused between calls. */
  drain(rec: InputRecord, fn: (rec: InputRecord) => void): number {
    let head = Atomics.load(this.header, HEAD);
    const tail = Atomics.load(this.header, TAIL);
    const n = tail - head;
    while (head !== tail) {
      const o = (head & this.mask) * RECORD_WORDS;
      rec.type = this.u32[o]!;
      rec.t = this.f32[o + 1]!;
      rec.x = this.f32[o + 2]!;
      rec.y = this.f32[o + 3]!;
      rec.dx = this.f32[o + 4]!;
      rec.dy = this.f32[o + 5]!;
      rec.buttons = this.u32[o + 6]!;
      rec.mods = this.u32[o + 7]!;
      fn(rec);
      head++;
    }
    Atomics.store(this.header, HEAD, head);
    return n;
  }

  /**
   * Mark the consumer asleep. Returns false if input raced in, in which case
   * the flag is withdrawn and the consumer must keep running.
   */
  trySleep(): boolean {
    Atomics.store(this.header, SLEEPING, 1);
    if (!this.isEmpty) {
      Atomics.store(this.header, SLEEPING, 0);
      return false;
    }
    return true;
  }
}

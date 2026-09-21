/**
 * Sorted, coalescing list of dirty `[start, end)` element ranges (§5.5).
 * Fixed capacity; on overflow collapses to a single covering range.
 * Allocation-free after construction.
 */
export class DirtyRanges {
  static readonly CAPACITY = 64;

  private readonly starts = new Uint32Array(DirtyRanges.CAPACITY);
  private readonly ends = new Uint32Array(DirtyRanges.CAPACITY);
  private n = 0;

  get count(): number {
    return this.n;
  }

  get isEmpty(): boolean {
    return this.n === 0;
  }

  start(i: number): number {
    return this.starts[i]!;
  }

  end(i: number): number {
    return this.ends[i]!;
  }

  clear(): void {
    this.n = 0;
  }

  /** Mark `[start, end)` dirty. Touching or overlapping ranges merge. */
  add(start: number, end: number): void {
    if (end <= start) return;
    const s = this.starts;
    const e = this.ends;

    // First range whose end reaches `start` (touching counts as overlap).
    let i = 0;
    while (i < this.n && e[i]! < start) i++;

    // Merge every range that overlaps [start, end).
    let j = i;
    let lo = start;
    let hi = end;
    while (j < this.n && s[j]! <= end) {
      if (s[j]! < lo) lo = s[j]!;
      if (e[j]! > hi) hi = e[j]!;
      j++;
    }

    const removed = j - i;
    if (removed === 0) {
      if (this.n === DirtyRanges.CAPACITY) {
        this.collapse(start, end);
        return;
      }
      s.copyWithin(i + 1, i, this.n);
      e.copyWithin(i + 1, i, this.n);
      this.n++;
    } else if (removed > 1) {
      s.copyWithin(i + 1, j, this.n);
      e.copyWithin(i + 1, j, this.n);
      this.n -= removed - 1;
    }
    s[i] = lo;
    e[i] = hi;
  }

  private collapse(start: number, end: number): void {
    const lo = Math.min(start, this.starts[0]!);
    const hi = Math.max(end, this.ends[this.n - 1]!);
    this.starts[0] = lo;
    this.ends[0] = hi;
    this.n = 1;
  }
}

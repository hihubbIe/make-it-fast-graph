import { describe, expect, it } from "vitest";
import { DirtyRanges } from "../src/data/DirtyRanges";

const dump = (d: DirtyRanges) => Array.from({ length: d.count }, (_, i) => [d.start(i), d.end(i)]);

describe("DirtyRanges", () => {
  it("keeps disjoint ranges sorted", () => {
    const d = new DirtyRanges();
    d.add(20, 30);
    d.add(0, 5);
    d.add(10, 12);
    expect(dump(d)).toEqual([
      [0, 5],
      [10, 12],
      [20, 30],
    ]);
  });

  it("merges overlapping and touching ranges", () => {
    const d = new DirtyRanges();
    d.add(0, 5);
    d.add(5, 8);
    d.add(20, 30);
    d.add(7, 21);
    expect(dump(d)).toEqual([[0, 30]]);
  });

  it("ignores empty ranges", () => {
    const d = new DirtyRanges();
    d.add(4, 4);
    expect(d.isEmpty).toBe(true);
  });

  it("collapses to one covering range on overflow", () => {
    const d = new DirtyRanges();
    for (let i = 0; i < DirtyRanges.CAPACITY; i++) d.add(i * 10, i * 10 + 1);
    expect(d.count).toBe(DirtyRanges.CAPACITY);
    d.add(10_000, 10_001);
    expect(dump(d)).toEqual([[0, 10_001]]);
  });
});

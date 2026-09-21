import { describe, expect, it } from "vitest";
import { INPUT, InputRing, type InputRecord } from "../src/bridge/InputRing";

const rec = (): InputRecord => ({ type: 0, t: 0, x: 0, y: 0, dx: 0, dy: 0, buttons: 0, mods: 0 });

describe("InputRing", () => {
  it("delivers records in order across wraparound", () => {
    const ring = InputRing.create();
    const seen: number[] = [];
    let next = 0;
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 300; i++) expect(ring.push(INPUT.POINTER_MOVE, 0, next++, 0, 0, 0, 1, 0)).toBe(true);
      ring.drain(rec(), (r) => seen.push(r.x));
    }
    expect(seen).toEqual(Array.from({ length: 1500 }, (_, i) => i));
    expect(ring.isEmpty).toBe(true);
  });

  it("drops records when full instead of overwriting", () => {
    const ring = InputRing.create();
    for (let i = 0; i < InputRing.CAPACITY; i++) ring.push(INPUT.WHEEL, 0, i, 0, 0, 0, 0, 0);
    expect(ring.push(INPUT.WHEEL, 0, -1, 0, 0, 0, 0, 0)).toBe(false);
    const xs: number[] = [];
    ring.drain(rec(), (r) => xs.push(r.x));
    expect(xs[0]).toBe(0);
    expect(xs.length).toBe(InputRing.CAPACITY);
  });

  it("wake handshake: producer wakes a sleeping consumer exactly once", () => {
    const ring = InputRing.create();
    expect(ring.trySleep()).toBe(true);
    ring.push(INPUT.POINTER_DOWN, 0, 1, 1, 0, 0, 1, 0);
    expect(ring.claimWake()).toBe(true);
    expect(ring.claimWake()).toBe(false);
  });

  it("consumer refuses to sleep when input raced in", () => {
    const ring = InputRing.create();
    ring.push(INPUT.POINTER_DOWN, 0, 1, 1, 0, 0, 1, 0);
    expect(ring.trySleep()).toBe(false);
    expect(ring.claimWake()).toBe(false);
  });

  it("is consistent across two views of the same SharedArrayBuffer", () => {
    const producer = InputRing.create();
    const consumer = new InputRing(producer.buffer);
    producer.push(INPUT.WHEEL, 12.5, 3, 4, 0, -120, 0, 2);
    const got: InputRecord[] = [];
    consumer.drain(rec(), (r) => got.push({ ...r }));
    expect(got).toEqual([{ type: INPUT.WHEEL, t: 12.5, x: 3, y: 4, dx: 0, dy: -120, buttons: 0, mods: 2 }]);
  });
});

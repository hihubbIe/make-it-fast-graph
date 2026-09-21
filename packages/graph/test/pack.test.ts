import { describe, expect, it } from "vitest";
import { packNodeSizes, packRgba, toHalfBits } from "../src/data/Pack";

type F16Ctor = new (n: number) => { [i: number]: number; buffer: ArrayBuffer };

describe("Pack", () => {
  it("toHalfBits matches known binary16 encodings", () => {
    expect(toHalfBits(0)).toBe(0x0000);
    expect(toHalfBits(-0)).toBe(0x8000);
    expect(toHalfBits(1)).toBe(0x3c00);
    expect(toHalfBits(-2)).toBe(0xc000);
    expect(toHalfBits(0.5)).toBe(0x3800);
    expect(toHalfBits(65504)).toBe(0x7bff);
    expect(toHalfBits(1e6)).toBe(0x7c00);
    expect(toHalfBits(2 ** -24)).toBe(0x0001);
    expect(toHalfBits(Infinity)).toBe(0x7c00);
    expect(toHalfBits(NaN) & 0x7c00).toBe(0x7c00);
  });

  it("toHalfBits agrees with native Float16Array", () => {
    const F16 = (globalThis as { Float16Array?: F16Ctor }).Float16Array;
    if (!F16) return;
    const h = new F16(1);
    const bits = new Uint16Array(h.buffer);
    for (const v of [0.1, 3.14159, 1234.5, 7.999, 1e-5, 42]) {
      h[0] = v;
      expect(toHalfBits(v)).toBe(bits[0]);
    }
  });

  it("packNodeSizes puts size in the low half, ring width 0", () => {
    const out = packNodeSizes(new Float32Array([1, 2]), new Uint32Array(2));
    expect(out[0]).toBe(0x3c00);
    expect(out[1]).toBe(0x4000);
  });

  it("packRgba is little-endian rgba8unorm", () => {
    expect(packRgba(1, 0, 0, 1)).toBe(0xff0000ff);
    expect(packRgba(0, 0, 1, 0)).toBe(0x00ff0000);
  });
});

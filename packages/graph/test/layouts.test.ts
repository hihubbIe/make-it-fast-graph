import { describe, expect, it } from "vitest";
import { FRAME, defineStruct } from "../src/data/Layouts";
import { emitLayoutsWgsl } from "../src/data/LayoutsWgsl";
import onDisk from "../src/shaders/common/layouts.wgsl?raw";

describe("Layouts", () => {
  it("Frame matches the §8 byte layout", () => {
    expect(FRAME.size).toBe(104);
    expect(FRAME.align).toBe(8);
    expect(FRAME.offset.originHi).toBe(0);
    expect(FRAME.offset.zoom).toBe(52);
    expect(FRAME.offset.pointerPx).toBe(64);
    expect(FRAME.offset.rasterDim).toBe(72);
    expect(FRAME.offset.flags).toBe(96);
    expect(FRAME.offset.globalEdgeColor).toBe(100);
  });

  it("applies WGSL alignment rules", () => {
    const s = defineStruct("S", [
      { name: "a", type: "f32" },
      { name: "b", type: "vec4<f32>" },
      { name: "c", type: "f32" },
    ] as const);
    expect(s.offset.b).toBe(16);
    expect(s.offset.c).toBe(32);
    expect(s.size).toBe(48);
  });

  it("checked-in layouts.wgsl is up to date (run `npm run gen`)", () => {
    expect(onDisk).toBe(emitLayoutsWgsl());
  });
});

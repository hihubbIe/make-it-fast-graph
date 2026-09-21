import { describe, expect, it } from "vitest";
import { formatDiagnostic, preprocess, ShaderPreprocessError } from "../src/shaders/preprocess/Preprocessor";

const FS = {
  "a.wgsl": ['#include "b.wgsl"', '#include "c.wgsl"', "fn a() {}"].join("\n"),
  "b.wgsl": ['#include "c.wgsl"', "fn b() {}"].join("\n"),
  "c.wgsl": "fn c() {}",
};

describe("Preprocessor", () => {
  it("resolves includes depth-first, each file once", () => {
    expect(preprocess(FS, "a.wgsl").code).toBe("fn c() {}\nfn b() {}\nfn a() {}");
  });

  it("maps output lines back to their origin", () => {
    const out = preprocess(FS, "a.wgsl");
    expect(out.origins).toEqual([
      { file: "c.wgsl", line: 1 },
      { file: "b.wgsl", line: 2 },
      { file: "a.wgsl", line: 3 },
    ]);
    expect(formatDiagnostic(out, { lineNum: 2, linePos: 4, message: "boom", type: "error" })).toBe("error at b.wgsl:2:4: boom");
  });

  it("detects include cycles", () => {
    const fs = { "x.wgsl": '#include "y.wgsl"', "y.wgsl": '#include "x.wgsl"' };
    expect(() => preprocess(fs, "x.wgsl")).toThrow(ShaderPreprocessError);
  });

  it("reports missing includes with the including file", () => {
    expect(() => preprocess({ "x.wgsl": '#include "nope.wgsl"' }, "x.wgsl")).toThrow(/nope\.wgsl.*x\.wgsl/);
  });
});

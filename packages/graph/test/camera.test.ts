import { describe, expect, it } from "vitest";
import { Camera2D } from "../src/camera/Camera2D";

const p = { x: 0, y: 0 };

function make(): Camera2D {
  const c = new Camera2D();
  c.setViewport(800, 600);
  c.setView({ x: 10, y: -5, zoom: 3, rotation: 0.7 });
  return c;
}

describe("Camera2D", () => {
  it("worldToScreen and screenToWorld are inverses", () => {
    const c = make();
    c.worldToScreen(42, 17, p);
    c.screenToWorld(p.x, p.y, p);
    expect(p.x).toBeCloseTo(42, 9);
    expect(p.y).toBeCloseTo(17, 9);
  });

  it("zoomAt keeps the world point under the cursor fixed", () => {
    const c = make();
    c.screenToWorld(123, 456, p);
    const before = { ...p };
    c.zoomAt(2.5, 123, 456);
    c.screenToWorld(123, 456, p);
    expect(p.x).toBeCloseTo(before.x, 9);
    expect(p.y).toBeCloseTo(before.y, 9);
  });

  it("panByScreen moves content with the pointer", () => {
    const c = make();
    c.worldToScreen(0, 0, p);
    const before = { ...p };
    c.panByScreen(30, -20);
    c.worldToScreen(0, 0, p);
    expect(p.x - before.x).toBeCloseTo(30, 9);
    expect(p.y - before.y).toBeCloseTo(-20, 9);
  });

  it("fit frames the bounds inside the padded viewport", () => {
    const c = make();
    c.fit({ minX: -100, minY: -50, maxX: 100, maxY: 50 }, 0);
    expect(c.zoom).toBeCloseTo(4, 9); // min(800 / 200, 600 / 100)
    c.worldToScreen(-100, 0, p);
    expect(p.x).toBeCloseTo(0, 9);
  });
});

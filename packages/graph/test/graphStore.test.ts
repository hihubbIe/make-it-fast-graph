import { describe, expect, it } from "vitest";
import { DEFAULT_NODE_COLOR, GraphStore } from "../src/data/GraphStore";

describe("GraphStore", () => {
  it("bulk set flags node channels for reallocation and computes bounds", () => {
    const s = new GraphStore();
    s.setNodes(3, { positions: new Float32Array([0, 0, 10, -5, -2, 7]) });
    expect(s.channels.nodePos.realloc).toBe(true);
    expect(s.channels.nodeColor.data[2]).toBe(DEFAULT_NODE_COLOR);
    expect(s.bounds).toEqual({ minX: -2, minY: -5, maxX: 10, maxY: 7 });
  });

  it("partial position updates produce dirty ranges, not reallocations", () => {
    const s = new GraphStore();
    s.setNodes(100, {});
    for (const ch of Object.values(s.channels)) ch.realloc = false;
    s.markClean();
    s.updatePositions(10, new Float32Array(10));
    expect(s.dirty).toBe(true);
    expect(s.channels.nodePos.realloc).toBe(false);
    expect(s.channels.nodePos.dirty.start(0)).toBe(10);
    expect(s.channels.nodePos.dirty.end(0)).toBe(15);
  });

  it("rejects updates past the node count", () => {
    const s = new GraphStore();
    s.setNodes(4, {});
    expect(() => s.updatePositions(3, new Float32Array(4))).toThrow(RangeError);
  });
});

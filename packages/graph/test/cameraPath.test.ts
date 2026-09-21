import { describe, expect, it } from "vitest";
import { Camera2D } from "../src/camera/Camera2D";
import { CameraPath } from "../src/camera/CameraPath";
import { CHUNK_BOUNDS, chunkCount, cullScratchWords, drawStride, ENGINE_CONSTANTS, mortonBitsPerAxis } from "../src/data/Layouts";

const bounds = { minX: -100, minY: 0, maxX: 100, maxY: 50 };

describe("CameraPath", () => {
  const keys = [
    { x: 0.5, y: 0.5, zoom: 1 },
    { x: 1, y: 0, zoom: 100 },
  ];

  it("hits the keys exactly at the first and last frame", () => {
    const c = new Camera2D();
    const p = new CameraPath(keys, 11, bounds, 2);
    p.apply(0, c);
    expect([c.x, c.y, c.zoom]).toEqual([0, 25, 2]);
    p.apply(10, c);
    expect(c.x).toBeCloseTo(100, 9);
    expect(c.y).toBeCloseTo(0, 9);
    expect(c.zoom).toBeCloseTo(200, 9);
  });

  it("interpolates zoom geometrically (constant perceived speed)", () => {
    const c = new Camera2D();
    new CameraPath(keys, 3, bounds, 1).apply(1, c);
    expect(c.zoom).toBeCloseTo(10, 9); // midpoint of 1..100 in log space
  });

  it("is frame-indexed: the same frame always yields the same view", () => {
    const a = new Camera2D();
    const b = new Camera2D();
    const p = new CameraPath(keys, 200, bounds, 3);
    p.apply(137, a);
    p.apply(12, b);
    p.apply(137, b);
    expect([b.x, b.y, b.zoom]).toEqual([a.x, a.y, a.zoom]);
  });

  it("clamps past the end and supports a single key", () => {
    const c = new Camera2D();
    new CameraPath([{ x: 0, y: 1, zoom: 4 }], 10, bounds, 1).apply(999, c);
    expect([c.x, c.y, c.zoom]).toEqual([-100, 50, 4]);
  });
});

describe("cull scratch layout", () => {
  it("reserves header, per-(segment, chunk) counts/offsets, totals, chunk list and chunk bounds", () => {
    const n = 1_000_000;
    const c = chunkCount(n);
    const k0 = ENGINE_CONSTANTS;
    const segments = k0.CHUNK_SIZE / k0.DRAW_SEGMENT;
    expect(c).toBe(Math.ceil(n / 1024));
    expect(256 % k0.DRAW_SEGMENT).toBe(0); // segments never span a row of lanes
    const cells = (segments + k0.NUM_BUCKETS - 1) * c;
    expect(cullScratchWords(n)).toBe(k0.SCRATCH_CHUNKS + 2 * cells + Math.ceil(cells / k0.CHUNK_SIZE) + 2 * c + k0.CHUNK_BOUNDS_WORDS * c);
    expect(k0.SCRATCH_DRAW_STRIDE).toBeLessThan(k0.SCRATCH_CHUNKS);
    expect(ENGINE_CONSTANTS.CHUNK_BOUNDS_WORDS * 4).toBe(CHUNK_BOUNDS.size);
    const k = ENGINE_CONSTANTS;
    expect(k.SCRATCH_BUCKET_BASE).toBeGreaterThanOrEqual(k.SCRATCH_DRAW_ARGS + k.NUM_BUCKETS * 4);
    expect(k.SCRATCH_LIST_COUNT).toBeGreaterThanOrEqual(k.SCRATCH_BUCKET_BASE + k.NUM_BUCKETS);
    expect(k.SCRATCH_CHUNKS).toBeGreaterThan(k.SCRATCH_LIST_COUNT);
    expect(k.CHUNK_SIZE).toBe(256 * k.ITEMS_PER_THREAD);
  });
});

describe("LOD prefix sampling", () => {
  const k = ENGINE_CONSTANTS;

  it("keeps a chunk addressable by one workgroup, so the prefix is workgroup-uniform", () => {
    // shuffle_chunks sorts a whole chunk in workgroup memory; cull_count reads a
    // prefix of it with ITEMS_PER_THREAD items per lane. Both rely on this.
    expect(k.CHUNK_SIZE).toBe(256 * k.ITEMS_PER_THREAD);
    expect(k.CHUNK_SIZE % k.DRAW_SEGMENT).toBe(0);
    // Bitonic sort needs a power-of-two span.
    expect(Number.isInteger(Math.log2(k.CHUNK_SIZE))).toBe(true);
  });

  it("conserves ink: a prefix of m stands in for CHUNK_SIZE nodes", () => {
    // lodScale(m) = sqrt(CHUNK_SIZE / m); drawn area must match the full chunk.
    const lodScale = (m: number) => Math.sqrt(k.CHUNK_SIZE / m);
    for (const m of [1, 4, 37, 256, k.CHUNK_SIZE]) {
      const areaDrawn = m * Math.PI * lodScale(m) ** 2;
      const areaFull = k.CHUNK_SIZE * Math.PI * 1 ** 2;
      expect(areaDrawn).toBeCloseTo(areaFull, 6);
    }
    expect(lodScale(k.CHUNK_SIZE)).toBe(1); // drawing everything never rescales
  });
});

describe("Morton key width", () => {
  it("targets ~4 nodes per cell and stays within 16 bits per axis", () => {
    expect(mortonBitsPerAxis(1)).toBe(1);
    expect(mortonBitsPerAxis(1_000_000)).toBe(9); // 512² cells ≈ 3.8 nodes each
    expect(mortonBitsPerAxis(10_000_000)).toBe(11); // 22-bit keys: 6 radix passes
    expect(mortonBitsPerAxis(4e9)).toBe(15);
    expect(mortonBitsPerAxis(1e12)).toBe(16); // capped: keys are 32-bit
  });
});

describe("draw stride", () => {
  it("makes chunk draw positions a bijection with far-apart neighbours", () => {
    for (const chunks of [1, 2, 3, 10, 98, 977, 7919, 9766, 65535]) {
      const stride = drawStride(chunks);
      const posToChunk = new Int32Array(chunks).fill(-1);
      for (let c = 0; c < chunks; c++) {
        const p = (c * stride) % chunks;
        expect(posToChunk[p]).toBe(-1);
        posToChunk[p] = c;
      }
      if (chunks < 10) continue;
      // consecutive draw positions are chunks ≥ C/4 apart (golden step: ~0.38·C circular distance)
      const d = Math.abs(posToChunk[1]! - posToChunk[0]!);
      expect(Math.min(d, chunks - d)).toBeGreaterThanOrEqual(chunks * 0.25);
      expect((chunks - 1) * stride).toBeLessThan(2 ** 32);
    }
  });
});

/**
 * CPU reference implementations of engine results, used as test oracles.
 * They mirror the engine's rules exactly (see shaders/common/nodes.wgsl and
 * transform_cull.wgsl); any GPU/CPU mismatch is a bug in one of the two.
 */
import type { NodeDataset } from "./datasets";

export interface ReferenceView {
  /** Camera centre, world units. */
  x: number;
  y: number;
  /** Device px per world unit. */
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
  nodeScale?: number;
}

// Must match shaders/common/nodes.wgsl.
const NODE_AA_PAD_PX = 1.0;
const NODE_MIN_DRAW_RADIUS_PX = 0.5;
const NODE_MIN_VISIBLE_RADIUS_PX = 0.0224;

type F16Ctor = new (src: ArrayLike<number>) => ArrayLike<number>;
const Float16 = (globalThis as { Float16Array?: F16Ctor }).Float16Array;

/** Sizes as the GPU sees them (stored as f16). */
export function sizesAsF16(sizes: Float32Array): ArrayLike<number> {
  return Float16 ? new Float16(sizes) : sizes;
}

/**
 * Number of nodes the engine should draw for `view` (rotation 0, no hidden or
 * foreground state). `sizes` should come from `sizesAsF16` for exact parity.
 */
export function cpuVisibleCount(data: NodeDataset, view: ReferenceView, sizes: ArrayLike<number> = sizesAsF16(data.sizes)): number {
  const { x, y, zoom, viewportWidth: w, viewportHeight: h } = view;
  const scale = view.nodeScale ?? 1;
  const p = data.positions;
  let n = 0;
  for (let i = 0; i < data.count; i++) {
    const r = sizes[i]! * scale * zoom * 0.5;
    if (r < NODE_MIN_VISIBLE_RADIUS_PX) continue;
    const sx = (p[2 * i]! - x) * zoom + w / 2;
    const sy = (p[2 * i + 1]! - y) * zoom + h / 2;
    const m = Math.max(r, NODE_MIN_DRAW_RADIUS_PX) + NODE_AA_PAD_PX;
    if (sx < -m || sy < -m || sx > w + m || sy > h + m) continue;
    n++;
  }
  return n;
}

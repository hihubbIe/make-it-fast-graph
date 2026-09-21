// Edge sizing rules shared by the edge cull and EDGE_GEOMETRY, so a chunk is
// culled by exactly the footprint its edges are drawn with.
#include "common/layouts.wgsl"
#include "common/camera.wgsl"

/** Screen-space room for the 1 px anti-aliasing ramp. */
const EDGE_AA_PAD_PX : f32 = 1.0;
/** Thinner edges are drawn this wide with alpha scaled down: they fade instead of shimmering. */
const EDGE_MIN_DRAW_WIDTH_PX : f32 = 1.0;
/**
 * An edge this short on screen or shorter, in CSS px, is not drawn (engine
 * option `edgeMinLengthPx`): too small to read as a line. 0 draws every edge
 * with any length.
 */
override EDGE_MIN_LEN_PX : f32 = 6.0;
/** Diagnostic colouring (engine option `edgeDebug`): 0 off, 1 length, 2 thinning, 3 chunk. */
override EDGE_DEBUG : u32 = 0u;
/** Arrowhead length and half-width as multiples of the edge width. */
const ARROW_LEN_MUL : f32 = 4.0;
const ARROW_HALF_MUL : f32 = 2.0;
/**
 * An arrowhead is never shorter than this, in CSS px, or it vanishes on thin
 * edges and next to large nodes.
 */
const ARROW_MIN_LEN_CSS_PX : f32 = 10.0;

/** Width from a style word; 0 in its width byte means the global width. */
fn edgeWidthPx(style : u32) -> f32 {
  let packed = f32(style & EDGE_WIDTH_MASK) / f32(EDGE_WIDTH_SCALE);
  return select(packed, frame.globalEdgeWidth, packed == 0.0);
}

/** Arrowhead length in device px for an edge this wide, before the cap at half the edge. */
fn arrowLenPx(widthPx : f32) -> f32 {
  return max(widthPx * ARROW_LEN_MUL, ARROW_MIN_LEN_CSS_PX * frame.pixelRatio);
}

/** Farthest an edge of this width draws from its centreline, arrowhead and AA ramp included. */
fn edgeReachPx(widthPx : f32, arrows : bool) -> f32 {
  let half = max(widthPx, EDGE_MIN_DRAW_WIDTH_PX) * 0.5;
  return select(half, max(half, arrowLenPx(widthPx)), arrows) + EDGE_AA_PAD_PX;
}

/**
 * Alpha factor from on-screen length in device px: 0 up to the minimum, 1 from
 * 1.5x it. A short fade, so an edge that is drawn at all is clearly visible,
 * yet it still eases in rather than popping. The minimum is in CSS px so it
 * means the same on every display.
 */
fn edgeLengthFade(lenPx : f32) -> f32 {
  let minPx = max(EDGE_MIN_LEN_PX * frame.pixelRatio, 1e-6);
  return clamp((lenPx / minPx - 1.0) * 2.0, 0.0, 1.0);
}

// ---- thinning ---------------------------------------------------------------

/**
 * How many times over one length level may cover a pixel before its edges are
 * thinned (engine option `edgeMaxOverdraw`). 0 draws every edge.
 */
override EDGE_MAX_OVERDRAW : f32 = 6.0;

/**
 * How many of a chunk's `n` edges to draw, as a real number. The chunk is
 * shuffled, so any prefix of it is a random sample of it.
 *
 * `density` is edge length per area where the chunk's length level lies, so
 * `density · width / zoom` is how many times that level covers each pixel.
 * It falls as the camera zooms in, so the kept count only GROWS on zoom-in:
 * edges appear, they never vanish. The fractional part fades the next edge in.
 */
fn edgeKeep(n : u32, density : f32, widthPx : f32) -> f32 {
  let all = f32(n);
  if (EDGE_MAX_OVERDRAW <= 0.0) {
    return all;
  }
  let overdraw = density * max(widthPx, EDGE_MIN_DRAW_WIDTH_PX) / frame.zoom;
  return clamp(all * EDGE_MAX_OVERDRAW / max(overdraw, 1e-30), 1.0, all);
}

/**
 * Opacity of one drawn edge standing in for `weight` identical ones: exactly
 * what `weight` layers of alpha `a` composite to, so a thinned area keeps its
 * look and saturates the way the full set would.
 */
fn edgeStandInAlpha(a : f32, weight : f32) -> f32 {
  return 1.0 - pow(1.0 - clamp(a, 0.0, 1.0), weight);
}

// ---- edge state buffer layout (EDGE_CONSTANTS in Layouts.ts) ----------------

fn numEdgeChunks() -> u32 {
  return (frame.edgeCount + EDGE_CHUNK_SIZE - 1u) >> EDGE_CHUNK_SHIFT;
}

/** Edges in chunk `c`: EDGE_CHUNK_SIZE, except in the last chunk. */
fn edgeChunkLen(c : u32) -> u32 {
  return min(EDGE_CHUNK_SIZE, frame.edgeCount - c * EDGE_CHUNK_SIZE);
}

fn edgeOffsetsAt(chunks : u32) -> u32 {
  return EDGE_SCRATCH_LIST + chunks;
}

fn edgeChunkAt(c : u32, chunks : u32) -> u32 {
  return EDGE_SCRATCH_LIST + 2u * chunks + 1u + c * EDGE_CHUNK_WORDS;
}

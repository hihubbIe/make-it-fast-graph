// EDGE_GEOMETRY: one instanced quad per edge in the draw list EDGE_CULL
// wrote, oriented along the segment, with an analytic distance field for the
// anti-aliased line, round caps and the arrowhead.
//
// A thinned chunk draws a prefix of its (shuffled) edges; each one carries the
// opacity of the edges it stands for, and the last one fades in with the
// prefix, so thinning neither dims an area nor pops while zooming. Edges too
// short to see collapse to a point and rasterize nothing.
#include "common/nodes.wgsl"
#include "common/edges.wgsl"

@group(2) @binding(0) var<storage, read> edgeScratch : array<u32>;
@group(2) @binding(1) var<storage, read> edgeList : array<u32>;

// Arrowheads need a wider quad, so every edge pays for them in fill: compiled
// out unless the graph is directed. When every edge shares a width or a colour,
// the per-edge reads are compiled out too and the default edge touches only
// its endpoints.
override EDGE_ARROWS : bool = false;
override EDGE_PER_EDGE_STYLE : bool = false;
override EDGE_PER_EDGE_COLOR : bool = false;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  /** Segment-local px: x along the centreline (0 at the midpoint), y across. */
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) halfLen : f32,
  @location(2) @interpolate(flat) halfWidth : f32,
  /** Straight alpha, already scaled by coverage, length fade and thinning. Interpolated = gradient. */
  @location(3) color : vec4<f32>,
  /** Arrowhead length in px; 0 when this edge has none. */
  @location(4) @interpolate(flat) arrowLen : f32,
}

/** All four corners on one point outside clip space: zero area, no fragments. */
fn culled() -> VOut {
  var o : VOut;
  o.pos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
  return o;
}

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VOut {
  let e = edgeList[ii];
  let ij = edgeIdx[e];
  let a = worldToScreen(nodePos[ij.x]);
  var b = worldToScreen(nodePos[ij.y]);
  let full = b - a;
  let fullLen = length(full);
  let fade = edgeLengthFade(fullLen);
  if (fade <= 0.0 && EDGE_DEBUG != 1u) {
    return culled();
  }

  var style = 0u;
  if (EDGE_PER_EDGE_STYLE) {
    style = edgeStyle[e];
  }
  let w = edgeWidthPx(style);
  let wDraw = max(w, EDGE_MIN_DRAW_WIDTH_PX);
  // Equal ink: a half-width edge keeps half the alpha rather than disappearing.
  let coverage = min(1.0, w / wDraw);
  let halfWidth = wDraw * 0.5;

  var arrowLen = 0.0;
  if (EDGE_ARROWS && (style & EDGE_FLAG_DIRECTED) != 0u) {
    arrowLen = arrowLenPx(w);
    // Stop at the target's silhouette so the arrowhead touches the node.
    b = b - full / fullLen * min(nodeRadiusPx(ij.y), fullLen * 0.5);
  }

  let d = b - a;
  let len = max(length(d), 1e-4);
  // Never more arrow than half the visible edge: a short edge stays a line.
  arrowLen = min(arrowLen, len * 0.5);
  let dir = d / len;
  let nor = vec2<f32>(-dir.y, dir.x);
  let mid = (a + b) * 0.5;
  let halfLen = len * 0.5;
  let extX = halfLen + max(halfWidth, arrowLen) + EDGE_AA_PAD_PX;
  let extY = max(halfWidth, arrowLen * ARROW_HALF_MUL / ARROW_LEN_MUL) + EDGE_AA_PAD_PX;

  // Triangle strip corners: (-1,-1) (1,-1) (-1,1) (1,1)
  let corner = vec2<f32>(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
  let sp = mid + dir * (corner.x * extX) + nor * (corner.y * extY);

  // Gradient: the corner's end selects the endpoint colour, the rasterizer
  // interpolates between them along the segment.
  var c = unpack4x8unorm(frame.globalEdgeColor);
  if (EDGE_PER_EDGE_COLOR) {
    c = unpack4x8unorm(edgeColor[e * 2u + select(0u, 1u, corner.x > 0.0)]);
  }

  // Thinning: the same keep count EDGE_CULL computed for this chunk.
  let chunk = e >> EDGE_CHUNK_SHIFT;
  let rec = edgeChunkAt(chunk, numEdgeChunks());
  let n = edgeChunkLen(chunk);
  let width = max(bitcast<f32>(edgeScratch[rec + 5u]), frame.globalEdgeWidth);
  let keep = edgeKeep(n, bitcast<f32>(edgeScratch[rec + 6u]), width);
  let fadeIn = clamp(keep - f32(e & (EDGE_CHUNK_SIZE - 1u)), 0.0, 1.0);

  var o : VOut;
  o.pos = vec4<f32>(screenToClip(sp), 0.0, 1.0);
  o.uv = vec2<f32>(corner.x * extX, corner.y * extY);
  o.halfLen = halfLen;
  o.halfWidth = halfWidth;
  o.color = vec4<f32>(c.rgb, edgeStandInAlpha(c.a * coverage * fade, f32(n) / keep) * fadeIn);
  if (EDGE_DEBUG != 0u) {
    o.color = vec4<f32>(debugColor(fade, keep / f32(n), chunk), 0.9 * fadeIn);
  }
  o.arrowLen = arrowLen;
  return o;
}

/** The engine option `edgeDebug`: what the cull decided, as colour. */
fn debugColor(fade : f32, kept : f32, chunk : u32) -> vec3<f32> {
  switch (EDGE_DEBUG) {
    case 1u: {
      // Length: red = too short (hidden outside this view), orange = fading in, green = full.
      if (fade <= 0.0) {
        return vec3<f32>(1.0, 0.15, 0.15);
      }
      return select(vec3<f32>(0.2, 0.9, 0.3), vec3<f32>(1.0, 0.6, 0.1), fade < 1.0);
    }
    case 2u: {
      // Thinning, on a log scale: blue = all of the chunk drawn, red = 1 in 1024.
      let t = clamp(1.0 + log2(kept) / 10.0, 0.0, 1.0);
      return mix(vec3<f32>(1.0, 0.15, 0.15), vec3<f32>(0.3, 0.6, 1.0), t);
    }
    default: {
      // Chunk: a stable hue per chunk of 1024 edges.
      let h = f32((chunk * 2654435761u) >> 22u) / 1024.0;
      return 0.5 + 0.5 * cos(6.2831853 * (h + vec3<f32>(0.0, 0.33, 0.67)));
    }
  }
}

/** Distance to a capsule of half-length `halfLen` and radius `halfWidth`. */
fn sdSegment(p : vec2<f32>, halfLen : f32, halfWidth : f32) -> f32 {
  let q = vec2<f32>(max(abs(p.x) - halfLen, 0.0), p.y);
  return length(q) - halfWidth;
}

/**
 * Isosceles arrowhead with its tip at (tipX, 0), opening backwards along -x:
 * the intersection of its two slanted sides and its base. Exact outside the
 * dominant plane, slightly conservative at the corners, which a 1 px coverage
 * ramp hides, and much cheaper than an exact triangle.
 */
fn sdArrowhead(p : vec2<f32>, tipX : f32, len : f32, half : f32) -> f32 {
  let q = vec2<f32>(p.x - tipX, abs(p.y));
  let slant = dot(q, vec2<f32>(half, len)) * inverseSqrt(half * half + len * len);
  return max(slant, -(q.x + len));
}

@fragment
fn fs(in : VOut) -> @location(0) vec4<f32> {
  var d = sdSegment(in.uv, in.halfLen, in.halfWidth);
  if (EDGE_ARROWS && in.arrowLen > 0.0) {
    let half = in.arrowLen * ARROW_HALF_MUL / ARROW_LEN_MUL;
    d = min(d, sdArrowhead(in.uv, in.halfLen, in.arrowLen, half));
  }
  // Analytic 1 px coverage ramp across the silhouette.
  let a = in.color.a * clamp(0.5 - d, 0.0, 1.0);
  if (a < 0.002) {
    discard;
  }
  return vec4<f32>(in.color.rgb * a, a); // premultiplied
}

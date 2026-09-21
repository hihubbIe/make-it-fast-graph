// EDGE_SORT phase 0: one thread per edge, in the order the user gave them.
// Maps both endpoints to ENGINE node indices and builds the edge's sort key:
//
//   key = level << levelShift | morton(midpoint)
//
// `level` is the octave of the edge's length relative to the graph (0 =
// shortest, `levels - 1` = longer than half the graph). Sorting by it first
// puts edges of similar length in the same chunk, so a chunk's longest edge
// describes all of them (the sub-pixel test), and one long edge never
// stretches a chunk of short ones across the graph (the viewport test). Within
// a level, the Z-order of the midpoint keeps each chunk in one place.
//
// Standalone module: its own bindings, no engine groups. Runs on data changes only.
#include "common/morton.wgsl"

struct EdgeKeyParams {
  n : u32,
  nodeCount : u32,
  bitsPerAxis : u32,
  levels : u32,
  origin : vec2<f32>,
  invExtent : vec2<f32>,
  /** 1 / max(width, height) of the node bounds: lengths as a share of the graph. */
  invSize : f32,
  gridX : u32,
}

@group(0) @binding(0) var<uniform> params : EdgeKeyParams;
@group(0) @binding(1) var<storage, read> edgeUser : array<vec2<u32>>; // user node indices
@group(0) @binding(2) var<storage, read> rank : array<u32>; // rank[user] = engine
@group(0) @binding(3) var<storage, read> positions : array<vec2<f32>>; // engine order
@group(0) @binding(4) var<storage, read_write> keys : array<u32>;
@group(0) @binding(5) var<storage, read_write> vals : array<u32>;
@group(0) @binding(6) var<storage, read_write> mapped : array<vec2<u32>>; // engine indices, user order

const WG : u32 = 256u;

@compute @workgroup_size(WG)
fn edge_keys(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x + gid.y * params.gridX * WG;
  if (i >= params.n) {
    return;
  }
  let last = params.nodeCount - 1u;
  let u = edgeUser[i];
  let ij = vec2<u32>(rank[min(u.x, last)], rank[min(u.y, last)]);
  mapped[i] = ij;

  let pa = positions[ij.x];
  let pb = positions[ij.y];
  let rel = max(distance(pa, pb) * params.invSize, 1e-30);
  let level = u32(clamp(i32(floor(log2(rel))) + i32(params.levels), 0, i32(params.levels) - 1));

  let maxQ = f32((1u << params.bitsPerAxis) - 1u);
  let mid = (pa + pb) * 0.5;
  let q = vec2<u32>(clamp((mid - params.origin) * params.invExtent, vec2<f32>(0.0), vec2<f32>(1.0)) * maxQ);
  keys[i] = (level << (2u * params.bitsPerAxis)) | spread16(q.x) | (spread16(q.y) << 1u);
  vals[i] = i;
}

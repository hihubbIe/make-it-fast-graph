// EDGE_CULL: decide per CHUNK of EDGE_CHUNK_SIZE sorted, shuffled edges,
// never per edge.
//
//   edge_bounds  1 workgroup / chunk (data changes only): world box, longest
//                edge, widest styled edge and density of the chunk
//   edge_cull    1 workgroup, every frame: for each chunk that is on screen and
//                not entirely sub-pixel, how many of its edges to draw (a prefix,
//                see edgeKeep) and where they go in the draw list
//
// edge_expand.wgsl then writes the draw list; per-frame work here is one small
// record per chunk.
#include "common/edges.wgsl"
#include "common/scan.wgsl"

@group(2) @binding(0) var<storage, read_write> edgeScratch : array<u32>;

/** Arrowheads reach past the edge's width; the margin has to cover them. */
override EDGE_ARROWS : bool = false;

const BIG : f32 = 3.0e38;

fn loadEdgeChunk(c : u32, chunks : u32) -> EdgeChunk {
  let o = edgeChunkAt(c, chunks);
  return EdgeChunk(
    vec2<f32>(bitcast<f32>(edgeScratch[o]), bitcast<f32>(edgeScratch[o + 1u])),
    vec2<f32>(bitcast<f32>(edgeScratch[o + 2u]), bitcast<f32>(edgeScratch[o + 3u])),
    bitcast<f32>(edgeScratch[o + 4u]),
    bitcast<f32>(edgeScratch[o + 5u]),
    bitcast<f32>(edgeScratch[o + 6u]),
    0.0,
  );
}

fn storeEdgeChunk(c : u32, chunks : u32, v : EdgeChunk) {
  let o = edgeChunkAt(c, chunks);
  edgeScratch[o] = bitcast<u32>(v.lo.x);
  edgeScratch[o + 1u] = bitcast<u32>(v.lo.y);
  edgeScratch[o + 2u] = bitcast<u32>(v.hi.x);
  edgeScratch[o + 3u] = bitcast<u32>(v.hi.y);
  edgeScratch[o + 4u] = bitcast<u32>(v.maxLen);
  edgeScratch[o + 5u] = bitcast<u32>(v.maxWidthPx);
  edgeScratch[o + 6u] = bitcast<u32>(v.density);
}

// ---- bounds -----------------------------------------------------------------

/** (endpoint lo, endpoint hi) */
var<workgroup> wgBox : array<vec4<f32>, WORKGROUP_SIZE>;
/** (midpoint lo, midpoint hi) */
var<workgroup> wgMid : array<vec4<f32>, WORKGROUP_SIZE>;
/** (longest edge, widest style, total length, -) */
var<workgroup> wgLen : array<vec4<f32>, WORKGROUP_SIZE>;

@compute @workgroup_size(WORKGROUP_SIZE)
fn edge_bounds(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let chunks = numEdgeChunks();
  let c = wid.x + wid.y * nwg.x;
  if (c >= chunks) {
    return; // uniform per workgroup
  }
  // Without per-edge styles the style buffer is a 16-byte placeholder of
  // zeros (= global width), so reading inside its length is always right.
  let styles = arrayLength(&edgeStyle);
  var box = vec4<f32>(vec2<f32>(BIG), vec2<f32>(-BIG));
  var mid = box;
  var len = vec4<f32>(0.0);
  for (var k = 0u; k < ITEMS_PER_THREAD; k++) {
    let e = c * EDGE_CHUNK_SIZE + k * WORKGROUP_SIZE + lid;
    if (e < frame.edgeCount) {
      let ij = edgeIdx[e];
      let pa = nodePos[ij.x];
      let pb = nodePos[ij.y];
      let m = (pa + pb) * 0.5;
      box = vec4<f32>(min(box.xy, min(pa, pb)), max(box.zw, max(pa, pb)));
      mid = vec4<f32>(min(mid.xy, m), max(mid.zw, m));
      let style = select(0u, edgeStyle[e], e < styles);
      let d = distance(pa, pb);
      len = vec4<f32>(max(len.x, d), max(len.y, f32(style & EDGE_WIDTH_MASK) / f32(EDGE_WIDTH_SCALE)), len.z + d, 0.0);
    }
  }
  wgBox[lid] = box;
  wgMid[lid] = mid;
  wgLen[lid] = len;
  workgroupBarrier();
  for (var s = WORKGROUP_SIZE / 2u; s > 0u; s = s >> 1u) {
    if (lid < s) {
      let b = wgBox[lid + s];
      let m = wgMid[lid + s];
      let l = wgLen[lid + s];
      wgBox[lid] = vec4<f32>(min(wgBox[lid].xy, b.xy), max(wgBox[lid].zw, b.zw));
      wgMid[lid] = vec4<f32>(min(wgMid[lid].xy, m.xy), max(wgMid[lid].zw, m.zw));
      wgLen[lid] = vec4<f32>(max(wgLen[lid].xy, l.xy), wgLen[lid].z + l.z, 0.0);
    }
    workgroupBarrier();
  }
  if (lid == 0u) {
    // Density of the chunk's length level where it lies: its total length over
    // the area its MIDPOINTS span. Chunks of one level tile that level's
    // midpoints, so this sees the pile-up of the neighbouring chunks too —
    // which the chunk's own endpoint box, stretched by the edges' length,
    // would not. A thin midpoint box (edges along a line) is widened to the
    // spacing along it, so it cannot read as infinitely dense.
    let span = wgMid[0].zw - wgMid[0].xy;
    let pad = max(span.x, span.y) / sqrt(f32(edgeChunkLen(c)));
    let area = max((span.x + pad) * (span.y + pad), 1e-30);
    storeEdgeChunk(c, chunks, EdgeChunk(wgBox[0].xy, wgBox[0].zw, wgLen[0].x, wgLen[0].y, wgLen[0].z / area, 0.0));
  }
}

// ---- cull -------------------------------------------------------------------

/** Edges of chunk `c` to draw this frame: 0 if none can put a pixel on screen. */
fn edgeChunkDraw(c : u32, chunks : u32) -> u32 {
  let r = loadEdgeChunk(c, chunks);
  // Every edge of the chunk is at most this long on screen: all too short.
  // (The length debug view draws them anyway, in red.)
  if (edgeLengthFade(r.maxLen * frame.zoom) <= 0.0 && EDGE_DEBUG != 1u) {
    return 0u;
  }
  // Screen box of the (possibly rotated) world box, grown by what the widest
  // edge draws beyond its centreline.
  let width = max(r.maxWidthPx, frame.globalEdgeWidth);
  let p0 = worldToScreen(r.lo);
  let p1 = worldToScreen(vec2<f32>(r.hi.x, r.lo.y));
  let p2 = worldToScreen(vec2<f32>(r.lo.x, r.hi.y));
  let p3 = worldToScreen(r.hi);
  let m = edgeReachPx(width, EDGE_ARROWS);
  let lo = min(min(p0, p1), min(p2, p3)) - m;
  let hi = max(max(p0, p1), max(p2, p3)) + m;
  if (hi.x < 0.0 || hi.y < 0.0 || lo.x > frame.viewportPx.x || lo.y > frame.viewportPx.y) {
    return 0u;
  }
  return u32(ceil(edgeKeep(edgeChunkLen(c), r.density, width)));
}

/**
 * Deliberately ONE workgroup: the work is a few thousand 32-byte records
 * (30M edges = 29,297 chunks, ~115 per lane), and one workgroup lists the
 * chunks in chunk order with no atomics, so draw order is the same every frame
 * and overlapping edges never swap.
 */
@compute @workgroup_size(WORKGROUP_SIZE)
fn edge_cull(@builtin(local_invocation_index) lid : u32) {
  let chunks = numEdgeChunks();
  let per = (chunks + WORKGROUP_SIZE - 1u) / WORKGROUP_SIZE;
  let c0 = min(lid * per, chunks);
  let c1 = min(c0 + per, chunks);

  var listed = 0u;
  var drawn = 0u;
  for (var c = c0; c < c1; c++) {
    let n = edgeChunkDraw(c, chunks);
    listed += select(0u, 1u, n > 0u);
    drawn += n;
  }
  let sl = wgScanU32(listed, lid);
  let sd = wgScanU32(drawn, lid);
  var slot = sl.exclusive;
  var offset = sd.exclusive;
  for (var c = c0; c < c1; c++) {
    let n = edgeChunkDraw(c, chunks);
    if (n > 0u) {
      edgeScratch[EDGE_SCRATCH_LIST + slot] = c;
      edgeScratch[edgeOffsetsAt(chunks) + slot] = offset;
      slot += 1u;
      offset += n;
    }
  }

  if (lid == 0u) {
    edgeScratch[edgeOffsetsAt(chunks) + sl.total] = sd.total; // end of the last listed chunk
    let a = EDGE_SCRATCH_DRAW_ARGS;
    edgeScratch[a] = 4u; // vertexCount: one triangle-strip quad
    edgeScratch[a + 1u] = sd.total; // instanceCount: one per drawn edge
    edgeScratch[a + 2u] = 0u; // firstVertex
    edgeScratch[a + 3u] = 0u; // firstInstance
    let d = EDGE_SCRATCH_DISPATCH;
    edgeScratch[d] = min(sl.total, 65535u);
    edgeScratch[d + 1u] = max(1u, (sl.total + 65534u) / 65535u);
    edgeScratch[d + 2u] = 1u;
    // Edge label candidates: one thread per drawn edge (label_edges.wgsl).
    let groups = (sd.total + WORKGROUP_SIZE - 1u) / WORKGROUP_SIZE;
    let l = EDGE_SCRATCH_LABEL_DISPATCH;
    edgeScratch[l] = min(groups, 65535u);
    edgeScratch[l + 1u] = max(1u, (groups + 65534u) / 65535u);
    edgeScratch[l + 2u] = 1u;
    edgeScratch[EDGE_SCRATCH_LIST_COUNT] = sl.total;
  }
}

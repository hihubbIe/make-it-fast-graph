// TRANSFORM_CULL (§9.1): project, cull, bucket and compact visible nodes into
// NodeInstance records. Node buffers are in engine (Morton) order, so a chunk
// of CHUNK_SIZE consecutive nodes is spatially compact.
//
//   cull_count    1 workgroup / chunk  : chunk-bounds test (one 24 B read rejects
//                                        1024 nodes), else classify, count per cell
//   scan_reduce   1 workgroup / block  : sum of SCAN_BLOCK cells
//   scan_blocks   1 workgroup          : scan block sums; draw args + bucket bases;
//                                        deterministic list of non-empty chunks + dispatch args
//   scan_down     1 workgroup / block  : cell offsets = block prefix + in-block scan
//   cull_scatter  1 workgroup / listed chunk (indirect): re-classify, rank, write
//
// BUCKET_NORMAL draw order is (segment, scrambled chunk, engine index): each
// node's place depends only on its own index, so it is stable frame to frame
// (overlapping nodes never swap), while consecutive draws jump between far-apart
// chunks every DRAW_SEGMENT nodes (see cull_state.wgsl, docs/decisions.md).
// Other buckets keep chunk order: FOREGROUND is small, TINY is order-independent.
// Each phase has its own pipeline layout: the indirect dispatch args buffer
// must not be bound in the dispatch that consumes it (WebGPU usage-scope rule).
#include "common/nodes.wgsl"
#include "common/scan.wgsl"
#include "common/cull_state.wgsl"
#include "common/labels.wgsl"

@group(2) @binding(2) var<storage, read_write> dispatchArgs : array<u32>; // scan_blocks
@group(2) @binding(3) var<storage, read_write> instances : array<NodeInstance>; // cull_scatter
@group(2) @binding(4) var<storage, read_write> labelNodes : LabelCandidates; // label_nodes
@group(2) @binding(5) var<uniform> labelParams : LabelParams; // label_nodes

var<workgroup> wgFlag : u32;
var<workgroup> wgCells : array<atomic<u32>, CELLS_PER_CHUNK>;
var<workgroup> wgTotal : atomic<u32>;
var<workgroup> wgRun : array<u32, NUM_BUCKETS>;
var<workgroup> wgLevel : u32;

fn nodeIndex(chunk : u32, k : u32, lid : u32) -> u32 {
  return chunk * CHUNK_SIZE + k * WORKGROUP_SIZE + lid;
}

// Cheapest rejections first: state (4 B), size (4 B), then position (8 B).
// Must stay identical between cull_count and cull_scatter: counts and slots
// are derived from it independently.
fn classify(i : u32, scale : f32) -> u32 {
  if (i >= frame.nodeCount) {
    return BUCKET_CULLED;
  }
  let state = nodeState[i];
  if ((state & STATE_HIDDEN) != 0u) {
    return BUCKET_CULLED;
  }
  // Foreground nodes are never culled: halos and hover effects may reach on screen.
  if ((state & STATE_FOREGROUND_MASK) != 0u) {
    return BUCKET_FOREGROUND;
  }
  let r = nodeRadiusPx(i) * scale;
  if (r < NODE_MIN_VISIBLE_RADIUS_PX) {
    return BUCKET_CULLED;
  }
  let sp = worldToScreen(nodePos[i]);
  let m = max(r, NODE_MIN_DRAW_RADIUS_PX) + NODE_AA_PAD_PX;
  if (sp.x < -m || sp.y < -m || sp.x > frame.viewportPx.x + m || sp.y > frame.viewportPx.y + m) {
    return BUCKET_CULLED;
  }
  // TINY joins NORMAL until the compute rasterizer takes it (M4).
  return BUCKET_NORMAL;
}

// ---- LOD --------------------------------------------------------------------
// Engine order is shuffled within each chunk (shuffle_chunks.wgsl), so the
// first nodes of a chunk are a uniform RANDOM sample of it. LOD is therefore
// just a prefix length: no cluster records, no synthetic positions, no
// averaged colours, and every drawn dot is a real node.
//
// The length is a real number and nothing about it switches: the count and the
// survivors' size follow the zoom continuously, and the node at the end of the
// prefix fades in by the fractional part, so zooming never pops a node or a
// whole chunk.
//
// One representative per equal-count cell was tried first and is a jittered
// lattice by construction — 7x the reference 2-D autocorrelation peak, visible
// as a woven texture. Random sampling of a point process reproduces the parent
// process, so it has no structure at all.
//
// The choice is workgroup-uniform, and cull_count and cull_scatter derive it
// independently from the same chunk bounds.

/** How many of a chunk's CHUNK_SIZE nodes to draw, as a real number in [1, CHUNK_SIZE]. */
fn lodCount(cb : ChunkBounds) -> f32 {
  let all = f32(CHUNK_SIZE);
  // LOD off, or foreground nodes, which are never sampled away.
  if (LOD_TARGET_PX <= 0.0 || (cb.flags & CHUNK_FLAG_FOREGROUND) != 0u) {
    return all;
  }
  // Equivalent square side, NOT max(dx, dy). Chunks are arbitrary runs of
  // CHUNK_SIZE nodes, so their boxes are often elongated and the max dimension
  // swings ~2x between neighbours at equal density — and m squares it, so the
  // sample count swung 4x and the compensated dot size 2x. That difference
  // between adjacent chunks is what made chunk seams visible.
  let ext = sqrt(max(cb.hi.x - cb.lo.x, 0.0) * max(cb.hi.y - cb.lo.y, 0.0)) * frame.zoom;
  if (ext <= 0.0) {
    return all;
  }
  // m nodes spread over ext px sit about ext/sqrt(m) apart; keep that >= target.
  let m = (ext / LOD_TARGET_PX) * (ext / LOD_TARGET_PX);
  // Once nodes are as wide as the spacing we sample TO, they tile the region
  // and a dropped one leaves a hole its neighbours cannot fill: blend back to
  // every node as their width grows from half that spacing to all of it. Size
  // is the test, not separation: sub-pixel nodes are always far apart, so a
  // separation test would keep every node exactly where sampling matters most.
  let maxR = cb.maxSize * frame.globalNodeScale * frame.zoom * 0.5;
  let wide = smoothstep(0.5, 1.0, 2.0 * maxR / LOD_TARGET_PX);
  return clamp(mix(m, all, wide), 1.0, all);
}

/**
 * Each survivor stands in for CHUNK_SIZE / count nodes. Equal total area means
 * radius * sqrt(that ratio), the same ink conservation as the sub-pixel fade,
 * which keeps zoomed-out density unchanged.
 */
fn lodScale(count : f32) -> f32 {
  return sqrt(f32(CHUNK_SIZE) / count);
}

/** The node at prefix position `t` fades in with the fractional part of `count`. */
fn lodFade(color : u32, count : f32, t : u32) -> u32 {
  let fade = clamp(count - f32(t), 0.0, 1.0);
  if (fade >= 1.0) {
    return color;
  }
  let c = unpack4x8unorm(color);
  return pack4x8unorm(vec4<f32>(c.rgb, c.a * fade));
}

// Capping the compensated radius at the sample spacing was measured TWICE and
// rejected both times: it helps large (1.97 -> 1.55 ms) but costs deep-zoom
// (2.49 -> 2.95) and large-zoom (2.85 -> 3.70).

// Conservative: can any node of the chunk produce a visible pixel?
fn chunkMayBeVisible(c : u32, chunks : u32) -> bool {
  let cb = loadChunkBounds(c, chunks);
  if ((cb.flags & CHUNK_FLAG_FOREGROUND) != 0u) {
    return true;
  }
  let maxR = cb.maxSize * frame.globalNodeScale * frame.zoom * 0.5;
  if (maxR < NODE_MIN_VISIBLE_RADIUS_PX) {
    return false; // also rejects empty chunks (maxSize = 0)
  }
  // Screen AABB of the (possibly rotated) world box.
  let p0 = worldToScreen(cb.lo);
  let p1 = worldToScreen(vec2<f32>(cb.hi.x, cb.lo.y));
  let p2 = worldToScreen(vec2<f32>(cb.lo.x, cb.hi.y));
  let p3 = worldToScreen(cb.hi);
  let lo = min(min(p0, p1), min(p2, p3));
  let hi = max(max(p0, p1), max(p2, p3));
  let m = max(maxR, NODE_MIN_DRAW_RADIUS_PX) + NODE_AA_PAD_PX;
  return !(hi.x < -m || hi.y < -m || lo.x > frame.viewportPx.x + m || lo.y > frame.viewportPx.y + m);
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn cull_count(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let chunks = numChunks();
  let c = wid.x + wid.y * nwg.x;
  if (c >= chunks) {
    return; // uniform per workgroup
  }
  // Visibility and prefix length travel in one workgroup word: 0 = rejected,
  // otherwise the bits of the (>= 1) real count. One workgroupUniformLoad, and
  // no workgroup variable is written before a barrier loop and read after it.
  if (lid == 0u) {
    let cb = loadChunkBounds(c, chunks);
    wgFlag = select(0u, bitcast<u32>(lodCount(cb)), chunkMayBeVisible(c, chunks));
  }
  let flag = workgroupUniformLoad(&wgFlag);
  if (flag != 0u) {
    let count = bitcast<f32>(flag);
    let items = u32(ceil(count));
    let scale = lodScale(count);
    for (var k = 0u; k < ITEMS_PER_THREAD; k++) {
      let t = k * WORKGROUP_SIZE + lid;
      var b = BUCKET_CULLED;
      if (t < items) {
        b = classify(nodeIndex(c, k, lid), scale);
      }
      if (b != BUCKET_CULLED) {
        // local cell: NORMAL → its segment, other buckets → SEGMENTS + b - 1
        let local = select(SEGMENTS + b - 1u, t / DRAW_SEGMENT, b == BUCKET_NORMAL);
        atomicAdd(&wgCells[local], 1u);
        atomicAdd(&wgTotal, 1u);
      }
    }
  }
  workgroupBarrier();
  // Rejected chunks still write zeros: cells are read by position, not by list.
  for (var j = lid; j < CELLS_PER_CHUNK; j += WORKGROUP_SIZE) {
    let cell = select(chunkCell(j - SEGMENTS + 1u, c, chunks), drawIndex(j, c, chunks), j < SEGMENTS);
    scratch[countsAt(chunks) + cell] = atomicLoad(&wgCells[j]);
  }
  if (lid == 0u) {
    scratch[totalsAt(chunks) + c] = atomicLoad(&wgTotal);
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn scan_reduce(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let chunks = numChunks();
  let blk = wid.x + wid.y * nwg.x;
  if (blk >= numScanBlocks(chunks)) {
    return; // uniform per workgroup
  }
  let cells = numCells(chunks);
  var sum = 0u;
  for (var k = 0u; k < ITEMS_PER_THREAD; k++) {
    let cell = blk * SCAN_BLOCK + k * WORKGROUP_SIZE + lid;
    if (cell < cells) {
      sum += scratch[countsAt(chunks) + cell];
    }
  }
  let s = wgScanU32(sum, lid);
  if (lid == 0u) {
    scratch[blockSumsAt(chunks) + blk] = s.total;
  }
}

// Exclusive prefix of all cells before `cell` (block sums already scanned).
fn prefixBefore(cell : u32, chunks : u32) -> u32 {
  let blk = cell / SCAN_BLOCK;
  var p = scratch[blockSumsAt(chunks) + blk];
  for (var j = blk * SCAN_BLOCK; j < cell; j++) {
    p += scratch[countsAt(chunks) + j];
  }
  return p;
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn scan_blocks(@builtin(local_invocation_index) lid : u32) {
  let chunks = numChunks();

  // 1. Exclusive scan of block sums, in place.
  let nb = numScanBlocks(chunks);
  let per = (nb + WORKGROUP_SIZE - 1u) / WORKGROUP_SIZE;
  let b0 = min(lid * per, nb);
  let b1 = min(b0 + per, nb);
  var sum = 0u;
  for (var j = b0; j < b1; j++) {
    sum += scratch[blockSumsAt(chunks) + j];
  }
  let sb = wgScanU32(sum, lid);
  var run = sb.exclusive;
  for (var j = b0; j < b1; j++) {
    let v = scratch[blockSumsAt(chunks) + j];
    scratch[blockSumsAt(chunks) + j] = run;
    run += v;
  }
  storageBarrier(); // scanned block sums visible to every lane

  // 2. Bucket bases and draw args (buckets are contiguous cell ranges).
  if (lid < NUM_BUCKETS) {
    let first = bucketFirstCell(lid, chunks);
    let base = prefixBefore(first, chunks);
    let next = select(prefixBefore(bucketFirstCell(lid + 1u, chunks), chunks), sb.total, lid + 1u == NUM_BUCKETS);
    let a = SCRATCH_DRAW_ARGS + lid * 4u;
    scratch[a] = 4u; // vertexCount: one triangle-strip quad
    scratch[a + 1u] = next - base; // instanceCount
    scratch[a + 2u] = 0u; // firstVertex
    scratch[a + 3u] = 0u; // firstInstance (0: no indirect-first-instance dependency, §3 #4)
    scratch[SCRATCH_BUCKET_BASE + lid] = base;
  }

  // 3. Deterministic list of chunks with at least one visible node.
  let cper = (chunks + WORKGROUP_SIZE - 1u) / WORKGROUP_SIZE;
  let c0 = min(lid * cper, chunks);
  let c1 = min(c0 + cper, chunks);
  var nonEmpty = 0u;
  for (var j = c0; j < c1; j++) {
    nonEmpty += select(0u, 1u, scratch[totalsAt(chunks) + j] > 0u);
  }
  let sl = wgScanU32(nonEmpty, lid);
  var slot = listAt(chunks) + sl.exclusive;
  for (var j = c0; j < c1; j++) {
    if (scratch[totalsAt(chunks) + j] > 0u) {
      scratch[slot] = j;
      slot += 1u;
    }
  }
  if (lid == 0u) {
    scratch[SCRATCH_LIST_COUNT] = sl.total;
    dispatchArgs[0] = min(sl.total, 65535u);
    dispatchArgs[1] = max(1u, (sl.total + 65534u) / 65535u);
    dispatchArgs[2] = 1u;
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn scan_down(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let chunks = numChunks();
  let blk = wid.x + wid.y * nwg.x;
  if (blk >= numScanBlocks(chunks)) {
    return; // uniform per workgroup
  }
  let cells = numCells(chunks);
  var run = scratch[blockSumsAt(chunks) + blk];
  for (var k = 0u; k < ITEMS_PER_THREAD; k++) {
    let cell = blk * SCAN_BLOCK + k * WORKGROUP_SIZE + lid;
    let v = select(0u, scratch[countsAt(chunks) + min(cell, cells - 1u)], cell < cells);
    let s = wgScanU32(v, lid);
    if (cell < cells) {
      scratch[offsetsAt(chunks) + cell] = run + s.exclusive;
    }
    run += s.total;
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn cull_scatter(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let chunks = numChunks();
  let li = wid.x + wid.y * nwg.x;
  if (lid == 0u) {
    wgFlag = scratch[SCRATCH_LIST_COUNT];
  }
  if (li >= workgroupUniformLoad(&wgFlag)) {
    return; // padding workgroup of a 2D indirect grid
  }
  let c = scratch[listAt(chunks) + li];
  // Same prefix cull_count chose, derived the same way — but ONCE per workgroup.
  // Doing it per thread cost ~0.5 ms/frame even at 10k nodes, where LOD is inert.
  if (lid == 0u) {
    wgLevel = bitcast<u32>(lodCount(loadChunkBounds(c, chunks)));
  }
  let count = bitcast<f32>(workgroupUniformLoad(&wgLevel));
  let items = u32(ceil(count));
  let scale = lodScale(count);
  // First lane of this lane's NORMAL segment within the row (segments never span rows).
  let segLane = lid - lid % DRAW_SEGMENT;
  if (lid < NUM_BUCKETS) {
    wgRun[lid] = 0u;
  }
  workgroupBarrier();

  for (var k = 0u; k < ITEMS_PER_THREAD; k++) {
    let t = k * WORKGROUP_SIZE + lid;
    let i = nodeIndex(c, k, lid);
    var b = BUCKET_CULLED;
    if (t < items) {
      b = classify(i, scale);
    }
    let one = select(vec2<u32>(0u), oneHot16(b), b != BUCKET_CULLED);
    let s = wgScanVec2(one, lid);
    // Row-inclusive sum just before the segment start: rank in segment = exclusive − that.
    let segBase = select(vec2<u32>(0u), scanVec2[max(segLane, 1u) - 1u], segLane > 0u);
    if (b != BUCKET_CULLED) {
      var slot : u32;
      if (b == BUCKET_NORMAL) {
        slot = scratch[offsetsAt(chunks) + drawIndex(t / DRAW_SEGMENT, c, chunks)] + field16(s.exclusive - segBase, b);
      } else {
        slot = scratch[offsetsAt(chunks) + chunkCell(b, c, chunks)] + wgRun[b] + field16(s.exclusive, b);
      }
      instances[slot] = NodeInstance(worldToScreen(nodePos[i]), nodeRadiusPx(i) * scale, lodFade(nodeColor[i], count, t));
    }
    workgroupBarrier(); // every lane has read wgRun and scanVec2
    if (lid < NUM_BUCKETS) {
      wgRun[lid] += field16(s.total, lid);
    }
    workgroupBarrier();
  }
}

// ---- label candidates ---------------------------------------------------------
// Same chunk list, same LOD prefix and same classification as cull_scatter, so
// only nodes that are actually drawn can get a label. Of those, the ones at
// least labelParams.nodeMinSize big are appended; the worker keeps that
// threshold where the biggest few thousand pass, and places from there.

@compute @workgroup_size(WORKGROUP_SIZE)
fn label_nodes(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let chunks = numChunks();
  let li = wid.x + wid.y * nwg.x;
  if (lid == 0u) {
    wgFlag = scratch[SCRATCH_LIST_COUNT];
  }
  if (li >= workgroupUniformLoad(&wgFlag)) {
    return; // padding workgroup of a 2D indirect grid
  }
  let c = scratch[listAt(chunks) + li];
  if (lid == 0u) {
    wgLevel = bitcast<u32>(lodCount(loadChunkBounds(c, chunks)));
  }
  let count = bitcast<f32>(workgroupUniformLoad(&wgLevel));
  let items = u32(ceil(count));
  let scale = lodScale(count);
  for (var k = 0u; k < ITEMS_PER_THREAD; k++) {
    let t = k * WORKGROUP_SIZE + lid;
    let i = nodeIndex(c, k, lid);
    if (t < items && classify(i, scale) != BUCKET_CULLED) {
      let size = unpack2x16float(nodeSize[i]).x;
      let r = max(nodeRadiusPx(i) * scale, NODE_MIN_DRAW_RADIUS_PX);
      if (size >= labelParams.nodeMinSize && r >= labelParams.nodeMinRadiusPx) {
        let slot = atomicAdd(&labelNodes.count, 1u);
        if (slot < LABEL_NODE_CAPACITY) {
          let sp = worldToScreen(nodePos[i]);
          labelNodes.records[slot] = LabelRecord(i, 0u, size, r, sp, sp);
        }
      }
    }
  }
}

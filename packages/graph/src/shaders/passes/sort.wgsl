// SORT (§11.1): Morton keys + stable LSD radix sort of (key, engine index).
// No batch shuffle of engine order: measured to cost culling more than it saves
// on draws (docs/decisions.md 0020).
//
// Reduce-then-scan per 4-bit digit: radix_count → radix_scan → radix_scatter.
// Stable (equal keys keep input order), deterministic, no global atomics and no
// forward-progress assumptions (decoupled look-back is unsafe in WebGPU).
// Validated against a CPU stable sort; 10M × 22-bit keys ≈ 31 ms on Intel Xe-LPG.
// Runs on topology change only — never per camera frame.
#include "common/morton.wgsl"
#include "common/scan.wgsl"

struct SortParams {
  n : u32,
  blocks : u32,
  shift : u32,
  bitsPerAxis : u32,
  origin : vec2<f32>,
  invExtent : vec2<f32>,
}

@group(2) @binding(0) var<uniform> params : SortParams;
@group(2) @binding(1) var<storage, read> keysIn : array<u32>;
@group(2) @binding(2) var<storage, read> valsIn : array<u32>;
@group(2) @binding(3) var<storage, read_write> keysOut : array<u32>;
@group(2) @binding(4) var<storage, read_write> valsOut : array<u32>;
@group(2) @binding(5) var<storage, read_write> hist : array<u32>; // [bin * blocks + block]

var<workgroup> wgHist : array<atomic<u32>, RADIX_BINS>;
var<workgroup> wgRun : array<u32, RADIX_BINS>;

fn blockOf(wid : vec3<u32>, nwg : vec3<u32>) -> u32 {
  return wid.x + wid.y * nwg.x;
}

// One thread per node: key = Morton code of the quantized position, value = current index.
@compute @workgroup_size(WORKGROUP_SIZE)
fn morton_keys(@builtin(global_invocation_id) gid : vec3<u32>, @builtin(num_workgroups) nwg : vec3<u32>) {
  let i = gid.x + gid.y * nwg.x * WORKGROUP_SIZE;
  if (i >= params.n) {
    return;
  }
  let maxQ = f32((1u << params.bitsPerAxis) - 1u);
  let q = vec2<u32>(clamp((nodePos[i] - params.origin) * params.invExtent, vec2<f32>(0.0), vec2<f32>(1.0)) * maxQ);
  keysOut[i] = spread16(q.x) | (spread16(q.y) << 1u);
  valsOut[i] = i;
}

fn digitAt(i : u32) -> u32 {
  return (keysIn[i] >> params.shift) & (RADIX_BINS - 1u);
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn radix_count(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let blk = blockOf(wid, nwg);
  if (blk >= params.blocks) {
    return; // uniform per workgroup
  }
  for (var k = 0u; k < ITEMS_PER_THREAD; k++) {
    let i = blk * CHUNK_SIZE + k * WORKGROUP_SIZE + lid;
    if (i < params.n) {
      atomicAdd(&wgHist[digitAt(i)], 1u);
    }
  }
  workgroupBarrier();
  if (lid < RADIX_BINS) {
    hist[lid * params.blocks + blk] = atomicLoad(&wgHist[lid]);
  }
}

// Exclusive scan of the bin-major histogram: global destination base of every (bin, block).
@compute @workgroup_size(WORKGROUP_SIZE)
fn radix_scan(@builtin(local_invocation_index) lid : u32) {
  let n = RADIX_BINS * params.blocks;
  let per = (n + WORKGROUP_SIZE - 1u) / WORKGROUP_SIZE;
  let start = min(lid * per, n);
  let end = min(start + per, n);
  var sum = 0u;
  for (var j = start; j < end; j++) {
    sum += hist[j];
  }
  var run = wgScanU32(sum, lid).exclusive;
  for (var j = start; j < end; j++) {
    let c = hist[j];
    hist[j] = run;
    run += c;
  }
}

// Stable scatter: an item's rank within its block is the number of earlier
// items with the same digit (earlier k-iterations via wgRun, same iteration via scan).
@compute @workgroup_size(WORKGROUP_SIZE)
fn radix_scatter(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let blk = blockOf(wid, nwg);
  if (blk >= params.blocks) {
    return; // uniform per workgroup
  }
  if (lid < RADIX_BINS) {
    wgRun[lid] = hist[lid * params.blocks + blk];
  }
  workgroupBarrier();
  for (var k = 0u; k < ITEMS_PER_THREAD; k++) {
    let i = blk * CHUNK_SIZE + k * WORKGROUP_SIZE + lid;
    let valid = i < params.n;
    let d = select(0u, digitAt(min(i, params.n - 1u)), valid);
    let one = select(vec4<u32>(0u), oneHot8(d), valid);
    let s = wgScanVec4(one, lid);
    if (valid) {
      let dst = wgRun[d] + field8(s.exclusive, d);
      keysOut[dst] = keysIn[i];
      valsOut[dst] = valsIn[i];
    }
    workgroupBarrier(); // every lane has read wgRun
    if (lid < RADIX_BINS) {
      wgRun[lid] += field8(s.lastExclusive, lid) + field8(s.lastOne, lid);
    }
    workgroupBarrier();
  }
}


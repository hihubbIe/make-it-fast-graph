// Permutation helpers for SORT (§11.1). Standalone module: no engine bindings.
//
//   gather   dst[e] = src[perm[e]]              (one node channel, `words` u32 per node)
//   compose  orderOut[e] = orderIn[perm[e]];    rank[orderOut[e]] = e
//
// Random reads by design: this runs once per sort, so every per-frame pass can
// read node data in spatially sorted order (docs/decisions.md 0018).

struct GatherParams {
  n : u32,
  words : u32,
  gridX : u32,
  pad : u32,
}

@group(0) @binding(0) var<uniform> params : GatherParams;
@group(0) @binding(1) var<storage, read> perm : array<u32>;
@group(0) @binding(2) var<storage, read> src : array<u32>;
@group(0) @binding(3) var<storage, read_write> dst : array<u32>;
@group(0) @binding(4) var<storage, read_write> rank : array<u32>; // compose only

const WG : u32 = 256u;

fn linearIndex(gid : vec3<u32>) -> u32 {
  return gid.x + gid.y * params.gridX * WG;
}

@compute @workgroup_size(WG)
fn gather(@builtin(global_invocation_id) gid : vec3<u32>) {
  let e = linearIndex(gid);
  if (e >= params.n) {
    return;
  }
  let j = perm[e];
  for (var w = 0u; w < params.words; w++) {
    dst[e * params.words + w] = src[j * params.words + w];
  }
}

@compute @workgroup_size(WG)
fn compose(@builtin(global_invocation_id) gid : vec3<u32>) {
  let e = linearIndex(gid);
  if (e >= params.n) {
    return;
  }
  let user = src[perm[e]];
  dst[e] = user;
  rank[user] = e;
}

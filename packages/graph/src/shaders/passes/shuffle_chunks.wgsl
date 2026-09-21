// SORT phase 2: shuffle engine order WITHIN each chunk.
//
// Why this exists. LOD has to draw fewer things when nodes fall below a pixel.
// Emitting one representative per equal-count cell — which is what a cluster
// pyramid does — is one sample per grid cell, and that is a jittered lattice by
// construction: measured 7x the reference's 2-D autocorrelation peak, and
// plainly visible as a woven texture. No choice of representative, colour or
// radius fixes it, because the cells themselves are the lattice.
//
// A uniform RANDOM subset has no such structure: sampling a point process at
// rate p reproduces the parent process, so density stays right (weight the
// survivors by 1/p) and nothing repeats. To make that subset cheap to read, the
// nodes are permuted inside their chunk so any prefix IS a random sample —
// contiguous, coalesced, no extra storage and no second gather.
//
// Chunks stay in Morton order, so chunk bounds and the cull's early-out are
// untouched; only the order within a 1024-node chunk changes, which is one
// cache-resident block.
//
// The permutation must differ per chunk. Taking the same positions in every
// chunk would pick the same relative locations everywhere and rebuild a lattice,
// so the key is a hash of the node's own user index: stable across rebuilds,
// and independent between chunks.
#include "common/layouts.wgsl"

struct ShuffleParams {
  nodeCount : u32,
  chunks : u32,
};

@group(2) @binding(0) var<uniform> params : ShuffleParams;
@group(2) @binding(1) var<storage, read_write> order : array<u32>;

var<workgroup> wgKey : array<u32, CHUNK_SIZE>;
var<workgroup> wgVal : array<u32, CHUNK_SIZE>;

/** Integer avalanche (Wang/Jenkins style): neighbouring indices land far apart. */
fn hashU32(x : u32) -> u32 {
  var h = x;
  h = (h ^ 61u) ^ (h >> 16u);
  h = h + (h << 3u);
  h = h ^ (h >> 4u);
  h = h * 0x27D4EB2Du;
  h = h ^ (h >> 15u);
  return h;
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn shuffle_chunks(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let c = wid.x + wid.y * nwg.x;
  if (c >= params.chunks) {
    return; // uniform per workgroup
  }
  let base = c * CHUNK_SIZE;

  // Load the chunk. Slots past the end sort last so they never enter a prefix.
  for (var k = 0u; k < ITEMS_PER_THREAD; k++) {
    let t = k * WORKGROUP_SIZE + lid;
    let i = base + t;
    let present = i < params.nodeCount;
    let user = select(0u, order[i], present);
    wgVal[t] = user;
    wgKey[t] = select(0xFFFFFFFFu, hashU32(user), present);
  }
  workgroupBarrier();

  // Bitonic sort by hash: a full random permutation of the chunk, computed in
  // workgroup memory with no global traffic.
  for (var span = 2u; span <= CHUNK_SIZE; span = span << 1u) {
    for (var stride = span >> 1u; stride > 0u; stride = stride >> 1u) {
      for (var k = 0u; k < ITEMS_PER_THREAD; k++) {
        let t = k * WORKGROUP_SIZE + lid;
        let partner = t ^ stride;
        if (partner > t) {
          let ascending = (t & span) == 0u;
          let a = wgKey[t];
          let b = wgKey[partner];
          if ((a > b) == ascending) {
            wgKey[t] = b;
            wgKey[partner] = a;
            let va = wgVal[t];
            wgVal[t] = wgVal[partner];
            wgVal[partner] = va;
          }
        }
      }
      workgroupBarrier();
    }
  }

  for (var k = 0u; k < ITEMS_PER_THREAD; k++) {
    let t = k * WORKGROUP_SIZE + lid;
    let i = base + t;
    if (i < params.nodeCount) {
      order[i] = wgVal[t];
    }
  }
}

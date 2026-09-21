// TRANSFORM_CULL phase 0: bounds of each chunk of CHUNK_SIZE engine-order
// (Morton-sorted) nodes, stored in the cull state buffer.
// Runs on topology, position and state changes only — never per camera frame.
// Hidden nodes are excluded (never drawn); foreground nodes flag their chunk so
// the cull never rejects it wholesale.
#include "common/cull_state.wgsl"

var<workgroup> wgLo : array<vec2<f32>, WORKGROUP_SIZE>;
var<workgroup> wgHi : array<vec2<f32>, WORKGROUP_SIZE>;
var<workgroup> wgSize : array<f32, WORKGROUP_SIZE>;
var<workgroup> wgFlags : array<u32, WORKGROUP_SIZE>;

const BIG : f32 = 3.0e38;

@compute @workgroup_size(WORKGROUP_SIZE)
fn chunk_bounds(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let chunks = numChunks();
  let c = wid.x + wid.y * nwg.x;
  if (c >= chunks) {
    return; // uniform per workgroup
  }

  var lo = vec2<f32>(BIG);
  var hi = vec2<f32>(-BIG);
  var size = 0.0;
  var flags = 0u;
  for (var k = 0u; k < ITEMS_PER_THREAD; k++) {
    let i = c * CHUNK_SIZE + k * WORKGROUP_SIZE + lid;
    if (i < frame.nodeCount) {
      let state = nodeState[i];
      if ((state & STATE_HIDDEN) == 0u) {
        let p = nodePos[i];
        lo = min(lo, p);
        hi = max(hi, p);
        size = max(size, unpack2x16float(nodeSize[i]).x);
        if ((state & STATE_FOREGROUND_MASK) != 0u) {
          flags |= CHUNK_FLAG_FOREGROUND;
        }
      }
    }
  }
  wgLo[lid] = lo;
  wgHi[lid] = hi;
  wgSize[lid] = size;
  wgFlags[lid] = flags;
  workgroupBarrier();

  for (var s = WORKGROUP_SIZE / 2u; s > 0u; s = s >> 1u) {
    if (lid < s) {
      wgLo[lid] = min(wgLo[lid], wgLo[lid + s]);
      wgHi[lid] = max(wgHi[lid], wgHi[lid + s]);
      wgSize[lid] = max(wgSize[lid], wgSize[lid + s]);
      wgFlags[lid] = wgFlags[lid] | wgFlags[lid + s];
    }
    workgroupBarrier();
  }

  if (lid == 0u) {
    let empty = wgLo[0].x > wgHi[0].x;
    storeChunkBounds(c, chunks, ChunkBounds(
      select(wgLo[0], vec2<f32>(0.0), empty),
      select(wgHi[0], vec2<f32>(0.0), empty),
      select(wgSize[0], 0.0, empty),
      wgFlags[0],
    ));
  }
}

// EDGE_CULL, last phase: one workgroup per chunk edge_cull listed (indirect),
// writing the first `n` edge indices of that chunk into the draw list at the
// chunk's offset. Work is proportional to the edges DRAWN, so a thinned chunk
// costs the vertex stage only what it shows.
//
// Its own module: it reads the state buffer, which also holds the dispatch
// args it runs from, so the buffer must be bound read-only here.
#include "common/edges.wgsl"

@group(2) @binding(0) var<storage, read> edgeScratch : array<u32>;
@group(2) @binding(1) var<storage, read_write> edgeList : array<u32>;

var<workgroup> wgListed : u32;

@compute @workgroup_size(WORKGROUP_SIZE)
fn edge_expand(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let slot = wid.x + wid.y * nwg.x;
  if (lid == 0u) {
    wgListed = edgeScratch[EDGE_SCRATCH_LIST_COUNT];
  }
  if (slot >= workgroupUniformLoad(&wgListed)) {
    return; // padding workgroup of a 2D indirect grid
  }
  let chunks = numEdgeChunks();
  let first = edgeScratch[EDGE_SCRATCH_LIST + slot] * EDGE_CHUNK_SIZE;
  let at = edgeScratch[edgeOffsetsAt(chunks) + slot];
  let n = edgeScratch[edgeOffsetsAt(chunks) + slot + 1u] - at;
  for (var t = lid; t < n; t += WORKGROUP_SIZE) {
    edgeList[at + t] = first + t;
  }
}

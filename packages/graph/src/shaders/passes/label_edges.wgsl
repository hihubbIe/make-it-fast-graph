// Edge label candidates: one thread per edge in the draw list EDGE_CULL wrote
// (indirect, EDGE_SCRATCH_LABEL_DISPATCH). An edge qualifies when it is long
// enough on screen to hold text and its midpoint, where the label goes, is on
// screen. The worker then checks the actual text width.
//
// Its own bindings (not @group(1)), to stay within the storage-buffer limit.
#include "common/labels.wgsl"
#include "common/camera.wgsl"

@group(2) @binding(0) var<storage, read> edgeState : array<u32>;
@group(2) @binding(1) var<storage, read> drawList : array<u32>;
@group(2) @binding(2) var<storage, read> ends : array<vec2<u32>>; // = edgeIdx
@group(2) @binding(3) var<storage, read> positions : array<vec2<f32>>; // = nodePos
@group(2) @binding(4) var<storage, read_write> labelEdges : LabelCandidates;
@group(2) @binding(5) var<uniform> labelParams : LabelParams;

@compute @workgroup_size(WORKGROUP_SIZE)
fn label_edges(@builtin(global_invocation_id) gid : vec3<u32>, @builtin(num_workgroups) nwg : vec3<u32>) {
  let ii = gid.x + gid.y * nwg.x * WORKGROUP_SIZE;
  if (ii >= edgeState[EDGE_SCRATCH_DRAW_ARGS + 1u]) {
    return;
  }
  let e = drawList[ii];
  let ij = ends[e];
  let a = worldToScreen(positions[ij.x]);
  let b = worldToScreen(positions[ij.y]);
  let len = distance(a, b);
  let mid = (a + b) * 0.5;
  let onScreen = mid.x >= 0.0 && mid.y >= 0.0 && mid.x <= frame.viewportPx.x && mid.y <= frame.viewportPx.y;
  if (len >= labelParams.edgeMinLenPx && onScreen) {
    let slot = atomicAdd(&labelEdges.count, 1u);
    if (slot < LABEL_EDGE_CAPACITY) {
      labelEdges.records[slot] = LabelRecord(e, 0u, len, 0.0, a, b);
    }
  }
}

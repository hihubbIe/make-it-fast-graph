// Node sizing rules shared by TRANSFORM_CULL and NODE_GEOMETRY, so a node is
// culled by exactly the footprint it would be drawn with (§16.5, pitfall #2).
#include "common/layouts.wgsl"
#include "common/camera.wgsl"

// Screen-space room for the 1 px anti-aliasing ramp.
const NODE_AA_PAD_PX : f32 = 1.0;
// Smaller nodes are drawn at this radius with alpha scaled by area (fade, no shimmer).
const NODE_MIN_DRAW_RADIUS_PX : f32 = 0.5;
// Below this radius the area-scaled alpha, (r / 0.5)^2, falls under the fragment
// discard threshold (0.002): the node cannot produce a visible pixel.
const NODE_MIN_VISIBLE_RADIUS_PX : f32 = 0.0224;

fn nodeRadiusPx(i : u32) -> f32 {
  return unpack2x16float(nodeSize[i]).x * frame.globalNodeScale * frame.zoom * 0.5;
}

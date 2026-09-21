// NODE_GEOMETRY (§9.3): one instanced quad per visible node, no vertex buffers.
// Reads the NodeInstance records compacted by TRANSFORM_CULL — one 16-byte load
// per vertex, no re-projection (pitfall #1). One pipeline per bucket (BUCKET override).
#include "common/nodes.wgsl"
#include "common/sdf.wgsl"

@group(2) @binding(0) var<storage, read> scratch : array<u32>;
@group(2) @binding(1) var<storage, read> instances : array<NodeInstance>;

override BUCKET : u32 = 0u;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  // [-1,1] at the node radius
  @location(0) uv : vec2<f32>,
  // straight alpha, already scaled by sub-pixel coverage
  @location(1) @interpolate(flat) color : vec4<f32>,
  // device px per uv unit, for analytic AA
  @location(2) @interpolate(flat) radiusPx : f32,
}

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VOut {
  let n = instances[scratch[SCRATCH_BUCKET_BASE + BUCKET] + ii];

  let rDraw = max(n.radiusPx, NODE_MIN_DRAW_RADIUS_PX);
  let coverage = min(1.0, (n.radiusPx * n.radiusPx) / (rDraw * rDraw));

  // Triangle strip corners: (-1,-1) (1,-1) (-1,1) (1,1)
  let corner = vec2<f32>(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
  let ext = rDraw + NODE_AA_PAD_PX;

  var c = unpack4x8unorm(n.color);
  c.a = c.a * coverage;

  var o : VOut;
  o.pos = vec4<f32>(screenToClip(n.screenPos + corner * ext), 0.0, 1.0);
  o.uv = corner * (ext / rDraw);
  o.color = c;
  o.radiusPx = rDraw;
  return o;
}

@fragment
fn fs(in : VOut) -> @location(0) vec4<f32> {
  let sd = sdCircle(in.uv);
  // Analytic 1 px coverage ramp across the silhouette.
  let a = in.color.a * clamp(0.5 - sd * in.radiusPx, 0.0, 1.0);
  if (a < 0.002) {
    discard;
  }
  return vec4<f32>(in.color.rgb * a, a); // premultiplied
}

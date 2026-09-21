// LABEL_DRAW: one textured quad per placed label, on top of everything.
//
// Each label's image was drawn once by the browser into the atlas (text and
// its dark outline, at exactly its on-screen size). Here it is only positioned:
// node labels centred under their node, edge labels centred on their edge,
// along it and kept upright. Positions come from nodePos EVERY frame, so labels
// follow the camera exactly even though placement is decided a frame or two
// earlier.
#include "common/nodes.wgsl"

@group(2) @binding(0) var<storage, read> labels : array<LabelInstance>;
@group(2) @binding(1) var atlas : texture_2d<f32>;

/** Space between a node's rim and its label, CSS px. */
const LABEL_GAP_CSS_PX : f32 = 4.0;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) alpha : f32,
}

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VOut {
  let l = labels[ii];
  let origin = vec2<f32>(f32(l.rect.x & 0xFFFFu), f32(l.rect.x >> 16u));
  let size = vec2<f32>(f32(l.rect.y & 0xFFFFu), f32(l.rect.y >> 16u));
  // Triangle strip corners (0,0) (1,0) (0,1) (1,1).
  let corner = vec2<f32>(f32(vi & 1u), f32(vi >> 1u));

  var sp : vec2<f32>;
  if (l.kind == LABEL_KIND_NODE) {
    let c = worldToScreen(nodePos[l.anchor]);
    let r = max(nodeRadiusPx(l.anchor), NODE_MIN_DRAW_RADIUS_PX);
    // Centred under the node. Whole device pixels: the image is drawn at its
    // native size, so it stays sharp.
    let topLeft = floor(c + vec2<f32>(-size.x * 0.5, r + LABEL_GAP_CSS_PX * frame.pixelRatio) + 0.5);
    sp = topLeft + corner * size;
  } else {
    let ij = edgeIdx[l.anchor];
    let a = worldToScreen(nodePos[ij.x]);
    let b = worldToScreen(nodePos[ij.y]);
    var dir = normalize(b - a + vec2<f32>(1e-6, 0.0));
    dir = select(dir, -dir, dir.x < 0.0); // read left to right, never upside down
    let nor = vec2<f32>(-dir.y, dir.x);
    let local = (corner - 0.5) * size;
    sp = (a + b) * 0.5 + dir * local.x + nor * local.y;
  }

  var o : VOut;
  o.pos = vec4<f32>(screenToClip(sp), 0.0, 1.0);
  o.uv = (origin + corner * size) / vec2<f32>(textureDimensions(atlas));
  o.alpha = l.alpha;
  return o;
}

@fragment
fn fs(in : VOut) -> @location(0) vec4<f32> {
  // The atlas holds premultiplied colour, so fading is one multiply.
  return textureSampleLevel(atlas, samp_linear, in.uv, 0.0) * in.alpha;
}

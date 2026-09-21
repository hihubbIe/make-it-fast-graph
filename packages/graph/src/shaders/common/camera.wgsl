// Camera helpers. World -> screen (device px, y down) -> clip.
#include "common/layouts.wgsl"

// Hi/lo subtraction keeps precision when the camera is far from the origin:
// (p - hi) is exact-ish for nearby points, then the tiny residual `lo` is removed.
fn worldToScreen(p : vec2<f32>) -> vec2<f32> {
  let d = (p - frame.originHi) - frame.originLo;
  let r = frame.rotation;
  let rd = vec2<f32>(d.x * r.x - d.y * r.y, d.x * r.y + d.y * r.x);
  return rd * frame.zoom + frame.viewportPx * 0.5;
}

fn screenToClip(sp : vec2<f32>) -> vec2<f32> {
  let n = sp * frame.invViewportPx * 2.0 - vec2<f32>(1.0);
  return vec2<f32>(n.x, -n.y);
}

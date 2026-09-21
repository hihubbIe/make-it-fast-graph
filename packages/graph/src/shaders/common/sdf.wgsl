// Built-in shape SDFs (§9.5). Distances are in units where 1.0 = node radius;
// negative inside. The full shape table lands with the hook system (M7).

fn sdCircle(p : vec2<f32>) -> f32 {
  return length(p) - 1.0;
}

// UPLOAD: apply partial updates given in USER index order to engine-order
// buffers through the rank table. Standalone module: no engine bindings.
//
// The upload buffer holds the updated elements of up to 64 ranges back to back;
// `ranges` stores (userStart, prefix) pairs, so element t belongs to the last
// range whose prefix ≤ t.

struct UpdateParams {
  total : u32,
  rangeCount : u32,
  words : u32,
  gridX : u32,
}

@group(0) @binding(0) var<uniform> params : UpdateParams;
@group(0) @binding(1) var<storage, read> ranges : array<vec2<u32>>;
@group(0) @binding(2) var<storage, read> upload : array<u32>;
@group(0) @binding(3) var<storage, read> rank : array<u32>;
@group(0) @binding(4) var<storage, read_write> dstBuf : array<u32>;

const WG : u32 = 256u;

@compute @workgroup_size(WG)
fn scatter_update(@builtin(global_invocation_id) gid : vec3<u32>) {
  let t = gid.x + gid.y * params.gridX * WG;
  if (t >= params.total) {
    return;
  }
  // Binary search: last range with prefix <= t.
  var lo = 0u;
  var hi = params.rangeCount - 1u;
  while (lo < hi) {
    let mid = (lo + hi + 1u) >> 1u;
    if (ranges[mid].y <= t) {
      lo = mid;
    } else {
      hi = mid - 1u;
    }
  }
  let r = ranges[lo];
  let e = rank[r.x + (t - r.y)];
  for (var w = 0u; w < params.words; w++) {
    dstBuf[e * params.words + w] = upload[t * params.words + w];
  }
}

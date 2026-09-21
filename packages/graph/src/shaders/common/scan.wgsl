// Workgroup-wide exclusive scans (Hillis–Steele over WORKGROUP_SIZE lanes).
//
// Portable on purpose: subgroup scans measured no gain for these kernels on
// Intel Xe-LPG (docs/decisions.md 0016). Every invocation of the workgroup
// must call these from uniform control flow (they contain barriers).
#include "common/layouts.wgsl"

var<workgroup> scanU32 : array<u32, WORKGROUP_SIZE>;
var<workgroup> scanVec2 : array<vec2<u32>, WORKGROUP_SIZE>;
var<workgroup> scanVec4 : array<vec4<u32>, WORKGROUP_SIZE>;
var<workgroup> scanVec4Last : vec4<u32>;

struct ScanU32 {
  exclusive : u32,
  total : u32,
}

struct ScanVec2 {
  exclusive : vec2<u32>,
  total : vec2<u32>,
}

struct ScanVec4 {
  exclusive : vec4<u32>,
  // Exclusive value and own value of the last lane: per-field totals are
  // field(lastExclusive) + field(lastOne), which never overflow a field.
  lastExclusive : vec4<u32>,
  lastOne : vec4<u32>,
}

fn wgScanU32(v : u32, lid : u32) -> ScanU32 {
  scanU32[lid] = v;
  workgroupBarrier();
  for (var o = 1u; o < WORKGROUP_SIZE; o = o << 1u) {
    var a = 0u;
    if (lid >= o) {
      a = scanU32[lid - o];
    }
    workgroupBarrier();
    scanU32[lid] += a;
    workgroupBarrier();
  }
  let r = ScanU32(scanU32[lid] - v, scanU32[WORKGROUP_SIZE - 1u]);
  workgroupBarrier(); // scanU32 may be reused right after
  return r;
}

// Packed 16-bit fields: each field's total must stay ≤ 65535.
fn wgScanVec2(v : vec2<u32>, lid : u32) -> ScanVec2 {
  scanVec2[lid] = v;
  workgroupBarrier();
  for (var o = 1u; o < WORKGROUP_SIZE; o = o << 1u) {
    var a = vec2<u32>(0u);
    if (lid >= o) {
      a = scanVec2[lid - o];
    }
    workgroupBarrier();
    scanVec2[lid] += a;
    workgroupBarrier();
  }
  let r = ScanVec2(scanVec2[lid] - v, scanVec2[WORKGROUP_SIZE - 1u]);
  workgroupBarrier();
  return r;
}

// Packed 8-bit fields (16 bins in a vec4). A field's inclusive sum may reach
// 256 at the last lane and carry into its neighbour; exclusive values stay
// correct because the carry cancels in modular u32 arithmetic.
fn wgScanVec4(v : vec4<u32>, lid : u32) -> ScanVec4 {
  scanVec4[lid] = v;
  workgroupBarrier();
  for (var o = 1u; o < WORKGROUP_SIZE; o = o << 1u) {
    var a = vec4<u32>(0u);
    if (lid >= o) {
      a = scanVec4[lid - o];
    }
    workgroupBarrier();
    scanVec4[lid] += a;
    workgroupBarrier();
  }
  // Publish the last lane's value AFTER the scan, behind its own barrier.
  // Writing it before the scan loop and reading it after is valid WGSL, but
  // intermittently read stale values on Intel Xe-LPG / D3D12 once the GPU was
  // warm (reproduced and bisected; docs/decisions.md 0019). Keep this form.
  if (lid == WORKGROUP_SIZE - 1u) {
    scanVec4Last = v;
  }
  workgroupBarrier();
  let lastOne = scanVec4Last;
  let r = ScanVec4(scanVec4[lid] - v, scanVec4[WORKGROUP_SIZE - 1u] - lastOne, lastOne);
  workgroupBarrier();
  return r;
}

fn field8(v : vec4<u32>, bin : u32) -> u32 {
  return (v[bin >> 2u] >> ((bin & 3u) << 3u)) & 0xFFu;
}

fn oneHot8(bin : u32) -> vec4<u32> {
  let bit = 1u << ((bin & 3u) << 3u);
  let q = bin >> 2u;
  return vec4<u32>(select(0u, bit, q == 0u), select(0u, bit, q == 1u), select(0u, bit, q == 2u), select(0u, bit, q == 3u));
}

fn field16(v : vec2<u32>, bin : u32) -> u32 {
  return (select(v.x, v.y, bin >= 2u) >> ((bin & 1u) << 4u)) & 0xFFFFu;
}

fn oneHot16(bin : u32) -> vec2<u32> {
  let bit = 1u << ((bin & 1u) << 4u);
  return select(vec2<u32>(bit, 0u), vec2<u32>(0u, bit), bin >= 2u);
}

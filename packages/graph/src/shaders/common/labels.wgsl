// Label candidate buffers and the thresholds that fill them, shared by the
// GPU passes that look for labels (see LabelPass.ts).
#include "common/layouts.wgsl"

/** A candidate buffer: how many were found (may exceed capacity), then the first `capacity`. */
struct LabelCandidates {
  count : atomic<u32>,
  pad0 : u32,
  pad1 : u32,
  pad2 : u32,
  records : array<LabelRecord>,
}

/** Written by the worker every query, from what the previous one found. */
struct LabelParams {
  /** Only nodes at least this big (world) are candidates: the biggest win. */
  nodeMinSize : f32,
  /** ...and drawn at least this wide, device px, so the node is visible. */
  nodeMinRadiusPx : f32,
  /** Only edges at least this long on screen, device px: shorter ones cannot fit text. */
  edgeMinLenPx : f32,
  pad : f32,
}

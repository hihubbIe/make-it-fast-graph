/** Dirty-flag bitset driving pass skipping (§7). Zero flags => the frame is skipped entirely. */
export const Dirty = {
  TOPOLOGY: 1 << 0,
  POSITIONS: 1 << 1,
  CAMERA: 1 << 2,
  STYLE: 1 << 3,
  STATE: 1 << 4,
  RESIZE: 1 << 5,
  /** Explicit `requestRender()` from the caller. */
  FORCED: 1 << 6,
  /** Only the clear colour changed: re-render without re-running compute passes. */
  CLEAR_COLOR: 1 << 7,
  /** Edge endpoints, styles or colours changed. */
  EDGES: 1 << 8,
  /** Placed labels or their fades changed: re-render, no compute. */
  LABELS: 1 << 9,
  /** Ask the GPU for label candidates again (labels changed, or placement wants another look). */
  LABEL_QUERY: 1 << 10,
} as const;

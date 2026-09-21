/**
 * Worker → main shared state block: frame stats, GPU timings and the camera.
 *
 * Backed by a SharedArrayBuffer when cross-origin isolated, so the main thread
 * reads it synchronously with zero messages and zero allocation. Otherwise the
 * worker posts snapshots of the same Float64Array layout (see worker.ts).
 */

export const STATE_SLOT = {
  FRAME_INDEX: 0,
  RENDERED_FRAMES: 1,
  CPU_MS_LAST: 2,
  CPU_MS_AVG: 3,
  NODE_COUNT: 4,
  EDGE_COUNT: 5,
  VIEWPORT_W: 6,
  VIEWPORT_H: 7,
  CAMERA_X: 8,
  CAMERA_Y: 9,
  CAMERA_ZOOM: 10,
  CAMERA_ROTATION: 11,
  UPLOAD_BYTES: 12,
  /** Rolling mean GPU frame time, ms (NaN without timestamp-query). */
  GPU_MS_AVG: 13,
  /** Instances drawn in the last profiled frame. */
  VISIBLE_NODES: 14,
  PROFILER_DROPPED: 15,
  /** Edges drawn in the last profiled frame (after the edge cull). */
  VISIBLE_EDGES: 48,
  /** Bytes in the GPU buffers the engine holds. */
  GPU_BYTES: 49,
  /** Rolling mean per profiler slot, ms; slot names are in `GraphCaps.profilerSlots`. */
  SLOT_MS_BASE: 16,
} as const;

/** 16 fixed slots + MAX_PROFILE_SLOTS rolling per-pass means + trailing extras. */
export const STATE_SLOTS = 56;

export function createStateBuffer(shared: boolean): Float64Array {
  const bytes = STATE_SLOTS * 8;
  return new Float64Array(shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));
}

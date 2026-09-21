/**
 * Fixed camera paths (§19.3), replayed frame-by-frame by the engine so every
 * run renders exactly the same frames regardless of GPU speed.
 *
 * Keys are dataset-independent: `x`, `y` are fractions of the data bounds
 * (0.5 = centre); `zoom` multiplies the fit-to-screen zoom (1 = fit).
 */

export interface PathKey {
  x: number;
  y: number;
  zoom: number;
}

export interface CameraPathSpec {
  keys: readonly PathKey[];
  frames: number;
}

export const PATHS = {
  /** fit → zoom to 10% → pan across → dive deep → back out. */
  standard: {
    frames: 200,
    keys: [
      { x: 0.5, y: 0.5, zoom: 1 },
      { x: 0.5, y: 0.5, zoom: 10 },
      { x: 0.2, y: 0.3, zoom: 10 },
      { x: 0.8, y: 0.7, zoom: 10 },
      { x: 0.62, y: 0.41, zoom: 70 },
      { x: 0.5, y: 0.5, zoom: 1 },
    ],
  },
  /** Stay fit-to-screen with a slow drift: the worst case for "everything visible". */
  fit: {
    frames: 200,
    keys: [
      { x: 0.5, y: 0.5, zoom: 1 },
      { x: 0.52, y: 0.48, zoom: 1.1 },
      { x: 0.5, y: 0.5, zoom: 1 },
    ],
  },
  /**
   * Interactive zooming at zoomed-out levels (fit … 12×): what a user does to
   * explore a large graph. Everything visible is small; the draw path dominates.
   */
  zoomSweep: {
    frames: 200,
    keys: [
      { x: 0.5, y: 0.5, zoom: 1 },
      { x: 0.45, y: 0.52, zoom: 4 },
      { x: 0.5, y: 0.5, zoom: 1 },
      { x: 0.56, y: 0.47, zoom: 12 },
      { x: 0.5, y: 0.5, zoom: 1 },
    ],
  },
  /** Deep zoom (~70× fit) panning over dense regions: few visible nodes, culling-bound. */
  deepZoom: {
    frames: 200,
    keys: [
      { x: 0.45, y: 0.45, zoom: 70 },
      { x: 0.55, y: 0.45, zoom: 70 },
      { x: 0.55, y: 0.55, zoom: 70 },
      { x: 0.45, y: 0.55, zoom: 70 },
    ],
  },
} as const satisfies Record<string, CameraPathSpec>;

export type PathName = keyof typeof PATHS;

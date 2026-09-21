/**
 * Pan / zoom controls, applied in the worker from InputRing records.
 * Pointer coordinates are absolute device px, so coalescing moves loses nothing.
 */
import { INPUT, MOD, type InputRecord } from "../bridge/InputRing";
import type { Camera2D } from "./Camera2D";

const WHEEL_ZOOM_SPEED = 0.0015;
/** Trackpad pinch arrives as ctrl+wheel with small deltas. */
const PINCH_ZOOM_SPEED = 0.01;

/**
 * Time constant of the zoom glide, seconds. A wheel notch sets a target and the
 * camera approaches it exponentially, so ONE event produces many frames.
 *
 * Measured before this existed: the engine rendered exactly one frame per input
 * event (90 drag events -> 90 frames), so smoothness was capped by however fast
 * the wheel happened to fire — 10 events/s rendered 7.8 fps at deep zoom while
 * the GPU used 3.3 ms of its 16.7 ms budget. Input latency was never the
 * problem; median input->frame was 0.9 ms.
 *
 * ~0.05 s reaches 90 % in about 7 frames at 60 Hz. Panning is deliberately NOT
 * smoothed: a drag is already 1:1 with the pointer, and easing it would only add
 * lag to a gesture that tracks correctly today.
 */
const ZOOM_TAU_S = 0.05;
/** Below this remaining log-zoom, finish in one step rather than creep. */
const ZOOM_EPSILON = 1e-4;
/** Longest dt honoured, seconds: after an idle sleep the gap is meaningless. */
const MAX_STEP_S = 0.1;

export class Controls {
  enabled = true;
  /** Last pointer position, device px; -1 when outside the canvas. */
  pointerX = -1;
  pointerY = -1;
  private dragging = false;
  /** Natural log of the zoom factor still to be applied. 0 when settled. */
  private pendingZoomLog = 0;
  private anchorX = 0;
  private anchorY = 0;

  /** Apply one record. Returns true if the camera changed. */
  apply(rec: InputRecord, camera: Camera2D): boolean {
    switch (rec.type) {
      case INPUT.POINTER_DOWN:
        this.pointerX = rec.x;
        this.pointerY = rec.y;
        this.dragging = this.enabled && (rec.buttons & 1) !== 0;
        return false;

      case INPUT.POINTER_MOVE: {
        const dx = rec.x - this.pointerX;
        const dy = rec.y - this.pointerY;
        const wasInside = this.pointerX >= 0;
        this.pointerX = rec.x;
        this.pointerY = rec.y;
        if (!this.dragging || !wasInside || (rec.buttons & 1) === 0) {
          if ((rec.buttons & 1) === 0) this.dragging = false;
          return false;
        }
        if (dx === 0 && dy === 0) return false;
        camera.panByScreen(dx, dy);
        return true;
      }

      case INPUT.POINTER_UP:
        this.dragging = false;
        return false;

      case INPUT.POINTER_LEAVE:
        if (!this.dragging) this.pointerX = this.pointerY = -1;
        return false;

      case INPUT.WHEEL: {
        if (!this.enabled || rec.dy === 0) return false;
        const speed = (rec.mods & MOD.CTRL) !== 0 ? PINCH_ZOOM_SPEED : WHEEL_ZOOM_SPEED;
        // Accumulate into the target; `advance` applies it over several frames.
        // Notches that arrive mid-glide simply add, so fast scrolling stays
        // responsive instead of queueing.
        this.pendingZoomLog += -rec.dy * speed;
        this.anchorX = rec.x;
        this.anchorY = rec.y;
        return true;
      }
    }
    return false;
  }

  /**
   * Advance the zoom glide by `dt` seconds. Returns true if the camera moved,
   * which is what keeps the frame loop awake; once settled it returns false and
   * the engine goes idle exactly as before — no frames are spent on a still view.
   */
  advance(dt: number, camera: Camera2D): boolean {
    const pending = this.pendingZoomLog;
    if (pending === 0) return false;
    // Exponential approach, framerate-independent: the same wall-clock glide
    // whether frames arrive every 4 ms or every 40.
    const alpha = 1 - Math.exp(-Math.min(dt, MAX_STEP_S) / ZOOM_TAU_S);
    let step = pending * alpha;
    if (Math.abs(pending - step) < ZOOM_EPSILON) step = pending; // land exactly
    const before = camera.zoom;
    camera.zoomAt(Math.exp(step), this.anchorX, this.anchorY);
    if (camera.zoom === before) {
      this.pendingZoomLog = 0; // clamped at a zoom limit, or converged
      return false;
    }
    this.pendingZoomLog = pending - step;
    return true;
  }

  /** Drop any in-flight glide; a programmatic view change wins outright. */
  cancelZoom(): void {
    this.pendingZoomLog = 0;
  }
}

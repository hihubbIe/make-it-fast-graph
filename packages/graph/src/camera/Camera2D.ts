/**
 * 2D camera. State is f64 (JS numbers); the GPU receives the centre as a
 * hi/lo f32 pair so deep zooms far from the origin stay stable (§8, §13).
 *
 * Conventions: world y points down (same as screen). `zoom` is device px per
 * world unit. Screen coordinates are device px, origin top-left.
 *
 *   screen = R(rotation) * (world - centre) * zoom + viewport / 2
 */
import type { CameraView } from "../api/types";
import type { Bounds } from "../data/GraphStore";

export const MIN_ZOOM = 1e-6;
export const MAX_ZOOM = 1e6;

export class Camera2D {
  x = 0;
  y = 0;
  zoom = 1;
  rotation = 0;
  viewportW = 1;
  viewportH = 1;

  setViewport(w: number, h: number): void {
    this.viewportW = Math.max(1, w);
    this.viewportH = Math.max(1, h);
  }

  setView(v: Partial<CameraView>): void {
    if (v.x !== undefined) this.x = v.x;
    if (v.y !== undefined) this.y = v.y;
    if (v.zoom !== undefined) this.zoom = clampZoom(v.zoom);
    if (v.rotation !== undefined) this.rotation = v.rotation;
  }

  /** Pan by a screen-space delta (device px); content follows the pointer. */
  panByScreen(dx: number, dy: number): void {
    const c = Math.cos(this.rotation);
    const s = Math.sin(this.rotation);
    // inverse rotation of the screen delta
    this.x -= (c * dx + s * dy) / this.zoom;
    this.y -= (-s * dx + c * dy) / this.zoom;
  }

  /** Multiply zoom by `factor`, keeping the world point under (sx, sy) fixed. */
  zoomAt(factor: number, sx: number, sy: number): void {
    const next = clampZoom(this.zoom * factor);
    if (next === this.zoom) return;
    // world point under cursor: centre + R^-1 * (s - vp/2) / zoom
    const ox = sx - this.viewportW * 0.5;
    const oy = sy - this.viewportH * 0.5;
    const c = Math.cos(this.rotation);
    const s = Math.sin(this.rotation);
    const rx = c * ox + s * oy;
    const ry = -s * ox + c * oy;
    const k = 1 / this.zoom - 1 / next;
    this.x += rx * k;
    this.y += ry * k;
    this.zoom = next;
  }

  /** Fit `b` into the viewport with `padding` device px on each side. */
  fit(b: Bounds, padding = 32): void {
    this.x = (b.minX + b.maxX) * 0.5;
    this.y = (b.minY + b.maxY) * 0.5;
    this.rotation = 0;
    this.zoom = this.fitZoom(b, padding);
  }

  /** Zoom at which `b` fits the viewport with `padding` device px per side. */
  fitZoom(b: Bounds, padding = 32): number {
    const w = Math.max(b.maxX - b.minX, 1e-9);
    const h = Math.max(b.maxY - b.minY, 1e-9);
    const availW = Math.max(1, this.viewportW - padding * 2);
    const availH = Math.max(1, this.viewportH - padding * 2);
    return clampZoom(Math.min(availW / w, availH / h));
  }

  worldToScreen(wx: number, wy: number, out: { x: number; y: number }): void {
    const dx = (wx - this.x) * this.zoom;
    const dy = (wy - this.y) * this.zoom;
    const c = Math.cos(this.rotation);
    const s = Math.sin(this.rotation);
    out.x = c * dx - s * dy + this.viewportW * 0.5;
    out.y = s * dx + c * dy + this.viewportH * 0.5;
  }

  screenToWorld(sx: number, sy: number, out: { x: number; y: number }): void {
    const ox = (sx - this.viewportW * 0.5) / this.zoom;
    const oy = (sy - this.viewportH * 0.5) / this.zoom;
    const c = Math.cos(this.rotation);
    const s = Math.sin(this.rotation);
    out.x = this.x + c * ox + s * oy;
    out.y = this.y - s * ox + c * oy;
  }
}

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

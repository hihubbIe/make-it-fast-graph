/**
 * Frame-indexed camera path (§19.3). Frame N always shows the same view, no
 * matter how fast the GPU is, so benchmark runs are directly comparable.
 *
 * Keys are relative to the data: x, y are fractions of the node bounds
 * (0.5 = centre), zoom multiplies the fit-to-screen zoom.
 */
import type { CameraPathKey } from "../api/types";
import type { Bounds } from "../data/GraphStore";
import type { Camera2D } from "./Camera2D";

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

export class CameraPath {
  private readonly logZooms: Float64Array;

  constructor(
    private readonly keys: readonly CameraPathKey[],
    readonly frames: number,
    private readonly bounds: Bounds,
    private readonly fitZoom: number,
  ) {
    if (keys.length === 0) throw new RangeError("CameraPath: at least one key required");
    this.logZooms = Float64Array.from(keys, (k) => Math.log(k.zoom));
  }

  /** Place the camera at path frame `frame` (clamped to the path). */
  apply(frame: number, camera: Camera2D): void {
    const segments = this.keys.length - 1;
    const t = segments === 0 || this.frames <= 1 ? 0 : (Math.min(frame, this.frames - 1) / (this.frames - 1)) * segments;
    const seg = Math.min(Math.floor(t), Math.max(0, segments - 1));
    const a = this.keys[seg]!;
    const b = this.keys[Math.min(seg + 1, segments)]!;
    const u = smoothstep(t - seg);

    const fx = a.x + (b.x - a.x) * u;
    const fy = a.y + (b.y - a.y) * u;
    const lz = this.logZooms[seg]! + (this.logZooms[Math.min(seg + 1, segments)]! - this.logZooms[seg]!) * u;
    const bb = this.bounds;
    camera.x = bb.minX + fx * (bb.maxX - bb.minX);
    camera.y = bb.minY + fy * (bb.maxY - bb.minY);
    camera.zoom = this.fitZoom * Math.exp(lz);
    camera.rotation = 0;
  }
}

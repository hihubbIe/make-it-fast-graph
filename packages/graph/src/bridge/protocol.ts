/**
 * Main ↔ worker messages. Bulk data travels as transferred ArrayBuffers; the
 * hot paths (pointer input, stats, camera readback) go through shared memory
 * and never produce a message in steady state.
 */
import type { GraphErrorCode } from "../api/errors";
import type { BenchmarkOptions, BenchmarkResult, CameraView, EdgeDebugMode, GraphCaps, RGBA } from "../api/types";

export interface InitOptions {
  background: RGBA;
  controls: boolean;
  nodeScale: number;
  /** Device-px spacing below which nodes merge into LOD clusters; 0 disables. */
  lodTargetPx: number;
  /** Width of an edge with no per-edge width, device px. */
  edgeWidth: number;
  /** Tint for edges with no per-edge colour, straight alpha. */
  edgeColor: RGBA;
  /** Compile the arrowhead into the edge pipeline (wider quad, more fill). */
  directedEdges: boolean;
  /** Edges per pixel a crowded length level is thinned to; 0 = never. */
  edgeMaxOverdraw: number;
  /** Edges this short on screen or shorter are not drawn, CSS px. */
  edgeMinLengthPx: number;
  edgeDebug: EdgeDebugMode;
  /** Node label size, CSS px; edge labels are a little smaller. */
  labelSize: number;
  /** Labels on screen at most. */
  labelMax: number;
}

export type ToWorker =
  | {
      t: "init";
      canvas: OffscreenCanvas;
      width: number;
      height: number;
      pixelRatio: number;
      /** SharedArrayBuffer for InputRing, or null when not cross-origin isolated. */
      ring: SharedArrayBuffer | null;
      /** Shared state block (see SharedState.ts), or null. */
      state: SharedArrayBuffer | null;
      options: InitOptions;
    }
  | { t: "resize"; width: number; height: number; pixelRatio: number }
  | { t: "wake" }
  /** Fallback input path (no SharedArrayBuffer): numbers only, same fields as a ring record. */
  | { t: "input"; r: [type: number, time: number, x: number, y: number, dx: number, dy: number, buttons: number, mods: number] }
  | { t: "nodes"; count: number; positions?: Float32Array; colors?: Uint32Array; sizes?: Float32Array }
  | { t: "edges"; count: number; indices?: Uint32Array; styles?: Uint32Array; colors?: Uint32Array }
  | { t: "nodeLabels"; labels: string[] }
  | { t: "edgeLabels"; labels: string[] }
  | { t: "updatePositions"; start: number; data: Float32Array }
  | { t: "updateColor"; index: number; rgba: number }
  | { t: "view"; view: Partial<CameraView> }
  | { t: "fit"; padding: number }
  | { t: "background"; rgba: RGBA }
  | { t: "nodeScale"; value: number }
  | { t: "render" }
  | { t: "benchmark"; id: number; options: BenchmarkOptions }
  | { t: "destroy" };

export type FromWorker =
  | { t: "ready"; caps: GraphCaps }
  | { t: "error"; code: GraphErrorCode; message: string; fatal: boolean }
  /** Fallback state snapshot when the state block is not shared. */
  | { t: "state"; data: Float64Array }
  | { t: "benchmark"; id: number; result: BenchmarkResult }
  | { t: "destroyed" };

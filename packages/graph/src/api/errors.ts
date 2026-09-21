export type GraphErrorCode =
  | "webgpu-unavailable"
  | "offscreen-canvas-unavailable"
  | "no-adapter"
  | "compat-mode"
  | "insufficient-limits"
  | "limits-exceeded"
  | "device-failed"
  | "device-lost"
  | "detached-array"
  | "invalid-argument"
  | "destroyed"
  | "internal";

export class GraphError extends Error {
  override readonly name: string = "GraphError";
  constructor(
    readonly code: GraphErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The platform cannot run the engine (no WebGPU, no adapter, compat-only adapter…). */
export class UnsupportedError extends GraphError {
  override readonly name = "UnsupportedError";
}

const UNSUPPORTED: ReadonlySet<GraphErrorCode> = new Set([
  "webgpu-unavailable",
  "offscreen-canvas-unavailable",
  "no-adapter",
  "compat-mode",
  "insufficient-limits",
]);

/** Rebuild a typed error from its serialized form (worker → main). */
export function errorFromCode(code: GraphErrorCode, message: string): GraphError {
  return UNSUPPORTED.has(code) ? new UnsupportedError(code, message) : new GraphError(code, message);
}

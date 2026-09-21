/** Optional GPU features the engine can exploit, and the limits it negotiated. */
import type { GraphCaps } from "../api/types";

export const OPTIONAL_FEATURES = [
  "timestamp-query",
  "indirect-first-instance",
  "subgroups",
  "float32-filterable",
  "shader-f16",
] as const satisfies readonly GPUFeatureName[];

/**
 * Storage buffers bound in one shader stage by the busiest engine pass:
 * 8 graph-data bindings (@group(1), public contract) + 2 pass-local (@group(2)).
 */
export const REQUIRED_STORAGE_BUFFERS_PER_STAGE = 10;

export function describeAdapter(adapter: GPUAdapter): string {
  const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
  if (!info) return "unknown adapter";
  const parts = info.description ? [info.description] : [info.vendor, info.architecture, info.device].filter(Boolean);
  return parts.join(" ") || "unknown adapter";
}

export function readCaps(adapter: GPUAdapter, device: GPUDevice, sharedMemory: boolean, profilerSlots: string[]): GraphCaps {
  const f = device.features;
  const l = device.limits;
  return {
    timestampQuery: f.has("timestamp-query"),
    indirectFirstInstance: f.has("indirect-first-instance"),
    subgroups: f.has("subgroups"),
    float32Filterable: f.has("float32-filterable"),
    shaderF16: f.has("shader-f16"),
    maxBufferSize: l.maxBufferSize,
    maxStorageBufferBindingSize: l.maxStorageBufferBindingSize,
    maxTextureDimension2D: l.maxTextureDimension2D,
    maxStorageBuffersPerShaderStage: l.maxStorageBuffersPerShaderStage,
    sharedMemory,
    adapter: describeAdapter(adapter),
    profilerSlots,
  };
}

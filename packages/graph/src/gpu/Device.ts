/**
 * Adapter / device acquisition with limits negotiation (§3.1).
 * Runs in the render worker only — the main thread never touches the GPU.
 */
import { GraphError, UnsupportedError } from "../api/errors";
import { OPTIONAL_FEATURES, REQUIRED_STORAGE_BUFFERS_PER_STAGE } from "./Caps";

/** Limits requested at the adapter's maximum. Defaults are far too small (§3.1). */
const WANTED_LIMITS = [
  "maxBufferSize",
  "maxStorageBufferBindingSize",
  "maxStorageBuffersPerShaderStage",
  "maxStorageBuffersInVertexStage",
  "maxStorageBuffersInFragmentStage",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupSizeX",
  "maxComputeWorkgroupsPerDimension",
  "maxBindGroups",
  "maxColorAttachmentBytesPerSample",
  "maxTextureDimension2D",
] as const;

export interface Gpu {
  adapter: GPUAdapter;
  device: GPUDevice;
  /** Swap-chain format preferred by this platform. */
  format: GPUTextureFormat;
  /** Bytes in the GPU buffers this device currently holds (canvas textures excluded). */
  memory: { bytes: number };
}

export async function createGpu(gpu: GPU | undefined): Promise<Gpu> {
  if (!gpu) throw new UnsupportedError("webgpu-unavailable", "WebGPU is not available in this worker.");

  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new UnsupportedError("no-adapter", "No WebGPU adapter available.");

  // Compatibility mode has no vertex-stage storage buffers, which this engine relies on (§3 #3).
  const level = (adapter as GPUAdapter & { featureLevel?: string }).featureLevel;
  if (level !== undefined && level !== "core") {
    throw new UnsupportedError("compat-mode", `Adapter feature level "${level}" is not supported; "core" is required.`);
  }

  const supported = adapter.limits as unknown as Record<string, number | undefined>;
  const requiredLimits: Record<string, number> = {};
  for (const k of WANTED_LIMITS) {
    const v = supported[k];
    if (v !== undefined) requiredLimits[k] = v;
  }

  const requiredFeatures = OPTIONAL_FEATURES.filter((f) => adapter.features.has(f));

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({ requiredLimits, requiredFeatures });
  } catch (e) {
    throw new GraphError("device-failed", `requestDevice failed: ${(e as Error).message}`);
  }

  const limits = device.limits as unknown as Record<string, number | undefined>;
  for (const k of ["maxStorageBuffersPerShaderStage", "maxStorageBuffersInVertexStage"]) {
    const v = limits[k];
    if (v !== undefined && v < REQUIRED_STORAGE_BUFFERS_PER_STAGE) {
      device.destroy();
      throw new UnsupportedError(
        "insufficient-limits",
        `${k} is ${v}; the engine binds ${REQUIRED_STORAGE_BUFFERS_PER_STAGE} storage buffers per stage.`,
      );
    }
  }

  return { adapter, device, format: gpu.getPreferredCanvasFormat(), memory: trackBufferBytes(device) };
}

/**
 * Count the bytes of every live buffer the device creates. WebGPU cannot report
 * free or used GPU memory, so this is the one exact number available: what the
 * engine itself holds. Wraps `createBuffer` once, so no call site has to care.
 */
function trackBufferBytes(device: GPUDevice): { bytes: number } {
  const memory = { bytes: 0 };
  const create = device.createBuffer.bind(device);
  device.createBuffer = (descriptor: GPUBufferDescriptor): GPUBuffer => {
    const buffer = create(descriptor);
    const size = buffer.size;
    memory.bytes += size;
    const destroy = buffer.destroy.bind(buffer);
    let live = true;
    buffer.destroy = () => {
      if (live) {
        live = false;
        memory.bytes -= size;
      }
      destroy();
    };
    return buffer;
  };
  return memory;
}

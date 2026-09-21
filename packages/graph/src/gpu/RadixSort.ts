/**
 * Stable LSD radix sort of (u32 key, u32 value) pairs, 4-bit digits, driving
 * the count → scan → scatter kernels of sort.wgsl. A run owns its temporary
 * buffers for one frame; the caller fills `keys[0]` / `vals[0]` before
 * `encode` and retires `buffers` after submit.
 */
import { ENGINE_CONSTANTS } from "../data/Layouts";
import { createShaderModule } from "./ShaderModules";

const { CHUNK_SIZE, RADIX_BITS, RADIX_BINS } = ENGINE_CONSTANTS;
/** Size of `SortParams` in sort.wgsl. */
const PARAMS_BYTES = 32;

export interface RadixRun {
  keys: [GPUBuffer, GPUBuffer];
  vals: [GPUBuffer, GPUBuffer];
  /** Values in key order once encoded. */
  sorted: GPUBuffer;
  /** Everything to retire after submit. */
  buffers: GPUBuffer[];
  blocks: number;
  groups: GPUBindGroup[];
}

export class RadixSort {
  private readonly maxGroupsX: number;

  private constructor(
    private readonly device: GPUDevice,
    private readonly layout: GPUBindGroupLayout,
    private readonly empty: GPUBindGroup,
    private readonly count: GPUComputePipeline,
    private readonly scan: GPUComputePipeline,
    private readonly scatter: GPUComputePipeline,
  ) {
    this.maxGroupsX = device.limits.maxComputeWorkgroupsPerDimension;
  }

  static async create(device: GPUDevice): Promise<RadixSort> {
    const module = await createShaderModule(device, "passes/sort.wgsl");
    const s = (binding: number, type: GPUBufferBindingType) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    const layout = device.createBindGroupLayout({
      label: "group2/radix",
      entries: [s(0, "uniform"), s(1, "read-only-storage"), s(2, "read-only-storage"), s(3, "storage"), s(4, "storage"), s(5, "storage")],
    });
    // The radix kernels touch no engine bindings: groups 0 and 1 are empty.
    const empty = device.createBindGroupLayout({ label: "empty", entries: [] });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [empty, empty, layout] });
    const make = (entryPoint: string) =>
      device.createComputePipelineAsync({ label: `radix/${entryPoint}`, layout: pl, compute: { module, entryPoint } });
    const [count, scan, scatter] = await Promise.all([make("radix_count"), make("radix_scan"), make("radix_scatter")]);
    return new RadixSort(device, layout, device.createBindGroup({ layout: empty, entries: [] }), count, scan, scatter);
  }

  /** Buffers and bind groups to sort `n` pairs whose keys use the low `bits` bits. */
  begin(n: number, bits: number): RadixRun {
    const passes = Math.ceil(bits / RADIX_BITS);
    const blocks = Math.ceil(n / CHUNK_SIZE);
    const words = (count: number) =>
      this.device.createBuffer({ label: "radix/tmp", size: Math.max(16, Math.ceil((count * 4) / 16) * 16), usage: GPUBufferUsage.STORAGE });
    const keys: [GPUBuffer, GPUBuffer] = [words(n), words(n)];
    const vals: [GPUBuffer, GPUBuffer] = [words(n), words(n)];
    const hist = words(blocks * RADIX_BINS);
    const buffers = [keys[0], keys[1], vals[0], vals[1], hist];
    const groups: GPUBindGroup[] = [];
    for (let p = 0; p < passes; p++) {
      const params = this.device.createBuffer({ label: "radix/params", size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
      new Uint32Array(params.getMappedRange(), 0, 3).set([n, blocks, p * RADIX_BITS]);
      params.unmap();
      buffers.push(params);
      // Pass p reads slot p % 2 and writes the other one.
      const src = p % 2;
      const dst = 1 - src;
      groups.push(
        this.device.createBindGroup({
          layout: this.layout,
          entries: [params, keys[src], vals[src], keys[dst], vals[dst], hist].map((buffer, binding) => ({ binding, resource: { buffer } })),
        }),
      );
    }
    return { keys, vals, sorted: vals[passes % 2]!, buffers, blocks, groups };
  }

  encode(pass: GPUComputePassEncoder, run: RadixRun): void {
    const g = Math.max(1, run.blocks);
    const gx = Math.min(g, this.maxGroupsX);
    const gy = Math.ceil(g / gx);
    pass.setBindGroup(0, this.empty);
    pass.setBindGroup(1, this.empty);
    for (const group of run.groups) {
      pass.setBindGroup(2, group);
      pass.setPipeline(this.count);
      pass.dispatchWorkgroups(gx, gy);
      pass.setPipeline(this.scan);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(this.scatter);
      pass.dispatchWorkgroups(gx, gy);
    }
  }
}

/**
 * Compute kernels that move node data between user order and engine (Morton)
 * order: gather (apply a permutation), compose (update order/rank tables) and
 * scatter_update (apply user-indexed partial updates through the rank table).
 *
 * Bind groups and parameter buffers are created per call: gathers only run on
 * sort / bulk-replace events, never per frame. Per-frame partial updates use
 * `ScatterSlot`, which caches its resources.
 */
import { createShaderModule } from "./ShaderModules";

const WG = 256;

export interface ScatterSlot {
  params: GPUBuffer;
  ranges: GPUBuffer;
  upload: GPUBuffer | null;
  bindGroup: GPUBindGroup | null;
  /** Identity of the buffers the cached bind group points at. */
  key: readonly GPUBuffer[];
}

export class PermuteKernels {
  private readonly gatherLayout: GPUBindGroupLayout;
  private readonly composeLayout: GPUBindGroupLayout;
  private readonly scatterLayout: GPUBindGroupLayout;
  private readonly params = new Uint32Array(4);
  private readonly maxGroupsX: number;

  private constructor(
    private readonly device: GPUDevice,
    private readonly gatherPipe: GPUComputePipeline,
    private readonly composePipe: GPUComputePipeline,
    private readonly scatterPipe: GPUComputePipeline,
  ) {
    this.gatherLayout = gatherPipe.getBindGroupLayout(0);
    this.composeLayout = composePipe.getBindGroupLayout(0);
    this.scatterLayout = scatterPipe.getBindGroupLayout(0);
    this.maxGroupsX = device.limits.maxComputeWorkgroupsPerDimension;
  }

  static async create(device: GPUDevice): Promise<PermuteKernels> {
    const [gatherModule, scatterModule] = await Promise.all([
      createShaderModule(device, "passes/gather.wgsl"),
      createShaderModule(device, "passes/scatter_update.wgsl"),
    ]);
    const storage = (type: GPUBufferBindingType) => ({ visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    const uniform = { binding: 0, ...storage("uniform") };
    const gatherLayout = device.createBindGroupLayout({
      label: "gather",
      entries: [uniform, { binding: 1, ...storage("read-only-storage") }, { binding: 2, ...storage("read-only-storage") }, { binding: 3, ...storage("storage") }],
    });
    const composeLayout = device.createBindGroupLayout({
      label: "compose",
      entries: [
        uniform,
        { binding: 1, ...storage("read-only-storage") },
        { binding: 2, ...storage("read-only-storage") },
        { binding: 3, ...storage("storage") },
        { binding: 4, ...storage("storage") },
      ],
    });
    const scatterLayout = device.createBindGroupLayout({
      label: "scatter_update",
      entries: [
        uniform,
        { binding: 1, ...storage("read-only-storage") },
        { binding: 2, ...storage("read-only-storage") },
        { binding: 3, ...storage("read-only-storage") },
        { binding: 4, ...storage("storage") },
      ],
    });
    const pipe = (module: GPUShaderModule, entryPoint: string, layout: GPUBindGroupLayout) =>
      device.createComputePipelineAsync({
        label: entryPoint,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint },
      });
    const [g, c, s] = await Promise.all([
      pipe(gatherModule, "gather", gatherLayout),
      pipe(gatherModule, "compose", composeLayout),
      pipe(scatterModule, "scatter_update", scatterLayout),
    ]);
    return new PermuteKernels(device, g, c, s);
  }

  /** dst[e] = src[perm[e]] for `n` nodes of `words` u32 each. */
  gather(pass: GPUComputePassEncoder, perm: GPUBuffer, src: GPUBuffer, dst: GPUBuffer, n: number, words: number): GPUBuffer {
    const [gx, gy] = this.grid(n);
    const params = this.uniform(n, words, gx);
    pass.setPipeline(this.gatherPipe);
    pass.setBindGroup(0, this.device.createBindGroup({ layout: this.gatherLayout, entries: entries([params, perm, src, dst]) }));
    pass.dispatchWorkgroups(gx, gy);
    return params;
  }

  /** orderOut[e] = orderIn[perm[e]]; rank[orderOut[e]] = e. */
  compose(pass: GPUComputePassEncoder, perm: GPUBuffer, orderIn: GPUBuffer, orderOut: GPUBuffer, rank: GPUBuffer, n: number): GPUBuffer {
    const [gx, gy] = this.grid(n);
    const params = this.uniform(n, 1, gx);
    pass.setPipeline(this.composePipe);
    pass.setBindGroup(0, this.device.createBindGroup({ layout: this.composeLayout, entries: entries([params, perm, orderIn, orderOut, rank]) }));
    pass.dispatchWorkgroups(gx, gy);
    return params;
  }

  createScatterSlot(label: string): ScatterSlot {
    return {
      params: this.device.createBuffer({ label: `${label}/params`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      ranges: this.device.createBuffer({ label: `${label}/ranges`, size: 64 * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
      upload: null,
      bindGroup: null,
      key: [],
    };
  }

  /**
   * Apply `total` user-indexed elements (already written to `slot.upload`, ranges
   * table already written) to `target` through `rank`.
   */
  scatter(pass: GPUComputePassEncoder, slot: ScatterSlot, rank: GPUBuffer, target: GPUBuffer, total: number, rangeCount: number, words: number): void {
    const [gx, gy] = this.grid(total);
    this.params[0] = total;
    this.params[1] = rangeCount;
    this.params[2] = words;
    this.params[3] = gx;
    this.device.queue.writeBuffer(slot.params, 0, this.params);
    const upload = slot.upload!;
    if (slot.key[0] !== upload || slot.key[1] !== rank || slot.key[2] !== target) {
      slot.bindGroup = this.device.createBindGroup({ layout: this.scatterLayout, entries: entries([slot.params, slot.ranges, upload, rank, target]) });
      slot.key = [upload, rank, target];
    }
    pass.setPipeline(this.scatterPipe);
    pass.setBindGroup(0, slot.bindGroup!);
    pass.dispatchWorkgroups(gx, gy);
  }

  private grid(n: number): [number, number] {
    const groups = Math.max(1, Math.ceil(n / WG));
    const gx = Math.min(groups, this.maxGroupsX);
    return [gx, Math.ceil(groups / gx)];
  }

  private uniform(n: number, words: number, gx: number): GPUBuffer {
    const b = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
    new Uint32Array(b.getMappedRange()).set([n, words, gx, 0]);
    b.unmap();
    return b;
  }
}

function entries(buffers: GPUBuffer[]): GPUBindGroupEntry[] {
  return buffers.map((buffer, binding) => ({ binding, resource: { buffer } }));
}

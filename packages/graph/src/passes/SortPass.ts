/**
 * SORT (§11.1): rebuild engine order when node positions changed wholesale.
 *
 *   sort.keys     Morton key per node (bits per axis adapt to node count)
 *   sort.radix    stable LSD radix sort, 4-bit digits (count → scan → scatter per digit)
 *   sort.shuffle  randomise order WITHIN each chunk, so an LOD prefix is a
 *                 uniform random sample (see shuffle_chunks.wgsl)
 *   sort.permute  gather every node channel into sorted order; update order/rank
 *
 * Temporary buffers live for one frame only. Measured on Intel Xe-LPG:
 * radix 3.3 ms @ 1M, 31 ms @ 10M; permute is a random gather (≈ 33 ms @ 10M).
 * Runs on bulk loads only — never per camera frame.
 */
import type { Bounds } from "../data/GraphStore";
import { ENGINE_CONSTANTS, WORKGROUP_SIZE, mortonBitsPerAxis } from "../data/Layouts";
import { Dirty } from "../engine/Dirty";
import type { ContractLayouts } from "../gpu/BindLayouts";
import { Stage, type ComputeNode, type FrameContext } from "../gpu/FrameGraph";
import type { GraphBuffers } from "../gpu/GraphBuffers";
import { createShaderModule } from "../gpu/ShaderModules";

const { CHUNK_SIZE, RADIX_BITS, RADIX_BINS } = ENGINE_CONSTANTS;
const PARAMS_BYTES = 32;


interface SortRun {
  n: number;
  blocks: number;
  passes: number;
  keys: [GPUBuffer, GPUBuffer];
  vals: [GPUBuffer, GPUBuffer];
  hist: GPUBuffer;
  params: GPUBuffer[];
  keysGroup: GPUBindGroup;
  radixGroups: GPUBindGroup[];
  shuffleGroupCache?: GPUBindGroup;
}

export class SortPass implements ComputeNode {
  readonly stage = Stage.SORT;
  readonly phases = ["sort.keys", "sort.radix", "sort.shuffle", "sort.permute"] as const;
  readonly runsOn = Dirty.TOPOLOGY | Dirty.POSITIONS;

  private run: SortRun | null = null;
  private readonly maxGroupsX: number;

  private constructor(
    private readonly device: GPUDevice,
    private readonly graph: GraphBuffers,
    private readonly bounds: Bounds,
    private readonly layout: GPUBindGroupLayout,
    private readonly keysLayout: GPUBindGroupLayout,
    private readonly emptyGroup: GPUBindGroup,
    private readonly keysPipe: GPUComputePipeline,
    private readonly countPipe: GPUComputePipeline,
    private readonly scanPipe: GPUComputePipeline,
    private readonly scatterPipe: GPUComputePipeline,
    private readonly shuffleLayout: GPUBindGroupLayout,
    private readonly shufflePipe: GPUComputePipeline,
  ) {
    this.maxGroupsX = device.limits.maxComputeWorkgroupsPerDimension;
  }

  static async create(device: GPUDevice, layouts: ContractLayouts, graph: GraphBuffers, bounds: Bounds): Promise<SortPass> {
    const [module, shuffleModule] = await Promise.all([
      createShaderModule(device, "passes/sort.wgsl"),
      createShaderModule(device, "passes/shuffle_chunks.wgsl"),
    ]);
    const s = (binding: number, type: GPUBufferBindingType) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    const layout = device.createBindGroupLayout({
      label: "group2/sort",
      entries: [s(0, "uniform"), s(1, "read-only-storage"), s(2, "read-only-storage"), s(3, "storage"), s(4, "storage"), s(5, "storage")],
    });
    // morton_keys also reads @group(1) (8 storage buffers): its own group(2) keeps it at 10.
    const keysBgl = device.createBindGroupLayout({ label: "group2/sort-keys", entries: [s(0, "uniform"), s(3, "storage"), s(4, "storage")] });
    // Radix kernels touch no engine bindings: groups 0 and 1 are empty for them.
    const empty = device.createBindGroupLayout({ label: "empty", entries: [] });
    const keysLayout = device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, layouts.graph, keysBgl] });
    const radixLayout = device.createPipelineLayout({ bindGroupLayouts: [empty, empty, layout] });
    const make = (entryPoint: string, pl: GPUPipelineLayout) =>
      device.createComputePipelineAsync({ label: `sort/${entryPoint}`, layout: pl, compute: { module, entryPoint } });
    const [keys, count, scan, scatter] = await Promise.all([
      make("morton_keys", keysLayout),
      make("radix_count", radixLayout),
      make("radix_scan", radixLayout),
      make("radix_scatter", radixLayout),
    ]);
    const shuffleBgl = device.createBindGroupLayout({ label: "group2/sort-shuffle", entries: [s(0, "uniform"), s(1, "storage")] });
    const shuffle = await device.createComputePipelineAsync({
      label: "sort/shuffle_chunks",
      layout: device.createPipelineLayout({ bindGroupLayouts: [empty, empty, shuffleBgl] }),
      compute: { module: shuffleModule, entryPoint: "shuffle_chunks" },
    });
    const emptyGroup = device.createBindGroup({ layout: empty, entries: [] });
    return new SortPass(device, graph, bounds, layout, keysBgl, emptyGroup, keys, count, scan, scatter, shuffleBgl, shuffle);
  }

  active(): boolean {
    return this.graph.needsSort;
  }

  prepare(ctx: FrameContext): void {
    this.run = this.createRun(ctx.nodeCount);
  }

  encodePhase(phase: number, pass: GPUComputePassEncoder, ctx: FrameContext): void {
    const r = this.run!;
    const [bx, by] = this.grid(r.blocks);
    switch (phase) {
      case 0: {
        const [gx, gy] = this.grid(Math.ceil(r.n / WORKGROUP_SIZE));
        pass.setPipeline(this.keysPipe);
        pass.setBindGroup(0, ctx.frameBindGroup);
        pass.setBindGroup(1, ctx.graphBindGroup);
        pass.setBindGroup(2, r.keysGroup);
        pass.dispatchWorkgroups(gx, gy);
        return;
      }
      case 1:
        pass.setBindGroup(0, this.emptyGroup);
        pass.setBindGroup(1, this.emptyGroup);
        for (let p = 0; p < r.passes; p++) {
          pass.setBindGroup(2, r.radixGroups[p]!);
          pass.setPipeline(this.countPipe);
          pass.dispatchWorkgroups(bx, by);
          pass.setPipeline(this.scanPipe);
          pass.dispatchWorkgroups(1);
          pass.setPipeline(this.scatterPipe);
          pass.dispatchWorkgroups(bx, by);
        }
        return;
      case 2: {
        // Radix pass p writes slot 1 - p % 2, so the final order is in slot passes % 2.
        pass.setBindGroup(0, this.emptyGroup);
        pass.setBindGroup(1, this.emptyGroup);
        pass.setPipeline(this.shufflePipe);
        pass.setBindGroup(2, this.shuffleGroup(r));
        pass.dispatchWorkgroups(bx, by);
        return;
      }
      case 3: {
        const perm = r.vals[r.passes % 2];
        this.graph.permute(pass, perm);
        ctx.graphBindGroup = this.graph.bindGroup;
        this.retireRun(r);
        this.run = null;
        return;
      }
    }
  }

  /** Bind group for the in-chunk shuffle: params + the sorted order array. */
  private shuffleGroup(r: SortRun): GPUBindGroup {
    if (!r.shuffleGroupCache) {
      const params = this.device.createBuffer({
        label: "sort/shuffleParams",
        size: 16,
        usage: GPUBufferUsage.UNIFORM,
        mappedAtCreation: true,
      });
      new Uint32Array(params.getMappedRange(), 0, 2).set([r.n, r.blocks]);
      params.unmap();
      r.params.push(params);
      r.shuffleGroupCache = this.device.createBindGroup({
        layout: this.shuffleLayout,
        entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 1, resource: { buffer: r.vals[r.passes % 2] } },
        ],
      });
    }
    return r.shuffleGroupCache;
  }

  /** Temporary buffers + bind groups for one sort of `n` nodes. */
  private createRun(n: number): SortRun {
    const bits = mortonBitsPerAxis(n);
    const passes = Math.ceil((2 * bits) / RADIX_BITS);
    const blocks = Math.ceil(n / CHUNK_SIZE);
    const words = (count: number) =>
      this.device.createBuffer({ label: "sort/tmp", size: Math.max(16, Math.ceil((count * 4) / 16) * 16), usage: GPUBufferUsage.STORAGE });
    const keys: [GPUBuffer, GPUBuffer] = [words(n), words(n)];
    const vals: [GPUBuffer, GPUBuffer] = [words(n), words(n)];
    const hist = words(blocks * RADIX_BINS);

    const b = this.bounds;
    const w = Math.max(b.maxX - b.minX, 1e-30);
    const h = Math.max(b.maxY - b.minY, 1e-30);
    const params: GPUBuffer[] = [];
    const makeParams = (shift: number) => {
      const buf = this.device.createBuffer({ label: "sort/params", size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
      const m = buf.getMappedRange();
      new Uint32Array(m, 0, 4).set([n, blocks, shift, bits]);
      new Float32Array(m, 16, 4).set([b.minX, b.minY, 1 / w, 1 / h]);
      buf.unmap();
      params.push(buf);
      return buf;
    };
    const group = (p: GPUBuffer, kin: GPUBuffer, vin: GPUBuffer, kout: GPUBuffer, vout: GPUBuffer) =>
      this.device.createBindGroup({
        layout: this.layout,
        entries: [p, kin, vin, kout, vout, hist].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });

    const keysGroup = this.device.createBindGroup({
      layout: this.keysLayout,
      entries: [
        { binding: 0, resource: { buffer: makeParams(0) } },
        { binding: 3, resource: { buffer: keys[0] } },
        { binding: 4, resource: { buffer: vals[0] } },
      ],
    });
    const radixGroups: GPUBindGroup[] = [];
    for (let p = 0; p < passes; p++) {
      const src = p % 2;
      const dst = 1 - src;
      radixGroups.push(group(makeParams(p * RADIX_BITS), keys[src], vals[src], keys[dst], vals[dst]));
    }
    return { n, blocks, passes, keys, vals, hist, params, keysGroup, radixGroups };
  }

  private retireRun(r: SortRun): void {
    // Destroyed after submit through the graph's retire list.
    this.graph.retireAfterSubmit(r.keys[0], r.keys[1], r.vals[0], r.vals[1], r.hist, ...r.params);
  }

  private grid(groups: number): [number, number] {
    const g = Math.max(1, groups);
    const gx = Math.min(g, this.maxGroupsX);
    return [gx, Math.ceil(g / gx)];
  }
}

/**
 * TRANSFORM_CULL (§9.1): chunk-level rejection, per-node classification,
 * compaction into NodeInstance records per bucket and drawIndirect args.
 * No CPU readback, ever. See transform_cull.wgsl / chunk_bounds.wgsl.
 *
 *   cull.bounds        1 workgroup / chunk   (only on data changes)
 *   cull.count         1 workgroup / chunk
 *   cull.scan.reduce   1 workgroup / scan block
 *   cull.scan.blocks   1 workgroup
 *   cull.scan.down     1 workgroup / scan block
 *   cull.scatter       indirect: 1 workgroup / non-empty chunk
 *
 * Owns the cull state buffer (counts, offsets, chunk list, chunk bounds).
 */
import { GraphError } from "../api/errors";
import {
  chunkCount, cullCellCount, cullScratchWords, drawStride, ENGINE_CONSTANTS, NODE_INSTANCE } from "../data/Layouts";
import { Dirty } from "../engine/Dirty";
import type { ContractLayouts } from "../gpu/BindLayouts";
import { Stage, type ComputeNode, type FrameContext } from "../gpu/FrameGraph";
import { createShaderModule } from "../gpu/ShaderModules";

/** Outputs consumed by the draw passes. `version` bumps when buffers are recreated. */
export interface CullOutputs {
  scratch: GPUBuffer;
  instances: GPUBuffer;
  version: number;
}

/** Grow with headroom so streaming node additions don't reallocate every frame. */
const GROWTH = 1.25;

interface PhaseLayouts {
  state: GPUBindGroupLayout;
  scan: GPUBindGroupLayout;
  scatter: GPUBindGroupLayout;
}

const BOUNDS_DIRTY = Dirty.TOPOLOGY | Dirty.POSITIONS | Dirty.STATE;

export class TransformCullPass implements ComputeNode {
  readonly stage = Stage.TRANSFORM_CULL;
  readonly phases = ["cull.bounds", "cull.count", "cull.scan.reduce", "cull.scan.blocks", "cull.scan.down", "cull.scatter"] as const;
  // Everything that moves, resizes, recolours or restyles nodes on screen. Not CLEAR_COLOR.
  readonly runsOn = Dirty.TOPOLOGY | Dirty.POSITIONS | Dirty.CAMERA | Dirty.STYLE | Dirty.STATE | Dirty.RESIZE;

  outputs: CullOutputs | null = null;
  private dispatchArgs: GPUBuffer;
  private groups: { state: GPUBindGroup; scan: GPUBindGroup; scatter: GPUBindGroup } | null = null;
  /** Chunk bounds / LOD clusters in the state buffer are stale (new buffer or data change). */
  private boundsStale = true;
  private capacity = 0;
  private gx = 0;
  private gy = 0;
  private sx = 0;
  private sy = 0;
  /** Chunk count the draw stride in the state buffer was written for (-1: stale). */
  private strideChunks = -1;
  private readonly strideWord = new Uint32Array(1);
  private readonly maxGroupsX: number;

  private constructor(
    private readonly device: GPUDevice,
    private readonly layouts: PhaseLayouts,
    private readonly bounds: GPUComputePipeline,
    private readonly count: GPUComputePipeline,
    private readonly reduce: GPUComputePipeline,
    private readonly scan: GPUComputePipeline,
    private readonly down: GPUComputePipeline,
    private readonly scatter: GPUComputePipeline,
  ) {
    this.maxGroupsX = device.limits.maxComputeWorkgroupsPerDimension;
    // Separate buffer: indirect args must not be bound in the dispatch that consumes them.
    this.dispatchArgs = device.createBuffer({ label: "cull/dispatchArgs", size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT });
  }

  static async create(device: GPUDevice, layouts: ContractLayouts, lodTargetPx: number): Promise<TransformCullPass> {
    const [module, boundsModule] = await Promise.all([
      createShaderModule(device, "passes/transform_cull.wgsl"),
      createShaderModule(device, "passes/chunk_bounds.wgsl"),
    ]);
    const e = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    // One layout per phase keeps each dispatch at <= 8 (graph) + 2 storage buffers, and
    // the indirect args buffer out of the dispatch that consumes it.
    const phase: PhaseLayouts = {
      state: device.createBindGroupLayout({ label: "group2/cull.state", entries: [e(0, "storage")] }),
      scan: device.createBindGroupLayout({ label: "group2/cull.scan", entries: [e(0, "storage"), e(2, "storage")] }),
      scatter: device.createBindGroupLayout({ label: "group2/cull.scatter", entries: [e(0, "storage"), e(3, "storage")] }),
    };
    const make = (m: GPUShaderModule, entryPoint: string, layout: GPUBindGroupLayout, constants?: Record<string, number>) =>
      device.createComputePipelineAsync({
        label: "cull/" + entryPoint + (constants ? `#${Object.values(constants).join(",")}` : ""),
        layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, layouts.graph, layout] }),
        compute: { module: m, entryPoint, constants },
      });
    const [bounds, count, reduce, scan, down, scatter] = await Promise.all([
      make(boundsModule, "chunk_bounds", phase.state),
      make(module, "cull_count", phase.state, { LOD_TARGET_PX: lodTargetPx }),
      make(module, "scan_reduce", phase.state),
      make(module, "scan_blocks", phase.scan),
      make(module, "scan_down", phase.state),
      make(module, "cull_scatter", phase.scatter, { LOD_TARGET_PX: lodTargetPx }),
    ]);
    return new TransformCullPass(device, phase, bounds, count, reduce, scan, down, scatter);
  }

  /** Ensure buffers fit `nodeCount`. Old buffers go to `retire`. */
  reserve(nodeCount: number, retire: (b: GPUBuffer) => void): void {
    if (nodeCount <= this.capacity && this.outputs) return;
    const cap = Math.max(1024, Math.ceil(nodeCount * GROWTH));
    const instanceBytes = cap * NODE_INSTANCE.size;
    const limits = this.device.limits;
    if (instanceBytes > limits.maxStorageBufferBindingSize || instanceBytes > limits.maxBufferSize) {
      // Buffer chunking above binding limits is milestone 9 (§3.1).
      throw new GraphError(
        "limits-exceeded",
        `${nodeCount.toLocaleString("en-US")} nodes need a ${(instanceBytes / 2 ** 20).toFixed(0)} MiB instance buffer; ` +
          `this GPU binds at most ${(limits.maxStorageBufferBindingSize / 2 ** 20).toFixed(0)} MiB.`,
      );
    }
    if (this.outputs) {
      retire(this.outputs.scratch);
      retire(this.outputs.instances);
    }
    const scratch = this.device.createBuffer({
      label: "cull/scratch",
      size: cullScratchWords(cap) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const instances = this.device.createBuffer({ label: "cull/instances", size: instanceBytes, usage: GPUBufferUsage.STORAGE });
    this.outputs = { scratch, instances, version: (this.outputs?.version ?? 0) + 1 };
    this.capacity = cap;
    this.groups = null; // rebuilt in prepare()
    this.boundsStale = true;
    this.strideChunks = -1;

  }

  phaseActive(phase: number, ctx: FrameContext): boolean {
    return phase !== 0 || this.boundsStale || (ctx.dirty & BOUNDS_DIRTY) !== 0;
  }

  prepare(ctx: FrameContext): void {
    const out = this.outputs!;
    if (!this.groups) {
      const bg = (layout: GPUBindGroupLayout, entries: [number, GPUBuffer][]) =>
        this.device.createBindGroup({ layout, entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })) });
      this.groups = {
        state: bg(this.layouts.state, [[0, out.scratch]]),
        scan: bg(this.layouts.scan, [[0, out.scratch], [2, this.dispatchArgs]]),
        scatter: bg(this.layouts.scatter, [[0, out.scratch], [3, out.instances]]),
      };
    }
    const chunks = chunkCount(ctx.nodeCount);
    if (chunks !== this.strideChunks) {
      this.strideWord[0] = drawStride(chunks);
      this.device.queue.writeBuffer(out.scratch, ENGINE_CONSTANTS.SCRATCH_DRAW_STRIDE * 4, this.strideWord);
      this.strideChunks = chunks;
    }
    this.gx = Math.min(chunks, this.maxGroupsX);
    this.gy = Math.ceil(chunks / this.gx);
    const blocks = Math.max(1, Math.ceil(cullCellCount(ctx.nodeCount) / ENGINE_CONSTANTS.CHUNK_SIZE));
    this.sx = Math.min(blocks, this.maxGroupsX);
    this.sy = Math.ceil(blocks / this.sx);
  }

  encodePhase(phase: number, pass: GPUComputePassEncoder, ctx: FrameContext): void {
    const g = this.groups!;
    pass.setBindGroup(0, ctx.frameBindGroup);
    pass.setBindGroup(1, ctx.graphBindGroup);
    switch (phase) {
      case 0:
        pass.setPipeline(this.bounds);
        pass.setBindGroup(2, g.state);
        pass.dispatchWorkgroups(this.gx, this.gy);
        this.boundsStale = false;
        return;
      case 1:
        pass.setPipeline(this.count);
        pass.setBindGroup(2, g.state);
        pass.dispatchWorkgroups(this.gx, this.gy);
        return;
      case 2:
        pass.setPipeline(this.reduce);
        pass.setBindGroup(2, g.state);
        pass.dispatchWorkgroups(this.sx, this.sy);
        return;
      case 3:
        pass.setPipeline(this.scan);
        pass.setBindGroup(2, g.scan);
        pass.dispatchWorkgroups(1);
        return;
      case 4:
        pass.setPipeline(this.down);
        pass.setBindGroup(2, g.state);
        pass.dispatchWorkgroups(this.sx, this.sy);
        return;
      case 5:
        pass.setPipeline(this.scatter);
        pass.setBindGroup(2, g.scatter);
        pass.dispatchWorkgroupsIndirect(this.dispatchArgs, 0);
        return;
    }
  }

  /** Indirect args of cull_scatter: one workgroup per chunk with a visible node. */
  get dispatch(): GPUBuffer {
    return this.dispatchArgs;
  }

  destroy(): void {
    this.outputs?.scratch.destroy();
    this.outputs?.instances.destroy();
    this.dispatchArgs.destroy();
  }
}

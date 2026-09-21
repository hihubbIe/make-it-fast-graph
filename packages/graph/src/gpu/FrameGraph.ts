/**
 * Fixed stage order (§7) and pass execution.
 *
 * - Compute nodes run in stage order, only when one of their `runsOn` dirty
 *   flags is set. Each phase of a node gets its own compute pass so it is timed
 *   individually (compute pass boundaries are cheap, unlike render passes).
 * - Render nodes share ONE render pass — `beginRenderPass` is a real cost on
 *   tiled GPUs. The render pass is timed as a whole ("render").
 */
import type { Profiler } from "./Profiler";

export const Stage = {
  UPLOAD: 0,
  PRE_COMPUTE: 1,
  SORT: 2,
  EDGE_SORT: 3,
  TRANSFORM_CULL: 4,
  NEIGHBOR: 5,
  EDGE_CULL: 6,
  EDGE_GEOMETRY: 7,
  NODE_RASTER: 8,
  NODE_GEOMETRY: 9,
  HALO: 10,
  LABEL_PLACE: 11,
  LABEL_DRAW: 12,
  POST: 13,
  RESOLVE: 14,
  PICK: 15,
} as const;

export type StageId = (typeof Stage)[keyof typeof Stage];

/** Per-frame inputs shared by every pass. One instance, mutated each frame. */
export interface FrameContext {
  frameBindGroup: GPUBindGroup;
  graphBindGroup: GPUBindGroup;
  nodeCount: number;
  edgeCount: number;
  /** Dirty flags that triggered this frame (see engine/Dirty.ts). */
  dirty: number;
}

export interface ComputeNode {
  readonly stage: StageId;
  /** Profiler slot names, one per phase, encoded in order. */
  readonly phases: readonly string[];
  /** Dirty flags that require this pass to run; otherwise its last output is reused. */
  readonly runsOn: number;
  /** Optional extra gate (e.g. "has queued work"), checked after `runsOn`. */
  active?(ctx: FrameContext): boolean;
  /** Called once per frame before its phases are encoded. */
  prepare?(ctx: FrameContext): void;
  /** Optional per-phase gate (e.g. a phase that only runs on data changes). */
  phaseActive?(phase: number, ctx: FrameContext): boolean;
  encodePhase(phase: number, pass: GPUComputePassEncoder, ctx: FrameContext): void;
}

export interface RenderNode {
  readonly stage: StageId;
  encode(pass: GPURenderPassEncoder, ctx: FrameContext): void;
}

interface TimedCompute {
  node: ComputeNode;
  slots: number[];
  descs: GPUComputePassDescriptor[];
}

export class FrameGraph {
  private readonly computeNodes: TimedCompute[] = [];
  private readonly renderNodes: RenderNode[] = [];
  private readonly renderSlot: number;
  // Reused descriptors: no allocation per frame.
  private readonly attachment: GPURenderPassColorAttachment = {
    view: undefined as unknown as GPUTextureView,
    loadOp: "clear",
    storeOp: "store",
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
  };
  private readonly passDesc: GPURenderPassDescriptor;

  constructor(private readonly profiler: Profiler) {
    this.renderSlot = profiler.register("render");
    this.passDesc = { label: "render", colorAttachments: [this.attachment] };
  }

  addCompute(node: ComputeNode): void {
    const slots = node.phases.map((p) => this.profiler.register(p));
    this.computeNodes.push({ node, slots, descs: node.phases.map((label) => ({ label })) });
    this.computeNodes.sort((a, b) => a.node.stage - b.node.stage);
  }

  addRender(node: RenderNode): void {
    this.renderNodes.push(node);
    this.renderNodes.sort((a, b) => a.stage - b.stage);
  }

  /** Clear colour, straight alpha (converted to premultiplied). */
  setClearColor(r: number, g: number, b: number, a: number): void {
    this.attachment.clearValue = { r: r * a, g: g * a, b: b * a, a };
  }

  execute(encoder: GPUCommandEncoder, target: GPUTextureView, ctx: FrameContext): void {
    for (let i = 0; i < this.computeNodes.length; i++) {
      const c = this.computeNodes[i]!;
      if ((ctx.dirty & c.node.runsOn) === 0 || ctx.nodeCount === 0) continue;
      if (c.node.active && !c.node.active(ctx)) continue;
      c.node.prepare?.(ctx);
      for (let p = 0; p < c.slots.length; p++) {
        if (c.node.phaseActive && !c.node.phaseActive(p, ctx)) continue;
        const desc = c.descs[p]!;
        desc.timestampWrites = this.profiler.timestampWrites(c.slots[p]!);
        const pass = encoder.beginComputePass(desc);
        c.node.encodePhase(p, pass, ctx);
        pass.end();
      }
    }

    this.attachment.view = target;
    this.passDesc.timestampWrites = this.profiler.timestampWrites(this.renderSlot);
    const pass = encoder.beginRenderPass(this.passDesc);
    for (let i = 0; i < this.renderNodes.length; i++) this.renderNodes[i]!.encode(pass, ctx);
    pass.end();
  }
}

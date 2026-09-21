/**
 * EDGE_GEOMETRY: one indirect instanced draw over the draw list EDGE_CULL
 * wrote, before the nodes in the shared render pass so edges sit under them.
 * Premultiplied alpha, no vertex buffers.
 */
import { EDGE_CONSTANTS } from "../data/Layouts";
import type { ContractLayouts } from "../gpu/BindLayouts";
import { Stage, type FrameContext, type RenderNode } from "../gpu/FrameGraph";
import { createShaderModule } from "../gpu/ShaderModules";
import type { EdgeCullOptions, EdgeCullOutputs } from "./EdgeCullPass";

/** Pipeline variant index: bit 0 = per-edge style, bit 1 = per-edge colour. */
const VARIANTS = 4;

export class EdgeGeometryPass implements RenderNode {
  readonly stage = Stage.EDGE_GEOMETRY;

  /** Set by the engine from what the store holds. */
  perEdgeStyle = false;
  perEdgeColor = false;

  private bound: EdgeCullOutputs | null = null;
  private bindGroup: GPUBindGroup | null = null;

  private constructor(
    private readonly device: GPUDevice,
    private readonly layout: GPUBindGroupLayout,
    private readonly pipelines: readonly GPURenderPipeline[],
  ) {}

  static async create(device: GPUDevice, format: GPUTextureFormat, layouts: ContractLayouts, opts: EdgeCullOptions): Promise<EdgeGeometryPass> {
    const module = await createShaderModule(device, "passes/edge_geometry.wgsl");
    const read = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } });
    const layout = device.createBindGroupLayout({ label: "group2/edges", entries: [read(0), read(1)] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, layouts.graph, layout] });
    const blend: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    // Every variant is built up front: choosing one must never wait inside a frame.
    const make = (v: number) => {
      const constants = {
        EDGE_ARROWS: opts.directed ? 1 : 0,
        EDGE_MAX_OVERDRAW: opts.maxOverdraw,
        EDGE_MIN_LEN_PX: opts.minLengthPx,
        EDGE_DEBUG: opts.debug,
        EDGE_PER_EDGE_STYLE: v & 1,
        EDGE_PER_EDGE_COLOR: (v >> 1) & 1,
      };
      return device.createRenderPipelineAsync({
        label: `edges#${v}`,
        layout: pipelineLayout,
        vertex: { module, entryPoint: "vs", constants },
        fragment: { module, entryPoint: "fs", targets: [{ format, blend }], constants },
        primitive: { topology: "triangle-strip" },
      });
    };
    const pipelines = await Promise.all(Array.from({ length: VARIANTS }, (_, v) => make(v)));
    return new EdgeGeometryPass(device, layout, pipelines);
  }

  /** (Re)bind the cull outputs; a no-op when unchanged. */
  bind(outputs: EdgeCullOutputs): void {
    if (outputs.scratch === this.bound?.scratch && outputs.list === this.bound.list) return;
    this.bound = { ...outputs };
    this.bindGroup = this.device.createBindGroup({
      label: "group2/edges",
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: outputs.scratch } },
        { binding: 1, resource: { buffer: outputs.list } },
      ],
    });
  }

  encode(pass: GPURenderPassEncoder, ctx: FrameContext): void {
    if (ctx.edgeCount === 0 || ctx.nodeCount === 0 || !this.bindGroup || !this.bound) return;
    pass.setPipeline(this.pipelines[(this.perEdgeStyle ? 1 : 0) | (this.perEdgeColor ? 2 : 0)]!);
    pass.setBindGroup(0, ctx.frameBindGroup);
    pass.setBindGroup(1, ctx.graphBindGroup);
    pass.setBindGroup(2, this.bindGroup);
    // Instance count is written by the cull: the CPU never learns it.
    pass.drawIndirect(this.bound.scratch, EDGE_CONSTANTS.EDGE_SCRATCH_DRAW_ARGS * 4);
  }
}

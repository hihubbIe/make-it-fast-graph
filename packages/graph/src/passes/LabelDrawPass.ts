/**
 * LABEL_DRAW: one instanced draw of the placed labels (LabelLayout), last in
 * the shared render pass so labels sit on top. See label_draw.wgsl.
 */
import type { ContractLayouts } from "../gpu/BindLayouts";
import { Stage, type FrameContext, type RenderNode } from "../gpu/FrameGraph";
import { createShaderModule } from "../gpu/ShaderModules";
import type { LabelAtlas } from "../labels/LabelAtlas";
import type { LabelLayout } from "../labels/LabelLayout";

export class LabelDrawPass implements RenderNode {
  readonly stage = Stage.LABEL_DRAW;

  private bindGroup: GPUBindGroup | null = null;
  private bound: GPUBuffer | null = null;

  private constructor(
    private readonly device: GPUDevice,
    private readonly layout: GPUBindGroupLayout,
    private readonly pipeline: GPURenderPipeline,
    private readonly labels: LabelLayout,
    private readonly atlas: LabelAtlas,
  ) {}

  static async create(
    device: GPUDevice,
    format: GPUTextureFormat,
    layouts: ContractLayouts,
    labels: LabelLayout,
    atlas: LabelAtlas,
  ): Promise<LabelDrawPass> {
    const module = await createShaderModule(device, "passes/label_draw.wgsl");
    const layout = device.createBindGroupLayout({
      label: "group2/labels",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        // The vertex stage reads the atlas size; the fragment stage samples it.
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });
    const blend: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const pipeline = await device.createRenderPipelineAsync({
      label: "labels",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, layouts.graph, layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format, blend }] },
      primitive: { topology: "triangle-strip" },
    });
    return new LabelDrawPass(device, layout, pipeline, labels, atlas);
  }

  encode(pass: GPURenderPassEncoder, ctx: FrameContext): void {
    const n = this.labels.count;
    const buffer = this.labels.buffer;
    if (n === 0 || !buffer || ctx.nodeCount === 0) return;
    if (buffer !== this.bound) {
      this.bound = buffer;
      this.bindGroup = this.device.createBindGroup({
        label: "group2/labels",
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer } },
          { binding: 1, resource: this.atlas.view },
        ],
      });
    }
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, ctx.frameBindGroup);
    pass.setBindGroup(1, ctx.graphBindGroup);
    pass.setBindGroup(2, this.bindGroup!);
    pass.draw(4, n);
  }
}

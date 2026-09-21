/** UPLOAD (§7 stage 0): GPU half of data uploads — permutes replaced channels, applies partial updates. */
import { Dirty } from "../engine/Dirty";
import { Stage, type ComputeNode, type FrameContext } from "../gpu/FrameGraph";
import type { GraphBuffers } from "../gpu/GraphBuffers";

export class UploadPass implements ComputeNode {
  readonly stage = Stage.UPLOAD;
  readonly phases = ["upload"] as const;
  readonly runsOn = Dirty.TOPOLOGY | Dirty.POSITIONS | Dirty.STYLE | Dirty.STATE;

  constructor(private readonly graph: GraphBuffers) {}

  active(): boolean {
    return this.graph.hasPendingWork;
  }

  encodePhase(_phase: number, pass: GPUComputePassEncoder, ctx: FrameContext): void {
    this.graph.encode(pass);
    ctx.graphBindGroup = this.graph.bindGroup;
  }
}

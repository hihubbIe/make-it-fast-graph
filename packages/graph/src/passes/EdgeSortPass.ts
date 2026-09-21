/**
 * EDGE_SORT: on data changes only, turn the user's edge list into the form the
 * per-frame edge passes rely on — endpoints as ENGINE node indices, edges
 * sorted by (length level, midpoint Z-order), shuffled within each chunk. See
 * edge_sort.wgsl for why that key makes a 1024-edge chunk a meaningful unit to
 * cull; the shuffle makes any prefix of a chunk a random sample of it, which
 * is what thinning draws (edgeKeep in edges.wgsl).
 *
 *   edge.keys     user -> engine endpoints (through rank), one sort key per edge
 *   edge.radix    stable LSD radix sort (the kernels of the node sort)
 *   edge.shuffle  permute each chunk by a hash of the user's edge index
 *                 (shuffle_chunks.wgsl, the node LOD's kernel): stable per edge
 *   edge.permute  gather endpoints, styles and colours into sorted order
 *
 * Input is always the edge list as the user gave it (GraphBuffers re-uploads
 * it whenever the nodes are renumbered), so no permutations are ever composed.
 * Runs after SORT, so `rank` and node positions are this frame's.
 */
import type { Bounds } from "../data/GraphStore";
import { EDGE_CONSTANTS, edgeChunkCount, mortonBitsPerAxis } from "../data/Layouts";
import { Dirty } from "../engine/Dirty";
import { Stage, type ComputeNode, type FrameContext } from "../gpu/FrameGraph";
import type { GraphBuffers } from "../gpu/GraphBuffers";
import { RadixSort, type RadixRun } from "../gpu/RadixSort";
import { createShaderModule } from "../gpu/ShaderModules";

const WG = 256;
/** Size of `EdgeKeyParams` in edge_sort.wgsl, rounded up to 16. */
const PARAMS_BYTES = 48;
const LEVEL_BITS = EDGE_CONSTANTS.EDGE_LEVEL_BITS;
/** Morton bits per axis, capped so the level still fits above them in 32 bits. */
const MAX_BITS_PER_AXIS = (32 - LEVEL_BITS) >> 1;

interface Run {
  sort: RadixRun;
  /** Engine-index endpoints in user order, written by edge.keys. */
  engineIdx: GPUBuffer;
  params: GPUBuffer;
  shuffleGroup: GPUBindGroup;
  shuffleParams: GPUBuffer;
}

export class EdgeSortPass implements ComputeNode {
  readonly stage = Stage.EDGE_SORT;
  readonly phases = ["edge.keys", "edge.radix", "edge.shuffle", "edge.permute"] as const;
  readonly runsOn = Dirty.TOPOLOGY | Dirty.POSITIONS | Dirty.EDGES;

  private run: Run | null = null;
  private readonly maxGroupsX: number;

  private constructor(
    private readonly device: GPUDevice,
    private readonly graph: GraphBuffers,
    private readonly bounds: Bounds,
    private readonly radix: RadixSort,
    private readonly keysLayout: GPUBindGroupLayout,
    private readonly keysPipe: GPUComputePipeline,
    private readonly shuffleLayout: GPUBindGroupLayout,
    private readonly shufflePipe: GPUComputePipeline,
    private readonly empty: GPUBindGroup,
  ) {
    this.maxGroupsX = device.limits.maxComputeWorkgroupsPerDimension;
  }

  static async create(device: GPUDevice, graph: GraphBuffers, bounds: Bounds): Promise<EdgeSortPass> {
    const [module, shuffleModule, radix] = await Promise.all([
      createShaderModule(device, "passes/edge_sort.wgsl"),
      createShaderModule(device, "passes/shuffle_chunks.wgsl"),
      RadixSort.create(device),
    ]);
    const s = (binding: number, type: GPUBufferBindingType) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    const keysLayout = device.createBindGroupLayout({
      label: "edge-keys",
      entries: [
        s(0, "uniform"),
        s(1, "read-only-storage"),
        s(2, "read-only-storage"),
        s(3, "read-only-storage"),
        s(4, "storage"),
        s(5, "storage"),
        s(6, "storage"),
      ],
    });
    const keysPipe = await device.createComputePipelineAsync({
      label: "edge/keys",
      layout: device.createPipelineLayout({ bindGroupLayouts: [keysLayout] }),
      compute: { module, entryPoint: "edge_keys" },
    });
    // The shuffle touches no engine bindings: groups 0 and 1 are empty.
    const emptyLayout = device.createBindGroupLayout({ label: "empty", entries: [] });
    const shuffleLayout = device.createBindGroupLayout({ label: "group2/edge-shuffle", entries: [s(0, "uniform"), s(1, "storage")] });
    const shufflePipe = await device.createComputePipelineAsync({
      label: "edge/shuffle",
      layout: device.createPipelineLayout({ bindGroupLayouts: [emptyLayout, emptyLayout, shuffleLayout] }),
      compute: { module: shuffleModule, entryPoint: "shuffle_chunks" },
    });
    const empty = device.createBindGroup({ layout: emptyLayout, entries: [] });
    return new EdgeSortPass(device, graph, bounds, radix, keysLayout, keysPipe, shuffleLayout, shufflePipe, empty);
  }

  active(ctx: FrameContext): boolean {
    return ctx.edgeCount > 0 && this.graph.edgesUnsorted;
  }

  prepare(ctx: FrameContext): void {
    const n = ctx.edgeCount;
    const bits = Math.min(MAX_BITS_PER_AXIS, mortonBitsPerAxis(n));
    const sort = this.radix.begin(n, 2 * bits + LEVEL_BITS);
    const engineIdx = this.device.createBuffer({ label: "edge/engineIdx", size: Math.max(16, n * 8), usage: GPUBufferUsage.STORAGE });

    const b = this.bounds;
    const w = Math.max(b.maxX - b.minX, 1e-30);
    const h = Math.max(b.maxY - b.minY, 1e-30);
    const params = this.device.createBuffer({ label: "edge/keyParams", size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
    const m = params.getMappedRange();
    new Uint32Array(m, 0, 4).set([n, ctx.nodeCount, bits, 1 << LEVEL_BITS]);
    new Float32Array(m, 16, 5).set([b.minX, b.minY, 1 / w, 1 / h, 1 / Math.max(w, h)]);
    new Uint32Array(m, 36, 1)[0] = this.grid(Math.ceil(n / WG))[0];
    params.unmap();

    // shuffle_chunks.wgsl: (item count, chunk count). Its chunks are 1024 wide, as ours are.
    const shuffleParams = this.device.createBuffer({ label: "edge/shuffleParams", size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
    new Uint32Array(shuffleParams.getMappedRange(), 0, 2).set([n, edgeChunkCount(n)]);
    shuffleParams.unmap();
    const shuffleGroup = this.device.createBindGroup({
      layout: this.shuffleLayout,
      entries: [
        { binding: 0, resource: { buffer: shuffleParams } },
        { binding: 1, resource: { buffer: sort.sorted } },
      ],
    });

    this.run = { sort, engineIdx, params, shuffleGroup, shuffleParams };
  }

  encodePhase(phase: number, pass: GPUComputePassEncoder, ctx: FrameContext): void {
    const r = this.run!;
    switch (phase) {
      case 0: {
        const g = this.graph;
        pass.setPipeline(this.keysPipe);
        pass.setBindGroup(
          0,
          this.device.createBindGroup({
            layout: this.keysLayout,
            entries: [r.params, g.buffers.edgeIdx, g.rank, g.buffers.nodePos, r.sort.keys[0], r.sort.vals[0], r.engineIdx].map(
              (buffer, binding) => ({ binding, resource: { buffer } }),
            ),
          }),
        );
        const [gx, gy] = this.grid(Math.ceil(ctx.edgeCount / WG));
        pass.dispatchWorkgroups(gx, gy);
        return;
      }
      case 1:
        this.radix.encode(pass, r.sort);
        return;
      case 2: {
        const [gx, gy] = this.grid(edgeChunkCount(ctx.edgeCount));
        pass.setPipeline(this.shufflePipe);
        pass.setBindGroup(0, this.empty);
        pass.setBindGroup(1, this.empty);
        pass.setBindGroup(2, r.shuffleGroup);
        pass.dispatchWorkgroups(gx, gy);
        return;
      }
      case 3: {
        this.graph.adoptSortedEdges(pass, r.sort.sorted, r.engineIdx, ctx.edgeCount);
        ctx.graphBindGroup = this.graph.bindGroup;
        // The final order is exactly sorted edge -> user edge: edge labels keep it.
        const keep = this.graph.keepEdgeOrder;
        this.graph.setEdgeOrder(keep ? r.sort.sorted : null);
        const temps = r.sort.buffers.filter((b) => !keep || b !== r.sort.sorted);
        this.graph.retireAfterSubmit(r.engineIdx, r.params, r.shuffleParams, ...temps);
        this.run = null;
        return;
      }
    }
  }

  private grid(groups: number): [number, number] {
    const g = Math.max(1, groups);
    const gx = Math.min(g, this.maxGroupsX);
    return [gx, Math.ceil(g / gx)];
  }
}

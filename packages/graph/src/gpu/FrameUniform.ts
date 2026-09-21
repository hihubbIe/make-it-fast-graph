/**
 * @group(0): the Frame uniform + samplers. One CPU staging ArrayBuffer is
 * reused every frame — no allocation in the frame loop.
 */
import type { Camera2D } from "../camera/Camera2D";
import { FRAME } from "../data/Layouts";

const O = FRAME.offset;
const F = (byteOffset: number) => byteOffset >> 2;

export interface FrameInputs {
  camera: Camera2D;
  pixelRatio: number;
  time: number;
  frameIndex: number;
  pointerX: number;
  pointerY: number;
  nodeCount: number;
  edgeCount: number;
  nodeScale: number;
  edgeWidth: number;
  /** rgba8unorm tint for edges with no per-edge colour. */
  edgeColor: number;
  flags: number;
}

export class FrameUniform {
  readonly buffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  private readonly cpu = new ArrayBuffer(FRAME.size);
  private readonly f32 = new Float32Array(this.cpu);
  private readonly u32 = new Uint32Array(this.cpu);

  constructor(
    private readonly device: GPUDevice,
    layout: GPUBindGroupLayout,
  ) {
    this.buffer = device.createBuffer({
      label: "frame",
      size: FRAME.size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const linear = device.createSampler({ label: "samp_linear", magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });
    const nearest = device.createSampler({ label: "samp_nearest" });
    this.bindGroup = device.createBindGroup({
      label: "group0/frame",
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.buffer } },
        { binding: 1, resource: linear },
        { binding: 2, resource: nearest },
      ],
    });
  }

  write(i: FrameInputs): void {
    const f = this.f32;
    const u = this.u32;
    const c = i.camera;
    const w = c.viewportW;
    const h = c.viewportH;

    // Hi/lo split of the f64 centre: hi = nearest f32, lo = f32 residual.
    const hx = Math.fround(c.x);
    const hy = Math.fround(c.y);
    f[F(O.originHi)] = hx;
    f[F(O.originHi) + 1] = hy;
    f[F(O.originLo)] = c.x - hx;
    f[F(O.originLo) + 1] = c.y - hy;

    f[F(O.scale)] = (2 * c.zoom) / w;
    f[F(O.scale) + 1] = (2 * c.zoom) / h;
    f[F(O.rotation)] = Math.cos(c.rotation);
    f[F(O.rotation) + 1] = Math.sin(c.rotation);
    f[F(O.viewportPx)] = w;
    f[F(O.viewportPx) + 1] = h;
    f[F(O.invViewportPx)] = 1 / w;
    f[F(O.invViewportPx) + 1] = 1 / h;
    f[F(O.pixelRatio)] = i.pixelRatio;
    f[F(O.zoom)] = c.zoom;
    f[F(O.time)] = i.time;
    u[F(O.frameIndex)] = i.frameIndex;
    f[F(O.pointerPx)] = i.pointerX;
    f[F(O.pointerPx) + 1] = i.pointerY;
    u[F(O.rasterDim)] = w;
    u[F(O.rasterDim) + 1] = h;
    u[F(O.nodeCount)] = i.nodeCount;
    u[F(O.edgeCount)] = i.edgeCount;
    f[F(O.globalNodeScale)] = i.nodeScale;
    f[F(O.globalEdgeWidth)] = i.edgeWidth;
    u[F(O.flags)] = i.flags;
    u[F(O.globalEdgeColor)] = i.edgeColor;

    this.device.queue.writeBuffer(this.buffer, 0, this.cpu);
  }

  destroy(): void {
    this.buffer.destroy();
  }
}

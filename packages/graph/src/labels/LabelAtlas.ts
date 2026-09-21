/**
 * Label images. Each label's text, with a dark outline, is drawn ONCE by the
 * browser into one shared texture, at exactly its on-screen size, so the GPU
 * only has to position a textured quad. The browser's own text engine does
 * the shaping, kerning and every script and emoji, which a glyph atlas would
 * have to reimplement.
 *
 * Shelf-packed. When full it starts over (`generation` bumps) and callers drop
 * the images they held; labels fade, so the rebuild is not visible.
 */

const ATLAS_SIZE = 2048;
/** Transparent border inside every image, so linear sampling never pulls in a neighbour. */
const PAD = 2;
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
const HALO = "rgba(8, 10, 14, 0.85)";
/**
 * New images drawn per placement. Drawing text costs tens of microseconds; the
 * rest are drawn on the next placement, and their labels fade in a moment later.
 */
const RASTER_BUDGET = 64;

export interface AtlasEntry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class LabelAtlas {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  /** Bumps when the atlas starts over: every entry handed out before is gone. */
  generation = 0;
  private readonly entries = new Map<string, AtlasEntry>();
  private readonly canvas = new OffscreenCanvas(256, 64);
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private x = 0;
  private y = 0;
  private rowH = 0;
  private budget = RASTER_BUDGET;

  constructor(private readonly device: GPUDevice) {
    this.texture = device.createTexture({
      label: "labels/atlas",
      size: [ATLAS_SIZE, ATLAS_SIZE],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.view = this.texture.createView();
    this.ctx = this.canvas.getContext("2d")!;
  }

  /** Allow another RASTER_BUDGET new images. */
  refill(): void {
    this.budget = RASTER_BUDGET;
  }

  /**
   * The image of `text` at `px` device px in colour `fill`, drawn now if it is
   * new. Null when this placement's budget is spent or the atlas just filled up.
   */
  get(text: string, px: number, fill: string): AtlasEntry | null {
    const key = `${px}|${fill}|${text}`;
    const hit = this.entries.get(key);
    if (hit) return hit;
    if (this.budget <= 0) return null;
    this.budget--;

    const ctx = this.ctx;
    const font = `${px}px ${FONT}`;
    const halo = Math.max(2, Math.round(px / 5));
    const inset = halo + PAD;
    ctx.font = font;
    const w = Math.min(ATLAS_SIZE, Math.ceil(ctx.measureText(text).width) + 2 * inset);
    const h = Math.ceil(px * 1.35) + 2 * inset;
    if (this.x + w > ATLAS_SIZE) {
      this.x = 0;
      this.y += this.rowH;
      this.rowH = 0;
    }
    if (this.y + h > ATLAS_SIZE) {
      this.reset();
      return null;
    }
    const canvas = this.canvas;
    if (canvas.width < w || canvas.height < h) {
      // Resizing clears the context state, so the font is set again below.
      canvas.width = Math.max(canvas.width, w);
      canvas.height = Math.max(canvas.height, h);
    }
    ctx.clearRect(0, 0, w, h);
    ctx.font = font;
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = halo * 2;
    ctx.strokeStyle = HALO;
    ctx.strokeText(text, inset, h / 2);
    ctx.fillStyle = fill;
    ctx.fillText(text, inset, h / 2);
    this.device.queue.copyExternalImageToTexture(
      { source: canvas, origin: { x: 0, y: 0 } },
      { texture: this.texture, origin: { x: this.x, y: this.y }, premultipliedAlpha: true },
      [w, h],
    );

    const entry = { x: this.x, y: this.y, w, h };
    this.entries.set(key, entry);
    this.x += w;
    this.rowH = Math.max(this.rowH, h);
    return entry;
  }

  /** Forget every image; the texture is overwritten as new ones are drawn. */
  reset(): void {
    this.entries.clear();
    this.x = this.y = this.rowH = 0;
    this.generation++;
  }

  destroy(): void {
    this.texture.destroy();
  }
}

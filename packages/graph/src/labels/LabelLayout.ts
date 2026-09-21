/**
 * Which labels are shown, and their fades. Greedy placement on the CPU from the
 * GPU's candidates (LabelPass): node labels first, biggest node first; then
 * edge labels, longest edge first, only where the text fits along the edge. A
 * label is kept only where it overlaps none placed before it, tested on a
 * coarse occupancy grid. A label already on screen gets a head start, so
 * labels do not flip between neighbours while the view moves.
 *
 * Anchors are engine node / sorted edge indices, so a label follows its node
 * on the GPU every frame even though placement runs a frame or two behind.
 */
import type { GraphStore } from "../data/GraphStore";
import { LABEL_CONSTANTS, LABEL_INSTANCE } from "../data/Layouts";
import type { AtlasEntry, LabelAtlas } from "./LabelAtlas";

const { LABEL_KIND_NODE, LABEL_KIND_EDGE } = LABEL_CONSTANTS;
/** LabelRecord / 4. */
const RECORD_WORDS = 8;
/** Seconds to fade a label fully in or out. */
const FADE_S = 0.15;
/** Priority head start for a label already on screen. */
const STAY_BONUS = 1.5;
/** Occupancy grid cell, device px. */
const CELL = 4;
/** Space between a node's rim and its label, CSS px (label_draw.wgsl). */
const GAP_CSS_PX = 4;
/** Edge labels are smaller than node labels, and dimmer. */
const EDGE_SCALE = 0.85;
const NODE_FILL = "#e9edf3";
const EDGE_FILL = "#b9c3d0";
/** Share of an edge's on-screen length its label may take. */
const EDGE_FIT = 0.7;

/** One kind of candidates, as read back: `count` records from word 0. */
export interface Candidates {
  u32: Uint32Array;
  f32: Float32Array;
  count: number;
}

export interface LabelOptions {
  /** Node label size, CSS px. */
  sizeCssPx: number;
  /** Labels on screen at most, nodes and edges together. */
  max: number;
}

interface Label {
  kind: number;
  anchor: number;
  entry: AtlasEntry;
  alpha: number;
  target: number;
}

export class LabelLayout {
  /** Instance buffer for LABEL_DRAW, or null before the first label. */
  buffer: GPUBuffer | null = null;
  /** Labels in `buffer`. */
  count = 0;
  private labels = new Map<number, Label>();
  private grid = new Uint8Array(0);
  private gridW = 0;
  private gridH = 0;
  private data = new ArrayBuffer(0);
  private dirty = false;
  private generation = 0;
  private lastMs = 0;

  constructor(
    private readonly device: GPUDevice,
    private readonly atlas: LabelAtlas,
    private readonly opts: LabelOptions,
  ) {}

  /** Drop the labels of one kind (their anchors changed meaning), or all. */
  clear(kind?: number): void {
    for (const [key, l] of this.labels) if (kind === undefined || l.kind === kind) this.labels.delete(key);
    this.dirty = true;
  }

  /**
   * Place labels from fresh candidates. Returns true when some wanted an image
   * that was not drawn yet (per-placement budget), so another placement should
   * follow soon.
   */
  place(nodes: Candidates, edges: Candidates, store: GraphStore, width: number, height: number, pixelRatio: number): boolean {
    if (this.atlas.generation !== this.generation) {
      this.labels.clear(); // their images are gone
      this.generation = this.atlas.generation;
    }
    this.atlas.refill();
    this.resetGrid(width, height);
    const placed = new Map<number, Label>();
    let starved = false;
    const max = this.opts.max;

    const nodeText = store.nodeLabels;
    if (nodeText && nodes.count > 0) {
      const px = Math.round(this.opts.sizeCssPx * pixelRatio);
      const gap = GAP_CSS_PX * pixelRatio;
      for (const k of this.byPriority(nodes, LABEL_KIND_NODE)) {
        if (placed.size >= max) break;
        const o = k * RECORD_WORDS;
        const text = nodeText[nodes.u32[o + 1]!];
        if (!text) continue;
        const entry = this.atlas.get(text, px, NODE_FILL);
        if (!entry) {
          starved = true;
          continue;
        }
        // Centred under the node, as label_draw.wgsl draws it.
        const x = nodes.f32[o + 4]! - entry.w / 2;
        const y = nodes.f32[o + 5]! + nodes.f32[o + 3]! + gap;
        if (!this.claim(x, y, x + entry.w, y + entry.h)) continue;
        this.keep(placed, LABEL_KIND_NODE, nodes.u32[o]!, entry);
      }
    }

    const edgeText = store.edgeLabels;
    if (edgeText && edges.count > 0) {
      const px = Math.round(this.opts.sizeCssPx * EDGE_SCALE * pixelRatio);
      for (const k of this.byPriority(edges, LABEL_KIND_EDGE)) {
        if (placed.size >= max) break;
        const o = k * RECORD_WORDS;
        const text = edgeText[edges.u32[o + 1]!];
        if (!text) continue;
        const len = edges.f32[o + 2]!;
        const entry = this.atlas.get(text, px, EDGE_FILL);
        if (!entry) {
          starved = true;
          continue;
        }
        if (entry.w > len * EDGE_FIT) continue; // the text does not fit along the edge
        // The label is centred on the edge and turned along it: claim the box around that.
        const ax = edges.f32[o + 4]!;
        const ay = edges.f32[o + 5]!;
        const cos = Math.abs(edges.f32[o + 6]! - ax) / len;
        const sin = Math.abs(edges.f32[o + 7]! - ay) / len;
        const hw = (entry.w * cos + entry.h * sin) / 2;
        const hh = (entry.w * sin + entry.h * cos) / 2;
        const mx = (ax + edges.f32[o + 6]!) / 2;
        const my = (ay + edges.f32[o + 7]!) / 2;
        if (!this.claim(mx - hw, my - hh, mx + hw, my + hh)) continue;
        this.keep(placed, LABEL_KIND_EDGE, edges.u32[o]!, entry);
      }
    }

    // Labels not placed again fade out where they are.
    for (const [key, l] of this.labels) {
      if (placed.has(key) || l.alpha <= 0) continue;
      l.target = 0;
      placed.set(key, l);
    }
    this.labels = placed;
    this.dirty = true;
    return starved;
  }

  /** Advance fades to `nowMs`. True while any label is still fading. */
  animate(nowMs: number): boolean {
    const dt = this.lastMs > 0 ? Math.min((nowMs - this.lastMs) / 1000, 0.1) : 0;
    this.lastMs = nowMs;
    let moving = false;
    for (const [key, l] of this.labels) {
      if (l.alpha === l.target) continue;
      const step = dt / FADE_S;
      l.alpha = l.target > l.alpha ? Math.min(l.target, l.alpha + step) : Math.max(l.target, l.alpha - step);
      this.dirty = true;
      if (l.alpha === 0 && l.target === 0) this.labels.delete(key);
      else if (l.alpha !== l.target) moving = true;
    }
    if (!moving) this.lastMs = 0; // idle: the next fade starts from a fresh clock
    return moving;
  }

  /** Write the instance buffer if anything changed. */
  upload(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const n = this.labels.size;
    const bytes = Math.max(1, n) * LABEL_INSTANCE.size;
    if (!this.buffer || this.buffer.size < bytes) {
      this.buffer?.destroy();
      const size = 2 ** Math.ceil(Math.log2(Math.max(bytes, 64 * LABEL_INSTANCE.size)));
      this.buffer = this.device.createBuffer({ label: "labels/instances", size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.data = new ArrayBuffer(size);
    }
    const u32 = new Uint32Array(this.data);
    const f32 = new Float32Array(this.data);
    const stride = LABEL_INSTANCE.size / 4;
    const at = LABEL_INSTANCE.offset;
    let i = 0;
    for (const l of this.labels.values()) {
      const o = i * stride;
      u32[o + at.anchor / 4] = l.anchor;
      u32[o + at.kind / 4] = l.kind;
      u32[o + at.rect / 4] = (l.entry.x | (l.entry.y << 16)) >>> 0;
      u32[o + at.rect / 4 + 1] = (l.entry.w | (l.entry.h << 16)) >>> 0;
      f32[o + at.alpha / 4] = l.alpha;
      i++;
    }
    this.count = n;
    if (n > 0) this.device.queue.writeBuffer(this.buffer, 0, this.data, 0, n * LABEL_INSTANCE.size);
  }

  destroy(): void {
    this.buffer?.destroy();
  }

  /** Candidate indices, most important first; labels already shown get a head start. */
  private byPriority(c: Candidates, kind: number): number[] {
    const key = new Float64Array(c.count);
    for (let k = 0; k < c.count; k++) {
      const o = k * RECORD_WORDS;
      const shown = this.labels.get(c.u32[o]! * 2 + kind);
      key[k] = c.f32[o + 2]! * (shown && shown.target > 0 ? STAY_BONUS : 1);
    }
    return Array.from({ length: c.count }, (_, k) => k).sort((a, b) => key[b]! - key[a]!);
  }

  private keep(placed: Map<number, Label>, kind: number, anchor: number, entry: AtlasEntry): void {
    const key = anchor * 2 + kind;
    const prev = this.labels.get(key);
    placed.set(key, { kind, anchor, entry, alpha: prev?.alpha ?? 0, target: 1 });
  }

  private resetGrid(width: number, height: number): void {
    this.gridW = Math.max(1, Math.ceil(width / CELL));
    this.gridH = Math.max(1, Math.ceil(height / CELL));
    if (this.grid.length < this.gridW * this.gridH) this.grid = new Uint8Array(this.gridW * this.gridH);
    else this.grid.fill(0, 0, this.gridW * this.gridH);
  }

  /** Take the screen box if it is on screen and free. */
  private claim(x0: number, y0: number, x1: number, y1: number): boolean {
    const w = this.gridW;
    const c0 = Math.max(0, Math.floor(x0 / CELL));
    const r0 = Math.max(0, Math.floor(y0 / CELL));
    const c1 = Math.min(w - 1, Math.floor(x1 / CELL));
    const r1 = Math.min(this.gridH - 1, Math.floor(y1 / CELL));
    if (c0 > c1 || r0 > r1) return false; // off screen
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (this.grid[r * w + c]) return false;
    for (let r = r0; r <= r1; r++) this.grid.fill(1, r * w + c0, r * w + c1 + 1);
    return true;
  }
}

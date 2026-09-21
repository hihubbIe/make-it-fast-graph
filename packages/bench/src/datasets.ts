/**
 * Deterministic synthetic datasets (§19.3). Same seed ⇒ same bytes, so
 * Storybook and the benchmark harness render identical data.
 *
 * Layout-free: positions are generated directly (the engine does no layout).
 * World scale: ~4 world units of spacing per node, node diameters ~1–6 units.
 */

export interface NodeDataset {
  count: number;
  /** xy interleaved. */
  positions: Float32Array;
  /** rgba8unorm, R in the low byte. */
  colors: Uint32Array;
  /** Diameters, world units. */
  sizes: Float32Array;
}

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

/** sfc32: fast, 128-bit state, good statistical quality. Returns [0, 1). */
export function rng(seed: number): () => number {
  let a = 0x9e3779b9;
  let b = 0x243f6a88;
  let c = 0xb7e15162;
  let d = seed >>> 0;
  const next = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next(); // warm up
  return next;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** Categorical palette, tuned to read on a near-black background. */
export const PALETTE = [
  0x4c9aff, 0xff7a59, 0x36c98f, 0xf5c542, 0xb57bff, 0x2fc6d6, 0xff5c93, 0x9ccc3d, 0xff9f1c, 0x7f8cff,
] as const;

/** 0xRRGGBB + alpha (0..1) → rgba8unorm word. */
export function rgbToWord(rgb: number, alpha = 1): number {
  const r = (rgb >>> 16) & 0xff;
  const g = (rgb >>> 8) & 0xff;
  const b = rgb & 0xff;
  return (r | (g << 8) | (b << 16) | (Math.round(alpha * 255) << 24)) >>> 0;
}

const PALETTE_WORDS = PALETTE.map((c) => rgbToWord(c));

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** World units between neighbouring nodes at average density. */
export const SPACING = 4;

function alloc(count: number): NodeDataset {
  return {
    count,
    positions: new Float32Array(count * 2),
    colors: new Uint32Array(count),
    sizes: new Float32Array(count),
  };
}

/** Heavy-tailed size: most nodes small, a few hubs. */
export function sizeSample(r: () => number): number {
  return 1 + 5 * Math.pow(r(), 6);
}

/** Square lattice, row-major. Colour by quadrant. Useful for precision/culling checks. */
export function grid(count: number, seed = 1): NodeDataset {
  const d = alloc(count);
  const r = rng(seed);
  const side = Math.ceil(Math.sqrt(count));
  const half = (side * SPACING) / 2;
  for (let i = 0; i < count; i++) {
    const x = (i % side) * SPACING - half;
    const y = Math.floor(i / side) * SPACING - half;
    d.positions[i * 2] = x;
    d.positions[i * 2 + 1] = y;
    d.colors[i] = PALETTE_WORDS[(x >= 0 ? 1 : 0) + (y >= 0 ? 2 : 0)]!;
    d.sizes[i] = 1.5 + r();
  }
  return d;
}

/** Uniform random points in a disk. */
export function uniform(count: number, seed = 1): NodeDataset {
  const d = alloc(count);
  const r = rng(seed);
  const radius = Math.sqrt((count * SPACING * SPACING) / Math.PI);
  for (let i = 0; i < count; i++) {
    const a = r() * Math.PI * 2;
    const rr = radius * Math.sqrt(r());
    d.positions[i * 2] = Math.cos(a) * rr;
    d.positions[i * 2 + 1] = Math.sin(a) * rr;
    d.colors[i] = PALETTE_WORDS[i % PALETTE_WORDS.length]!;
    d.sizes[i] = sizeSample(r);
  }
  return d;
}

/** `k` Gaussian communities of power-law sizes, coloured by community. */
export function clustered(count: number, k = 24, seed = 1): NodeDataset {
  const d = alloc(count);
  const r = rng(seed);
  const extent = Math.sqrt(count * SPACING * SPACING);

  // Community centres, weights (power law) and spreads.
  const cx = new Float64Array(k);
  const cy = new Float64Array(k);
  const cdf = new Float64Array(k);
  const spread = new Float64Array(k);
  let total = 0;
  for (let c = 0; c < k; c++) {
    cx[c] = (r() - 0.5) * extent;
    cy[c] = (r() - 0.5) * extent;
    total += 1 / (c + 1);
    cdf[c] = total;
  }
  for (let c = 0; c < k; c++) {
    cdf[c]! /= total;
    const members = count * ((c === 0 ? cdf[0]! : cdf[c]! - cdf[c - 1]!) || 0);
    spread[c] = Math.sqrt(members) * SPACING * 0.5;
  }

  for (let i = 0; i < count; i++) {
    const u = r();
    let c = 0;
    while (c < k - 1 && cdf[c]! < u) c++;
    // Box–Muller
    const m = Math.sqrt(-2 * Math.log(1 - r()));
    const a = r() * Math.PI * 2;
    d.positions[i * 2] = cx[c]! + Math.cos(a) * m * spread[c]!;
    d.positions[i * 2 + 1] = cy[c]! + Math.sin(a) * m * spread[c]!;
    d.colors[i] = PALETTE_WORDS[c % PALETTE_WORDS.length]!;
    d.sizes[i] = sizeSample(r);
  }
  return d;
}

/** Logarithmic spiral galaxy with `arms` arms; dense core, sparse rim. */
export function galaxy(count: number, arms = 4, seed = 1): NodeDataset {
  const d = alloc(count);
  const r = rng(seed);
  const radius = Math.sqrt((count * SPACING * SPACING) / Math.PI) * 1.4;
  for (let i = 0; i < count; i++) {
    const t = Math.pow(r(), 0.7);
    const arm = Math.floor(r() * arms);
    const theta = t * 3.2 * Math.PI + (arm / arms) * Math.PI * 2;
    const jitter = (0.08 + 0.25 * (1 - t)) * radius * 0.35;
    const m = Math.sqrt(-2 * Math.log(1 - r()));
    const a = r() * Math.PI * 2;
    d.positions[i * 2] = Math.cos(theta) * t * radius + Math.cos(a) * m * jitter;
    d.positions[i * 2 + 1] = Math.sin(theta) * t * radius + Math.sin(a) * m * jitter;
    d.colors[i] = rgbToWord(PALETTE[arm % PALETTE.length]!, 0.55 + 0.45 * (1 - t));
    d.sizes[i] = sizeSample(r);
  }
  return d;
}

/**
 * Settlements on a 16:9 map: towns of Zipf-distributed size over a sparse
 * countryside, the point set of a road or infrastructure network. Density
 * varies ~5x between town and country, which is what makes a mesh built on it
 * look like roads rather than a lattice.
 */
export function towns(count: number, seed = 1): NodeDataset {
  const d = alloc(count);
  const r = rng(seed);
  const area = count * SPACING * SPACING;
  const w = Math.sqrt((area * 16) / 9);
  const h = area / w;
  const k = Math.max(1, Math.round(count / 1500));

  const cx = new Float64Array(k);
  const cy = new Float64Array(k);
  const cdf = new Float64Array(k);
  const spread = new Float64Array(k);
  let total = 0;
  for (let t = 0; t < k; t++) {
    cx[t] = (r() - 0.5) * w;
    cy[t] = (r() - 0.5) * h;
    total += 1 / Math.pow(t + 1, 0.8);
    cdf[t] = total;
  }
  for (let t = 0; t < k; t++) {
    cdf[t]! /= total;
    const members = count * TOWN_SHARE * (t === 0 ? cdf[0]! : cdf[t]! - cdf[t - 1]!);
    spread[t] = Math.sqrt(members) * SPACING * 0.35;
  }

  const country = rgbToWord(0x5a6b82);
  for (let i = 0; i < count; i++) {
    let x: number;
    let y: number;
    if (r() >= TOWN_SHARE) {
      x = (r() - 0.5) * w;
      y = (r() - 0.5) * h;
      d.colors[i] = country;
    } else {
      // Binary search: one town per 1500 nodes makes a linear scan O(n²).
      const u = r();
      let lo = 0;
      let hi = k - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid]! < u) lo = mid + 1;
        else hi = mid;
      }
      const t = lo;
      const m = Math.sqrt(-2 * Math.log(1 - r()));
      const a = r() * Math.PI * 2;
      x = cx[t]! + Math.cos(a) * m * spread[t]!;
      y = cy[t]! + Math.sin(a) * m * spread[t]!;
      d.colors[i] = TOWN_WORDS[t % TOWN_WORDS.length]!;
    }
    d.positions[i * 2] = x;
    d.positions[i * 2 + 1] = y;
    d.sizes[i] = 0.8 + r() * 1.2;
  }
  return d;
}

/** Fraction of `towns` nodes that live in a town rather than the countryside. */
const TOWN_SHARE = 0.7;
const TOWN_WORDS = [0xf5c542, 0xff9f1c, 0xff7a59].map((c) => rgbToWord(c));

export const GENERATORS = { grid, uniform, clustered, galaxy, towns } as const;
export type GeneratorName = keyof typeof GENERATORS;

/** Generate by name with default parameters. */
export function generate(name: GeneratorName, count: number, seed = 1): NodeDataset {
  switch (name) {
    case "grid":
      return grid(count, seed);
    case "uniform":
      return uniform(count, seed);
    case "clustered":
      return clustered(count, 24, seed);
    case "galaxy":
      return galaxy(count, 4, seed);
    case "towns":
      return towns(count, seed);
  }
}

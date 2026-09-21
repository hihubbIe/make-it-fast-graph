/**
 * Whole graphs — nodes AND edges — shaped like the graphs people actually
 * draw. Same seed ⇒ same bytes, so Storybook and the harness see identical data.
 *
 * Edges are local by construction (nearest neighbours, parent → child, lattice
 * links) because that is what a layout produces: it puts connected nodes near
 * each other. The exception is `fuzzball`, the stress case, whose endpoints are
 * uniformly random so long edges cross the whole graph.
 *
 * Everything here is O(n) or O(n·k): the Z-order sort is an LSD radix sort, and
 * neighbour search looks at a fixed window of that order, never a spatial tree.
 */
import { PALETTE, SPACING, grid, rgbToWord, rng, sizeSample, towns, uniform, type NodeDataset } from "./datasets";

export interface EdgeDataset {
  count: number;
  /** Source, target node indices interleaved. Length `2 * count`. */
  indices: Uint32Array;
}

export interface GraphDataset {
  nodes: NodeDataset;
  edges: EdgeDataset;
}

const NONE = 0xffffffff;

export type HierarchyLayout = "nested" | "layered";

// ---------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------

/** Square lattice, each node linked to its right and lower neighbour. */
export function gridGraph(count: number, seed = 1): GraphDataset {
  const nodes = grid(count, seed);
  const side = Math.ceil(Math.sqrt(count));
  const right = (i: number) => (i + 1) % side !== 0 && i + 1 < count;
  let m = 0;
  for (let i = 0; i < count; i++) m += (right(i) ? 1 : 0) + (i + side < count ? 1 : 0);
  const indices = new Uint32Array(m * 2);
  let e = 0;
  for (let i = 0; i < count; i++) {
    if (right(i)) {
      indices[e++] = i;
      indices[e++] = i + 1;
    }
    if (i + side < count) {
      indices[e++] = i;
      indices[e++] = i + side;
    }
  }
  return { nodes, edges: { count: m, indices } };
}

/**
 * A modular graph (social, citation, biological network) as a force layout
 * draws it: round blobs of Zipf-distributed size set apart on a spiral, each
 * node linked to its `k` nearest neighbours (local texture), one in five also
 * to a random member of its own blob (the blob's fuzz), and one in fifty to a
 * random member of one of the nearest blobs (the bundles between them).
 * Coloured by community.
 */
export function communities(count: number, k = 2, seed = 1): GraphDataset {
  const n = Math.max(0, Math.floor(count));
  const r = rng(seed);
  const blobs = Math.max(1, Math.min(MAX_COMMUNITIES, Math.round(n / COMMUNITY_SIZE)));

  // Members: Zipf weights, rounded so the ranges tile [0, n) exactly.
  // Nodes of community c are [start[c], start[c + 1]).
  const start = new Uint32Array(blobs + 1);
  let total = 0;
  for (let c = 0; c < blobs; c++) total += Math.pow(c + 1, -COMMUNITY_ZIPF);
  let acc = 0;
  for (let c = 0; c < blobs; c++) {
    acc += Math.pow(c + 1, -COMMUNITY_ZIPF);
    start[c + 1] = c === blobs - 1 ? n : Math.round((acc / total) * n);
  }

  // Placement: a sunflower spiral by cumulative area, largest first, each blob
  // given COMMUNITY_GAP times its own radius, so blobs sit apart but close.
  const cx = new Float64Array(blobs);
  const cy = new Float64Array(blobs);
  const nodes: NodeDataset = { count: n, positions: new Float32Array(n * 2), colors: new Uint32Array(n), sizes: new Float32Array(n) };
  let area = 0;
  for (let c = 0; c < blobs; c++) {
    const radius = Math.sqrt(((start[c + 1]! - start[c]!) * SPACING * SPACING) / Math.PI);
    const slot = Math.PI * (radius * COMMUNITY_GAP) ** 2;
    const rho = Math.sqrt((area + slot / 2) / Math.PI);
    area += slot;
    cx[c] = Math.cos(c * GOLDEN_ANGLE) * rho;
    cy[c] = Math.sin(c * GOLDEN_ANGLE) * rho;
    const sigma = radius * 0.5;
    const color = rgbToWord(PALETTE[c % PALETTE.length]!);
    for (let i = start[c]!; i < start[c + 1]!; i++) {
      const m = Math.sqrt(-2 * Math.log(1 - r())) * sigma; // Box–Muller radius
      const a = r() * Math.PI * 2;
      nodes.positions[i * 2] = cx[c]! + Math.cos(a) * m;
      nodes.positions[i * 2 + 1] = cy[c]! + Math.sin(a) * m;
      nodes.colors[i] = color;
      nodes.sizes[i] = sizeSample(r);
    }
  }

  // The nearest blobs of each blob, by centre distance.
  const reach = Math.min(BRIDGE_NEIGHBOURS, blobs - 1);
  const nearest = new Uint32Array(blobs * reach);
  const best = new Float64Array(reach);
  for (let c = 0; c < blobs; c++) {
    best.fill(Infinity);
    for (let d = 0; d < blobs; d++) {
      if (d === c) continue;
      const dist = (cx[d]! - cx[c]!) ** 2 + (cy[d]! - cy[c]!) ** 2;
      if (dist >= best[reach - 1]!) continue;
      let s = reach - 1;
      while (s > 0 && best[s - 1]! > dist) {
        best[s] = best[s - 1]!;
        nearest[c * reach + s] = nearest[c * reach + s - 1]!;
        s--;
      }
      best[s] = dist;
      nearest[c * reach + s] = d;
    }
  }

  // Random links, drawn twice from the same stream: once to count, once to fill.
  const links = (emit: (a: number, b: number) => void) => {
    const rr = rng(seed ^ 0x27d4eb2d);
    for (let c = 0; c < blobs; c++) {
      const s0 = start[c]!;
      const size = start[c + 1]! - s0;
      for (let i = s0; i < s0 + size; i++) {
        if (size > 1 && rr() < IN_COMMUNITY_SHARE) {
          const j = s0 + Math.floor(rr() * (size - 1));
          emit(i, j >= i ? j + 1 : j);
        }
        if (reach > 0 && rr() < BRIDGE_SHARE) {
          const d = nearest[c * reach + Math.floor(rr() * reach)]!;
          const t = start[d]! + Math.floor(rr() * (start[d + 1]! - start[d]!));
          if (t < start[d + 1]!) emit(i, t); // never into an empty community
        }
      }
    }
  };
  let m = 0;
  links(() => m++);
  const indices = new Uint32Array(m * 2);
  let e = 0;
  links((a, b) => {
    indices[e++] = a;
    indices[e++] = b;
  });

  const near = nearestPairs(nodes, [mortonOrder(nodes), mortonOrder(nodes, 1 / 3)], k);
  return { nodes, edges: concat(near, { count: m, indices }) };
}

/** Nodes per community, on average. */
const COMMUNITY_SIZE = 4000;
const MAX_COMMUNITIES = 2000;
/** Zipf exponent of community sizes: a few large communities, many small ones. */
const COMMUNITY_ZIPF = 0.8;
/** Room each blob gets on the spiral, as a multiple of its radius. */
const COMMUNITY_GAP = 1.5;
/** Share of nodes with one extra link to a random member of their own community. */
const IN_COMMUNITY_SHARE = 0.2;
/** Share of nodes with one link to a random member of a nearby community. */
const BRIDGE_SHARE = 0.02;
/** Bridges go to one of this many nearest communities. */
const BRIDGE_NEIGHBOURS = 3;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Road / infrastructure network: settlements joined to their `k` nearest. */
export function mesh(count: number, k = 3, seed = 1): GraphDataset {
  const nodes = towns(count, seed);
  return { nodes, edges: nearestPairs(nodes, [mortonOrder(nodes), mortonOrder(nodes, 1 / 3)], k) };
}

/**
 * A tree (file system, org chart, taxonomy): heavy-tailed fan-out, a quarter
 * of the nodes are leaves before the last level, and a few hubs have hundreds
 * of children. Edges run parent → child. Nodes are coloured by top-level
 * branch and sized by subtree.
 *
 * `nested`: space-filling, uniform density, self-similar at every zoom — the
 * layout that scales. `layered`: the classic top-down drawing, one row per
 * depth — readable small, a dense fan at scale.
 */
export function hierarchy(count: number, layout: HierarchyLayout = "nested", seed = 1): GraphDataset {
  const n = Math.max(1, count);
  const r = rng(seed);
  const parent = new Uint32Array(n);
  const depth = new Uint16Array(n);

  // Breadth-first growth: node `head` receives its children at the end of the
  // list, so every parent precedes its children and siblings are contiguous.
  parent[0] = NONE;
  let next = 1;
  for (let head = 0; next < n; head++) {
    let c = r() < LEAF_SHARE ? 0 : Math.min(MAX_FANOUT, Math.floor(Math.pow(1 - r(), -1 / FANOUT_ALPHA)));
    if (head === next - 1) c = Math.max(c, 1); // never let the frontier die out
    for (let j = 0; j < c && next < n; j++, next++) {
      parent[next] = head;
      depth[next] = depth[head]! + 1;
    }
  }

  // Subtree sizes: children follow parents, so one reverse pass.
  const size = new Uint32Array(n).fill(1);
  for (let i = n - 1; i > 0; i--) size[parent[i]!]! += size[i]!;

  const nodes: NodeDataset = { count: n, positions: new Float32Array(n * 2), colors: new Uint32Array(n), sizes: new Float32Array(n) };
  if (layout === "nested") nested(parent, size, nodes.positions);
  else layered(parent, depth, size, nodes.positions);

  const branch = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    branch[i] = depth[i]! <= 1 ? i : branch[parent[i]!]!;
    nodes.colors[i] = i === 0 ? rgbToWord(0xffffff) : rgbToWord(PALETTE[branch[i]! % PALETTE.length]!);
    nodes.sizes[i] = 1 + Math.min(7, Math.log2(size[i]!) * 0.5);
  }

  const indices = new Uint32Array((n - 1) * 2);
  for (let i = 1; i < n; i++) {
    indices[(i - 1) * 2] = parent[i]!;
    indices[(i - 1) * 2 + 1] = i;
  }
  return { nodes, edges: { count: n - 1, indices } };
}

/** Heavy-tailed fan-out: Pareto(alpha) children for a non-leaf, capped. */
const FANOUT_ALPHA = 1.4;
const MAX_FANOUT = 2000;
/** Share of nodes that get no children even though the tree is still growing. */
const LEAF_SHARE = 0.25;

/**
 * Space-filling layout: every subtree owns a rectangle whose area is its node
 * count (16 units² per node, the usual 4-unit spacing), its children's
 * rectangles tile it (squarified, Bruls et al. 2000), and each node sits at
 * the centre of its own. Density is uniform at every zoom, and an edge is as
 * long as its parent's rectangle is wide: a handful of long top-level edges,
 * short ones everywhere below.
 *
 * A balloon layout (child disks on a ring) was tried first and rejected: disk
 * radius grows ~1.35x per link along single-child chains, so a 1M-node tree
 * was mostly empty space with specks of nodes.
 */
function nested(parent: Uint32Array, size: Uint32Array, out: Float32Array): void {
  const n = parent.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const w = new Float64Array(n);
  const h = new Float64Array(n);
  w[0] = Math.sqrt((n * 16 * 16) / 9);
  h[0] = (n * 16) / w[0]!;
  x[0] = -w[0]! / 2;
  y[0] = -h[0]! / 2;

  // Siblings are contiguous (breadth-first growth), so a node's children are
  // [first, first + count) and one scratch array serves every parent.
  const first = new Uint32Array(n).fill(NONE);
  const count = new Uint32Array(n);
  for (let i = 1; i < n; i++) {
    const p = parent[i]!;
    if (first[p] === NONE) first[p] = i;
    count[p]!++;
  }
  const kids = new Uint32Array(n);
  const bySize = (a: number, b: number) => size[b]! - size[a]!;

  for (let p = 0; p < n; p++) {
    out[p * 2] = x[p]! + w[p]! / 2;
    out[p * 2 + 1] = y[p]! + h[p]! / 2;
    const c = count[p]!;
    if (c === 0) continue;
    const list = kids.subarray(0, c);
    for (let j = 0; j < c; j++) list[j] = first[p]! + j;
    list.sort(bySize);

    // The parent's own cell is left as the rectangle's remainder.
    const scale = (w[p]! * h[p]!) / size[p]!;
    let rx = x[p]!;
    let ry = y[p]!;
    let rw = w[p]!;
    let rh = h[p]!;
    let j = 0;
    while (j < c) {
      const side = Math.min(rw, rh);
      let sum = size[list[j]!]! * scale;
      let worst = aspect(sum, sum, sum, side);
      let end = j + 1;
      while (end < c) {
        const a = size[list[end]!]! * scale;
        const next = aspect(sum + a, size[list[j]!]! * scale, a, side);
        if (next > worst) break;
        worst = next;
        sum += a;
        end++;
      }
      // Lay the row along the short side, then cut it off the rectangle.
      const thick = sum / side;
      let along = 0;
      for (let t = j; t < end; t++) {
        const k = list[t]!;
        const len = (size[k]! * scale) / thick;
        if (rw >= rh) {
          x[k] = rx;
          y[k] = ry + along;
          w[k] = thick;
          h[k] = len;
        } else {
          x[k] = rx + along;
          y[k] = ry;
          w[k] = len;
          h[k] = thick;
        }
        along += len;
      }
      if (rw >= rh) {
        rx += thick;
        rw -= thick;
      } else {
        ry += thick;
        rh -= thick;
      }
      j = end;
    }
  }
}

/** Worst aspect ratio of a squarified row: total area, largest, smallest, side. */
function aspect(sum: number, max: number, min: number, side: number): number {
  const s2 = side * side;
  return Math.max((s2 * max) / (sum * sum), (sum * sum) / (s2 * min));
}

/**
 * Top-down layout: y is depth, x is the centre of the node's slice of the
 * leaf order (children split their parent's slice by subtree size). Width
 * fits the widest row at 4 units per node; height makes it 16:9.
 */
function layered(parent: Uint32Array, depth: Uint16Array, size: Uint32Array, out: Float32Array): void {
  const n = parent.length;
  let levels = 0;
  for (let i = 0; i < n; i++) if (depth[i]! > levels) levels = depth[i]!;
  const perLevel = new Uint32Array(levels + 1);
  for (let i = 0; i < n; i++) perLevel[depth[i]!]!++;
  let widest = 1;
  for (const c of perLevel) if (c > widest) widest = c;
  const width = widest * 4;
  const rowGap = levels > 0 ? (width * 9) / 16 / levels : 0;
  const start = new Float64Array(n);
  const cursor = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const p = parent[i]!;
    start[i] = start[p]! + cursor[p]!;
    cursor[p]! += size[i]!;
  }
  for (let i = 0; i < n; i++) {
    out[i * 2] = ((start[i]! + size[i]! / 2) / n - 0.5) * width;
    out[i * 2 + 1] = depth[i]! * rowGap;
  }
}

/**
 * STRESS: uniformly random endpoints over a disk of nodes, so edges are as
 * long as the graph is wide and cross every pixel many times over.
 */
export function fuzzball(nodeCount: number, edgeCount: number, seed = 1): GraphDataset {
  const nodes = uniform(nodeCount, seed);
  const r = rng(seed ^ 0x5bd1e995);
  const indices = new Uint32Array(edgeCount * 2);
  if (nodeCount > 1) {
    for (let e = 0; e < edgeCount; e++) {
      const s = Math.floor(r() * nodeCount);
      const t = Math.floor(r() * (nodeCount - 1));
      indices[e * 2] = s;
      indices[e * 2 + 1] = t >= s ? t + 1 : t; // never a self-loop
    }
  }
  return { nodes, edges: { count: nodeCount > 1 ? edgeCount : 0, indices: nodeCount > 1 ? indices : new Uint32Array(0) } };
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/**
 * Node indices sorted along a Z-order curve (16 bits per axis, radix sort).
 * `shift` moves the curve by that share of its domain, so its quadtree seams
 * fall elsewhere (see `nearestPairs`). Every curve uses the same domain,
 * 1.5x the extent, so shifted and unshifted curves share one grid scale; with
 * different scales their seams coincide periodically (measured: recall at the
 * seams stayed at 0.70).
 */
export function mortonOrder(nodes: NodeDataset, shift = 0): Uint32Array {
  const n = nodes.count;
  const pos = nodes.positions;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 2]!;
    const y = pos[i * 2 + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const extent = Math.max(maxX - minX, maxY - minY, 1e-9);
  const domain = extent * 1.5;
  const off = shift * domain;
  const scale = 65535 / domain;
  let keys = new Uint32Array(n);
  let vals = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const qx = ((pos[i * 2]! - minX + off) * scale) | 0;
    const qy = ((pos[i * 2 + 1]! - minY + off) * scale) | 0;
    keys[i] = (spreadBits(qx) | (spreadBits(qy) << 1)) >>> 0;
    vals[i] = i;
  }
  let keys2 = new Uint32Array(n);
  let vals2 = new Uint32Array(n);
  const bins = new Uint32Array(256);
  for (let shift = 0; shift < 32; shift += 8) {
    bins.fill(0);
    for (let i = 0; i < n; i++) bins[(keys[i]! >>> shift) & 255]!++;
    let sum = 0;
    for (let b = 0; b < 256; b++) {
      const c = bins[b]!;
      bins[b] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) {
      const k = keys[i]!;
      const p = bins[(k >>> shift) & 255]!++;
      keys2[p] = k;
      vals2[p] = vals[i]!;
    }
    [keys, keys2] = [keys2, keys];
    [vals, vals2] = [vals2, vals];
  }
  return vals;
}

/** Interleave the low 16 bits of `v` with zeros. */
function spreadBits(v: number): number {
  v &= 0xffff;
  v = (v | (v << 8)) & 0x00ff00ff;
  v = (v | (v << 4)) & 0x0f0f0f0f;
  v = (v | (v << 2)) & 0x33333333;
  v = (v | (v << 1)) & 0x55555555;
  return v;
}

/**
 * Approximate k-nearest-neighbour edges, each pair once. A node's candidates
 * are the `window` nodes on either side of it along each of `orders` (Z-order
 * curves). A window covers a small area in a dense core and a large one on a
 * sparse rim, so it adapts to density on its own, and the TRUE distance picks
 * among candidates, so a curve jump never wins over a real neighbour.
 *
 * One curve is not enough: a node beside a quadtree seam sees only its own
 * side, and the mesh broke into islands along a visible square grid. A second
 * curve shifted by 1/3 of its domain has its seams at least a third of a cell
 * away at every level (Chan's shifted quadtrees), which closes the gaps.
 *
 * Measured at 1M nodes: reading candidates through `order` cost a cache miss
 * each (650 ms), so positions are gathered into curve order first; keeping
 * the best k in locals rather than typed arrays is another 1.7x. Hence `k` is
 * at most 4.
 */
export function nearestPairs(nodes: NodeDataset, orders: readonly Uint32Array[], k: number, window = 6): EdgeDataset {
  const n = nodes.count;
  k = Math.max(1, Math.min(4, Math.floor(k)));
  const pos = nodes.positions;
  // Best k per NODE across all curves, nearest first.
  const bestD = new Float32Array(n * k).fill(Infinity);
  const bestJ = new Uint32Array(n * k).fill(NONE);
  const found = new Uint32Array(4);
  const foundD = new Float32Array(4);
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);

  for (const order of orders) {
    for (let p = 0; p < n; p++) {
      const i = order[p]!;
      xs[p] = pos[i * 2]!;
      ys[p] = pos[i * 2 + 1]!;
    }
    for (let p = 0; p < n; p++) {
      const x = xs[p]!;
      const y = ys[p]!;
      let d0 = Infinity, d1 = Infinity, d2 = Infinity, d3 = Infinity;
      let q0 = NONE, q1 = NONE, q2 = NONE, q3 = NONE;
      let limit = Infinity;
      const lo = p > window ? p - window : 0;
      const hi = p + window < n ? p + window : n - 1;
      for (let q = lo; q <= hi; q++) {
        const dx = xs[q]! - x;
        const dy = ys[q]! - y;
        const d = dx * dx + dy * dy;
        if (d >= limit || q === p) continue;
        if (d < d0) {
          d3 = d2; q3 = q2; d2 = d1; q2 = q1; d1 = d0; q1 = q0; d0 = d; q0 = q;
        } else if (d < d1) {
          d3 = d2; q3 = q2; d2 = d1; q2 = q1; d1 = d; q1 = q;
        } else if (d < d2) {
          d3 = d2; q3 = q2; d2 = d; q2 = q;
        } else {
          d3 = d; q3 = q;
        }
        limit = k === 1 ? d0 : k === 2 ? d1 : k === 3 ? d2 : d3;
      }
      found[0] = q0; found[1] = q1; found[2] = q2; found[3] = q3;
      foundD[0] = d0; foundD[1] = d1; foundD[2] = d2; foundD[3] = d3;

      // Merge into the node's list, skipping neighbours an earlier curve found.
      const o = order[p]! * k;
      for (let s = 0; s < k; s++) {
        if (found[s] === NONE) break;
        const j = order[found[s]!]!;
        const d = foundD[s]!;
        if (d >= bestD[o + k - 1]!) break;
        let dup = false;
        for (let t = 0; t < k; t++) if (bestJ[o + t] === j) dup = true;
        if (dup) continue;
        let t = k - 1;
        while (t > 0 && bestD[o + t - 1]! > d) {
          bestD[o + t] = bestD[o + t - 1]!;
          bestJ[o + t] = bestJ[o + t - 1]!;
          t--;
        }
        bestD[o + t] = d;
        bestJ[o + t] = j;
      }
    }
  }

  // i -> j is emitted unless j also picked i and j comes first: once per pair.
  const keep = (i: number, j: number): boolean => {
    if (j === NONE) return false;
    if (j > i) return true;
    for (let s = 0; s < k; s++) if (bestJ[j * k + s] === i) return false;
    return true;
  };
  let m = 0;
  for (let i = 0; i < n; i++) for (let s = 0; s < k; s++) if (keep(i, bestJ[i * k + s]!)) m++;
  const indices = new Uint32Array(m * 2);
  let e = 0;
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < k; s++) {
      const j = bestJ[i * k + s]!;
      if (keep(i, j)) {
        indices[e++] = i;
        indices[e++] = j;
      }
    }
  }
  return { count: m, indices };
}

function concat(a: EdgeDataset, b: EdgeDataset): EdgeDataset {
  const indices = new Uint32Array((a.count + b.count) * 2);
  indices.set(a.indices, 0);
  indices.set(b.indices, a.count * 2);
  return { count: a.count + b.count, indices };
}

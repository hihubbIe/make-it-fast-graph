/**
 * Shared wiring for the graph stories. Every story is a whole graph — nodes
 * AND edges — with the same look controls, so the only thing that changes
 * from one story to the next is the kind of graph.
 *
 *   - `load` builds the dataset (through the cache); it runs again only when
 *     the node count, the seed or one of the story's `dataArgs` changes.
 *   - Toggling edges or their colouring re-uploads the edges alone; toggling
 *     labels sends the label text alone.
 *   - Edge width, tint, thinning, minimum length, node sampling and the debug
 *     view are engine options: changing them recreates the engine (stage.ts),
 *     which reloads from the cache.
 */
import type { ArgTypes } from "@storybook/html-vite";
import type { EdgeDebugMode, Graph, GraphOptions } from "@vhult/graph";
import type { GraphDataset } from "@vhult/graph-bench";
import type { Loaded } from "./data";
import type { Hud } from "./hud";
import { stage } from "./stage";

export interface GraphArgs {
  nodes: number;
  seed: number;
  edges: boolean;
  /** "tint": one colour for every edge. "nodes": a gradient between its endpoints' colours. */
  edgeColor: "tint" | "nodes";
  edgeWidth: number;
  edgeAlpha: number;
  /** Overdraw a crowded area of edges is thinned to; 0 draws every edge. */
  edgeMaxOverdraw: number;
  /** On-screen length at or below which an edge is not drawn, CSS px. */
  edgeMinLengthPx: number;
  /** What the edge cull decided, as colour (diagnostic). */
  edgeDebug: EdgeDebugMode;
  nodeScale: number;
  /** Node sampling spacing, device px; 0 draws every node. */
  lodTargetPx: number;
  /** Show labels: the story's own text, or node numbers. */
  labels: boolean;
}

/** Label text for a dataset, in its node and edge order. */
export interface GraphLabels {
  nodes?: string[];
  edges?: string[];
}

export interface GraphStory<A extends GraphArgs> {
  /** First HUD note line: what this graph is. */
  describe: (a: A) => string;
  /** Build (or fetch from the cache) the dataset for `a`. */
  load: (a: A) => Loaded<GraphDataset>;
  /** Story args, beyond nodes and seed, that change the data. */
  dataArgs?: readonly (keyof A)[];
  /** Extra engine options. */
  options?: (a: A) => GraphOptions;
  /** Style word given to every edge, if any (e.g. `EDGE_DIRECTED`). */
  edgeStyle?: (a: A) => number | undefined;
  /** After every upload, e.g. to (re)start an animation. */
  onLoad?: (graph: Graph, g: GraphDataset, a: A) => void;
  /** Args handled live, without reloading anything. */
  onUpdate?: (graph: Graph, a: A, prev: A) => void;
  /** Label text for the loaded data; default: every node numbered, no edge labels. */
  labels?: (g: GraphDataset) => GraphLabels;
  dispose?: () => void;
}

/**
 * Edge style flag: draw an arrowhead at the target. Mirrors
 * `EDGE_FLAG_DIRECTED` in the engine's Layouts.ts until the style word gets a
 * public packing helper.
 */
export const EDGE_DIRECTED = 1 << 28;

/** Light blue-grey: reads on the dark background without competing with the nodes. */
const EDGE_TINT = [0.6, 0.7, 0.9] as const;

export const GRAPH_ARGS: Omit<GraphArgs, "nodes"> = {
  seed: 1,
  edges: true,
  edgeColor: "tint",
  edgeWidth: 1,
  edgeAlpha: 0.4,
  edgeMaxOverdraw: 6,
  edgeMinLengthPx: 6,
  edgeDebug: "off",
  nodeScale: 1,
  lodTargetPx: 2.5,
  labels: false,
};

const fmt = (n: number) => n.toLocaleString("en-US");

/** A select control over counts, labelled with separators. */
export function countControl(options: readonly number[]) {
  return { control: "select", options, labels: Object.fromEntries(options.map((n) => [n, fmt(n)])) } as const;
}

/** `nodes` first, then the story's own controls, then the shared look controls. */
export function graphArgTypes<A extends GraphArgs>(sizes: readonly number[], own: Partial<ArgTypes<A>> = {}): Partial<ArgTypes<A>> {
  return {
    nodes: countControl(sizes),
    ...own,
    seed: { control: { type: "number", min: 1, step: 1 } },
    edges: { control: "boolean" },
    edgeColor: { control: "inline-radio", options: ["tint", "nodes"] },
    edgeWidth: { control: { type: "range", min: 0.25, max: 6, step: 0.25 } },
    edgeAlpha: { control: { type: "range", min: 0.01, max: 1, step: 0.01 } },
    edgeMaxOverdraw: { control: { type: "range", min: 0, max: 32, step: 0.5 } },
    edgeMinLengthPx: { control: { type: "range", min: 0, max: 16, step: 0.5 } },
    edgeDebug: { control: "inline-radio", options: ["off", "length", "thinning", "chunk"] },
    nodeScale: { control: { type: "range", min: 0.1, max: 4, step: 0.1 } },
    lodTargetPx: { control: { type: "range", min: 0, max: 8, step: 0.5 } },
    labels: { control: "boolean" },
  } as Partial<ArgTypes<A>>;
}

export function renderGraph<A extends GraphArgs>(spec: GraphStory<A>) {
  return (args: A, ctx: { id: string }): HTMLElement =>
    stage(args, ctx, {
      options: (a) => ({
        edgeWidth: a.edgeWidth,
        edgeColor: [...EDGE_TINT, a.edgeAlpha],
        edgeMaxOverdraw: a.edgeMaxOverdraw,
        edgeMinLengthPx: a.edgeMinLengthPx,
        edgeDebug: a.edgeDebug,
        lodTargetPx: a.lodTargetPx,
        ...spec.options?.(a),
      }),
      setup: (graph, a, hud) => {
        graph.setNodeScale(a.nodeScale);
        upload(graph, a, hud, spec, true);
      },
      update: (graph, a, prev, hud) => {
        const data = a.nodes !== prev.nodes || a.seed !== prev.seed || (spec.dataArgs ?? []).some((k) => a[k] !== prev[k]);
        if (data) upload(graph, a, hud, spec, true);
        else if (a.edges !== prev.edges || a.edgeColor !== prev.edgeColor) upload(graph, a, hud, spec, false);
        else if (a.labels !== prev.labels) setLabels(graph, spec.load(a).data, a, spec);
        if (a.nodeScale !== prev.nodeScale) graph.setNodeScale(a.nodeScale);
        spec.onUpdate?.(graph, a, prev);
      },
      dispose: spec.dispose,
    });
}

function upload<A extends GraphArgs>(graph: Graph, a: A, hud: Hud, spec: GraphStory<A>, withNodes: boolean): void {
  const { data: g, genMs } = spec.load(a);
  if (withNodes) {
    hud.measureLoad(graph, genMs, g.nodes.count);
    graph.setNodes(g.nodes, { copy: true });
  }
  setEdges(graph, g, a, spec.edgeStyle?.(a));
  setLabels(graph, g, a, spec);
  if (withNodes) graph.camera.fit();
  const edges = a.edges ? `${fmt(g.edges.count)} edges` : "edges off";
  hud.setNote(`${spec.describe(a)}\n${fmt(g.nodes.count)} nodes · ${edges}`);
  spec.onLoad?.(graph, g, a);
}

function setEdges(graph: Graph, g: GraphDataset, a: GraphArgs, style: number | undefined): void {
  const e = g.edges;
  if (!a.edges || e.count === 0) {
    graph.setEdges({ count: 0, indices: new Uint32Array(0) });
    return;
  }
  // Indices are the cached master, so they are copied; colours and styles are
  // made here and transferred as they are.
  graph.setEdges({
    count: e.count,
    indices: e.indices.slice(),
    colors: a.edgeColor === "nodes" ? endpointColors(g, a.edgeAlpha) : undefined,
    styles: style !== undefined ? new Uint32Array(e.count).fill(style) : undefined,
  });
}

function setLabels<A extends GraphArgs>(graph: Graph, g: GraphDataset, a: A, spec: GraphStory<A>): void {
  if (!a.labels) {
    graph.setNodeLabels([]);
    graph.setEdgeLabels([]);
    return;
  }
  const labels = spec.labels?.(g) ?? { nodes: Array.from({ length: g.nodes.count }, (_, i) => `#${i}`) };
  graph.setNodeLabels(labels.nodes ?? []);
  graph.setEdgeLabels(a.edges ? (labels.edges ?? []) : []);
}

/** Each edge's two endpoint colours, with the edge alpha. */
function endpointColors(g: GraphDataset, alpha: number): Uint32Array {
  const { indices, count } = g.edges;
  const nodeColors = g.nodes.colors;
  const a = (Math.round(Math.max(0, Math.min(1, alpha)) * 255) << 24) >>> 0;
  const out = new Uint32Array(count * 2);
  for (let i = 0; i < count * 2; i++) out[i] = ((nodeColors[indices[i]!]! & 0x00ffffff) | a) >>> 0;
  return out;
}

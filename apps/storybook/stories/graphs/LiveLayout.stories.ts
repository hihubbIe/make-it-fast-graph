/**
 * A layout that is still running: the Communities graph with node positions
 * rewritten every frame through `updateNodePositions`, a rolling window at a
 * time, the way a force simulation streams its output. Edges follow their
 * nodes.
 *
 * What to check:
 *   - Edges stay attached to their nodes while they move.
 *   - HUD "worker" ms stays flat as the window grows: uploads scale with the
 *     window, not with the graph.
 *   - `updatesPerFrame` 0 drops the engine to idle.
 */
import type { Meta, StoryObj } from "@storybook/html-vite";
import type { Graph } from "@vhult/graph";
import { communities } from "@vhult/graph-bench";
import { cached } from "../../src/data";
import { GRAPH_ARGS, countControl, graphArgTypes, renderGraph, type GraphArgs } from "../../src/graphStory";

interface Args extends GraphArgs {
  updatesPerFrame: number;
  amplitude: number;
}

const SIZES = [100_000, 1_000_000] as const;
const UPDATES = [0, 1_000, 10_000, 100_000, 1_000_000] as const;
/** Same data as Communities at its default, so switching between the two is a cache hit. */
const NEIGHBOURS = 2;

/** Mutable loop state shared between load, update and dispose. */
const loop = { raf: 0, args: null as Args | null };

function start(graph: Graph, base: Float32Array, count: number): void {
  cancelAnimationFrame(loop.raf);
  let cursor = 0;
  const tick = (t: number): void => {
    const a = loop.args!;
    const n = Math.min(a.updatesPerFrame, count);
    if (n > 0) {
      if (cursor + n > count) cursor = 0;
      const out = new Float32Array(n * 2); // transferred to the worker, so fresh each frame
      const phase = t * 0.003;
      for (let i = 0; i < n; i++) {
        const j = (cursor + i) * 2;
        out[i * 2] = base[j]! + Math.sin(phase + j) * a.amplitude;
        out[i * 2 + 1] = base[j + 1]! + Math.cos(phase + j) * a.amplitude;
      }
      graph.updateNodePositions(cursor, out);
      cursor += n;
    }
    loop.raf = requestAnimationFrame(tick);
  };
  loop.raf = requestAnimationFrame(tick);
}

const meta: Meta<Args> = {
  title: "Graphs/Live layout",
  render: renderGraph<Args>({
    describe: () => "Live layout · communities, positions streamed every frame",
    load: (a) => cached(`communities:${a.nodes}:${NEIGHBOURS}:${a.seed}`, () => communities(a.nodes, NEIGHBOURS, a.seed)),
    onLoad: (graph, g, a) => {
      loop.args = a;
      start(graph, g.nodes.positions, g.nodes.count);
    },
    onUpdate: (_graph, a) => {
      loop.args = a;
    },
    dispose: () => cancelAnimationFrame(loop.raf),
  }),
  argTypes: graphArgTypes<Args>(SIZES, {
    updatesPerFrame: countControl(UPDATES),
    amplitude: { control: { type: "range", min: 0, max: 50, step: 1 } },
  }),
  args: { nodes: 1_000_000, updatesPerFrame: 10_000, amplitude: 8, ...GRAPH_ARGS },
};

export default meta;

export const LiveLayout: StoryObj<Args> = { name: "Live layout" };

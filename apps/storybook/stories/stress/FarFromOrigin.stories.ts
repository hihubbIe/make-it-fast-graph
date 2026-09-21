/**
 * STRESS (precision): a small grid graph placed far from the origin, viewed at
 * deep zoom. The camera centre is split hi/lo on upload, so nodes AND edges
 * stay put even at large offsets.
 *
 * What to check:
 *   - At offset 1e5–1e6, panning is smooth: no jitter or snapping in steps.
 *   - Nodes stay circular and edges stay attached to them at zoom ~200 px/unit.
 * (Node positions themselves are f32: at 1e6 their spacing quantizes to 1/16
 * unit. That is data precision, not camera precision.)
 */
import type { Meta, StoryObj } from "@storybook/html-vite";
import type { Graph } from "@vhult/graph";
import { gridGraph } from "@vhult/graph-bench";
import { countControl } from "../../src/graphStory";
import { stage } from "../../src/stage";

interface Args {
  offset: number;
  zoom: number;
}

const OFFSETS = [0, 10_000, 100_000, 1_000_000] as const;
const SIDE = 100;

function load(graph: Graph, a: Args): void {
  const g = gridGraph(SIDE * SIDE);
  const p = g.nodes.positions;
  for (let i = 0; i < p.length; i += 2) {
    p[i] = p[i]! + a.offset;
    p[i + 1] = p[i + 1]! + a.offset;
  }
  graph.setNodes(g.nodes); // freshly generated: transfer, no copy
  graph.setEdges(g.edges);
  // Centre on a node near the middle of the grid; x.3 so the centre is not f32-representable.
  graph.camera.setView({ x: a.offset + 0.3, y: a.offset + 0.3, zoom: a.zoom, rotation: 0 });
}

const note = (a: Args) => `Far from origin · ${SIDE}×${SIDE} grid graph at +${a.offset.toLocaleString("en-US")}`;

const meta: Meta<Args> = {
  title: "Stress/Far from origin",
  render: (args, ctx) =>
    stage(args, ctx, {
      options: () => ({ edgeColor: [0.6, 0.7, 0.9, 0.6] }),
      setup: (graph, a, hud) => {
        load(graph, a);
        hud.setNote(note(a));
      },
      update: (graph, a, prev, hud) => {
        if (a.offset !== prev.offset) {
          load(graph, a);
          hud.setNote(note(a));
        } else if (a.zoom !== prev.zoom) {
          graph.camera.setView({ zoom: a.zoom });
        }
      },
    }),
  argTypes: {
    offset: countControl(OFFSETS),
    zoom: { control: { type: "range", min: 1, max: 2000, step: 1 } },
  },
  args: {
    offset: 1_000_000,
    zoom: 200,
  },
};

export default meta;

export const FarFromOrigin: StoryObj<Args> = { name: "Far from origin" };

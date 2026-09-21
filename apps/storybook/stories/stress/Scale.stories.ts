/**
 * STRESS: the Communities graph at up to 25M nodes and ~70M edges: the memory
 * ceiling (buffer sizes, upload) and the cost of touching every edge's
 * endpoints each frame.
 *
 * Generation runs on the main thread and takes seconds at this size; the HUD
 * reports it separately from the engine's load time.
 */
import type { Meta, StoryObj } from "@storybook/html-vite";
import { communities } from "@vhult/graph-bench";
import { cached } from "../../src/data";
import { GRAPH_ARGS, graphArgTypes, renderGraph, type GraphArgs } from "../../src/graphStory";

interface Args extends GraphArgs {
  neighbours: number;
}

const SIZES = [5_000_000, 10_000_000, 25_000_000] as const;

const meta: Meta<Args> = {
  title: "Stress/Scale",
  render: renderGraph<Args>({
    describe: (a) => `Scale · communities, ${a.neighbours} nearest neighbours`,
    load: (a) => cached(`communities:${a.nodes}:${a.neighbours}:${a.seed}`, () => communities(a.nodes, a.neighbours, a.seed)),
    dataArgs: ["neighbours"],
  }),
  argTypes: graphArgTypes<Args>(SIZES, {
    neighbours: { control: { type: "range", min: 1, max: 4, step: 1 } },
  }),
  args: { nodes: 10_000_000, neighbours: 2, ...GRAPH_ARGS, edgeAlpha: 0.25 },
};

export default meta;

export const Scale: StoryObj<Args> = {};

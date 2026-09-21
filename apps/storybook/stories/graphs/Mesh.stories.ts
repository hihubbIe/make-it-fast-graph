/**
 * A road or infrastructure network: towns over a sparse countryside, each
 * settlement joined to its nearest neighbours. Millions of short edges that
 * fill the whole screen, with density varying ~5x between town and country.
 *
 * What to check:
 *   - A connected web at every zoom, no square gaps.
 *   - Cost when zoomed out, where every edge is a pixel or two long.
 */
import type { Meta, StoryObj } from "@storybook/html-vite";
import { mesh } from "@vhult/graph-bench";
import { cached } from "../../src/data";
import { GRAPH_ARGS, graphArgTypes, renderGraph, type GraphArgs } from "../../src/graphStory";

interface Args extends GraphArgs {
  neighbours: number;
}

const SIZES = [100_000, 1_000_000, 5_000_000] as const;

const meta: Meta<Args> = {
  title: "Graphs/Mesh",
  render: renderGraph<Args>({
    describe: (a) => `Mesh · settlements joined to ${a.neighbours} nearest`,
    load: (a) => cached(`mesh:${a.nodes}:${a.neighbours}:${a.seed}`, () => mesh(a.nodes, a.neighbours, a.seed)),
    dataArgs: ["neighbours"],
  }),
  argTypes: graphArgTypes<Args>(SIZES, {
    neighbours: { control: { type: "range", min: 1, max: 4, step: 1 } },
  }),
  args: { nodes: 1_000_000, neighbours: 3, ...GRAPH_ARGS },
};

export default meta;

export const Mesh: StoryObj<Args> = {};

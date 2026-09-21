/**
 * A square lattice: every node linked to its right and lower neighbour.
 * Meshes, images, chip layouts.
 *
 * What to check:
 *   - Only horizontal and vertical edges, at every zoom. The engine reorders
 *     nodes on the GPU, so a single diagonal means an edge was mapped to the
 *     wrong node.
 *   - Uniform density everywhere: cost should not depend on where you look.
 */
import type { Meta, StoryObj } from "@storybook/html-vite";
import { gridGraph } from "@vhult/graph-bench";
import { cached } from "../../src/data";
import { GRAPH_ARGS, graphArgTypes, renderGraph, type GraphArgs } from "../../src/graphStory";

const SIZES = [10_000, 100_000, 1_000_000, 4_000_000] as const;

const meta: Meta<GraphArgs> = {
  title: "Graphs/Grid",
  render: renderGraph({
    describe: () => "Grid · square lattice, 4-neighbour links",
    load: (a) => cached(`grid:${a.nodes}:${a.seed}`, () => gridGraph(a.nodes, a.seed)),
  }),
  argTypes: graphArgTypes(SIZES),
  args: { nodes: 100_000, ...GRAPH_ARGS, edgeAlpha: 0.5 },
};

export default meta;

export const Grid: StoryObj<GraphArgs> = {};

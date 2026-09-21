/**
 * STRESS: uniformly random endpoints over a disk of nodes. Edges are as long
 * as the graph is wide, so every pixel is crossed many times over: skipping
 * short edges removes none of them, and culling off-screen ones only helps once
 * zoomed in far enough that most chords miss the viewport. The worst case for
 * fill, and the case that shows what edge drawing costs per pixel.
 */
import type { Meta, StoryObj } from "@storybook/html-vite";
import { fuzzball } from "@vhult/graph-bench";
import { cached } from "../../src/data";
import { GRAPH_ARGS, countControl, graphArgTypes, renderGraph, type GraphArgs } from "../../src/graphStory";

interface Args extends GraphArgs {
  edgeCount: number;
}

const SIZES = [10_000, 100_000, 1_000_000] as const;
const EDGE_COUNTS = [100_000, 1_000_000, 3_000_000, 10_000_000, 30_000_000] as const;

const meta: Meta<Args> = {
  title: "Stress/Fuzzball",
  render: renderGraph<Args>({
    describe: () => "Fuzzball · random endpoints, long edges everywhere",
    load: (a) => cached(`fuzzball:${a.nodes}:${a.edgeCount}:${a.seed}`, () => fuzzball(a.nodes, a.edgeCount, a.seed)),
    dataArgs: ["edgeCount"],
  }),
  argTypes: graphArgTypes<Args>(SIZES, { edgeCount: countControl(EDGE_COUNTS) }),
  args: { nodes: 100_000, edgeCount: 1_000_000, ...GRAPH_ARGS, edgeAlpha: 0.04 },
};

export default meta;

export const Fuzzball: StoryObj<Args> = {};

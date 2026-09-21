/**
 * A modular graph as a force layout draws it: round communities of very
 * different sizes set apart on a spiral. Inside each, nodes link to their
 * nearest neighbours and one in five also to a random member (the blob's fuzz);
 * one in fifty links to a nearby community (the bundles between blobs).
 * Social, citation and biological networks.
 *
 * What to check:
 *   - Blobs read as separate communities, joined by visible bundles.
 *   - `neighbours` scales the edge count (~0.65 · n per neighbour, plus
 *     ~0.22 · n of fuzz and bundles) without changing the shape.
 */
import type { Meta, StoryObj } from "@storybook/html-vite";
import { communities } from "@vhult/graph-bench";
import { cached } from "../../src/data";
import { GRAPH_ARGS, graphArgTypes, renderGraph, type GraphArgs } from "../../src/graphStory";

interface Args extends GraphArgs {
  neighbours: number;
}

const SIZES = [100_000, 1_000_000, 5_000_000] as const;

const meta: Meta<Args> = {
  title: "Graphs/Communities",
  render: renderGraph<Args>({
    describe: (a) => `Communities · ${a.neighbours} nearest neighbours, in-community links, bundles`,
    load: (a) => cached(`communities:${a.nodes}:${a.neighbours}:${a.seed}`, () => communities(a.nodes, a.neighbours, a.seed)),
    dataArgs: ["neighbours"],
  }),
  argTypes: graphArgTypes<Args>(SIZES, {
    neighbours: { control: { type: "range", min: 1, max: 4, step: 1 } },
  }),
  args: { nodes: 1_000_000, neighbours: 2, ...GRAPH_ARGS },
};

export default meta;

export const Communities: StoryObj<Args> = {};

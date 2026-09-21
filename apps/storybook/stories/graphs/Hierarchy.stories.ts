/**
 * A tree: file systems, org charts, taxonomies. Heavy-tailed fan-out, so a few
 * hubs have hundreds of children; nodes are coloured by top-level branch and
 * sized by subtree.
 *
 * Layouts:
 *   - nested: every subtree owns a rectangle proportional to its size, the
 *     node at its centre. Uniform density and short edges at every zoom; the
 *     layout that scales to millions.
 *   - layered: the classic top-down drawing, one row per depth. Readable up
 *     to a few thousand nodes, a dense fan beyond.
 *
 * What to check:
 *   - `directed` draws arrowheads, parent → child.
 *   - A few long top-level edges over many short ones: the length mix of a
 *     real hierarchy.
 */
import type { Meta, StoryObj } from "@storybook/html-vite";
import { hierarchy, type HierarchyLayout } from "@vhult/graph-bench";
import { cached } from "../../src/data";
import { EDGE_DIRECTED, GRAPH_ARGS, graphArgTypes, renderGraph, type GraphArgs } from "../../src/graphStory";

interface Args extends GraphArgs {
  layout: HierarchyLayout;
  directed: boolean;
}

const SIZES = [1_000, 10_000, 100_000, 1_000_000, 5_000_000] as const;

const meta: Meta<Args> = {
  title: "Graphs/Hierarchy",
  render: renderGraph<Args>({
    describe: (a) => `Hierarchy · ${a.layout} tree${a.directed ? ", directed" : ""}`,
    load: (a) => cached(`hierarchy:${a.nodes}:${a.layout}:${a.seed}`, () => hierarchy(a.nodes, a.layout, a.seed)),
    dataArgs: ["layout"],
    // Arrowheads are compiled into the edge shader, so this is an engine option.
    options: (a) => ({ directedEdges: a.directed }),
    edgeStyle: (a) => (a.directed ? EDGE_DIRECTED : undefined),
  }),
  argTypes: graphArgTypes<Args>(SIZES, {
    layout: { control: "inline-radio", options: ["nested", "layered"] },
    directed: { control: "boolean" },
  }),
  args: { nodes: 1_000_000, layout: "nested", directed: false, ...GRAPH_ARGS },
};

export default meta;

export const Hierarchy: StoryObj<Args> = {};

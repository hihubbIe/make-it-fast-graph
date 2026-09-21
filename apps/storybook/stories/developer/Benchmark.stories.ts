/**
 * Benchmark harness (§19.3). A fixed camera path is replayed one step per
 * rendered frame inside the render worker; per-frame GPU (total and per pass),
 * worker CPU, frame interval and visible counts are recorded there and returned
 * in one message. The main thread does nothing during a run.
 *
 * - Run: the dataset/count/path selected in Controls.
 * - Run suite: the SPEC §2 datasets (nodes only until edges land), with targets.
 * - Download JSON: summaries + raw series, to diff against later runs.
 *
 * For unquantized GPU timestamps in Chrome, enable
 * chrome://flags/#enable-webgpu-developer-features.
 */
import type { Meta, StoryObj } from "@storybook/html-vite";
import type { Graph } from "@vhult/graph";
import { PATHS, type GeneratorName, type PathName } from "@vhult/graph-bench";
import { BenchPanel } from "../../src/bench";
import { COUNT_OPTIONS, GENERATOR_OPTIONS, loadDataset } from "../../src/data";
import type { Hud } from "../../src/hud";
import { stage } from "../../src/stage";

interface Args {
  dataset: GeneratorName;
  count: number;
  path: PathName;
  /** 0 disables LOD; see docs/decisions.md 0022. */
  lodTargetPx: number;
}

/** Latest args, read by the panel when "Run" is clicked. */
let current: Args | null = null;

function load(graph: Graph, a: Args, hud: Hud): void {
  const { data, genMs } = loadDataset(a.dataset, a.count);
  hud.measureLoad(graph, genMs, a.count);
  graph.setNodes(data, { copy: true });
  graph.camera.fit();
  hud.setNote(`${a.dataset} · path ${a.path}`);
}

const meta: Meta<Args> = {
  title: "Developer/Benchmark",
  render: (args, ctx) =>
    stage(args, ctx, {
      // Changing this recreates the engine, so LOD on/off is a clean A/B.
      options: (a) => ({ lodTargetPx: a.lodTargetPx }),
      setup: (graph, a, hud, root) => {
        current = a;
        load(graph, a, hud);
        new BenchPanel(root, graph, () => ({ name: "custom", dataset: current!.dataset, count: current!.count, path: current!.path }));
      },
      update: (graph, a, prev, hud) => {
        current = a;
        if (a.dataset !== prev.dataset || a.count !== prev.count) load(graph, a, hud);
        else if (a.path !== prev.path) hud.setNote(`${a.dataset} · path ${a.path}`);
      },
    }),
  argTypes: {
    dataset: { control: "select", options: GENERATOR_OPTIONS },
    count: {
      control: "select",
      options: COUNT_OPTIONS,
      labels: Object.fromEntries(COUNT_OPTIONS.map((n) => [n, n.toLocaleString("en-US")])),
    },
    path: { control: "select", options: Object.keys(PATHS) as PathName[] },
    lodTargetPx: { control: { type: "number", min: 0, step: 0.5 } },
  },
  args: {
    dataset: "clustered",
    count: 1_000_000,
    path: "standard",
    lodTargetPx: 2.5,
  },
};

export default meta;
type Story = StoryObj<Args>;

export const Benchmark: Story = {};

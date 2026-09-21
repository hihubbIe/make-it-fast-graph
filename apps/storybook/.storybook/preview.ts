import type { Preview } from "@storybook/html-vite";
import { disposeStage } from "../src/stage";
import "./preview.css";

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true, sort: "none" },
    options: {
      storySort: {
        order: [
          "Demos",
          ["Small graph"],
          "Graphs",
          ["Grid", "Communities", "Hierarchy", "Mesh", "Live layout"],
          "Stress",
          ["Fuzzball", "Scale", "Far from origin"],
          "Developer",
          ["Benchmark", "GPU correctness"],
        ],
      },
    },
  },
  // Release the engine (worker + GPU device) when the story is torn down.
  // Storybook calls this once on teardown, not on arg changes.
  beforeEach: () => disposeStage,
};

export default preview;

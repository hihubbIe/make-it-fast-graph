import type { StorybookConfig } from "@storybook/html-vite";
import { mergeConfig } from "vite";

/**
 * Storybook is a CONSUMER of the built package (`@vhult/graph` → dist/), exactly
 * like a real app. Run `npm run dev` at the repo root: it rebuilds the library
 * on change and Storybook reloads.
 *
 * Performance hygiene: HTML renderer (no React/Vue in the preview iframe),
 * every preview-side addon that injects DOM or listeners is disabled, only
 * Controls remain.
 */
const config: StorybookConfig = {
  stories: ["../stories/**/*.stories.ts"],
  // `_headers`: the static host's COOP/COEP (the dev server's `crossOriginIsolated` does not reach a static build).
  staticDirs: ["../public"],
  addons: [],
  framework: { name: "@storybook/html-vite", options: {} },
  core: {
    disableTelemetry: true,
    // COOP/COEP on every response → SharedArrayBuffer input ring + stats (§6).
    crossOriginIsolated: true,
  },
  features: {
    actions: false,
    backgrounds: false,
    highlight: false,
    interactions: false,
    measure: false,
    outline: false,
    viewport: false,
    sidebarOnboardingChecklist: false,
    menuOnboardingChecklist: false,
  },
  viteFinal: (cfg) =>
    mergeConfig(cfg, {
      // Linked workspace package: serve its dist as-is; never pre-bundle the worker away.
      optimizeDeps: { exclude: ["@vhult/graph"] },
      worker: { format: "es" },
      build: { target: "es2022" },
    }),
};

export default config;

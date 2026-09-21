/**
 * Build @vhult/graph.
 *
 *   node scripts/build.mjs             generate layouts.wgsl, bundle, emit .d.ts
 *   node scripts/build.mjs --watch     same, then rebuild on change (no .d.ts)
 *   node scripts/build.mjs --gen-only  only regenerate layouts.wgsl
 *
 * Output: dist/index.js (main thread), dist/worker.js (render worker),
 * dist/types/**.d.ts. The worker is loaded via
 * `new URL("./worker.js", import.meta.url)`, which every modern bundler understands.
 */
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const args = new Set(process.argv.slice(2));
const watch = args.has("--watch");
const LAYOUTS_WGSL = "src/shaders/common/layouts.wgsl";

/** Emit layouts.wgsl from Layouts.ts; writes only on change so watch mode doesn't loop. */
async function generateLayouts() {
  const out = await esbuild.build({
    entryPoints: ["src/data/LayoutsWgsl.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  });
  const url = `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`;
  const { emitLayoutsWgsl } = await import(url);
  const next = emitLayoutsWgsl();
  const prev = await readFile(LAYOUTS_WGSL, "utf8").catch(() => "");
  if (prev !== next) await writeFile(LAYOUTS_WGSL, next);
}

function emitDeclarations() {
  const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [tsc, "-p", "tsconfig.build.json"], { stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tsc exited with ${code}`))));
  });
}

const layoutsPlugin = {
  name: "layouts-wgsl",
  setup(build) {
    build.onStart(generateLayouts);
  },
};

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: { index: "src/index.ts", worker: "src/bridge/worker.ts" },
  outdir: "dist",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  // Measured: index + worker 55 -> 44 KB brotli; time to first frame unchanged (parse is not the startup cost).
  minify: true,
  sourcemap: "linked",
  loader: { ".wgsl": "text" },
  legalComments: "none",
  logLevel: "info",
  plugins: [layoutsPlugin],
};

if (args.has("--gen-only")) {
  await generateLayouts();
} else if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await rm("dist", { recursive: true, force: true });
  await esbuild.build(options);
  await emitDeclarations();
}

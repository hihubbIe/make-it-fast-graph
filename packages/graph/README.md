# @vhult/graph

WebGPU graph rendering engine. Rendering only: no layout, no simulation.
You give it node positions and edges as typed arrays; it draws them from a Web
Worker on an `OffscreenCanvas`, so the main thread never touches the GPU.

```sh
npm install @vhult/graph
```

Requires a WebGPU-capable browser (Chrome/Edge 113+, Firefox 141+ on Windows,
Safari 26+). Zero runtime dependencies.

## Quick start

```ts
import { Graph, packRgba, UnsupportedError } from "@vhult/graph";

const canvas = document.querySelector("canvas")!; // give it a CSS size; it tracks resizes

let graph: Graph;
try {
  graph = await Graph.create(canvas);
} catch (e) {
  if (e instanceof UnsupportedError) console.warn("No WebGPU here:", e.code);
  throw e;
}

const n = 100_000;
const positions = new Float32Array(2 * n); // x, y interleaved, world units
for (let i = 0; i < 2 * n; i++) positions[i] = Math.random() * 1000;

graph.setNodes({
  count: n,
  positions,
  sizes: new Float32Array(n).fill(4), // diameters, world units
  colors: new Uint32Array(n).fill(packRgba(0.3, 0.6, 1)),
});
graph.setEdges({ count: 2, indices: new Uint32Array([0, 1, 1, 2]) }); // source, target pairs
graph.camera.fit();
```

Pan and zoom are built in (`controls: false` turns them off). Call
`graph.destroy()` to release the worker and the GPU device.

**Arrays are transferred, not copied**: after `setNodes` / `setEdges` the arrays
you passed are detached. Pass `{ copy: true }` as the second argument to keep
them.

## Serve with cross-origin isolation

For the fastest input path, serve your page with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Pointer input and stats then go through a `SharedArrayBuffer`. Without these
headers the engine still runs, but falls back to `postMessage`.
`graph.caps.sharedMemory` tells you which one you got.

## Bundlers

The render worker is loaded with
`new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`, so
`dist/worker.js` must stay next to `dist/index.js`. With Vite, keep the package
out of dependency pre-bundling so that URL survives:

```ts
// vite.config.ts
export default defineConfig({
  optimizeDeps: { exclude: ["@vhult/graph"] },
  worker: { format: "es" },
});
```

## API

Everything is typed; the `.d.ts` files document each option and method.

| | |
|---|---|
| `Graph.create(canvas, options?)` | Start the engine. Rejects with `UnsupportedError` when WebGPU or `OffscreenCanvas` is missing |
| `setNodes`, `setEdges` | Bulk-load typed arrays (set nodes first, then edges) |
| `updateNodePositions`, `updateNodeColor` | Partial updates |
| `setNodeLabels`, `setEdgeLabels` | Label text, placed without overlap |
| `camera.fit`, `camera.setView`, `camera.getView` | Camera control |
| `readStats(out?)` | Frame stats: visible counts, CPU/GPU ms, GPU memory held |
| `on("error", fn)` | Runtime errors, e.g. device loss |
| `destroy()` | Release everything |

## License

MIT

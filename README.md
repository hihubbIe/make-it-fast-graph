# @vhult/graph

Super fast WebGPU graph rendering engine..

<img width="448" height="397" alt="image" src="https://github.com/user-attachments/assets/67372405-85ef-4394-9f5d-4096b1bd4dfe" />

## Demo
Storybook is available here: https://vhult-graph.ivanalglave.workers.dev/

## Performance
The goal of this library is to make a new generation graph rendering using webGPU with the highest possible level of performance.
It is currently able to render a 25 million nodes and 66 million edges graph smoothly on a laptop iGPU.

<img width="677" height="814" alt="image" src="https://github.com/user-attachments/assets/aa8b26e4-05c4-4dee-b9d0-eba157ce742a" />

## Workspace

```
packages/graph/          @vhult/graph — the library (zero runtime dependencies)
  src/api/               main-thread facade: Graph, public types, errors, pointer capture
  src/bridge/            main ↔ worker: protocol, InputRing (SAB), shared state, worker entry
  src/engine/            worker-side orchestrator: frame loop, dirty flags, idle sleep
  src/gpu/               device/limits, caps, bind layouts, uploader, frame graph, shaders
  src/data/              Layouts.ts (single source of truth), SoA store, dirty ranges, packing
  src/camera/            f64 camera with hi/lo upload, pan/zoom controls
  src/passes/            one file per frame-graph pass (cull, node geometry, …)
  src/shaders/           WGSL (common/, passes/) + preprocessor
  test/                  unit tests (vitest)
  docs/decisions.md      ADR log
packages/bench/          @vhult/graph-bench — seeded datasets, camera paths, stats (private)
apps/storybook/          @vhult/graph-storybook — consumes the built package (private)
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Build the library, then watch it + run Storybook on http://localhost:6006 |
| `npm run build` | Build `packages/graph/dist` (ESM + worker + `.d.ts`) |
| `npm test` | Unit tests |
| `npm run typecheck` | Typecheck every workspace |
| `npm run gen -w @vhult/graph` | Regenerate `layouts.wgsl` from `Layouts.ts` |

Requires a WebGPU-capable browser (Chrome/Edge 113+, Firefox 141+ on Windows,
Safari 26+).

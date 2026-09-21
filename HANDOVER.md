# HANDOVER — @vhult/graph

Start-of-thread briefing. Read with `SPEC.md` (the build spec) and
`packages/graph/docs/decisions.md` (ADR log with every measurement; source of truth).

## Working rules (from CLAUDE.md + owner)

- No work without the owner's explicit **"GO"**. Never push. No new libraries/packages/tools without approval.
- Performance first, **measured before decided** (CLAUDE.md). Keep only what wins on the owner's GPU.
- Clean, scoped file structure; no filler files. No competitor libs (cosmos.gl was dropped).
- Naming: npm `@vhult/graph`; internal `graph` (class `Graph`, WGSL prefix `graph_`).

## Status

- M1 (worker/OffscreenCanvas/SAB input ring, f64 camera with hi/lo), M2 (instanced SDF nodes),
  M3 (GPU cull + indirect draw + timestamp profiler + benchmark harness) — done.
- Plus parts of M6 pulled forward: GPU Morton sort + engine order + chunk bounds + interleaved draw order.
- 36 unit tests pass (`npm test`), typecheck clean, Storybook builds.

### IN PROGRESS — M5 edge rework (owner approved a full teardown of the edge path)

> **READ ADR 0038 FIRST.** Edge sampling as shipped makes edges POP while
> zooming — a real bug, reported by the owner. It is now disabled by default
> (`edgeSampleLenPx: 0`, exact drawing), which costs back most of the speed
> below. 0038 has the diagnosis, why a precomputed density field was rejected,
> and the density-driven design that replaces it. **That is the next work.**

The edge path does not scale: 3M edges cost 31 ms at fit and **220 ms at zoom x8**,
while 10M nodes are fine. Diagnosis and plan are ADRs **0029** and **0030**; read
those two first, they contain the numbers that decide the design.

Agreed scope: sampling is acceptable (same deal as node LOD), **full feature
parity** with what the quad path ships today (per-edge width, per-edge colour
gradient, arrowheads, analytic AA, round caps — curves/dashes/caps/z-layer are
reserved bits nothing reads), and a full teardown rather than staged patching.
The quad path stays in the tree until the new one wins every bench case, then is
deleted in the same change — `setEdgeMode` is what makes that A/B a single
browser run.

| # | step | state |
|---|---|---|
| 1 | ink counter (`setProfileEdgeInk`, `GraphStats.edgeInk`), validated vs CPU oracle | **done** (ADR 0029) |
| 2 | what governs splat throughput | **done** (ADR 0030) |
| 2b | honest tiled pipeline: bin-count → scan → bin-scatter → shared-mem raster | **done** (ADR 0031) — 6–13x |
| 2c | binning cost vs entries (decides the budget split) | **done** (ADR 0032) |
| 3 | edge order: length-bucketed sort key (shuffle tried, reverted) | **done** (ADR 0033) |
| 4 | weighted sampling: keep short whole, hash-drop long (default 64 px) | **done** (ADR 0034) — 12x at zoom |
| 5 | tiled rasterizer in the engine (`edgeMode: "tiled"`) | **done** (ADR 0035) — 11x raster at zoom |
| 5b | split the raster by length: short global-atomic, long tiled (`auto` uses it) | **done** (ADR 0036) |
| 5c | full parity in the tiled path (per-edge width/colour, arrowheads) | not started |
| 6a | **zoom-sweep visual regression** — diff consecutive frames along a zoom | **do this first** (ADR 0038) |
| 6b | density-driven keep-rate from the previous frame's accumulator | **next**, and it replaces 0034 |
| 6c | fuse cull+bin, drop the 24 B compaction (2 of 4 per-frame edge walks) | not started |
| 6d | single-pass binning + workgroup-aggregated tile counters | not started |
| 6 | delete compaction, quad path, scan machinery | not started |

**Where it stands**, 1M nodes / 3M edges, whole frame:

| view | before this work | now | |
|---|---|---|---|
| fit | 33.1 ms | **18.7 – 20.7** | ~1.7x |
| zoom x8 | **252.8 ms** | **10.5 – 13.6** | **~20x** |

Two levers got there: weighted sampling of long edges (0034) and a hybrid
rasterizer — short edges splatted directly, long edges tiled (0035, 0036).

**With sampling off (the correct default), drawing every edge costs ~28 ms at
fit and ~42 ms at x8** on the current tiled hybrid. The numbers in the table
above were measured with the popping sampler ON and are not a shippable state.

**LOD is not optional:** ink peaks mid-zoom — 142M splats at fit, **342M at
x8**, 66M at x64 — and 342M deposits into 2.7M pixels is ~127 per pixel, which
no tone map can show. The mistake in 0034 was the axis (length, which tracks
cost) rather than the idea; 0038 keys it to local density, which tracks
invisibility.

The original 2–4 ms budget (ADR 0032) was rasterizer-only and never counted the
cull — a planning error. Getting there needs 6b (fewer edges, honestly) plus
6c/6d (fewer walks over them).

**Measurement caveat:** this iGPU gives a ~2x spread on repeated identical work
in the `__edgeBench.measure` harness. Do not trust differences under ~2x from a
single run; the ranges above are real spread, not rounding.

Probe scripts live in the session scratchpad, not the repo (they are the
measurement, so keep them if this work continues):
`%LOCALAPPDATA%/Temp/claude/C--Users-ivana-Documents-repos-make-it-fast-graph/<session>/scratchpad/`
— `ink.js` / `ink-fit.js` / `sample.js` (run with
`gpu.mjs eval --story edges-geometry--hairball`), `splat.js` / `tiled.js` (run
with `gpu.mjs eval`, blank page). Worth moving into `scripts/` if kept.
**That story and its `__edgeBench` hook are gone** (Storybook rework, 2026-09-21);
any story now exposes the engine as `globalThis.__graphStage.graph`. The old
hairball (85 % local + 15 % random edges) has no exact successor: local edges are
`graphs-communities--communities`, long ones `stress-fuzzball--fuzzball`.

Three things to carry forward: **cost is deposited pixel steps, not edges**;
**throughput depends on how spread out those deposits are, not on geometry**;
and once tiled, **the bill moves back to segment count**, because binning is
per segment and does not care about ink (ADR 0031).

## Layout

```
packages/graph     library (zero runtime deps). src/{api,bridge,engine,gpu,data,camera,passes,shaders}
packages/bench     @vhult/graph-bench: seeded datasets, camera PATHS, stats, CPU reference (oracle)
apps/storybook     consumes built dist/. Stories by use case: Graphs/* (Grid, Communities,
                   Hierarchy, Mesh, Live layout), Stress/* (Fuzzball, Scale, Far from origin),
                   Developer/* (Benchmark, GPU correctness). Graph generators: packages/bench/src/graphs.ts
```
`npm run dev` = build lib + watch + Storybook on :6006. `data/Layouts.ts` is the single source of
truth; `npm run gen` regenerates `shaders/common/layouts.wgsl` (a test checks it is current).

## Architecture (as built)

- **Threads:** main thread (DOM input → SharedArrayBuffer ring, API calls) + one render Web Worker
  (`new Worker(new URL("./worker.js", import.meta.url), {type:"module"})`, canvas via
  `transferControlToOffscreen`). Stats/camera back via SAB. Idle frames skipped entirely.
- **Engine order:** all node buffers (@group(1)) are physically Morton-sorted on the GPU (stable LSD
  radix, 4-bit digits). `order[engine]=user`, `rank[user]=engine` on GPU; partial updates by user index
  go through `rank` (scatter kernel). CPU never needs the permutation. (ADR 0018)
- **Frame:** UPLOAD → SORT (data changes only) → TRANSFORM_CULL → one render pass.
- **Cull phases:** `bounds` (per 1024-node chunk, data changes only) → `count` (whole-chunk early-out,
  4 nodes/thread) → `scan.reduce` / `scan.blocks` / `scan.down` (device-wide scan) → `scatter`
  (indirect over non-empty chunks) → `NodeInstance` 16 B records → `drawIndirect` per bucket.
- **Draw order ≠ engine order:** BUCKET_NORMAL slots ordered by (segment of 16, golden-ratio-scrambled
  chunk, engine index): stable (no flicker) yet decorrelated (no blend serialization). (ADR 0020)
- **Limits:** the §8 contract takes 8 storage buffers/stage; passes add up to 5 more (the owner's device reports 16). Indirect args live in their own buffer.

## Owner's GPU & key numbers

Intel Xe-LPG iGPU (Arc), Edge 153, ~69.5 GB/s measured read bandwidth, viewport ~2418×1112.
Owner suite, GPU ms p50 / p99 (first M3 run → latest run `Downloads/bench-2026-09-19-20-23.json`):

| case | M3 | latest | target p99 |
|---|---|---|---|
| small 10k | 0.59 / 0.85 | 0.85 / 1.18 | 1.0 ✗ (fixed-overhead regression) |
| medium 250k | 0.98 / 1.57 | 1.11 / 1.77 | 2.5 ✓ |
| large 1M | 1.90 / 3.80 | 1.38 / 4.39 | 6.0 ✓ |
| xlarge 10M (standard) | 9.37 / 40.0 | 4.06 / 37.6 | 16 ✗ |
| deep-zoom 10M | 7.14 / 9.11 | 1.84 / 2.88 | 8.0 ✓ |
| zoom sweep 10M | (130 / 324 before interleave) | 20.6 / 38.1 | 16 ✗ |
| zoom sweep 1M | — | 3.93 / 5.96 | 6.0 ✓ |

Microbenchmark conclusions (all in ADRs 0014–0020):
- full 16 B/node scan roofline 2.3 ms @10M; 4 items/thread −20 %; subgroups: no gain.
- sorted buffers vs index permutation: 0.37 vs 1.01 (deep), 1.12 vs 10.96 (10 %), 8.2 vs 99.5 ms (fit).
- radix sort 3.3 ms @1M, 31 ms @10M; permute gather ≈ 33 ms @10M (data changes only).
- batch shuffle of engine order rejected (cull vs draw trade-off); segment interleave of draw slots wins.
- **Driver bug (ADR 0019):** a valid WGSL pattern (write workgroup var before a barrier loop, read after)
  read stale values when the GPU was warm. Rule: verify kernels warm, repeatedly, on real data vs CPU.

## Known issues

1. **Deep zoom feels choppy by hand (8–30 fps) although the benchmark is a steady 60 fps**
   (frame interval p99 16.9 ms). So it is input → frame, not GPU. Suspects: instant unsmoothed wheel
   steps (~15 %/notch), worker sleep/wake latency between events, worker rAF pacing; HUD "fps" counts
   rendered frames, so it also reflects input rate.
2. **Small graphs over target:** fixed ~0.2 ms in `cull.scan.blocks` (serial `prefixBefore` loops over
   ≤1024 cells for bucket bases) + 7 passes of fixed cost.
3. **Profiler drops the slowest samples** under load (148/200 in heavy cases, readback ring of 4 full) →
   GPU p99 optimistic; frame interval p99 (86 ms) exceeds GPU p99 (38 ms) in the 10M zoom sweep.
4. **Partial position updates rescan all bounds:** 0.9 ms/frame @1M (~9 ms @10M).
5. **10M zoomed-out** still ~20 ms: draw ~10–24 ms, scatter ~6–9 ms, count ~3–5 ms → needs M4 + LOD.
6. Owner's timestamps are quantized (65 µs): enable `edge://flags/#enable-webgpu-developer-features`.

## Next steps (proposed order — each needs GO, stop after each testable step)

1. **Interactive smoothness:** input-driven benchmark (synthetic wheel/drag via CDP, measure frame
   intervals + event→frame latency) → smooth animated zoom (+ optional pan inertia) in the worker →
   fix wake latency → **A/B worker vs main-thread engine** (`Engine` is nearly thread-agnostic):
   pacing, latency, and smoothness under an artificially busy main thread. Choose default by data.
2. **Small-graph overhead:** pad bucket cell ranges to SCAN_BLOCK so bucket bases read directly from
   block sums (remove serial loops); consider fused passes for small N.
3. **Honest profiler:** larger readback ring, report dropped-sample count in results.
4. **Partial updates:** scatter kernel flags touched chunks; bounds phase recomputes flagged chunks only.
5. **M4 compute rasterizer:** TINY bucket (r < 3 px) → atomic weighted-average accumulation (order-
   independent; input list may be decorrelated freely), resolve pass, tiling fallback. Must beat M3/now
   at large/xlarge; record ratio in ADR.
6. **M6 LOD** (clusters + cross-fade) **before M5 edges**, so edges get edge-LOD + spatial culling from day one.
   Also later: radix sort 8-bit digits (half the passes), per-node `screenPos` cache when edges need it.

## How to verify (no extra deps)

- **Correctness:** Storybook *Developer / GPU correctness* (GPU visible counts vs `cpuVisibleCount` oracle,
  incl. partial updates) — must show PASS. Automation: `await globalThis.__graphCorrectness.result`.
- **Benchmarks:** *Developer / Benchmark* → Run suite → Download JSON (keep in `packages/bench/results/`).
  Automation: `await globalThis.__graphBench.run(cases?)`; `__graphBench.graph` gives the `Graph`.
- Instance-level checks were done with a temporary debug readback (not in repo): every visible node
  exactly one `NodeInstance`, 0 wrong.

## Appendix — headless GPU runner (was in a temp folder, not committed)

Headless Edge reaches the real GPU. Launch, then drive over the DevTools protocol with Node's
built-in `WebSocket` (open `/json/new?<url>` with PUT, wait for `document.readyState === "complete"`,
then `Runtime.evaluate` an async function with `awaitPromise:true, returnByValue:true`):

```
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new
  --remote-debugging-port=9333 --user-data-dir=<temp>/edge-profile
  --enable-unsafe-webgpu --enable-webgpu-developer-features
  --disable-gpu-vsync --disable-frame-rate-limit --window-size=1920,1080
  --force-device-scale-factor=1 about:blank
```
Story URLs: `http://localhost:6006/iframe.html?id=developer-benchmark--benchmark&viewMode=story`,
`...id=developer-gpu-correctness--gpu-correctness...`. Never run two correctness runs at once
(they share the camera). Don't rebuild the library while a benchmark is running (Vite reloads the page).

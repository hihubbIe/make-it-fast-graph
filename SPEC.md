# @vhult/graph — Build Specification

**A WebGPU graph rendering engine. Rendering only. No layout, no simulation.**

Target: sustain 60 fps on 10M nodes / 30M edges on a mid-range 2024 discrete GPU, and
meet every per-stage budget in §18.2. Performance is judged against these absolute
budgets and against our own previous benchmark runs — no competitor libraries are
added to the repository.

---

## 0. How to use this document

This is a build spec for an AI coding agent. Read it fully before writing code.

Rules of engagement:

1. **Build in milestone order (§20).** Each milestone has acceptance criteria. Do not
   start milestone N+1 until N's criteria pass.
2. **Every performance claim in this spec must be measured, not assumed.** The engine
   ships with its own GPU profiler (§18) from milestone 3 onward. If a technique does
   not measurably win on the benchmark harness, revert it and note why in
   `docs/decisions.md`.
3. **Do not add dependencies** beyond those listed in §3. Specifically: no three.js, no
   luma.gl, no Babylon, no regl, no wgpu-matrix. The abstractions those provide are
   exactly the ones this engine must control directly (indirect draws, bind group
   layouts, custom compute passes, buffer lifetimes).
4. **The binding layout contract (§8) and the shader hook contract (§16) are public
   API.** Changing them is a breaking change. Get them right early; version them.
5. When something in this spec is wrong or impossible, say so and propose an
   alternative. Do not silently deviate.

---

## 1. Scope

### In scope

- Rendering 2D graphs: nodes, edges, labels, icons, halos, selection, hover.
- GPU-resident data. Streaming updates. Zero per-object CPU work per frame.
- Camera (pan/zoom/rotate), hit testing, box/lasso selection.
- A shader extension system that lets users write WGSL for node shapes, colors,
  transforms, edge appearance, and whole custom passes.

### Out of scope (deliberately)

- **Force simulation or any layout algorithm.** The node position buffer is a
  `GPUBuffer` the caller owns and may write to from their own compute shaders.
  This is a feature, not an omission — renderers that couple simulation and rendering
  cannot be driven by the caller's own compute.
- 3D. The engine is 2D with an optional z-order/priority channel.
- Data loading, parsing, graph algorithms.
- A React/Vue wrapper. Ship the core; wrappers live in separate packages later.

### Non-goals that look like goals

- **WebGL2 fallback.** Do not build one. It doubles the engine and forces abandoning
  compute rasterization (§9.2), density edges (§10.2), and GPU culling (§7), which are
  the entire performance thesis. Ship a clear "WebGPU required" error path instead.
- Optimizing for 10k nodes. At that size any GPU renderer is idle. The architecture
  pays off from ~200k and becomes decisive at ~1M.

---

## 2. Success criteria

The benchmark harness (§19.3) runs these on a fixed machine and writes
`bench/results/<date>.json`. These are the ship gates.

| Dataset | Nodes | Edges | Target frame time (p99) | Notes |
|---|---|---|---|---|
| `small` | 10k | 30k | < 1.0 ms | must be GPU-idle |
| `medium` | 250k | 750k | < 2.5 ms | |
| `large` | 1M | 5M | < 6.0 ms | fit-to-screen zoom |
| `xlarge` | 10M | 30M | < 16.0 ms | fit-to-screen zoom |
| `deep-zoom` | 10M | 30M | < 8.0 ms | zoomed to ~2k visible nodes |
| `labels` | 1M | 5M | < 10.0 ms | 500 visible labels |

Additional gates:

- **Idle cost is zero.** With no camera movement and no data change, the engine must
  submit no GPU work and allocate nothing.
- **Main thread time per frame < 0.2 ms** in all cases (engine runs in a worker, §6).
- **Upload of a 1M-node dataset from typed arrays to first frame < 250 ms.**
- **No GC-triggering allocation in the steady-state frame loop.** Verify with a heap
  profile over 600 frames: allocation delta must be 0 bytes.

---

## 3. Platform, dependencies, constraints

### Required

- WebGPU, `featureLevel: "core"`. WebGPU reached Baseline in January 2026 (Chrome,
  Edge, Firefox on Windows/macOS-ARM, Safari 26+). Firefox on Linux and Android still
  lag — detect and fail gracefully.
- `OffscreenCanvas` transferred to a dedicated Worker.
- `SharedArrayBuffer` for the input ring buffer. Requires COOP/COEP headers; if
  unavailable, fall back to `postMessage` with a structured-clone-free path (numbers
  only) and document the perf delta.

### Dependencies

```
runtime:   (none)
dev:       typescript, vitest, @webgpu/types, esbuild
tools:     msdf-atlas-gen (build-time only, for font + icon atlases)
```

That is the whole list. Write the WGSL preprocessor yourself (§16.3) — it is ~200 lines
and a dependency here would own your public API.

### Known platform constraints to design around

1. **No 64-bit atomics.** WGSL atomics are `u32`/`i32` on storage and workgroup memory
   only. All compute-raster keys must pack into 32 bits (§9.2).
2. **No atomics on storage textures.** The compute rasterizer's framebuffer is a
   storage *buffer*, blitted in a resolve pass.
3. **Compatibility mode has `maxStorageBuffersInVertexStage = 0`.** If
   `adapter.featureLevel !== "core"`, refuse to initialize the fast path; storage
   buffers in the vertex stage are load-bearing everywhere in this engine.
4. **`drawIndirect` with non-zero `firstInstance` requires the
   `indirect-first-instance` feature.** Without it the draw is silently a no-op. Always
   write `firstInstance = 0` and offset inside the shader unless the feature is present.
5. **`multi-draw-indirect` is experimental**, not core. Treat it as an optional fast
   path behind `caps.multiDrawIndirect`; the default path issues one `drawIndirect` per
   bucket (there are ≤8 buckets, so this is cheap).
6. **`maxComputeWorkgroupsPerDimension` is 65535.** At workgroup size 256 that caps a
   1D dispatch at 16.7M items. Use 2D dispatch grids for anything that can exceed it,
   and pass the grid width as a constant.
7. **Timestamp query values are quantized** by the browser for security. Average over
   ≥30 frames before reporting.

### 3.1 Limits negotiation (do this correctly, it is load-bearing)

Default limits are far too small. At device request, ask for the adapter's reported
maximum on every limit you use:

```ts
const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
if (!adapter) throw new UnsupportedError("no-adapter");

const WANTED = [
  "maxBufferSize",
  "maxStorageBufferBindingSize",
  "maxStorageBuffersPerShaderStage",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupSizeX",
  "maxBindGroups",
  "maxColorAttachmentBytesPerSample",
] as const;

const requiredLimits: Record<string, number> = {};
for (const k of WANTED) requiredLimits[k] = adapter.limits[k];

const device = await adapter.requestDevice({
  requiredLimits,
  requiredFeatures: pickOptional(adapter, [
    "timestamp-query",
    "indirect-first-instance",
    "subgroups",
    "float32-filterable",
  ]),
});
```

Why this matters concretely:

- 10M nodes × 16 B = 160 MB. The *default* `maxStorageBufferBindingSize` is 128 MiB,
  so the node buffer would not bind. Most desktop adapters report far more.
- The compute-raster accumulation buffer at 3840×2160 with 4 × `u32` per pixel is
  133 MB — also over the default.

If the adapter's reported limits are still too small for the requested dataset, the
engine must **tile the rasterizer** (§9.4) and **chunk the data buffers** rather than
fail. Implement chunking as: buffers are arrays of `GPUBuffer` each ≤
`maxStorageBufferBindingSize`, with a `chunkShift` constant so shaders index as
`chunk = i >> CHUNK_SHIFT; slot = i & CHUNK_MASK`. Bind up to 4 chunks per group and
dispatch per chunk-set. Only implement chunking at milestone 8 — until then, assert.

---

## 4. Repository layout

```
graph/
  package.json
  SPEC.md                     ← this file
  docs/
    decisions.md              ← ADR log; every deviation from SPEC goes here
    shader-hooks.md           ← generated from §16, user-facing
    binding-contract.md       ← generated from §8, user-facing
  src/
    index.ts                  ← public API, main-thread side
    api/
      Graph.ts                ← the main-thread facade
      types.ts                ← public types
      errors.ts
    bridge/
      worker.ts               ← worker entry
      protocol.ts             ← main↔worker message types
      InputRing.ts            ← SharedArrayBuffer ring for pointer/camera events
    gpu/
      Device.ts               ← adapter/device/limits negotiation, caps
      Caps.ts
      BufferPool.ts           ← suballocator + staging ring
      Uploader.ts             ← dirty-range coalescing, writeBuffer batching
      PipelineCache.ts        ← variant cache keyed by hook hash
      Profiler.ts             ← timestamp queries
      FrameGraph.ts           ← pass registry + execution order
    data/
      GraphStore.ts           ← SoA typed arrays, dirty tracking
      Layouts.ts              ← exact byte layouts, single source of truth
      Morton.ts               ← CPU Morton for initial order (GPU sort replaces it)
    passes/
      TransformCullPass.ts
      SortPass.ts             ← GPU radix sort
      ClusterPass.ts          ← LOD hierarchy build
      EdgeDensityPass.ts
      EdgeGeometryPass.ts
      NodeComputeRasterPass.ts
      NodeGeometryPass.ts
      HaloPass.ts
      LabelPlacePass.ts
      LabelDrawPass.ts
      ResolvePass.ts
      PickPass.ts
    shaders/
      common/
        camera.wgsl           ← camera + precision helpers
        layouts.wgsl          ← the binding contract, generated from Layouts.ts
        sdf.wgsl              ← built-in shape SDF library
        color.wgsl
        pack.wgsl
      hooks/
        defaults.wgsl         ← default implementations of every hook
        contract.wgsl         ← hook signatures + ctx structs (public)
      passes/*.wgsl
      preprocess/
        Preprocessor.ts       ← #include, hook substitution, override injection
        SourceMap.ts          ← map compile errors back to user snippets
    text/
      MsdfAtlas.ts
      IconAtlas.ts
      Shaper.ts               ← minimal: no complex shaping in v1, see §12.5
    camera/
      Camera2D.ts             ← f64 state, hi/lo split upload
      Controls.ts
  bench/
    harness.ts
    datasets.ts               ← deterministic synthetic generators
  test/
    golden/                   ← reference PNGs
    ...
```

`src/data/Layouts.ts` is the **single source of truth** for every struct layout. A build
step generates `src/shaders/common/layouts.wgsl` from it. Never hand-write a struct in
both places — layout drift is the #1 source of silent corruption in engines like this.

---

## 5. Data model and memory layout

### 5.1 Principles

- Structure of Arrays, always. Never an array of objects on the hot path.
- Quantize aggressively. Bandwidth is the budget; precision beyond a pixel is waste.
- Everything GPU-resident. The CPU never reads node data during a frame.
- Node *identity* is an index. IDs, labels, and user metadata live in CPU-side maps
  keyed by index. The GPU never sees a string.

### 5.2 Node buffers

Nodes are stored in several parallel buffers rather than one interleaved struct,
because different passes touch different subsets and this avoids pulling cold bytes
into cache/L2.

| Buffer | Type | Bytes/node | Written by | Read by |
|---|---|---|---|---|
| `nodePos` | `vec2<f32>` | 8 | user / uploader | transform, cluster, pick, all draw |
| `nodeStyle` | `u32` packed | 4 | uploader | draw passes |
| `nodeSize` | `f16` ×2 (size, ringWidth) | 4 | uploader | transform, draw |
| `nodeColor` | `u32` (rgba8unorm) | 4 | uploader | draw |
| `nodeState` | `u32` bitflags | 4 | interaction | transform, draw |
| `nodeUser` | `u32` ×N | 4N | user | user hooks only |

Total baseline: **24 B/node**. 10M nodes = 240 MB. `nodeUser` is opt-in, sized by
`userWordsPerNode` at construction (0 by default).

`nodeStyle` packing (`u32`):

```
bits  0..7   shapeId     u8    index into built-in shape table, or user shape id
bits  8..23  iconId      u16   index into icon atlas; 0xFFFF = none
bits 24..27  zLayer      u4    draw ordering / priority for atomicMax resolution
bits 28..31  flags       u4    bit0 = hasRing, bit1 = hasLabel, bit2 = pinnedVisible,
                               bit3 = reserved
```

`nodeState` bitflags (`u32`), written by interaction, read by every draw pass:

```
bit 0  HOVERED
bit 1  SELECTED
bit 2  DIMMED        ← rendered at reduced alpha
bit 3  HIDDEN        ← culled unconditionally
bit 4  NEIGHBOR      ← adjacent to hovered node (set by a GPU pass, §15.3)
bit 5  DRAGGING
bits 8..15  groupId   u8    user-defined grouping for styling
bits 16..31 reserved
```

Hovered/selected/dragging nodes are **promoted to the foreground bucket** in the cull
pass and always take the hardware geometry path regardless of pixel size (§9.1), so
hover effects are always crisp and always drawn last.

### 5.3 Edge buffers

| Buffer | Type | Bytes/edge | Notes |
|---|---|---|---|
| `edgeIdx` | `vec2<u32>` | 8 | source, target node indices |
| `edgeStyle` | `u32` | 4 | packed, see below |
| `edgeColor` | `u32` ×2 | 8 | rgba8unorm at source and target (gradient) |

Baseline **20 B/edge**; drop `edgeColor` to one `u32` (12 B) when
`edgeGradient: false`. 30M edges = 600 MB / 360 MB. This is the dominant memory cost;
see §10.5 for the compressed edge mode.

`edgeStyle` packing:

```
bits  0..7   width       u8    in 1/8 px units, 0 = use global
bits  8..11  curveKind   u4    0 straight, 1 quadratic, 2 arc, 3 orthogonal
bits 12..19  curvature   u8    signed, 1/64 units
bits 20..23  zLayer      u4
bits 24..27  capKind     u4
bits 28..31  flags       u4    bit0 = directed (draw arrow), bit1 = dashed
```

Edges are **not** sorted with nodes. Keep them in insertion order but build an optional
`edgeByCell` bucketing at cluster-build time for spatial edge culling (§10.4).

### 5.4 Derived / engine-owned buffers

| Buffer | Purpose | Size |
|---|---|---|
| `mortonKey` | `u32` per node, Z-order key | 4 N |
| `sortedIdx` | `u32` per node, permutation | 4 N |
| `clusterNode` | cluster records (§11.2) | 24 × (N/64 + N/4096 + …) |
| `bucketCounts` | `atomic<u32>` × NUM_BUCKETS | 32 |
| `bucketList` | compacted node indices per bucket | 4 N |
| `drawArgs` | indirect draw args, 4 × `u32` per bucket | 128 |
| `dispatchArgs` | indirect dispatch args | 64 |
| `accum` | compute-raster accumulation | see §9.4 |
| `pickResult` | 8 B, mappable | 8 |

### 5.5 Upload strategy

- `GraphStore` keeps CPU mirrors as typed arrays and a **dirty interval list** per
  buffer (a sorted, coalescing list of `[start, end)` ranges, max 64 entries; on
  overflow, collapse to one range covering all).
- Flush once per frame, before any pass. Use `device.queue.writeBuffer` for ranges
  < 64 KB total, and a **mapped staging ring** for larger ones:
  - Ring of 4 buffers × 16 MB, `MAP_WRITE | COPY_SRC`.
  - `mapAsync` the next buffer while the current one is in flight; never await inside
    the frame. If all four are in flight, fall back to `writeBuffer` for this frame and
    log a warning to the profiler.
- **Bulk load path** (`setNodes`): create buffers with `mappedAtCreation: true` and
  write directly into the mapped range. This is the fastest possible path and must be
  used for the initial dataset; it is what gets 1M nodes under the 250 ms gate.
- Never re-upload the whole buffer for a single node change. Never.

---

## 6. Threading architecture

```
Main thread                      Render worker
-----------                      -------------
Graph facade                     Device, FrameGraph, all passes
  transfers OffscreenCanvas  →   owns the GPUCanvasContext
  writes pointer/camera      →   reads InputRing (SharedArrayBuffer, lock-free)
    events into InputRing          every frame, coalescing
  postMessage for bulk data  →   (transferable ArrayBuffers, zero-copy)
  reads pick results         ←   postMessage small objects only
```

Rules:

- The worker runs its own `requestAnimationFrame` loop. `OffscreenCanvas` in a worker
  gets rAF via `self.requestAnimationFrame`.
- **The main thread never touches the GPU.** No exceptions.
- `InputRing` is a `SharedArrayBuffer` with a single-producer/single-consumer ring of
  fixed 32-byte records: `{ type u32, t f32, x f32, y f32, dx f32, dy f32, buttons u32,
  mods u32 }`. Head/tail are `Int32Array` slots manipulated with `Atomics.store` /
  `Atomics.load`. No `Atomics.wait` on the main thread.
- Pointer events are coalesced in the worker: consume the whole ring, apply, render
  once. Use `getCoalescedEvents()` on the main thread so nothing is lost.
- Bulk data arrives as transferred `ArrayBuffer`s. After transfer the caller's arrays
  are detached; document this loudly and offer `{ copy: true }` for convenience.
- **Idle:** if the ring is empty, no buffer is dirty, and no animation is running, skip
  the frame entirely — do not even acquire a canvas texture. This is required by §2.

---

## 7. Frame graph

The frame is a fixed sequence of passes with static bind group layouts. The `FrameGraph`
exists so users can insert custom passes (§16.6) at defined stages, not to do dynamic
resource aliasing.

Stages, in order:

```
0  UPLOAD          flush dirty ranges, write camera uniform
1  PRE_COMPUTE     [user hook stage] — e.g. a caller's force simulation writes nodePos
2  SORT            Morton sort (only when topology/positions changed materially)
3  CLUSTER         LOD hierarchy rebuild (same trigger as SORT)
4  TRANSFORM_CULL  project, cull, LOD-select, bucket, write indirect args
5  NEIGHBOR        propagate hover to adjacent nodes (only when hover changed)
6  EDGE_DENSITY    compute rasterize sub-pixel edges into accum
7  EDGE_GEOMETRY   hardware draw for above-threshold edges
8  NODE_RASTER     compute rasterize sub-pixel nodes into accum
9  NODE_GEOMETRY   hardware draw for above-threshold nodes + foreground bucket
10 HALO            hover/selection rings and glows
11 LABEL_PLACE     GPU label collision resolution
12 LABEL_DRAW      MSDF text
13 POST            [user hook stage] — custom render passes
14 RESOLVE         composite accum + color target → canvas, tone map, user post hook
15 PICK            hit test under cursor, write to mappable buffer
```

Passes 6–12 share **one render pass encoder** where possible. Passes 4, 5, 6, 8, 11, 15
are compute. Minimize `beginRenderPass` calls: each one is a real cost on tiled GPUs.

Pass skipping is mandatory and driven by a dirty-flag bitset:

| Flag | Set by | Invalidates |
|---|---|---|
| `TOPOLOGY` | add/remove nodes or edges | SORT, CLUSTER, everything after |
| `POSITIONS` | position writes | SORT (throttled), CLUSTER (throttled), TRANSFORM_CULL… |
| `CAMERA` | pan/zoom | TRANSFORM_CULL… |
| `STYLE` | style/color writes | draw passes only |
| `STATE` | hover/selection | NEIGHBOR, draw passes |
| `RESIZE` | canvas resize | reallocate accum, all |

SORT/CLUSTER re-run at most once every N frames (default 8) while positions are
changing, and immediately once they settle. A stale Morton order costs a little
coherence, never correctness.

---

## 8. Binding layout contract  (PUBLIC API — versioned)

Four bind groups, fixed meaning. Custom shaders and custom passes rely on this.

### `@group(0)` — Frame

Rebound once per frame. Uniform buffer + samplers.

```wgsl
struct Frame {
  // Camera: world→clip, with hi/lo split origin for precision (§5 / §13)
  originHi      : vec2<f32>,   // camera centre, high part
  originLo      : vec2<f32>,   // camera centre, low part
  scale         : vec2<f32>,   // world units → NDC, includes aspect
  rotation      : vec2<f32>,   // cos, sin
  viewportPx    : vec2<f32>,
  invViewportPx : vec2<f32>,
  pixelRatio    : f32,
  zoom          : f32,         // px per world unit
  time          : f32,         // seconds since init, for animated hooks
  frameIndex    : u32,
  pointerPx     : vec2<f32>,   // cursor, device px; (-1,-1) if outside
  rasterDim     : vec2<u32>,   // accumulation buffer dimensions
  nodeCount     : u32,
  edgeCount     : u32,
  globalNodeScale : f32,
  globalEdgeWidth : f32,
  flags         : u32,         // FRAME_* bits
  _pad          : u32,
}
@group(0) @binding(0) var<uniform> frame : Frame;
@group(0) @binding(1) var samp_linear  : sampler;
@group(0) @binding(2) var samp_nearest : sampler;
```

### `@group(1)` — Graph data (read-only in every pass but the caller's PRE_COMPUTE)

```wgsl
@group(1) @binding(0) var<storage, read> nodePos   : array<vec2<f32>>;
@group(1) @binding(1) var<storage, read> nodeStyle : array<u32>;
@group(1) @binding(2) var<storage, read> nodeSize  : array<u32>;   // 2×f16 packed
@group(1) @binding(3) var<storage, read> nodeColor : array<u32>;
@group(1) @binding(4) var<storage, read> nodeState : array<u32>;
@group(1) @binding(5) var<storage, read> edgeIdx   : array<vec2<u32>>;
@group(1) @binding(6) var<storage, read> edgeStyle : array<u32>;
@group(1) @binding(7) var<storage, read> edgeColor : array<u32>;
```

### `@group(2)` — Pass-local

Per-pass: accumulation buffers, bucket lists, indirect args, atlases. Layout varies by
pass and is **not** part of the public contract; custom passes declare their own.

### `@group(3)` — User

**Reserved entirely for the caller.** The engine never binds anything here. Users
declare whatever they like and bind it via `graph.setUserBindGroup(desc)`. Hook code
may reference `@group(3)` freely.

```wgsl
// example, user-authored
@group(3) @binding(0) var<storage, read> myScores : array<f32>;
@group(3) @binding(1) var myTexture : texture_2d<f32>;
```

### Reserved override constants

Every engine shader module is compiled with these pipeline-overridable constants
available; hook code may read them.

```wgsl
override WORKGROUP_SIZE   : u32 = 256u;
override RASTER_TILE_X    : u32 = 1u;
override RASTER_TILE_Y    : u32 = 1u;
override ENABLE_ICONS     : bool = true;
override ENABLE_RINGS     : bool = true;
override ENABLE_GRADIENT_EDGES : bool = true;
override SMALL_NODE_PX    : f32 = 3.0;   // §9.1 threshold
override SMALL_EDGE_PX    : f32 = 1.5;
override USER_WORDS       : u32 = 0u;
```

---

## 9. Node rendering

The core performance idea: **branch on projected pixel size**. The hardware rasterizer
is excellent at large primitives and terrible at millions of sub-pixel ones (setup,
binning, and blend-stage overdraw dominate). Compute-based point rendering has been
shown to outperform the hardware pipeline by up to an order of magnitude — Schütz,
Kerbl & Wimmer (2021) rendered 796M points at 62–64 fps on an RTX 3090 with no LOD at
all. That result is the thesis of this engine, adapted to 2D graphs.

### 9.1 Bucketing (in TRANSFORM_CULL)

Each node is assigned to exactly one bucket:

| Bucket | Condition | Renderer |
|---|---|---|
| `CULLED` | offscreen, HIDDEN, or LOD-replaced by a cluster | none |
| `CLUSTER` | node represents an LOD cluster | compute raster, weighted |
| `TINY` | radiusPx < `SMALL_NODE_PX` | compute raster |
| `NORMAL` | radiusPx ≥ `SMALL_NODE_PX` | hardware geometry |
| `FOREGROUND` | HOVERED \| SELECTED \| DRAGGING \| pinnedVisible | hardware geometry, drawn last, never LOD-collapsed |
| `LABELED` | hasLabel and radiusPx ≥ label threshold | feeds LABEL_PLACE |

Buckets are compacted into `bucketList` with `atomicAdd` on `bucketCounts`, then a tiny
"finalize" dispatch converts counts into `drawArgs` / `dispatchArgs`. No readback ever.

```wgsl
// transform_cull.wgsl — core
@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x + gid.y * (WORKGROUP_SIZE * 65535u);
  if (i >= frame.nodeCount) { return; }

  let state = nodeState[i];
  if ((state & STATE_HIDDEN) != 0u) { return; }

  var ctx = makeNodeCtx(i);
  let x = node_transform(ctx);          // ← USER HOOK (§16.4)

  let sp = worldToScreen(x.pos);        // camera.wgsl, hi/lo precision
  let rPx = x.size * frame.zoom * 0.5;

  // Conservative screen cull with radius margin.
  if (sp.x < -rPx || sp.y < -rPx ||
      sp.x > frame.viewportPx.x + rPx || sp.y > frame.viewportPx.y + rPx) {
    if ((state & STATE_FOREGROUND_MASK) == 0u) { return; }
  }

  let fg = (state & STATE_FOREGROUND_MASK) != 0u;
  var bucket : u32;
  if (fg)                        { bucket = BUCKET_FOREGROUND; }
  else if (rPx < SMALL_NODE_PX)  { bucket = BUCKET_TINY; }
  else                           { bucket = BUCKET_NORMAL; }

  let slot = atomicAdd(&bucketCounts[bucket], 1u);
  bucketList[bucket * bucketStride + slot] = i;

  // screen-space cache so later passes never redo the projection
  screenPos[i]  = sp;
  screenSize[i] = rPx;
}
```

Write `screenPos`/`screenSize` once here and read them in every later pass. Re-projecting
per pass is a common and expensive mistake.

### 9.2 Compute rasterizer (TINY + CLUSTER buckets)

One invocation per bucketed node. Two accumulation modes:

**Mode A — weighted average (default).** Antialiases for free, order-independent, no
popping when a node crosses the size threshold.

```wgsl
// accum layout: 4 parallel u32 arrays, rasterDim.x * rasterDim.y each
//   accR, accG, accB : premultiplied colour, 8.8 fixed point
//   accW             : coverage weight, 8.8 fixed point
@compute @workgroup_size(WORKGROUP_SIZE)
fn raster_tiny(@builtin(global_invocation_id) gid : vec3<u32>) {
  let k = gid.x;
  if (k >= atomicLoad(&bucketCounts[BUCKET_TINY])) { return; }
  let i = bucketList[BUCKET_TINY * bucketStride + k];

  let sp = screenPos[i];
  let r  = max(screenSize[i], 0.35);          // never below ~1/3 px
  var ctx = makeNodeCtx(i);
  let col = node_color(ctx, 0.0);             // ← USER HOOK
  if (col.a <= 0.001) { return; }

  // Footprint: at most a 3×3 px stamp at this size. Unrolled, no loops over
  // unbounded ranges — this keeps the invocation uniform and cheap.
  let base = vec2<i32>(floor(sp - vec2(1.0)));
  for (var dy = 0; dy < 3; dy = dy + 1) {
    for (var dx = 0; dx < 3; dx = dx + 1) {
      let p = base + vec2(dx, dy);
      if (p.x < 0 || p.y < 0 ||
          u32(p.x) >= frame.rasterDim.x || u32(p.y) >= frame.rasterDim.y) { continue; }
      let c  = vec2<f32>(p) + vec2(0.5);
      let d  = length(c - sp);
      let cov = clamp(r + 0.5 - d, 0.0, 1.0) * col.a;   // analytic-ish coverage
      if (cov <= 0.002) { continue; }

      let idx = u32(p.y) * frame.rasterDim.x + u32(p.x);
      let w  = u32(cov * 256.0);
      atomicAdd(&accR[idx], u32(col.r * cov * 256.0));
      atomicAdd(&accG[idx], u32(col.g * cov * 256.0));
      atomicAdd(&accB[idx], u32(col.b * cov * 256.0));
      atomicAdd(&accW[idx], w);
    }
  }
}
```

Overflow analysis: each contribution adds ≤ 256 per channel. A `u32` overflows after
~16.7M contributions to a single pixel. LOD clustering (§11) caps contributions per
pixel far below that in practice; additionally the resolve pass detects saturation
(`accW > 0xF0000000`) and clamps. Document the limit.

**Mode B — topmost wins (`rasterMode: "top"`).** For categorical data where averaging
muddies colours. Pack a 32-bit key and `atomicMax`:

```wgsl
// key = zLayer(4) | invDistQuant(4) | nodeIndex(24)
let key = (zLayer << 28u) | (distBits << 24u) | (i & 0x00FFFFFFu);
atomicMax(&accKey[idx], key);
```

Resolve then re-fetches node attributes for the winning index. Limit: 16.7M nodes on
this path; assert and fall back to Mode A above that.

### 9.3 Hardware path (NORMAL + FOREGROUND)

One `drawIndirect` per bucket. **No vertex buffers.** Generate the quad from
`vertex_index`, read everything else from storage.

```wgsl
struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv        : vec2<f32>,   // [-1,1] unit quad
  @location(1) @interpolate(flat) node : u32,
  @location(2) @interpolate(flat) pxPerUnit : f32,
}

@vertex
fn vs(@builtin(vertex_index) vi : u32,
      @builtin(instance_index) ii : u32) -> VOut {
  let i = bucketList[bucketBase + ii];
  var ctx = makeNodeCtx(i);
  let x = node_transform(ctx);                 // ← USER HOOK (must match §9.1)

  // Triangle strip of 4 verts: (-1,-1) (1,-1) (-1,1) (1,1)
  let uv = vec2<f32>(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);

  let rPx   = x.size * frame.zoom * 0.5;
  let pad   = 2.0 + x.outlinePx;               // room for AA + rings + glow
  let sp    = screenPos[i] + uv * (rPx + pad);

  var o : VOut;
  o.pos = vec4<f32>(screenToClip(sp), 0.0, 1.0);
  o.uv  = uv * (rPx + pad) / max(rPx, 0.001);  // uv normalised to node radius
  o.node = i;
  o.pxPerUnit = 1.0 / max(rPx, 0.001);
  return o;
}

@fragment
fn fs(in : VOut) -> @location(0) vec4<f32> {
  var ctx = makeNodeCtx(in.node);
  ctx.uv = in.uv;
  ctx.pxPerUnit = in.pxPerUnit;

  let sd = node_shape(ctx);                    // ← USER HOOK: signed distance
  var col = node_color(ctx, sd);               // ← USER HOOK

  // Analytic AA. screen-space derivative of the SD field.
  let aa = fwidth(sd);
  let alpha = 1.0 - smoothstep(-aa, aa, sd);
  col.a = col.a * alpha;
  if (col.a < 0.002) { discard; }
  return vec4<f32>(col.rgb * col.a, col.a);    // premultiplied
}
```

Notes:

- Blend state: premultiplied alpha, `src: one, dst: one-minus-src-alpha`.
- Draw order within the hardware path: CLUSTER → NORMAL → FOREGROUND → HALO. No depth
  buffer; ordering is by draw sequence and `zLayer` sorting *within* NORMAL is handled
  by writing bucket lists in zLayer-major order during cull (use 4 sub-counters).
- `discard` is cheap here and saves blend bandwidth; Chrome 133 improved WGSL
  performance with `discard` specifically.

### 9.4 Accumulation buffer sizing and tiling

```
bytesPerPixel = 16 (Mode A: 4 × u32)  |  4 (Mode B: 1 × u32) + resolve fetch
required      = rasterDim.x * rasterDim.y * bytesPerPixel
```

If `required > limits.maxStorageBufferBindingSize`, split the screen into
`RASTER_TILE_X × RASTER_TILE_Y` tiles and run passes 6/8 once per tile with a scissor
constant. Choose the smallest tile count that fits. Tiling also improves atomic
locality on large displays, so **benchmark a forced 2×2 tiling even when not required** —
it may be a win.

Clear the accumulation buffer with a dedicated compute dispatch (`workgroup_size(256)`,
one thread per 4 pixels using `vec4<u32>` stores), not `writeBuffer` and not a
zero-filled staging copy.

### 9.5 Built-in shapes

`src/shaders/common/sdf.wgsl` provides, all returning a signed distance in units where
1.0 = node radius:

```
sdCircle, sdRing, sdSquare, sdRoundedRect(r), sdSquircle(n), sdDiamond,
sdTriangle, sdHexagon, sdPentagon, sdStar(points, inner), sdCross, sdPlus,
sdCapsule, sdArrowhead, sdPie(a0, a1), sdDonutSegment(a0, a1, w)
```

`shapeId` selects among them via a `switch` in the default `node_shape` hook. Ids
0–63 are reserved for built-ins; 64–255 are free for user hooks to interpret.

A `switch` over 16 shapes in the fragment shader is effectively free because
`shapeId` is flat-interpolated and coherent across a primitive. Do **not** compile a
pipeline variant per shape.

---

## 10. Edge rendering

Edges are the actual bottleneck in every large-graph renderer. At `xlarge`, 30M edges
at ~2 quads each would be 120M vertices per frame through the hardware path. Not viable.

### 10.1 Bucketing

Same idea as nodes, decided per edge in a compute pass:

| Bucket | Condition | Renderer |
|---|---|---|
| `EDGE_CULLED` | both endpoints offscreen and segment misses viewport AABB | none |
| `EDGE_DENSITY` | projected length < `densityLengthPx` **or** width < `SMALL_EDGE_PX` | compute density raster |
| `EDGE_GEOM` | otherwise | hardware instanced quads |
| `EDGE_FOREGROUND` | endpoint hovered/selected | hardware, drawn last, full styling |

Segment-vs-AABB culling must be a real segment test (Liang–Barsky), not an endpoint
test — a long edge crossing the viewport has both endpoints outside.

### 10.2 Density rasterization (the big win)

Sub-pixel-width edges should not be geometry. Rasterize them in compute, accumulating
into the same `accum` buffers as tiny nodes (so they composite correctly in one resolve).

```wgsl
@compute @workgroup_size(WORKGROUP_SIZE)
fn raster_edges(@builtin(global_invocation_id) gid : vec3<u32>) {
  let k = gid.x;
  if (k >= atomicLoad(&edgeBucketCounts[EDGE_DENSITY])) { return; }
  let e = edgeList[EDGE_DENSITY * edgeStride + k];

  let ij = edgeIdx[e];
  var a = screenPos[ij.x];
  var b = screenPos[ij.y];
  if (!clipSegment(&a, &b, vec2(0.0), vec2<f32>(frame.rasterDim))) { return; }

  var ctx = makeEdgeCtx(e);
  let col = edge_color(ctx, 0.0);              // ← USER HOOK
  let alphaScale = col.a * frame.edgeDensityGain;

  let d = b - a;
  let n = u32(clamp(max(abs(d.x), abs(d.y)), 1.0, f32(MAX_EDGE_STEPS)));
  let step = d / f32(n);
  var p = a;
  for (var s = 0u; s <= n; s = s + 1u) {
    // 2×2 bilinear splat so thin lines stay smooth
    splatBilinear(p, col.rgb, alphaScale / f32(n + 1u) * f32(n) * INV_LEN_NORM);
    p = p + step;
  }
}
```

Critical details:

- **Long-edge load balancing.** A naive one-thread-per-edge loop stalls the whole
  workgroup on the longest edge. Run a prepass that splits each edge into fixed-length
  chunks (`MAX_EDGE_STEPS = 64` px per chunk) and appends chunk records
  `{ edgeIndex, t0, t1 }` into a work list with `atomicAdd`, then dispatch indirectly
  over chunks. This turns a 100:1 divergence into ~1:1 and is worth 2–4× on real graphs.
- Normalize accumulated alpha by 1/length so long edges don't out-vote short ones,
  unless `edgeDensityMode: "additive"` (for flow/volume visuals, where they should).
- The resolve pass tone-maps density with a configurable curve
  (`linear | log | sqrt | custom hook`). `log` is the right default: it is what makes a
  hairball readable instead of a black rectangle.

### 10.3 Geometry path

Instanced quads, 4 vertices, generated from `vertex_index`, attributes from storage.
Support in the vertex shader:

- straight segments with round/square/butt caps via SDF in the fragment shader,
- quadratic Bézier: subdivide into `ceil(curvature * lengthPx / 8)` instances, capped
  at 16, with the instance's `t0/t1` derived from `instance_index` — no CPU tessellation,
- arrowheads for directed edges: an extra instance at `t≈1` with `sdArrowhead`,
- dashes: `fract(arcLength / dashPeriod)` discard in the fragment shader,
- gradient colour from `edgeColor.xy` interpolated by arc length.

Anti-alias width the same way as nodes: expand the quad by 1 px, use `fwidth` on the
distance-to-centreline.

### 10.4 Spatial edge culling for the xlarge case

At `xlarge`, even *iterating* 30M edges per frame to cull them costs ~1 ms. Fix with a
coarse bucketing built during CLUSTER:

- Divide world space into a 256×256 uniform grid.
- For each edge, compute the set of grid cells its AABB touches; append the edge index
  to a per-cell list (two-pass: count, prefix-sum, scatter — all on GPU).
- Each frame, dispatch only over cells intersecting the viewport.

Rebuild only on `TOPOLOGY` or when positions move more than a cell (track with a GPU
max-displacement reduction). Cost: 4 B × (sum of cells touched), typically 1.5–3× the
edge count.

### 10.5 Compressed edge mode

For `edgeCompact: true` (default above 10M edges):

- Drop `edgeColor` entirely; colour comes from `edge_color` hook or from endpoint node
  colours. Saves 8 B/edge.
- Store `edgeIdx` as `u32` pairs still (needed), but if `nodeCount < 65536`, pack both
  endpoints into one `u32`. Saves 4 B/edge.
- Result: 4–12 B/edge instead of 20.

---

## 11. LOD and spatial hierarchy

### 11.1 Morton ordering

Sort node indices by Z-order key. Two reasons: memory coherence in every pass (Schütz
et al. found Morton-sorted point buffers markedly faster, and that Morton-order followed
by shuffling in batches of 128 gives high throughput with low sensitivity to viewpoint),
and it makes cluster construction a contiguous-range problem.

- Key: quantize world x,y to 16 bits each over the graph AABB, interleave → `u32`.
- Sort: GPU radix sort, 8 passes × 4-bit digits, over `(key, index)` pairs.
  - Per-workgroup histogram in workgroup memory, then a global prefix scan
    (single-workgroup scan over 16 × numWorkgroups counters is fine up to ~4096
    workgroups; above that use a two-level scan).
  - Use `subgroupAdd` / `subgroupInclusiveAdd` when the `subgroups` feature is present —
    typically 1.5–2× on the scan.
- **Then shuffle in batches of 128** (a fixed permutation, not random per frame) —
  this is the "shuffled Morton" order from the literature and it removes the
  viewpoint-dependence of pure Morton order.
- All passes iterate `sortedIdx`, never raw index order.

Budget: 10M elements should sort in < 6 ms. If it is slower, the scan is the problem.

### 11.2 Cluster hierarchy

Bottom-up over the Morton-sorted array:

```
level 0 : the nodes themselves
level 1 : groups of 64 consecutive sorted nodes
level 2 : groups of 64 level-1 clusters
...      until a level has < 64 entries
```

Each cluster record (24 B):

```
centroid   : vec2<f32>    // 8
radiusW    : f32          // 4  — bounding radius in world units
colorSum   : u32          // 4  — rgba8 average, premultiplied by count
count      : u32          // 4
firstChild : u32          // 4
```

Built with one dispatch per level; each workgroup reduces 64 children. Total build for
10M nodes: one pass over ~10.2M records, < 2 ms.

### 11.3 LOD selection

In TRANSFORM_CULL, walk top-down is too divergent. Instead, use the flat rule:

```
level L is used when   clusterRadiusPx(L) < LOD_MIN_PX  and  clusterRadiusPx(L+1) >= LOD_MIN_PX
```

Precompute, once per frame on the CPU (it is a scalar), the single level `L*` whose
average cluster screen radius is closest to `LOD_MIN_PX` (default 2.0 px). Dispatch
TRANSFORM_CULL over level `L*` records instead of raw nodes when
`L* > 0`; each surviving cluster is drawn as a CLUSTER-bucket point with
`color = colorSum/count` and `alpha` scaled by `min(1, count * density)`.

Then **refine locally**: clusters whose screen radius exceeds `LOD_MIN_PX * 4` push
their children into a work queue for a second dispatch. Two refinement rounds is enough
in practice; make it configurable and measure.

FOREGROUND-state nodes are always resolved to level 0 regardless — a hovered node must
never be a blob.

**Transition smoothness:** cross-fade between levels over ~120 ms using a per-cluster
`fadeT` driven by `frame.time`, or popping will be visible — a faster renderer that
pops looks worse than a slower one that does not. Do not skip this.

---

## 12. Labels

### 12.1 Atlas

Build-time: `msdf-atlas-gen` produces an MSDF atlas per font (default 32 px em,
4 px range) plus a JSON of glyph metrics. Ship as `.png` + `.json`, load into an
`rgba8unorm` texture. MSDF gives crisp text at any zoom from one small texture and is
the correct state of the art here — no SDF blur, no per-size bitmaps.

Runtime dynamic atlas (v2): a `2048×2048 rgba8unorm` atlas with a shelf allocator for
glyphs not in the static set (CJK, emoji fallback via bitmap).

### 12.2 Label data

Labels are CPU-side strings, converted once into GPU glyph runs:

```
labelRun   : { nodeIndex u32, glyphStart u32, glyphCount u32, widthEm f32,
               anchor u32, priority f32 }         // 24 B per label
labelGlyph : { atlasUV vec4<u16>, offsetEm vec2<f16>, advanceEm f16, _pad f16 }  // 16 B
```

Re-shape only when the label text changes. Never per frame.

### 12.3 GPU placement (LABEL_PLACE)

CPU-side label collision is the hidden framerate killer in every graph library. Do it
on the GPU:

1. Screen is divided into a grid of `cellPx = 24` cells. `labelClaim : array<atomic<u32>>`,
   one per cell.
2. One invocation per candidate label (from the LABELED bucket). Compute its screen AABB
   from `widthEm × fontPx` and the anchor rule.
3. Pack `key = (quantizedPriority << 20) | labelIndex` and `atomicMax` it into **every**
   cell the AABB covers (cap at 64 cells; longer labels get truncated or ellipsised).
4. Second dispatch: each label re-reads all its cells. If it won *every* cell, it is
   placed — append to `placedLabels` with `atomicAdd` and write the indirect draw args.
   Otherwise it is rejected.

This is greedy-by-priority and gives stable, deterministic results. Priority default:
`nodeSize * (hovered ? 1e6 : 1) * (selected ? 1e5 : 1) * userPriority`.

**Temporal stability:** a label flickering on/off between frames is very visible. Keep a
`labelVisibleT : array<f32>` and fade over 100 ms; additionally add a small hysteresis
bonus to labels that were placed last frame (`+0.1` priority). Both are required.

### 12.4 Draw (LABEL_DRAW)

One instanced draw, 4 vertices per glyph, `drawIndirect` over the placed-glyph list.
Fragment shader: median-of-3 MSDF decode with screen-space AA:

```wgsl
fn msdfAlpha(s : vec3<f32>, pxRange : f32) -> f32 {
  let sd = max(min(s.r, s.g), min(max(s.r, s.g), s.b)) - 0.5;
  return clamp(sd * pxRange + 0.5, 0.0, 1.0);
}
```

Plus: optional halo/outline (second sample at a larger threshold), background pill
(`sdRoundedRect` quad drawn before the glyphs from the same placement data), and a
`label_style` hook (§16.4).

### 12.5 Shaping scope

v1: left-to-right, no ligatures, no kerning beyond the atlas's kerning pairs, no
bidi, no complex scripts. Document it. v2 can use HarfBuzz via WASM in the worker,
off the render path.

---

## 13. Icons inside nodes

First-class, because "a node with an icon in it" is the single most requested graph
feature and most GPU graph libraries handle it badly.

### 13.1 Icon atlas

Two atlases, both optional:

- **`iconSdf`** — `r8unorm` or MSDF `rgba8unorm` array texture for monochrome vector
  icons. Tintable, crisp at any zoom, ~2 KB per icon. This is the default and the one to
  build first.
- **`iconRgba`** — `rgba8unorm` 2D array texture for full-colour icons/avatars/sprites.
  Mipmapped, `samp_linear`.

API:

```ts
await graph.icons.addSdf("user", svgStringOrPath);          // → iconId
await graph.icons.addImage("avatar:42", imageBitmap);        // → iconId
graph.setNodeIcons(Uint16Array);                             // iconId per node, 0xFFFF = none
```

Build the SDF atlas in the worker with an offscreen canvas rasterization + a JFA
(jump-flooding) distance transform compute pass — fast, and keeps SVG handling off the
main thread.

### 13.2 Rendering

Icons are composited **inside** the node in the fragment shader of the hardware path
only (they are meaningless below ~8 px anyway; the cull pass clears `iconId` in an
effective sense by gating on `radiusPx > ICON_MIN_PX`, default 7).

```wgsl
// default node_color hook, icon section
if (ENABLE_ICONS && ctx.iconId != NO_ICON && ctx.radiusPx > ICON_MIN_PX) {
  let iuv = ctx.uv * ICON_FIT + vec2(0.5);   // ICON_FIT ≈ 0.7 for a circle inscribe
  if (all(iuv >= vec2(0.0)) && all(iuv <= vec2(1.0))) {
    if (ctx.iconIsSdf) {
      let a = msdfAlpha(textureSample(iconSdf, samp_linear, iuv, ctx.iconLayer).rgb,
                        ctx.pxRange);
      col = mix(col, vec4<f32>(ctx.iconTint, 1.0), a * ctx.iconOpacity);
    } else {
      let t = textureSample(iconRgba, samp_linear, iuv, ctx.iconLayer);
      col = mix(col, t, t.a * ctx.iconOpacity);
    }
  }
}
```

Because this lives in the *default hook implementation*, a user who overrides
`node_color` can call `graph_defaultIcon(ctx, col)` to keep it, or ignore it entirely.
Every default hook must be exposed as a callable `graph_default*` function for exactly
this reason (§16.5).

### 13.3 Badges and multi-layer nodes

Support up to 3 decorations per node via an optional `nodeDecor : array<u32>` buffer
(packed `iconId:16 | corner:2 | scale:6 | tintIdx:8`). Drawn in the same fragment
shader, each offset to a corner of the node bounds. Gate with
`ENABLE_DECOR` override so the pipeline has zero cost when unused.

---

## 14. Hover, selection, and effects

### 14.1 State is a buffer, not a draw call

All interaction state lives in `nodeState` (§5.2). Changing hover is **one
`writeBuffer` of 4 bytes**, and the visual change happens entirely in shaders. Never
re-upload, never rebuild geometry, never keep a separate "highlight layer" of objects.

### 14.2 The HALO pass

Drawn after NODE_GEOMETRY, before labels. Instanced quads over the FOREGROUND bucket,
expanded by `haloPx`. Provides:

- **Ring** — `sdRing` at `radius + offset`, animated by `frame.time` for a pulse.
- **Glow** — `exp(-k * sd)` falloff, additive blend.
- **Neighbourhood highlight** — see below.
- All of it overridable by the `halo_color` hook.

### 14.3 Neighbour propagation (NEIGHBOR pass)

"Hover a node, its neighbours and their edges light up" requires knowing adjacency on
the GPU. Do not do this on the CPU for a 30M-edge graph.

- Maintain a CSR adjacency (`rowOffsets : array<u32>`, `colIndices : array<u32>`) built
  once on TOPOLOGY change, on the GPU (count degrees → prefix scan → scatter).
- On hover change, run a single dispatch over `rowOffsets[h]..rowOffsets[h+1]` setting
  `STATE_NEIGHBOR` on each neighbour, and clear the previous hover's neighbours first
  (keep `lastHovered` in a tiny uniform). Both are O(degree), microseconds.
- Edges check `nodeState[src] | nodeState[dst]` for `HOVERED|NEIGHBOR` and route to
  `EDGE_FOREGROUND`.
- `dimUnrelated: true` sets `STATE_DIMMED` on everything else — do this by flipping a
  frame flag that the shaders read, **not** by writing 10M state words.

### 14.4 Transitions

A `transition` uniform block drives smooth changes:

```
hoverT, selectT, dimT : f32   // 0..1, eased on the CPU (worker) per frame
```

Shaders `mix()` between styles. 150 ms ease-out is the default. Because this animates,
the frame loop must stay awake while any `*T` is in flight — wire that into the
dirty-flag system.

---

## 15. Picking and selection

### 15.1 Point picking — never stall

Never `mapAsync` and await inside a frame. Never read back a render target.

```
PICK pass (compute, ~40 invocations):
  read frame.pointerPx
  find the grid cells within maxPickRadius
  iterate candidate nodes from the spatial grid (§10.4 reuses the same grid)
  atomicMin a packed (distanceQuant << 24 | index) into pickResult[0]
  write frame.frameIndex into pickResult[1]
```

`pickResult` is an 8-byte buffer, copied to a small mappable staging buffer each frame.
The worker `mapAsync`es it and reads the result **one or two frames later**, then posts
`{ type: "hover", node, frameIndex }` to the main thread. One-frame hover latency is
imperceptible; a pipeline stall is not.

Use a ring of 3 staging buffers so there is always one unmapped.

### 15.2 Edge picking

Same pass, second phase: for edges in nearby cells, compute point-to-segment distance,
`atomicMin` into `pickResult[2]`. Gate behind `pickEdges: true` (off by default — it
roughly doubles pick cost).

### 15.3 Box / lasso selection — zero readback

The great advantage of GPU state: selection needs no readback at all.

```ts
graph.selectRect(x0, y0, x1, y1, mode)      // "replace" | "add" | "subtract" | "toggle"
graph.selectLasso(Float32Array /* polygon */, mode)
graph.selectByPredicate(wgslSnippet)         // user WGSL, runs over all nodes
```

Each dispatches one compute pass over all nodes (or the visible bucket), sets/clears
`STATE_SELECTED` directly, and atomically counts the result into a 4-byte buffer that is
read back asynchronously for the UI's "N selected" indicator. 10M nodes, one pass,
< 0.5 ms.

`selectByPredicate` is a first-class feature: it compiles a tiny user WGSL expression
with `@group(1)` and `@group(3)` bound, which means "select every node whose user score
is above 0.8 and whose degree exceeds 10" costs one dispatch.

### 15.4 Reading selection to the CPU

`await graph.getSelectedIndices()` runs a compaction pass (atomic append into a buffer)
then maps it. Explicitly async, explicitly not per-frame. Document the cost.

---

## 16. Extensibility: the shader hook system  (PUBLIC API — versioned)

This is the most important design in the engine after the compute rasterizer. Get the
contract right before writing the passes that depend on it.

Design goals:

1. A user can change how nodes look — shape, colour, size, icon, animation — by writing
   a short WGSL snippet, with no knowledge of the engine's internals.
2. A hook that changes geometry must affect **culling and LOD too**, not just shading.
   (Most libraries get this wrong: a custom size hook in the fragment shader produces
   nodes that get culled at the wrong moment and clip at the quad edge.)
3. Compiling a new style must never stall a frame.
4. A power user can bypass all of it and inject a whole pass.

### 16.1 Hook list

| Hook | Stage(s) | Purpose |
|---|---|---|
| `node_transform` | TRANSFORM_CULL, node VS | position, size, outline width |
| `node_shape` | node FS, halo FS | signed distance field of the node silhouette |
| `node_color` | node FS, compute raster | final colour, icons, patterns |
| `halo_color` | halo FS | hover/selection ring & glow appearance |
| `edge_transform` | edge cull, edge VS | endpoints, curvature, width |
| `edge_color` | edge FS, edge density | colour along the edge |
| `label_style` | label FS | text colour, outline, pill background |
| `cluster_color` | cluster raster | how aggregated clusters look |
| `post` | RESOLVE | full-screen post-processing |
| `pick_filter` | PICK | veto or weight pick candidates |

Each has a default in `shaders/hooks/defaults.wgsl` and a public signature in
`shaders/hooks/contract.wgsl`.

### 16.2 Context structs

Immutable inputs, one per hook family. **Adding a field is non-breaking; removing or
reordering is breaking.** Version with `GRAPH_HOOK_ABI` (start at `1`).

```wgsl
const GRAPH_HOOK_ABI : u32 = 1u;

struct NodeCtx {
  index      : u32,          // node index (level-0) or cluster index
  isCluster  : bool,
  clusterCount : u32,        // 1 for a real node

  worldPos   : vec2<f32>,
  screenPos  : vec2<f32>,    // device px; valid in FS and post-cull compute
  radiusPx   : f32,
  pxPerUnit  : f32,          // 1 / radiusPx — multiply an SD by this for px units

  uv         : vec2<f32>,    // FS only. (0,0) = centre, |uv| = 1 at node radius
  baseColor  : vec4<f32>,    // from nodeColor, unpremultiplied
  size       : f32,          // world units, diameter
  shapeId    : u32,
  iconId     : u32,
  state      : u32,          // STATE_* bits
  zLayer     : u32,
  degree     : u32,          // 0 unless adjacency is built
  hoverT     : f32,          // 0..1 eased
  selectT    : f32,
  user       : array<u32, 4> // first 4 words of nodeUser, if USER_WORDS > 0
}

struct NodeXform {
  pos        : vec2<f32>,    // world
  size       : f32,          // world diameter
  outlinePx  : f32,          // extra screen padding to reserve (rings, glow)
}

struct EdgeCtx {
  index      : u32,
  src        : u32,
  dst        : u32,
  t          : f32,          // 0..1 along the edge; 0 in the density path
  srcScreen  : vec2<f32>,
  dstScreen  : vec2<f32>,
  lengthPx   : f32,
  widthPx    : f32,
  baseColorA : vec4<f32>,
  baseColorB : vec4<f32>,
  state      : u32,          // OR of endpoint states
  curvature  : f32,
  distToCenterline : f32,    // px, FS only; < 0 inside
}

struct PostCtx {
  uv         : vec2<f32>,    // 0..1
  fragCoord  : vec2<f32>,
  color      : vec4<f32>,    // composited scene
  density    : f32,          // edge density at this pixel, pre-tonemap
  coverage   : f32,          // accumulated node weight
}
```

### 16.3 The preprocessor

`src/shaders/preprocess/Preprocessor.ts`, ~200 lines, does exactly four things:

1. **`#include "path"`** — resolve against a virtual FS of engine shaders. Cycle-detect.
2. **Hook substitution** — for each user-supplied hook, find the default's
   `fn node_color(...)` in `defaults.wgsl`, rename it to `graph_default_node_color`,
   and append the user's source. Never string-replace inside the user's code.
3. **Override injection** — emit `override` declarations for the engine constants.
4. **Source mapping** — record, per output line, the origin file and line. On
   `getCompilationInfo()`, remap diagnostics before surfacing them.

Error reporting must look like:

```
GraphShaderError in hook "node_color" (your source, line 7:14)
  unresolved identifier 'texureSample'
  |  let t = texureSample(myTex, samp_linear, ctx.uv);
  |          ^^^^^^^^^^^^
```

If errors point at generated line 812 of a concatenated blob, users will not use the
feature. This is a milestone-7 acceptance criterion, not a nicety.

### 16.4 Using hooks

```ts
graph.setStyle({
  nodeShape: /* wgsl */ `
    fn node_shape(ctx: NodeCtx) -> f32 {
      // a squircle that rounds off as it shrinks
      let n = mix(2.0, 4.0, clamp(ctx.radiusPx / 40.0, 0.0, 1.0));
      return sdSquircle(ctx.uv, n) - 1.0;
    }
  `,
  nodeColor: /* wgsl */ `
    fn node_color(ctx: NodeCtx, sd: f32) -> vec4<f32> {
      var c = graph_default_node_color(ctx, sd);     // keeps icons + rings
      let score = myScores[ctx.index];               // @group(3) user buffer
      c = vec4<f32>(mix(c.rgb, vec3(1.0, 0.3, 0.1), score), c.a);
      // outline
      let edge = smoothstep(-2.0 * ctx.pxPerUnit, 0.0, sd);
      return mix(c, vec4<f32>(0.0, 0.0, 0.0, c.a), edge * 0.6);
    }
  `,
  nodeTransform: /* wgsl */ `
    fn node_transform(ctx: NodeCtx) -> NodeXform {
      var x = graph_default_node_transform(ctx);
      x.size = x.size * (1.0 + 0.25 * ctx.hoverT);   // grow on hover
      x.outlinePx = 6.0;                             // reserve room for the glow
      return x;
    }
  `,
});

graph.setUserBindGroup({
  layout: [
    { binding: 0, buffer: scoresBuffer, type: "read-only-storage" },
    { binding: 1, texture: myTextureView },
  ],
  wgslDeclarations: /* wgsl */ `
    @group(3) @binding(0) var<storage, read> myScores : array<f32>;
    @group(3) @binding(1) var myTex : texture_2d<f32>;
  `,
});
```

`setStyle` is async under the hood (compiles pipelines with
`createRenderPipelineAsync`) but does not block: the engine keeps rendering with the
previous variant until the new one is ready, then swaps atomically at a frame boundary.
`await graph.styleReady()` if you need determinism in a test.

### 16.5 Rules the implementation must enforce

- Every default hook is also emitted as `graph_default_<name>` so user code can
  delegate. **No exceptions** — the icon path (§13.2) is unusable otherwise.
- `node_transform` runs in **both** the cull compute shader and the vertex shader from
  the same source text. They must agree, or nodes clip or cull wrongly. Assert this in a
  test by comparing GPU-computed positions from both stages.
- Hooks must be pure functions of their context plus `@group(0)`/`@group(1)`/`@group(3)`.
  Document that writing to storage from a hook is undefined behaviour (WGSL will let
  them; the engine's pass ordering will not save them).
- A hook is allowed to be expensive. If `SMALL_NODE_PX` nodes run `node_color` in the
  compute rasterizer and the user's hook is heavy, that is their cost — but offer
  `simplifyTinyNodes: true` (default) which uses `baseColor` for the TINY bucket and
  skips the hook there. Document the visual difference.

### 16.6 Custom passes

The escape hatch for anything hooks can't express (edge bundling, glow blur, heatmaps,
a user's own force simulation):

```ts
graph.addPass({
  id: "bloom",
  stage: "POST",                   // any FrameGraph stage name
  kind: "render",                  // "render" | "compute"
  wgsl: myWgslSource,
  entry: { vertex: "vs", fragment: "fs" },
  bindGroups: [ /* group 2 is yours here */ ],
  target: "color",                 // "color" | "offscreen:<id>" | "accum"
  blend: "premultiplied",
  draw: { vertexCount: 3 },        // or { indirect: myBuffer, offset: 0 }
  enabled: () => true,
});
```

The engine exposes its own resources to custom passes through a documented accessor —
these are real `GPUBuffer`/`GPUTextureView` handles:

```ts
graph.resources.nodePos        // GPUBuffer, read-only for you
graph.resources.nodeState      // GPUBuffer, writable (that's the sanctioned way to
                               //   drive custom hover/selection logic)
graph.resources.screenPos      // GPUBuffer, this frame's projected positions
graph.resources.bucketList
graph.resources.drawArgs
graph.resources.accum          // { r, g, b, w } GPUBuffers
graph.resources.colorTarget    // GPUTextureView
graph.resources.clusters
graph.resources.adjacency      // { rowOffsets, colIndices } if built
```

**`PRE_COMPUTE` is how a caller plugs in a layout engine.** A force simulation is just a
custom compute pass at stage `PRE_COMPUTE` that writes `graph.resources.nodePos`. Ship
one in a *separate* package as a reference; the core stays layout-free.

### 16.7 Presets

Ship a `@vhult/graph/styles` module with ready-made hook bundles so the common cases need no
WGSL at all: `neon`, `flat`, `outlined`, `gradientEdges`, `heatmap`, `minimal`,
`blueprint`. These double as worked examples of the hook API.

---

## 17. Public API (main thread)

```ts
import { Graph } from "@vhult/graph";

const graph = await Graph.create(canvas, {
  rasterMode: "average",           // "average" | "top"
  edgeDensityMode: "normalized",   // "normalized" | "additive"
  edgeTonemap: "log",              // "linear" | "log" | "sqrt"
  pixelRatio: devicePixelRatio,
  background: [0.04, 0.04, 0.06, 1],
  userWordsPerNode: 0,
  edgeGradient: true,
  simplifyTinyNodes: true,
  labels: { font: "/fonts/inter.msdf.json", maxVisible: 2000 },
});

// --- data ---
graph.setNodeCount(n);
graph.setNodePositions(Float32Array);              // transferred, xy interleaved
graph.setNodeColors(Uint32Array | Uint8Array);
graph.setNodeSizes(Float32Array);
graph.setNodeShapes(Uint8Array);
graph.setNodeIcons(Uint16Array);
graph.setNodeUser(Uint32Array);                    // userWordsPerNode per node
graph.setEdges(Uint32Array);                       // [src,dst,src,dst,...]
graph.setEdgeColors(Uint32Array);
graph.setEdgeWidths(Uint8Array);

// partial updates, dirty-range tracked
graph.updateNodePositions(startIndex, Float32Array);
graph.updateNodeColor(index, rgba);

// --- camera ---
graph.camera.fit(padding?);
graph.camera.setView({ x, y, zoom, rotation });
graph.camera.zoomTo(node, { duration: 400 });
graph.camera.getView();

// --- state ---
graph.setHovered(index | null);
graph.setSelected(indices: Uint32Array | null, mode?);
graph.selectRect(x0, y0, x1, y1, mode);
graph.selectLasso(points: Float32Array, mode);
graph.selectByPredicate(wgsl: string, mode);
await graph.getSelectedIndices();                  // async, compaction pass
graph.setDimUnrelated(true);
graph.setLabels(Map<number, string> | (i:number)=>string|null);

// --- style / extension ---
graph.setStyle({ nodeShape?, nodeColor?, nodeTransform?, edgeColor?, halo?, post?, ... });
await graph.styleReady();
graph.setUserBindGroup(desc);
graph.addPass(desc); graph.removePass(id);
graph.icons.addSdf(name, svg); graph.icons.addImage(name, bitmap);

// --- events (all fire on the main thread, ≤1 frame latency) ---
graph.on("hover",  ({ node, edge }) => {});
graph.on("click",  ({ node, edge, modifiers }) => {});
graph.on("select", ({ count }) => {});
graph.on("camera", (view) => {});
graph.on("frame",  (stats) => {});                 // see §18
graph.on("error",  (err) => {});

// --- lifecycle ---
graph.resize(w, h);
graph.requestRender();                             // for external animation drivers
graph.screenshot({ scale }): Promise<Blob>;
graph.destroy();
```

Design notes:

- Every setter is synchronous and cheap on the main thread — it posts to the worker and
  returns. Errors surface through `on("error")`.
- Typed arrays passed to `set*` are **transferred** (detached) unless `{ copy: true }`.
  Throw a clear error if a detached array is reused.
- No method on this API ever returns a `Promise` that resolves inside a frame.

---

## 18. Profiling and the performance budget

### 18.1 Built-in profiler

Enable `timestamp-query` when available. Wrap every FrameGraph stage in a
timestamp-write pair, resolve into a query buffer, copy to a rotating mappable buffer,
and read it 2–3 frames later. Emit through `on("frame")`:

```ts
{
  frameIndex, cpuWorkerMs, gpuTotalMs,
  stages: { transformCull: 0.31, edgeDensity: 1.84, nodeRaster: 0.92, ... },
  counts: { visibleNodes, visibleEdges, drawnClusters, placedLabels,
            lodLevel, uploadBytes },
  warnings: ["staging-ring-exhausted"]
}
```

Browsers quantize timestamps, so average over ≥30 frames before displaying. Ship a
`@vhult/graph/devtools` overlay that renders this as a flame bar — it costs nothing and it is
how you will actually find regressions.

### 18.2 Budget at `xlarge` (10M nodes, 30M edges, 16 ms)

| Stage | Budget |
|---|---|
| UPLOAD | 0.2 ms |
| TRANSFORM_CULL (over LOD level, ~200k records) | 0.4 ms |
| EDGE cull + chunk build | 2.0 ms |
| EDGE_DENSITY | 5.0 ms |
| NODE_RASTER | 1.5 ms |
| NODE_GEOMETRY | 1.0 ms |
| HALO + LABELS | 1.5 ms |
| RESOLVE | 0.8 ms |
| PICK | 0.1 ms |
| slack | 3.5 ms |

If EDGE_DENSITY exceeds budget, the levers in order are: chunk-based load balancing
(§10.2), spatial edge culling (§10.4), edge LOD (drop edges whose *both* endpoints
collapsed into the same cluster — this alone removes 60–90% of edges when zoomed out;
implement it, it is the single largest edge-side win), and finally reducing
`MAX_EDGE_STEPS`.

**Edge LOD deserves emphasis:** when zoomed out, an edge between two nodes in the same
cluster is invisible by construction. Testing `clusterOf[src] == clusterOf[dst]` at
level `L*` is one comparison and kills the majority of edges in any graph with community
structure. Do this before optimizing anything else on the edge path.

---

## 19. Testing

### 19.1 Unit

- `Layouts.ts` ↔ generated WGSL struct sizes/offsets match (assert `sizeof` parity by
  round-tripping a known pattern through a trivial compute shader).
- Preprocessor: include resolution, cycle detection, hook renaming, source map
  correctness (given a deliberate syntax error at user line N, the reported line is N).
- `InputRing`: SPSC correctness under synthetic contention.
- Morton encode/decode; radix sort correctness against a JS sort on 1M random keys.

### 19.2 Golden image

Run headless Chrome with `--enable-unsafe-webgpu --use-angle=swiftshader` (or Dawn's
null/CPU backend) and compare rendered PNGs against `test/golden/` with a perceptual
diff (≤0.5% pixels over ΔE 2). Cases: each built-in shape, icons, labels at 3 zooms,
hover/selection, edge tonemap modes, LOD transition mid-fade, a custom hook.

Software rendering differs from hardware — keep tolerances loose and treat golden tests
as regression detection, not pixel truth.

### 19.3 Benchmark harness

`bench/harness.ts`:

- Deterministic synthetic generators (seeded): `scaleFree(n, m)`, `grid(n)`,
  `clustered(n, k)` — plus a loader for real datasets if present.
- A fixed camera path (fit → zoom to 10% → pan across → zoom to a node → back out),
  200 frames, replayed identically.
- Records per-stage GPU time, p50/p95/p99 frame time, main-thread time, peak memory
  (`performance.measureUserAgentSpecificMemory()` where available).
- Writes JSON; a small script diffs against the previous run and fails CI on >10%
  regression.

Build this at **milestone 3**, not at the end. Every optimization after that is
justified by it.

---

## 20. Milestones

Each milestone ends with working, committed, measured code.

**M1 — Skeleton.** Device + limits negotiation, worker + OffscreenCanvas, InputRing,
camera with hi/lo precision, clear-to-colour, idle frame skipping. *Accept:* zero GPU
work when idle; <0.2 ms main-thread per frame; resize works.

**M2 — Hardware nodes.** SoA buffers, bulk upload via `mappedAtCreation`, instanced
quads from `vertex_index`, circle SDF, premultiplied blending, pan/zoom.
*Accept:* 1M nodes render correctly; profiler shows a single draw call.

**M3 — Cull + indirect + profiler + bench harness.** TRANSFORM_CULL compute, bucket
compaction, `drawIndirect`, timestamp profiler, benchmark harness. *Accept:* baseline numbers recorded for all six datasets.

**M4 — Compute rasterizer.** TINY bucket, accumulation buffers, resolve pass, tiling
fallback. *Accept:* measurable win vs M3 at `large`/`xlarge`; record the ratio in
`docs/decisions.md`. If there is no win, investigate before proceeding — do not build
on an unverified premise.

**M5 — Edges.** Geometry path, then density path, then chunk-based load balancing, then
spatial edge culling, then edge LOD. Measure after each. *Accept:* `xlarge` under
16 ms p99.

**M6 — Morton sort + cluster LOD.** GPU radix sort, hierarchy build, level selection,
cross-fade. *Accept:* `xlarge` fit-to-screen under budget with smooth transitions (no
visible popping in the golden mid-fade test).

**M7 — Hook system.** Preprocessor, contract, defaults, `graph_default_*`, pipeline
variant cache, async compile with atomic swap, source-mapped errors.
*Accept:* all four example hooks in §16.4 work; a deliberate error reports the user's
line number; changing a style does not drop a frame.

**M8 — Icons, labels, hover, picking.** MSDF atlas, GPU label placement with hysteresis,
icon atlases incl. JFA SDF generation, HALO pass, CSR adjacency + neighbour propagation,
async picking, box/lasso/predicate selection.
*Accept:* `labels` dataset under budget; hover latency ≤1 frame; no label flicker over
a 200-frame pan.

**M9 — Hardening.** Buffer chunking above binding limits, device-lost recovery
(`device.lost` → rebuild everything from CPU mirrors), context-loss on tab restore,
memory pressure handling, `screenshot()`, presets, docs generation, `@vhult/graph/devtools`.

**M10 — Polish.** Dashes, arrowheads, curved edges, decorations/badges, transitions,
the reference force-simulation package in a separate module.

---

## 21. Known pitfalls (read before each milestone)

1. **Re-projecting positions in multiple passes.** Project once in TRANSFORM_CULL, cache
   `screenPos`/`screenSize`, read everywhere else.
2. **`node_transform` diverging between compute and vertex stages.** Same source, one
   file, tested for agreement.
3. **Forgetting `firstInstance` needs a feature.** Silent no-op draws are hard to debug.
4. **Default storage-buffer binding size.** 128 MiB kills 10M-node buffers. §3.1.
5. **Long-edge divergence in the density pass.** One thread per edge will be 4× slower
   than chunked work distribution on real graphs.
6. **Overflow in the accumulation buffer.** Detect and clamp; the symptom is black
   pixels in dense regions, which looks like a culling bug.
7. **Label flicker.** Hysteresis + fade are mandatory, not polish.
8. **LOD popping.** Cross-fade is mandatory. A faster renderer that pops looks worse
   than a slower one that doesn't.
9. **Awaiting `mapAsync` inside the frame.** Ever. Use rings and accept 1–2 frames of
   latency.
10. **Allocating in the frame loop.** Preallocate every array, matrix, and message
    object. Check with a heap profile.
11. **Rebuilding the CSR adjacency on every hover.** Build on topology change only.
12. **Pipeline recompilation on style change blocking the frame.**
    `createRenderPipelineAsync` + atomic swap.
13. **Assuming compat mode works.** It has no vertex-stage storage buffers; refuse it.
14. **Trusting a single benchmark machine.** Test on at least one discrete NVIDIA, one
    Apple Silicon, and one integrated Intel/AMD GPU. Metal, D3D12, and Vulkan backends
    have very different atomic throughput, which is precisely what this engine leans on.

---

## 22. References

- Schütz, Kerbl, Wimmer — *Rendering Point Clouds with Compute Shaders and Vertex Order
  Optimization*, CGF 2021. arXiv:2104.07526. Compute rasterization outperforming the
  hardware pipeline by up to an order of magnitude; 796M points at 62–64 fps on an
  RTX 3090 without LOD; the Morton-then-shuffle vertex ordering result.
- Chen, Kerbl, Schütz et al. — follow-up software rasterization work reaching ~2 billion
  points in real time with LOD; consult for the high-quality AA variant.
- WebGPU specification and `What's New in WebGPU` (Chrome for Developers) — the running
  record of feature availability: multi-draw indirect (experimental, Chrome 131),
  subgroups, immediates/push constants (Chrome 149–150), `buffer_view` and
  `swizzle_assignment` WGSL extensions (Chrome 153–154).
- Graphistry 2.53 engineering notes — a production GPU edge-rendering rewrite that took
  a 10M-edge graph from 7.6 GB to 537 MB of browser memory; useful corroboration that
  the edge path, not the node path, is where the memory and time actually go.
- Chlumský — *Shape Decomposition for Multi-channel Distance Fields* (the MSDF thesis),
  and `msdf-atlas-gen`.
- Inigo Quilez's 2D distance function catalogue — source material for `sdf.wgsl`.

---

## 23. Naming

The package is published as **`@vhult/graph`** (npm scope `@vhult`, domain vhult.com).
Internally the engine is called `graph`: main class `Graph`, WGSL prefix `graph_`
(`graph_default_*`, `GRAPH_HOOK_ABI`), errors `Graph*Error`. The hook prefix is public
API; renaming it is a breaking change for every user shader.

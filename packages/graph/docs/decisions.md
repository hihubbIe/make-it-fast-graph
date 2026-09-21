# Decisions (ADR log)

Every deviation from `SPEC.md`, and every technique kept or reverted on
benchmark evidence, is recorded here. Newest first.

Measurements below are from an Intel Xe-LPG iGPU (Arc Graphics, ~69.5 GB/s
measured read bandwidth), Edge 153, 10M nodes unless stated. Microbenchmarks
run standalone WebGPU kernels on the real device; engine numbers come from
`graph.benchmark()` along the fixed camera paths.

---

## 0038 — Edge sampling pops under zoom; it samples the wrong axis. Plan to fix.

**Owner-reported bug, and the design that replaces it.** Start here.

### The bug

Zooming in, visible edges disappear one by one. Reproduce by hand on
`Edges/Geometry` with `edgeSampleLenPx > 0` and zoom continuously.

`edgePick` keeps an edge with probability `lim / screenLength`. The die is a
hash of the edge index — fixed. **The threshold it is compared against is a
function of the camera.** Zoom in, screen length grows, `p` shrinks, and edges
cross the threshold and vanish, deterministically, one at a time.

ADR 0034 claims "the SAME edges survive every frame: the picture is stable
under camera movement instead of fizzing." **That is false.** The hash is
stable; the threshold is not. Only half of it was checked.

Worse, the direction is backwards: zooming in is when the viewer expects more
detail, and it is exactly when edges are removed.

### The design error underneath

Sampling was keyed to **length**, which correlates with *cost*. It should be
keyed to **local density**, which correlates with *invisibility*. A 300 px edge
is plainly resolvable, so dropping it destroys information no matter how the
weights are compensated.

ADR 0023 already established the right principle for nodes — *"a node big
enough to resolve is real information; only the sub-pixel mass is a density
field"* — and it was not carried across to edges.

### Why no measurement caught it

Every number and screenshot in 0029–0037 was taken at a **fixed camera**;
`__edgeBench.measure` deliberately wobbles the view sub-pixel to hold zoom
constant. There is no zoom-sweep visual check and no edge case in the bench
suite. The harness could not show a motion artifact. Throughput was being
measured and called correctness.

### Rejected: a precomputed world-space density field

Attractive — edges do not move, so the field is static; sampling a mip per
frame would be O(pixels) and independent of edge count. **It does not work.**

At fit the graph spans ~1100 screen px, so a 2048² field is only ~1.9x finer:
it under-resolves past ~2x zoom. Covering x8 needs 8192² (~268 MB); x64 is
hopeless. And **fit is not the worst case** — ink peaks mid-zoom (142M splats
at fit, **342M at x8**, 66M at x64) because edges lengthen on screen faster than
they leave the viewport. The field is useless precisely where the cost is worst.

### LOD is not optional

Drawing everything with the current tiled rasterizer costs roughly **28 ms at
fit and 42 ms at x8**. 342M deposits into 2.7M pixels is ~127 per pixel — not a
rendering preference, an un-displayable quantity; the tone map saturates long
before. Sampling is the correct answer. The axis was wrong, not the idea.

### The design to build

**Keep-rate from measured local screen density, as a continuous ramp.**

1. Per edge, read the local density at its midpoint from the **previous frame's
   accumulator** — one lookup, one frame stale. The tiled path already writes
   that buffer and the resolve already clears it; it needs to survive one extra
   frame (or be copied) instead of being consumed.
2. Keep-rate is a smooth function of that density — a ramp, never a cliff — so
   an edge fades out of contention instead of popping.
3. Drop only where saturated. Removing 1 of 50 edges covering a pixel changes
   nothing on screen, which is what makes it an LOD rather than a bug.

**It moves the right way under zoom.** Zoom in 2x: the viewport covers a
quarter of the world while each edge doubles on screen, so local density
*halves*. Keep-rate rises, and it converges to drawing everything as you zoom
in — the opposite of the reported bug.

**It is self-stabilising.** Survivors deposit weight `1/p`, so the accumulator
already holds the compensated density; the feedback loop reads back roughly the
true density rather than the sampled one, and does not run away.

### Risks to watch

- One-frame staleness during fast camera movement: the guide lags. Probably
  fine (density changes smoothly), but it is the thing to check first.
- Oscillation if the compensation is wrong — verify the accumulator is the
  weighted field, not the raw count.
- The first frame after a data change has no guide; fall back to keep-all.

### Order of work

1. **Zoom-sweep visual regression FIRST** — capture frames along a continuous
   zoom and diff consecutive pairs; a popping edge is a spike. Without it, no
   sampling rule can be trusted, and this bug would have been caught on day one.
2. Density-driven keep-rate as above.
3. Only then re-enable sampling by default.

`edgeSampleLenPx` now **defaults to 0** (exact drawing). Correct and slow beats
fast and wrong; the speed it was buying was not real.

## 0037 — Per-chunk density sampling does NOT work; the metric is wrong

M5 rework, attempt at the biggest remaining win. **Negative result, kept
because the reasoning is the useful part.**

At fit the engine still draws 2.6M edges, most of them ~2 px. They deposit
~5M splats but cost far more than that to read, cull and bin — per-edge
overhead, not ink. The plan was a second sampling rule alongside the
length rule of 0034: sample a *neighbourhood* down to a target overdraw, from
data the bounds pass can compute once (chunk box + total world edge length).

**It fires almost never.** Drawn edges at fit, 1M nodes / 3M edges:

| edgeTargetOverdraw | drawn | gpu ms |
|---|---|---|
| 0 (off) | 2,607,946 | 23.5 |
| 16 | 2,608,113 | 27.3 |
| 8 | 2,608,145 | 20.7 |
| 4 | 2,575,567 | 20.5 |

**Why: a chunk is spatially compact, so its own overdraw is low.** 1024 edges
of ~2 px is ~2,000 px of ink; the chunk's box at fit is roughly 35x35 px, so
its local overdraw is ~1.7 — nowhere near a target of 8, and the keep fraction
clamps to 1. The 58x overdraw measured in 0029 is a *global* pile-up: thousands
of chunks landing on the same pixels. Per-chunk density cannot see that, by
construction. Sorting edges by length and position (0033) makes chunks compact,
which is exactly what defeats this metric.

**What would work:** the density estimate has to be over the SCREEN, not over a
chunk. The previous frame's accumulator already is that map — the tiled path
writes it and the resolve clears it. Sampling each edge against the density at
its own midpoint (one texture-ish read per edge, one frame stale) would target
the real overdraw, and would also fix 0034's streak artifact, which is the same
problem seen from the other end: both want "how crowded is it *here*".

The knob is kept (`edgeTargetOverdraw`, `setEdgeTargetOverdraw`) but **defaults
to 0**, because a default that does nothing is worse than no default. All the
plumbing a screen-space version needs is now in place: `EdgeBounds.sumLen`, the
`edgeChunkKeep` hook in `edgePick`, and the frame field.

**Contract:** `Frame.edgeTargetOverdraw` appended. It lands in existing tail
padding, so the struct stays 112 bytes and every offset is unchanged;
`BINDING_CONTRACT_VERSION` is 3.

**Also:** `target` is a reserved keyword in WGSL.

## 0036 — Split the rasterizer by edge length; the hybrid wins in both regimes

M5 rework, step 5b. 0035 left tiling losing at fit because 2.6M ~2 px edges each
paid a binning entry and a contended atomic to deposit ~2 splats. Both
rasterizers now run over the SAME instance list and split it by length: edges
longer than `edgeTileSplitPx` are binned and tiled, shorter ones are splatted
directly. This is the per-edge bucketing 0028 asked for.

**No list splitting was needed.** The list is already length-ordered — the sort
key (0033) puts short buckets first — so each pass simply skips the half that is
not its own, measured on the UNCLIPPED instance so the two always agree about
ownership. Cost is one extra sequential read of the instance buffer (~0.9 ms),
against ~17.5 ms of binning removed.

**Ordering is what makes it safe.** Tiled runs first and flushes with plain
stores; the density pass then adds on top with atomics; a tile nobody tiled
reads zero because the resolve clears as it reads. So the tiled path keeps the
plain-store flush that was worth 3.07 → 1.97 ms (0035).

Edge work (cull + rasterizers), 1M nodes / 3M edges, `edgeSampleLenPx: 64`:

| view | density only | hybrid | |
|---|---|---|---|
| fit | 22.6 | **15.8 – 17.8** | ~1.3x |
| zoom x8 | 18.3 | **6.9 – 8.6** | ~2.3x |

Whole frame: fit 27.8 → 18.7–20.7 ms, zoom x8 21.7 → 10.5–13.6 ms. Output is
pixel-identical to the density path at fit — the split neither double-draws nor
drops anything.

**The ranges are honest, not sloppy.** The sweep repeated what is effectively
the same work and binning came back 6.83 / 10.43 / 10.33 / 5.02 ms — a 2x
spread. This dataset's edge lengths are bimodal (85 % at ~2 px, 15 % at ~300 px
at fit), so **every split from 16 to 128 selects the same edges**; the
differences between those rows are measurement noise, not signal, and the
harness cannot resolve them.

**So the default is reasoned, not measured: 32 px, one tile.** An edge shorter
than a tile crosses at most two of them and deposits at most ~32 splats, so the
binning entry costs more than the splatting it saves. A dataset with edge
lengths spread through 16–128 px would be needed to measure the crossover
properly, and the bench suite has no such case. `setEdgeTileSplitPx()` exposes
it for when one exists.

`edgeMode: "auto"` now selects the hybrid; `"density"` still forces density-only
so the A/B stays available at runtime.

## 0035 — Tiled rasterizer in the engine: 11x at zoom, and why it still loses at fit

M5 rework, step 5. `EdgeTiledPass` bins the cull's compacted instances into
32x32 tiles and rasterizes each tile in 4 KB of workgroup memory. Selectable as
`edgeMode: "tiled"`, so the comparison below is one browser run at one thermal
state. Output is visually identical to the density path at fit.

1M nodes / 3M edges, `edgeSampleLenPx: 64`:

| view | density raster | tiled raster | tiled bin | tiled total gpu |
|---|---|---|---|---|
| fit | 16.23 | **6.40** (2.5x) | 8.84 + 8.66 | 32.1 ✗ |
| zoom x8 | 16.18 | **1.47** (11x) | 0.94 + 1.25 | **9.56** (from 22.70) |

**At zoom the whole frame is 2.4x faster** and the rasterizer itself is 11x.
That is 0030's prediction landing: zoomed-out deposits are spread across the
screen, which is exactly where a global accumulator sits at the DRAM roofline
and an on-chip one does not.

**Two WebGPU facts cost a day between them, both worth remembering:**

1. **A writable storage buffer may not be bound twice in one bind group**, even
   at non-overlapping ranges. The first attempt packed counts, offsets and
   lists into one allocation bound as both atomic and plain — Dawn rejects it
   ("Writable storage buffer binding aliasing").
2. **Working around that with atomics everywhere cost 3x.** Routing offsets and
   list slots through `atomicLoad`/`atomicStore` put binning at 9.68 + 12.59 ms
   and the raster at 8.31. Splitting into two buffers — counts atomic, offsets
   and lists plain — took the same work to 8.84 + 8.66 and 6.40, and at zoom the
   raster went 6.78 → **1.47**. This device reports 16 storage buffers per
   stage, so the extra binding is affordable; HANDOVER's "10" was stale.

**Why fit still loses, and what fixes it.** Binning costs ~17.5 ms for 2.6M
edges. At fit almost every edge is ~2 px long: it deposits ~2 splats but still
costs a full (edge, tile) entry and an atomic on that tile's counter. 7.5M
entries over 2,660 tiles is ~2,800 per tile, so the counters contend hard — the
probe's 0.6 ms per million entries (0032) was measured at ~375 per tile and does
not survive the density here.

Short edges therefore should not be binned at all. They are cheap to splat
directly *and* cache-resident, because the layout is clustered — which is the
regime 0031 already measured tiling losing by 13 %. The fix is the per-edge
bucketing 0028 asked for and never built: rasterize the short bucket through the
global-atomic path and the long bucket through tiles, both accumulating into the
same buffer. Ordering makes that safe without giving up the plain-store flush —
tiled writes first, density adds on top, and a tile nobody wrote reads zero
because the resolve clears as it reads. The length-bucketed sort (0033) already
groups the two populations contiguously.

## 0034 — Weighted edge sampling: 12x at zoom, and the artifact it does have

M5 rework, step 4. Every edge up to `edgeSampleLenPx` on screen is drawn whole;
longer ones are kept with probability `lim/len` and carry weight `len/lim`, so
expected ink is unchanged while cost per edge is capped at `lim` pixels. The die
is `hash(edgeIndex)` and nothing else, so the same edges survive every frame —
the picture is stable under camera movement rather than fizzing.

`EdgeInstance._pad` became `weight` (no size change). `edgePick()` lives in
`edge_state.wgsl` because `edge_count` and `edge_scatter` must reach identical
decisions: count sizes each chunk's slice of the instance buffer and scatter
fills it, so any disagreement leaves holes and the indirect draw reads garbage.

1M nodes / 3M edges, density path, one browser run:

| view | lim | gpu ms | raster | ink | drawn edges |
|---|---|---|---|---|---|
| fit | 0 | 33.1 | 22.5 | 142M | 3.00M |
| fit | 64 | 25.2 | 14.2 | 44.9M | 2.61M |
| fit | 16 | 17.7 | 8.0 | 14.0M | 2.41M |
| **zoom x8** | **0** | **252.8** | 246.5 | 342M | 992k |
| **zoom x8** | **64** | **20.3** | 14.3 | 17.4M | 576k |
| zoom x8 | 16 | 12.7 | 5.8 | 7.5M | 560k |

**12.4x at zoom x8** — the case that was 4 fps. Only ~20 % of edges are dropped
even at lim=8, because 85 % of them are short and always kept: the policy takes
the long minority, which is where the ink was (0029).

**Default 64, chosen by looking at images, not at the table.** At fit, lim=64 is
indistinguishable from unsampled — same core density, same cluster hues, same
fine halo. **lim=16 is not**: the halo visibly coarsens into fewer, brighter
strokes, which is exactly the weight-streak failure 0029 predicted.

**The artifact is real and is not confined to sparse regions.** At zoom x8 even
lim=64 differs from the reference in the *densest* area: unsampled, thousands of
overlapping edges saturate into a smooth field; sampled, a fifth as many at 5x
weight read as a visible mesh of individual strokes. Ink is preserved, texture
is not. It is a fair trade at 252 → 20 ms, and arguably shows structure the
saturated version hides, but it is a change in appearance and should not be
described as free.

The known fix is to drive the sample rate by *local* density rather than one
global threshold — the previous frame's accumulator is already a density map and
could serve as the guide. Not built; `edgeSampleLenPx: 0` restores exactness.

**Contract:** `Frame` gained `edgeSampleLenPx` (104 → 112 bytes), so
`BINDING_CONTRACT_VERSION` is now **2**. Additive — every existing field keeps
its offset — but a custom shader compiled against v1 must be regenerated.

**Tooling:** `gpu.mjs shot` gained `--setup "<js>"`, which runs page-context
JavaScript before the capture. Storybook URL args do not reach a story (0028),
so this is the only way to screenshot one in a configured state.

## 0033 — Edges sort by length bucket first; the in-chunk shuffle is REVERTED

M5 rework, step 3. The sort key becomes

    key = bucket(chebyshevLen / graphExtent) << nodeBits | min(src, dst)

with 8 octave buckets (`EDGE_LEN_BUCKETS`). Length is measured in WORLD units
against the graph extent, so the bucket is view-independent and survives camera
changes; Chebyshev, so it means "pixels this edge will cost" up to the zoom.
One extra radix pass (7 instead of 6), on data change only.

**Measured on the owner's Xe-LPG, 1M nodes / 3M edges.** This machine drifted
10–28 % between runs in one session (the rasterizer is an unchanged workload and
moved 24.0 → 27.8 → 23.5 → 26.2 ms at fit for identical ink), so absolute times
are not comparable across runs and **cull is reported as a fraction of the
rasterizer measured in the same run**:

| view | cull/raster before | after | |
|---|---|---|---|
| fit | 0.198 | 0.201 | unchanged |
| zoom x8 | 0.0131 | 0.0103 | **−21 %** |
| zoom x64 | 0.0296 | 0.0184 | **−38 %** |

Correctness: deposited ink is identical to three significant figures at all
three zooms (142 / 342.3 / 65.7 Msplats) and drawn percentages are unchanged
(100 / 33.1 / 2.8), so the reorder changed the order and nothing else. The
`Edges/Lattice` story still renders only horizontal segments.

Fit cannot improve — every chunk really is on screen, so nothing can be
rejected; the win is entirely in the zoomed cases, which is where the cull was
meant to work and previously did not.

**The in-chunk shuffle was built, measured and reverted.** The plan (and the
node path, ADR 0024) wanted a prefix of each chunk to be a uniform random
sample. Reusing `shuffle_chunks.wgsl` over the edge permutation pushed cull/
raster at fit from 0.212 to **0.265** — the endpoint gather loses locality, and
fit is exactly where all 3M endpoints are read.

It buys almost nothing here, which is the part worth remembering: a prefix only
has to be random for edges that get *sampled*, and ADR 0032's policy keeps short
edges whole and samples only the long minority (~450k at fit). Hash-rejecting
those means reading 3.6 MB of `edgeIdx`, ~0.05 ms. Prefix selection would save
that 0.05 ms and cost ~1.5 ms. The node case is different because LOD samples
*every* chunk at high rates.

## 0032 — Binning costs 0.6 ms per million (segment, tile) entries; the budget follows

M5 rework, step 2c. 0031 showed the bill moves to binning but attributed it by
subtraction, which was noisy enough to report negative times. Each stage is now
timed in its own loop, and the entry count is read back rather than estimated.

| cell | segs | tiles/seg | entries | bin ms | ms per M entries |
|---|---|---|---|---|---|
| len 64 | 100k | 3.49 | 0.35M | 0.55 | 1.57 |
| len 64 | 400k | 3.49 | 1.40M | 1.18 | 0.84 |
| len 64 | 1M | 3.49 | 3.49M | 1.86 | 0.53 |
| len 64 | 3M | 3.49 | 10.47M | 6.22 | 0.59 |
| len 256 | 400k | 10.57 | 4.23M | 2.14 | 0.51 |
| len 256 | 1M | 10.56 | 10.56M | 5.69 | 0.54 |
| len 48 | 3M | 2.87 | 8.62M | 6.49 | 0.75 |

**Binning scales with entries, not segments**: ~**0.6 ms per million entries**
once past a ~0.4 ms fixed floor (the clear and scan passes). Entries per segment
are ≈ `1 + len/32 × 1.3` at a 32 px tile.

**This kills along-edge subsampling as the long-edge answer.** Striding the
samples does not reduce the tiles a segment *crosses*, so it leaves binning
untouched — a 300 px edge at stride 16 still deposits into ~10 tiles and still
costs ~10 entries. 0029 preferred stratified subsampling over dropping edges to
avoid weight streaks; 0031/0032 say that only works on the cheap population.

**The budget, sized from these numbers** (target ≤ 4 ms, 1M nodes / 3M edges at
fit: 2.55M short edges ~2 px, 450k long ~304 px):

| population | policy | entries | ink | cost |
|---|---|---|---|---|
| short (≤ tile) | keep all | 2.55M | 5.1M | ~1.5 + 0.5 ms |
| long | **drop whole edges**, keep ~10 %, weight 1/p | 0.47M | 13.7M | ~0.3 + 1.4 ms |
| | | | | **≈ 3.7 ms** |

So: **drop long edges, keep short ones whole** — the split the length-bucketed
sort (step 3) produces for free, and the reason that step comes first. Weight on
a surviving long edge is ~10, which is the streak risk 0029 identified; whether
that is visible is an `imagediff` question, and the fallback is a milder `p`
plus along-edge stride on the survivors.

**Floor worth knowing:** short-edge binning (~1.5 ms for 2.55M entries) cannot
be sampled away without dropping short edges too. Larger tiles reduce entries
for long edges but 64×64 needs 16 KB of workgroup storage, at this device's
limit. Not tuned yet.

## 0031 — Tiled rasterizer: 6–13x, and the cost moves from ink to segment count

M5 rework, step 2b. The honest tiled pipeline (bin-count → scan → bin-scatter →
shared-memory raster), everything timed, deposits verified identical to the
untiled kernel — same totals to the digit (20.51M / 17.25M / 21.48M / 87.51M),
which is what makes the comparison apples-to-apples.

| cell | splats | untiled ms | tiled ms | |
|---|---|---|---|---|
| uniform len 64 | 21.48M | 26.57 | **3.05** | 8.7x |
| uniform len 256 | 20.51M | 25.85 | **3.05** | 8.5x |
| uniform len 1024 | 17.25M | 19.64 | **3.10** | 6.3x |
| heavy, len 256 | 87.51M | 104.99 | **8.07** | **13.0x** |
| stride 16, len 256 | 5.63M | 9.49 | **4.96** | 1.9x |
| clustered 5 % area | 21.65M | **3.54** | 4.05 | 0.87x |

Tiled runs at 5.3–10.8 G splats/s, **independent of edge length**, against
0.6–0.9 G/s for spread-out untiled. 0027's "13 % loss at low density" is
confirmed and is exactly the cache-resident regime of 0030 — tiling pays binning
for locality it already had.

**Two things make it work, and both are the point:**

1. **No global atomic anywhere.** Tiles partition the screen, so each pixel has
   exactly one writer: accumulation is workgroup memory and the flush is a plain
   coalesced store. Changing the flush from `atomicAdd` to a store took the
   len-256 raster 3.07 → 1.97 ms.
2. **Ownership is decided by the integer pixel test, never by parametric
   ranges.** The range only narrows the search; positions are computed as
   `a + step*k`, never accumulated, so two tiles cannot disagree about who owns
   a sample.

**The cost has moved, and this is the finding that matters for the plan.**
Binning is per *segment* × tiles crossed — it does not care how much ink a
segment deposits. The stride-16 cell is the tell: 5.6M splats, yet 2.15 of its
4.96 ms is binning, because it still has 400k segments. Rough scaling from these
cells is **~5–11 ms per million segments binned**.

So **stratified along-edge subsampling alone no longer reaches the target**
(0029 chose it over dropping edges to avoid weight streaks). It cuts ink, which
is now the cheap part, and leaves segment count, which is now the expensive
part. The budget has to control *both*: fewer segments (drop or aggregate whole
edges, which the length-bucketed chunks make cheap) *and* fewer samples per
surviving segment. Deciding that split needs binning cost measured against
segment count directly — the next measurement, not a guess.

**Also known:** the ~3 ms floor at 21M splats is per-tile overhead (zeroing and
flushing all 2,660 tiles). Empty tiles must be skipped entirely in the real
implementation — the resolve already clears as it reads, so an untouched tile
correctly reads zero. At deep zoom, where most tiles are empty, that floor
should collapse.

**Three bugs the deposit guard caught**, each of which reported a plausible
number first:
- `timeIt` encoded into a command buffer and never submitted it: 279–500 G
  splats/s, i.e. 0.08 ms for 21M splats. 0027's rule earns its keep again.
- `i32()` truncates toward zero, so a sample at `x = tileX0 - 0.5` mapped to
  local column 0 and was deposited by two tiles. `floor()` first.
- Rounding in `a + d*t` left clipped endpoints a hair outside the viewport, and
  the traversal's bounds check then dropped the **whole** segment. Loss scaled
  as length² (clipped fraction ∝ len × samples lost ∝ len), which is what
  identified it; segments generated inset from the edge passed cleanly while
  the same code failed on realistic geometry. Clamp after clipping.

## 0030 — Splat throughput is bound by the accumulator's working set, not by geometry

M5 rework, step 2. 0029 measured throughput collapsing 6x (5.9 → 0.95 G
splats/s) as mean edge length grew, and attributed it to uncoalesced atomics.
**That attribution was wrong.** Standalone kernels on the blank page, every cell
verified by summing the accumulator against an exact deposit count:

| sweep | variable | splats | ms | G splats/s |
|---|---|---|---|---|
| ink held at ~20M | len 4 → 1024 px | 11.7–22.1M | 14.6–26.6 | **0.80–0.89** |
| segments held at 200k | len 4 → 1024 px | 0.8–147M | 1.1–170.8 | **0.75–0.88** |
| stride (subsampling) | k = 1 → 64 | 87.5M → 1.5M | 105.0 → 2.5 | 0.83 → 0.59 |
| **area** | **1.0 → 0.25 → 0.05** | **~21M (equal)** | **25.9 → 3.9 → 3.5** | **0.79 → 5.52 → 6.13** |

**Length does not matter. Workgroup count does not matter** (92 → 11,719
workgroups, same rate). **Spatial spread is the whole effect: identical ink
concentrated into 25 % of the screen runs 6.6x faster.**

The cause is the accumulator, not the atomics. It is 10.75 MB full-screen, so a
scattered splat pulls a 64 B cache line to update 4 B: 0.85 G splats/s × 64 B ≈
54 GB/s, which is this device's measured 69.5 GB/s DRAM roofline. Concentrated
splats stay in cache and run 7x faster.

This re-explains 0029's engine numbers exactly: at fit the clustered layout
keeps deposits cache-resident (5.9 G/s); at x64 the surviving long edges smear
across the whole screen (0.95 G/s). Same kernel, same ink — different footprint.

**Consequences for the plan:**

1. **Tiling is now the main lever, for a different reason than 0027 assumed.**
   Not atomic contention — a 32×32 tile accumulated in 4 KB of shared memory has
   *no* global traffic during accumulation. The headroom this probe implies
   (~7x) is much larger than 0027's measured 3.14x, which was a tiled variant
   still accumulating through global memory.
2. **Stratified subsampling costs ~30 % per splat** (0.83 → 0.59 G/s at k≥16),
   because sparser deposits coalesce even less. It still wins overwhelmingly on
   total time (105 → 9.5 ms at k=16) — but the two interact, and subsampling
   scatters exactly the deposits tiling wants to gather. **They must be measured
   together, not separately.**
3. The ink budget alone does not reach the target: 20M splats at the spread-out
   rate is still ~24 ms. Locality is not optional.

**Not yet measured:** the honest tiled pipeline including bin-count, scan,
bin-scatter and raster. The probe for it is written (Amanatides-Woo tile
traversal, per-tile lists, shared-memory accumulate, one coalesced flush) and is
the next thing to run. 0027's warning stands until then: an isolated probe said
14–33x and the honest pipeline said 3.14x.

## 0029 — Edge cost is ink, and now it is measured

M5 rework, step 1. Nothing in the engine measured the quantity edge cost is
actually proportional to: **deposited pixel steps** ("ink"). Every conclusion in
0027/0028 was inferred from wall time. `EdgeRasterPass` now counts them.

**Zero cost when off.** `EDGE_COUNT_INK` is an override constant selecting a
second compiled pipeline, so the counting branch — one extra `wgScanU32` plus
one global atomic per 256 edges — is removed at pipeline creation. Always-on
would cost ~0.6 ms at 3M edges, a fifth of the budget this work is aiming at.
`Graph.setProfileEdgeInk(on)` switches it at runtime (same pattern as
`setEdgeMode`, for the same reason: one browser run, one thermal state).

**Validated against the CPU oracle.** `__edgeBench.ink()` computes the same
quantity on the CPU from the same data. GPU / CPU ratio is **1.000** at fit, x8
and x64 — the counter and the oracle agree to three significant figures, which
is what makes either number usable.

1M nodes / 3M edges, density path, Intel Xe-LPG:

| view | drawn | ink (Msplats) | overdraw | mean len px | raster ms | cull ms | gpu ms |
|---|---|---|---|---|---|---|---|
| fit | 100 % | 142 | **58.5x** | 47.3 | 24.0 | 4.7 | 31.3 |
| zoom x8 | 33.1 % | **342** | **141x** | 345.6 | 213.7 | 2.8 | 220.0 |
| zoom x64 | 2.8 % | 65.7 | 27.1x | 785.9 | 69.5 | 2.1 | 73.8 |

Four things this says, none of which were visible before:

1. **Overdraw is 27–141x.** A 2.7M-pixel screen is being written 142–342M
   times. The image cannot hold that; almost all of it is waste.
2. **15 % of the edges carry 96 % of the ink.** The dataset is 85 % local (same
   grid cell, ~2 px at fit) and 15 % uniform-random (~304 px at fit); the
   octave histogram puts 88 % of ink above 127 px. Culling cannot touch this —
   those edges are *on screen*.
3. **Splat throughput collapses 6x as edges get longer**: 5.9 G/s at fit
   (mean 47 px) → 0.95 G/s at x64 (mean 786 px). Ink alone does not predict
   cost. Cause is the access pattern: neighbouring lanes consume spans of
   *different* edges, so their global atomics land on unrelated pixels and
   coalesce never happens. This is the case tiling exists for, and it is why
   0027's shootout saw tiled win 3.1x at high density.
4. **The cull costs 4.7 ms at fit** — more than the whole frame budget this
   work targets, because it gathers both endpoints of all 3M edges every frame
   regardless of zoom (0027's chunk bounds cannot reject: 15 % long edges means
   every 1024-edge chunk's box spans the graph).

**Design consequence, measured rather than assumed.** The plan was to drop whole
edges with probability `min(1, c/len)` and weight survivors by `1/p`. The
histogram says that concentrates weight `len/c` ≈ 5–19 on individual long
edges — visible streaks. **Stratified along-edge subsampling is strictly
better at the same cost**: keep every edge, step `k = max(1, len/c)` pixels and
deposit weight `k`. Every edge contributes ~`c` splats whatever its length,
nothing disappears, and the variance spreads along each line instead of
concentrating on whether it exists. It does not fix the gather floor (4), which
is what the length-bucketed sort is for.

Budget arithmetic at fit: `c = 64` → 34 Msplats (4.2x less); `c = 16` → 12
Msplats (11.5x, overdraw 4.5x). The value of `c` is an image question, decided
by `imagediff`, not by this table.

## 0028 — Compute density rasterizer for edges (and why it is not the whole answer)

The edge path was fill-bound, not count-bound: after the cull (0027), `render`
was 95 % of the frame. This replaces blended quads with coverage accumulated in
compute, resolved once per frame.

**A/B in ONE browser run** (same device, same thermal state, 45 frames per cell,
switched at runtime via `setEdgeMode`), GPU ms:

| nodes | edges | view | geometry | density | |
|---|---|---|---|---|---|
| 100k | 1M | fit | 29.0 | **13.9** | 2.1x |
| 1M | 1M | fit | 32.1 | **12.3** | 2.6x |
| 1M | 3M | fit | 87.6 | **30.6** | 2.9x |
| 1M | 10M | fit | 313.9 | **90.4** | 3.5x |
| 10M | 10M | fit | 405.4 | **96.0** | 4.2x |
| 100k | 1M | zoom x8 | **93.5** | 100.1 | 0.93x |
| 1M | 3M | zoom x64 | **57.9** | 74.5 | 0.78x |

**The win grows with edge count and REVERSES when zoomed in.** Density wins
where there are many short edges (the whole graph on screen); the hardware
rasterizer wins where there are few very long ones, because a long edge
amortises its vertex setup over hundreds of pixels while the compute path pays
one atomic for every one of them. This is the crossover the software-raster
literature predicts, measured here rather than assumed.

**So neither mode is correct on its own**, and `edgeMode: "auto"` currently
picking density for all thin edges is knowingly wrong when zoomed. The fix is
per-EDGE bucketing by projected length inside the existing cull (which already
has both endpoints in screen space), emitting two instance ranges — SPEC 10.1's
bucketing, with the threshold taken from a measured crossover rather than a
guess. Not yet built.

**Load balancing without a work list.** One thread per edge stalls a workgroup
on its longest edge, which is the "works in all conditions" failure. SPEC 10.2
proposes a global span list built with atomicAdd; that needs a capacity guess
and fails silently when wrong. Instead each workgroup balances itself: 256 edges
are clipped to the viewport (bounding length by the screen diagonal), their span
counts are prefix-summed in workgroup memory, and all 256 lanes then consume the
batch's spans cooperatively. Exact, no global list, no capacity limit. Pooling
SPANS rather than pixels matters: the first version pooled pixels and paid an
8-step binary search per splat, measured at 16.8 ms for 1M edges.

**The resolve clears the accumulator as it reads it** (`atomicExchange`), which
removes a separate 10 MB clear per frame — and immediately exposed a real bug:
`requestRender()` sets only `Dirty.FORCED`, which no compute pass listed, so a
forced frame resolved an accumulator nothing had refilled and drew NOTHING.
`EdgeRasterPass.runsOn` is now every frame: the invariant is that a frame which
resolves must have rasterized.

**Three harness bugs found, each of which produced confident nonsense first:**

1. `requestRender()` in the benchmark loop measured the render pass alone and
   reported every compute stage as NaN — 10M nodes + 10M edges "at 2.5 ms".
2. `camera.getView()` reads shared state the worker writes AFTER a frame, so
   reading it immediately after `setView` returned the OLD zoom and the wobble
   loop reset the camera to fit. Every zoomed row silently measured fit
   (drawn % was 100 everywhere, including at x64).
3. `passMs` is a 30-frame rolling mean and a heavy case renders ~6 frames in
   1.8 s, so consecutive measurements blended into each other. The loop now
   waits for 45 FRAMES, not wall time.

Storybook URL `args` did not reach the story for the mode switch, which is why
`Graph.setEdgeMode()` exists: it also makes the A/B a single browser run
instead of two, removing device and thermal drift from the comparison.

## 0027 — Edges: engine-index endpoints, a sorted edge list, and a chunk cull

M5, first two stages. Everything below is measured on the owner's Xe-LPG.

**The endpoint gather is the whole problem.** Before a pixel is drawn, an edge
pass must learn where its two endpoints are. At 30M edges (microbenchmark,
standalone kernels, data verified non-degenerate):

| endpoint layout | ms |
|---|---|
| user indices through `rank[]` (the naive port of SPEC 5.3) | 146 |
| engine indices, edge list in insertion order | 85.3 |
| + `screenPos` cache instead of `nodePos` | 86.9 |
| **engine indices, edge list sorted by lower endpoint** | **16.8** |
| sorted, every endpoint local (upper bound) | 10.5 |
| chunk-bounds record rejecting all 30M | **0.043** |

Three decisions follow, and one refutation:

1. **Endpoints are remapped to ENGINE indices once, on data change**
   (`edge_remap.wgsl`), through `rank` after an upload or through a new
   `invPerm` after the nodes are re-sorted — never re-uploaded. 5.1x.
2. **SPEC 5.3 is wrong.** It says "edges are **not** sorted with nodes. Keep
   them in insertion order". Sorting the edge list by `min(src, dst)` in engine
   (Morton) order is worth another 5.1x on the gather, and without it the chunk
   bounds are useless: 1024 arbitrary edges span the whole graph, so the bounds
   test never fires. `min`, not `src`, so direction survives for arrowheads.
   The radix kernels from `sort.wgsl` are reused unchanged.
3. **REFUTED: the `screenPos` cache.** HANDOVER listed it as the thing to build
   "when edges need it". It is worth nothing (86.9 vs 85.3): the cost is the
   random access pattern, not the payload size. Not built.

**The cull works, and it is cheap.** 1M nodes / 3M edges, edges drawn and
GPU ms, before (no cull) -> after:

| view | drawn edges | before | after |
|---|---|---|---|
| fit | 3.0M (100 %) | 77.1 | 71.8 |
| zoom x8 | 992k (33.1 %) | 213.1 | 198.4 |
| zoom x64 | 83.9k (**2.8 %**) | 183.3 | **55.6 (3.3x)** |

Per-pass at 3M edges: `edge.count` 1.0-1.3 ms, `edge.scan` 0.03, `edge.scatter`
2.4-6.4, `edge.bounds` ~1.5 (data changes only). Total cull overhead 4-8 ms.

**At fit the cull cannot help and slightly costs**, because every edge really is
on screen — 100 % drawn is the correct answer, not a bug. The win is entirely in
the zoomed cases, which is also where the hand-driven experience lives.

**What the measurement actually exposes: the rasterizer, not the cull.** With the
cull in place, `render` is 96.5 / 130.7 / 59.9 ms of the 100.9 / 132.9 / 61.5 ms
totals — **95 %**. At x64 zoom, 83,883 edges cost 59.9 ms, 0.7 us each, because
each one is enormous on screen. Culling removes off-screen edges; it cannot
remove on-screen ink, and sum-of-pixel-length is irreducible without LOD.

Rasterizer shootout at equal deposited weight (verified: every candidate
deposits the same total, which caught two that were silently doing nothing):

| candidate | 1M seg / 7.8M px | 4M / 31M px | 1M len30 / 26.5M px |
|---|---|---|---|
| compute DDA, 1 global atomic | **6.8** | 36.3 | **24.6** |
| compute DDA, 2 atomics (colour) | 17.1 | - | - |
| compute DDA, 4 atomics | 39.1 | - | - |
| tiled, on-chip accum, binning included | 7.8 | **11.6** | 25.9 |
| hardware quads -> fragment atomics | 10.7 | 44.7 | 28.7 |
| hardware quads -> alpha blend (what we ship now) | 17.8 | 50.9 | 44.8 |

So the next stage is the compute density path plus edge LOD, not more culling.
Two cautions for whoever builds it: **tiling is not the free 20x it first looks
like** — an isolated probe said 14-33x, the honest pipeline with binning says
3.14x at high density and a 13 % LOSS at low density (binning costs 3.3-7.1 ms);
and **WGSL has no 64-bit atomics**, so the published point-cloud rasterizers'
key trick (pack depth+colour into one `atomicMin`) does not port. Per-edge
colour costs 2.5x on the global-atomic path, which is why the default edge is a
global tint and per-edge colour is an opt-in pipeline variant.

**The default edge reads 8 bytes.** With no per-edge style or colour, those
buffers are never allocated (360 MB not uploaded at 30M) and the reads are
compiled out by override constants.

**A dataset bug found by looking at the picture.** The first edge generator
joined index-adjacent nodes. In `clustered`, node index is unrelated to
position, so those edges were spatially RANDOM — it would have made edge sorting
look worthless. Rewritten to bucket nodes into a uniform grid by counting sort
and pick local targets from the source's own cell. The same scene went 21.8 ->
1.55 ms on honest data. Aggregate numbers hid it; the screenshot did not
(cf. 0024).

**Verification.** `Edges/Lattice`: a grid graph whose every edge joins `i` to
`i + 1` in the same row, so correct output is only horizontal segments and any
remap error is instantly visible as diagonals. Passes with the full pipeline.
`scripts/gpu.mjs shot --story <id> --file out.png` screenshots any story
(the canvas belongs to the worker, so pixels can only be read over CDP).

**Also changed:** `MAX_PROFILE_SLOTS` 16 -> 24 and `STATE_SLOTS` 32 -> 48 (the
edge passes added 8 slots and the 16-slot query set overflowed at runtime);
`Frame._pad` became `Frame.globalEdgeColor`, same size, no layout change.

## 0026 — Wheel zoom glides; one input no longer means one frame

**Measured first** (`scripts/gpu.mjs input`, real events through CDP so they take
the production path DOM → PointerInput → ring → worker; timing is page-side so
there is one clock). The engine rendered **exactly one frame per input event** —
90 drag events produced 90 frames. Smoothness was therefore capped by however
fast the wheel happened to fire: 10 events/s rendered **7.8 fps** at deep zoom
on 10M, reproducing the owner's original "8 fps by hand" report, while the GPU
used 3.3 ms of its 16.7 ms budget. Input latency was never the problem —
median input→frame was **0.9 ms**; the SAB ring and wake handshake are fine.

**Decision:** a wheel notch no longer moves the camera. It adds to a target
(`pendingZoomLog`) and `Controls.advance` approaches it exponentially
(`ZOOM_TAU_S = 0.05`, framerate-independent), applied through the existing
`Camera2D.zoomAt` so anchor semantics are untouched. Notches arriving mid-glide
add rather than queue. 10 events/s now renders **231 fps headless** (vsync off;
a real browser caps at 60), frame interval 106.8 → 3.2 ms.

Panning is deliberately **not** smoothed: a drag is already 1:1 with the pointer
and easing it would only add lag to a gesture that already tracks correctly.

**Costs nothing when still.** The glide only keeps the loop awake while in
flight; measured 0 frames in 2 s of idle, both untouched and after a camera
change. GPU p50 across the suite is unchanged within noise.

**Not explained:** a latency tail under synthetic input (p95 184 ms at 60 Hz,
1260 ms at 120 Hz) and a ~20 fps / 44 ms ceiling that is not GPU-bound. The
probe polls the shared state in a tight MessageChannel loop and may be inflating
both, so this needs a cleaner measurement before anyone trusts it.

## 0025 — LOD engages earlier, and the harness stops lying about it

Three changes to `lodItems`, from the owner's observations that chunk seams were
visible and that low zoom still drew ~1M nodes:

1. **Chunk extent is `sqrt(dx*dy)`, not `max(dx, dy)`.** Chunks are arbitrary
   runs of CHUNK_SIZE nodes, so their boxes are often elongated and the max
   dimension swings ~2x between neighbours at equal density. `m` squares it, so
   the sample count swung 4x and the compensated dot size 2x — adjacent chunks
   got visibly different texture. The equivalent square side is both smoother
   and the correct 2-D density estimate.
2. **The size guard asks about size, not separation.** Sampling stops once
   `2 * maxR >= LOD_TARGET_PX`: nodes as wide as the spacing tile the region, so
   dropping one leaves a hole. The previous absolute test (largest node reaches
   0.5 px) disabled LOD across a whole chunk for one slightly larger node.
   A *separation* test was tried first and was badly wrong — sub-pixel nodes are
   technically far apart, so it kept everything exactly where sampling matters
   most (z2 drew 5.5M instead of 1.2M).
3. **A minimum worthwhile reduction.** Sampling inflates every survivor, so the
   quads grow as the count falls; below a 2x reduction it loses. LOD engaging on
   the 1M standard path cost 1.27 -> 1.97 ms.

Drawn instances vs LOD off, 10M: fit 3.01M -> **202k**, z2 9.93M -> **730k**,
z8 2.73M -> 1.42M. Ink error +4.7 % / +1.1 % / −3.9 %; lattice stays near the
reference. GPU p50: xlarge-zoom 29.83 -> 7.17 (**4.2x**, p99 50 -> 21),
large-zoom 3.61 -> 3.27, xlarge 6.06 -> 5.26.

**Still negative on the small cases:** small 0.91x, medium 0.91x, large 0.81x,
deep-zoom 0.92x. LOD costs something where it cannot help, and the remaining
differences sit inside run-to-run spread on this iGPU.

**Harness bugs found, both of which had corrupted earlier conclusions:**

- `--no-build` skipped the *Storybook* build, which is what embeds `dist/`, so
  runs after a library change silently measured old code. Two runs came back
  byte-identical and were read as "the change did nothing". The runner now
  compares mtimes and rebuilds anyway, ignoring `--no-build`. **The first radius-
  cap experiment (0024) was measured this way and was invalid** — re-run properly
  it reached the same verdict, but by luck.
- Opening a page occasionally lands on an error document, reporting
  `crossOriginIsolated === false` and failing a whole measurement. Startup
  failures now retry with a fresh browser; failures from the measurement itself
  never retry. Profile directories are also swept — 105 had accumulated.

**Measured and rejected (twice each):** capping the compensated radius at the
sample spacing (helps large 1.97 -> 1.55, costs deep-zoom 2.49 -> 2.95 and
large-zoom 2.85 -> 3.70), and stochastic rounding of the per-chunk count.

## 0024 — LOD is a random prefix of real nodes, not a cluster pyramid

**Replaces 0022.** The pyramid is deleted: no `Cluster` record, no 53 MB of
scratch, no 7.3 ms build pass.

**Why it had to go.** Emitting one representative per equal-count Morton cell is
one sample per grid cell, i.e. a jittered lattice *by construction*. It showed
as a woven, burlap-like texture — obvious side by side, and measured at **7x the
reference's 2-D autocorrelation peak** with a clean [-7, 0] lattice vector
matching the on-screen cell size. No choice of representative, colour or radius
fixes it, because the cells are the lattice. Potree's Poisson-disk spacing
guarantee exists for exactly this reason.

**What replaces it.** `shuffle_chunks.wgsl` permutes engine order *within* each
chunk by a hash of the node's user index (bitonic sort in workgroup memory),
right after the radix sort and before the single existing gather — so it costs
no extra permutation. Any prefix of a chunk is then a uniform random sample of
it. LOD becomes a prefix length: `m = (ext / LOD_TARGET_PX)^2`, continuous
rather than quantised to powers of 4, with survivors scaled by
`sqrt(CHUNK_SIZE / m)` to conserve ink. Every drawn dot is a real node with its
real colour and position. Chunks stay Morton-ordered, so bounds and the cull
early-out are untouched.

Image diff vs LOD off, 10M, `lodTargetPx = 2`:

| metric | clusters | random prefix |
|--------|----------|---------------|
| lattice peak (fit) | 0.184 vs ref 0.026 | **0.028 vs ref 0.023** |
| ink error (z2) | −7.2 % | **+1.7 %** |
| saturation error (z2) | −3.6 % | +3.7 % |

GPU p50, median of 3 headless runs (LOD off → prefix): xlarge-zoom 29.83 →
**7.90** (3.8x, p99 50 → 20), large-zoom 3.61 → 2.13, deep-zoom 2.72 → 2.21,
xlarge 6.06 → 5.10 (p99 48 → 21). Clusters were slightly faster on two cases
(xlarge-zoom 6.24, large-zoom 1.86) but produced the weave, and are worse on
xlarge p99. Correctness passes on four consecutive warm runs (0019's rule; the
bitonic sort is exactly the kernel shape that failed warm there).

**Known, not fixed:** `large` regresses 1.27 → 1.59 ms — LOD engaging on the 1M
standard path without paying for itself. `meanAbsError` rises slightly (1.21 →
1.76) because a stochastic method places different individual dots; the
structural metrics are the meaningful ones.

**Two changes were tried and REVERTED for lack of measured benefit:** capping
the compensated radius at half the sample spacing (helped large-zoom 3.78 →
3.52, cost the other three, deep-zoom 1.87 → 2.95), and stochastic rounding of
the per-chunk count (no effect).

**Metric caveat.** `imagediff` gained a lattice detector, and it took three
attempts: a 1-D row autocorrelation scored the artifact-free reference as *more*
periodic than a visibly woven image, and a 2-D version did the same until the
field was high-passed to remove the smooth density gradient. It still conflates
dot size with regularity, so it cannot compare settings whose dot sizes differ —
which is why `lodTargetPx` 2 was chosen by looking at crops, not by the number.
Aggregate statistics hid an artifact the owner could see immediately; look at
the images.

## 0023 — LOD merges only the sub-pixel mass (and how we now measure "looks right")

`scripts/gpu.mjs imagediff` renders the same views with LOD off and on, captures
both over CDP (the canvas belongs to the worker) and compares them in a page
(PNG decoding without a dependency). Metrics are picked for the failure modes
LOD actually has, not for a generic PSNR: **ink** (is total luminance preserved,
i.e. density lost or invented), **saturation** (averaging many hues greys them
out) and **blockP95** (worst local 32 px density error).

First run, 10M clustered, against LOD off:

| view | meanAbsErr | ink | saturation | blockP95 |
|------|-----------|-----|------------|----------|
| fit  | 1.43      | +1.3 % | −1.0 % | 3.9 % |
| z2   | 4.70      | −7.2 % | −3.6 % | 15.2 % |
| z8   | 20.79     | **−15.0 %** | **−15.3 %** | 22.4 % |

LOD was **most wrong zoomed IN**, the opposite of what eyeballing suggested.
Cause: `lodLevel` judged by spacing alone, so it merged nodes that were
individually resolvable — losing their colour and their size. A node big enough
to resolve is real information; only the sub-pixel mass is a density field.

**Decision:** a chunk whose largest node still reaches `NODE_MIN_DRAW_RADIUS_PX`
is never merged (`maxSize` is already in `ChunkBounds`, and being the max it errs
toward not merging). z8 becomes exact (meanAbsErr 0.03, drawn count identical to
the reference — LOD switches itself off), fit improves to 1.21 / −0.8 % / 2.7 %
while still drawing 151k instead of 3.0M. Speed is kept: xlarge-zoom 4.78x
(was 4.86x), large-zoom 1.94x; xlarge gives back 1.34x → 1.17x, which is the
correctness being paid for.

**Still open:** z2 (−7.2 % ink, 15.2 % blockP95) is the band where nodes straddle
the threshold and averaged colour still shows. The literature's answer is not a
better average — it is to stop inventing points: Potree/CLOD select *real* points
with a Poisson-disk spacing guarantee, and Schütz's high-quality shading averages
**per pixel** (atomicAdd colour + count, divide in a resolve pass) rather than per
cluster, which is zoom-correct and order-independent. Our cluster average also
assumes spatial colour coherence, which point clouds have and graphs do not.

## 0022 — LOD clusters (4-ary pyramid over Morton order)

Chunk bounds were already level 5 of a pyramid, so LOD generalises it instead of
adding a structure: level L = one 16 B `Cluster` per 4^L engine-order nodes,
stored in the scratch buffer (an 11th storage binding would break the §8
contract). Build is bottom-up, on data change only: **7.3 ms @ 10M**, next to
the existing 31 ms sort. Each chunk picks ONE level from its projected extent,
workgroup-uniform, so `cull_count` and `cull_scatter` derive the same item list
with no divergence.

Median of 3 headless runs, GPU p50 (LOD off → on): **xlarge-zoom 29.83 → 5.79
(5.2x)**, xlarge 6.06 → 4.48. Deep zoom and small are unchanged — LOD is
inactive there by construction, which is the point.

Three things were measured, not assumed:

- **Draw order still matters.** Deleting the ADR 0020 interleave once LOD caps
  the instance count made it *worse* than no LOD (render p50 7.41 → 18.74 @10M).
  The earlier microbenchmark had scrambled instances across the viewport, so it
  never tested spatial order. The interleave stays.
- **Cluster radius conserves ink, not extent.** Drawing a cluster at its group
  `spread` was SLOWER than no LOD on large-zoom: 2.7x fewer instances but
  +0.86 ms render, because every quad grew. Radius is `meanR * 2^level` (equal
  total area, cf. 0004), clamped by the spread: render 2.02 → 0.73.
- **Never derive pyramid offsets in the shader.** A chain of divisions per
  thread, evaluated even at level 0 where it is unused, cost deep-zoom p99
  5.34 → 11.14. The level bases are precomputed by the CPU into the scratch
  header (`SCRATCH_LOD_BASE`); they depend only on the node count.

`lodTargetPx` is a `GraphOptions` knob (default 2, `0` disables). The correctness
story runs with `0`: its oracle counts nodes, and LOD deliberately draws merged
clusters, so the two are only comparable with LOD off. What LOD costs *visually*
is an image-diff question and is not yet measured.

**Caveat:** the suite heats this iGPU, so a case measured last (large-zoom) reads
slower than the same case measured in a 3-case run (3.62 vs 1.70 p50). Compare
only runs of the same shape.

## 0021 — The cull is at the memory roofline; 10M-visible needs LOD, not tuning

Opened to fix the "profiler drops the slowest samples" issue. **Both halves of
that issue were wrong**, and the measurement redirected the plan.

**Instrument.** `scripts/gpu.mjs` (dev-only, no deps): headless Edge over CDP,
driven from Node's built-in `WebSocket`. Serves a *static* Storybook build with
COOP/COEP so a run is frozen for its duration and the SharedArrayBuffer ring
stays enabled; asserts `crossOriginIsolated` and `navigator.gpu` before running,
since either one silently measures the wrong path. `bench`, `correctness`, and
`eval` (arbitrary page script on an engine-free page, for microbenchmarks).

**Headless is ~2× slower than the owner's desktop** and its numbers are only
comparable to other headless runs. Measured roofline here vs 69.5 GB/s desktop:
read 16 B/node 4.54 ms (35.2 GB/s), read 8 B 2.38 ms, read+write 16 B 12.06 ms
(26.5 GB/s) at 10M. Cause: `--disable-gpu-vsync --disable-frame-rate-limit`
saturates the iGPU continuously, which throttles it.

**Sample drops are biased toward FAST frames, not slow ones.** Frame interval of
frames *with* a GPU sample vs *without*, 10M standard: p50 7.17 / max 79.21 vs
p50 **1.75** / max **5.09**; 193/200 kept, and 200/200 in the zoom sweep. When
frames are ~1.7 ms apart the CPU outruns `mapAsync` and the ring fills; a 45 ms
frame has ample time to read back. So the ring makes p50 slightly *pessimistic*
and leaves p99 intact. The reported "frame interval p99 86 ms vs GPU p99 38 ms"
gap does not reproduce (27.44 vs 25.68 p50; 52.70 vs 50.43 p99) — it was vsync
quantization (86 ≈ 5 × 16.7 ms), not lost time. **No profiler rework done.**

**The three heavy passes are at or near roofline.** `classify()` reads
`nodeState` 4 B + `nodeSize` 4 B + `nodePos` 8 B = 16 B/node; `cull_scatter`
re-classifies and writes a 16 B instance. At fit (10M visible):

| pass         | traffic         | roofline | in-frame p99 | kernel alone |
|--------------|-----------------|----------|--------------|--------------|
| cull.count   | 160 MB r        | 4.54     | 10.01        | **4.68** (1.03×) |
| cull.scatter | 160 MB r + 160 w| 12.06    | 13.36        | — (1.11×)    |

Isolating `cull_count`'s shape at 10M all-visible: per-cell atomics only 4.68 ms
vs + the single shared `wgTotal` atomic 4.715 ms — **the shared counter costs
0.035 ms**, so the suspected atomic serialization is not real. The in-frame p99
gap is contention with the render pass on a saturated GPU, not kernel waste.

**Conclusion.** At 10M fully visible, count + scatter at *perfect* roofline cost
4.54 + 12.06 = **16.6 ms, already over the 16 ms budget**, before a pixel is
drawn (render measures 12.6 / 32.3). Halving it on the owner's faster desktop
still leaves no room once edges arrive. This is not a constant-factor problem:
**no kernel tuning reaches the target while every node is touched every frame.**
The traffic itself must shrink, which means LOD (M6) — a chunk whose nodes are
all sub-pixel must be rejected by its 24 B bounds record and replaced by a
cluster, taking the fit case from 160 MB/frame to ~0.2 MB of chunk bounds plus
cluster records. `BUCKET_CLUSTER` is already reserved for it.

**Two microbenchmark traps hit and fixed while doing this** (both would have
produced a confident wrong answer, cf. 0019): zero-filled buffers make
`classify()` early-out at the size check so the position read and every atomic
vanish — kernels must be fed data that reaches the path under test, and the
result verified (every segment cell must hold exactly `DRAW_SEGMENT` nodes);
and a counter the compiler can bound (`acc ≤ 4`) makes the comparison that
consumes it provably false, so the whole loop is dead-code eliminated.

## 0020 — Draw order decoupled from engine order (no batch shuffle)

**Spec:** §11.1 shuffles Morton order in batches of 128 (Schütz et al. 2021).
**Measured** (p50/p99 ms; render at fit-to-screen 10M, GPU at deep zoom 10M):

| engine order                | render (fit) p99 | deep-zoom GPU p50 |
|-----------------------------|------------------|-------------------|
| Morton, chunk bounds        | 290              | **0.95**          |
| Morton + shuffle, B = 128   | 79               | 1.45              |
| Morton + shuffle, B = 64    | 49               | 1.57              |
| Morton + shuffle, B = 32    | 35               | 1.88              |
| random (M3)                 | 28               | 5.97              |

No batch size wins both: spatial order is what culling wants and exactly what
blending hates (back-to-back overlapping quads on the same pixels serialize).

**Resolution — decouple draw order from engine order.** Engine order stays pure
Morton (whole-chunk early-out). Only the *output slots* of BUCKET_NORMAL are
interleaved: draw order is (segment of DRAW_SEGMENT nodes, scrambled chunk,
engine index). Chunks are scrambled with a golden-ratio stride so consecutive
draw positions are ~0.38·C chunks apart. Each node's place depends only on its
own index → stable frame to frame (overlapping nodes never swap, no flicker).
Other buckets keep chunk order (FOREGROUND is small; TINY will be
order-independent). One device-wide 3-phase scan (block reduce → scan block
sums → down-sweep) over all buckets' cells yields every draw slot directly; a
single-workgroup scan was measured at 2.8 ms for 1.25M cells and rejected.

Measured, 10M, zoom sweep at zoomed-out levels (GPU p50/p99 ms):

| draw order                        | GPU total   | render | deep zoom |
|-----------------------------------|-------------|--------|-----------|
| spatial                           | 130 / 324   | 122    | 1.00      |
| segment 64, 1-workgroup scan      | 27 / 68     | 16     | 2.25      |
| segment 64, device-wide scan      | 25 / 64     | 16     | 1.09      |
| segment 32, device-wide scan      | 22 / 53     | 12     | 1.66      |
| **segment 16, device-wide scan**  | **20 / 44** | **9**  | **1.41**  |
| random (M3 order)                 | 20 / 41     | 11     | 5.97      |

Segment 16 matches random order for drawing and keeps the culling win.
Correctness: visible counts exact vs the CPU reference, and every instance
record matched to its node (instance-level readback, 0 wrong).

## 0019 — Workgroup-scan "last lane" read moved after the scan (driver bug)

A stable radix sort passed on cold first runs and on synthetic keys, then
produced duplicate indices on every warm run (216k duplicates at 1M). Bisected
kernel by kernel against a known-good prototype: the scatter's
`wgScanVec4` wrote the last lane's value into a workgroup variable *before* the
Hillis–Steele loop and read it *after* it. Valid WGSL (barriers in between), but
intermittently stale on this Intel/D3D12 stack. Writing it *after* the loop
behind its own barrier fixes it (16/16 warm runs, bit-exact vs CPU stable sort).
**Rule:** GPU kernels are verified warm, repeatedly, on real data (Morton keys),
against a CPU reference — never on first run or synthetic data alone.

## 0018 — Engine order: physically Morton-sorted node buffers

**Spec:** §11.1 keeps user order and iterates a `sortedIdx` permutation.
**Measured** (cull total, 10M, chunk bounds on):

| layout                                  | deep zoom | 10 % view | fit  |
|-----------------------------------------|-----------|-----------|------|
| physically sorted buffers               | 0.37      | 1.12      | 8.2  |
| permutation index (spec)                | 1.01      | 10.96     | 99.5 |
| sorted 16 B record, colour via index    | 0.34      | 2.25      | 19.2 |

Random gathers are ~10× more expensive on this GPU. **Decision:** every node
channel in @group(1) is stored in engine order. `order[engine] = user` and
`rank[user] = engine` live on the GPU; bulk loads arrive in user order and SORT
permutes them (gather ≈ 33 ms @ 10M, only on data change); partial updates are
applied through `rank` by a scatter kernel. The CPU never needs the permutation.
User compute passes see engine order and get the tables via `resources`.

## 0017 — Chunk bounds + coarsened, list-driven cull

**Measured** (cull total 10M; random-order data vs Morton-sorted):

| variant                                   | deep zoom        | 10 % view        | fit  |
|-------------------------------------------|------------------|------------------|------|
| M3 (1 node/thread, full scatter)          | 4.88             | 5.58             | 8.41 |
| 4 nodes/thread + indirect scatter         | 4.93 / 2.53 sort | 5.62 / 3.33 sort | 8.18 |
| + chunk bounds (sorted data only)         | **0.31**         | **1.14**         | 8.19 |

Read roofline for a full 16 B/node scan: 2.3 ms @ 10M (4 nodes/thread; 1 node/
thread reaches only 2.73). With random order 99 % of chunks hold a visible node
at deep zoom, so skipping empty chunks only pays after sorting. **Decision:**
chunk = 1024 nodes (256 threads × 4), one 24 B bounds record per chunk rejects
it with a workgroup-uniform early-out; scan builds a deterministic list of
non-empty chunks; scatter is an indirect dispatch over that list. Fit-to-screen
is bandwidth-bound (writing 10M instances ≈ 5 ms) — solved by M4/LOD, not here.

## 0016 — Portable scans, no subgroups (for now)

Subgroup scans vs Hillis–Steele in the tuned cull: 0.335 vs 0.294 ms (deep
zoom), 1.12 vs 1.05 (10 %), 8.16 vs 8.36 (fit) — no consistent gain, and a
second code path. Revisit for the radix sort (8-bit digits) with measurements.

## 0015 — Indirect args live in their own buffer

WebGPU forbids a buffer being both the indirect-args source and a writable
storage binding in the same dispatch ("writable usage and another usage in the
same synchronization scope"). Each cull phase has its own pipeline layout; the
dispatch args buffer is bound only in `cull.scan`.

## 0014 — Stable LSD radix sort, 4-bit digits, adaptive key width

Reduce-then-scan per digit (count → scan → scatter), no global atomics, no
decoupled look-back (needs forward-progress guarantees WebGPU does not give).
Key width targets ~4 nodes per Morton cell (22 bits @ 10M → 6 passes).
Measured: 3.3 ms @ 1M, 31 ms @ 10M (~57 % of the bandwidth roofline). Next
lever: 8-bit digits (half the passes). Runs on data change only.

## 0013 — No competitor in the harness (M3)

SPEC §2/§19.3 originally ran cosmos.gl head-to-head. Removed at the owner's
request: performance is judged against the §2/§18.2 budgets and against our own
previous runs (`Download JSON` → `packages/bench/results/`).

## 0012 — Benchmark runs inside the render worker (M3)

`graph.benchmark({ path, frames })` steps a frame-indexed camera path once per
rendered frame and records CPU, frame interval, GPU total, GPU per pass and
visible counts in the worker, returning them in one message. Frame N is the same
view on every machine, and the main thread is idle during a run, so the numbers
measure the engine, not Storybook. Paths are relative to the data bounds and the
fit zoom (`@vhult/graph-bench` `PATHS`).

## 0011 — Profiler granularity: per compute pass, one slot for the render pass (M3)

Timestamps come from pass `timestampWrites` (core WebGPU has no mid-pass
timestamps). Each compute stage runs in its own compute pass and is timed
individually. All render stages share one render pass (§7: `beginRenderPass`
is expensive on tiled GPUs), timed as a single `render` slot. If per-render-stage
attribution is needed later, add an opt-in "split render passes" profiling mode
rather than splitting in production.

## 0010 — Deterministic compaction instead of atomic append (M3)

**Spec:** §9.1 appends to bucket lists with a global `atomicAdd`.
**Problem:** atomic append order changes every frame. Overlapping nodes blend
"over" each other, so a varying draw order makes dense regions flicker. With
Morton ordering (M6) spatial neighbours share index ranges, making it worse.
**Decision:** reduce-then-scan in three dispatches (`cull_count` → `scan_groups`
→ `cull_scatter`), output in node-index order. Global atomics are gone entirely
(workgroup-local counters only). The cost is a second read of pos/size/color for
*visible* nodes only. Next steps to measure: subgroup scans instead of
Hillis–Steele (`subgroups` feature), and whether caching the projection from
pass 1 beats re-projecting in pass 3 once edges need a per-node `screenPos` (M5).

## 0009 — Compacted NodeInstance records instead of index lists (M3)

**Spec:** §9.1 writes `bucketList` (indices) + per-node `screenPos`/`screenSize`,
and the vertex shader gathers from them.
**Decision:** the cull writes one 16 B `NodeInstance { screenPos, radiusPx,
color }` per visible node in draw order. The vertex shader does one coalesced
16 B load, with no index indirection and no random gathers. Colour changes
therefore re-run the cull (STYLE is in its `runsOn`); background-only changes
(`CLEAR_COLOR`) do not. The per-node `screenPos` cache arrives with edges (M5),
where endpoint lookups need it.

## 0008 — Engine needs 10 storage buffers per stage (M3)

The public contract puts 8 storage buffers in @group(1); the cull and draw
passes add 2 in @group(2). Adapters below 10 are refused with
`UnsupportedError("insufficient-limits")`. If real hardware reports 8, pack
the edge bindings into fewer buffers (contract v2) rather than chunking passes.

## 0007 — Pass skipping by dirty flags (M3)

Compute passes declare `runsOn` flags; a frame whose only change is the clear
colour re-renders without re-running the cull.

## 0006 — Pointer input sends absolute positions, not coalesced events (M1)

**Spec:** §6 says to use `getCoalescedEvents()` on the main thread so nothing is lost.
**Decision:** Records carry absolute device-px positions; pan is computed from
consecutive positions in the worker, so coalesced sub-events add no information
for pan/zoom and would only multiply ring traffic. Revisit for lasso selection
(M8), where the intermediate path matters.

## 0005 — Analytic AA in the node fragment shader (M2)

**Spec:** §9.3 uses `fwidth(sd)`.
**Decision:** For the built-in circle the quad is screen-aligned and uniformly
scaled, so the AA width is exactly `1 / radiusPx`, passed flat from the vertex
stage. Same result, no derivative instructions. Custom `node_shape` hooks (M7)
may produce non-uniform fields, so the hook path will use `fwidth`.

## 0004 — Sub-pixel nodes on the hardware path fade by area (M2, temporary)

Until the compute rasterizer (M4) takes the TINY bucket, nodes below 0.5 px
radius are drawn at 0.5 px with alpha scaled by `(r / 0.5)²`. This conserves
energy (no shimmer, no disappearance on zoom-out). Removed by M4.

## 0003 — Mapped staging ring deferred (M2)

**Spec:** §5.5 routes partial uploads > 64 KB through a 4 × 16 MB mapped ring.
**Decision:** Bulk loads already use `mappedAtCreation` (the gate-relevant path).
Partial updates currently go through coalesced `writeBuffer` ranges only. The
ring will be implemented when the M3 harness can measure the streaming case;
it is kept only if it measurably beats `writeBuffer` (§0 rule 2).

## 0002 — Bench fixtures live in their own workspace package

**Spec:** §4 lists `bench/` inside the engine package.
**Decision:** `packages/bench` (`@vhult/graph-bench`, private): seeded datasets,
camera paths and statistics, shared by Storybook and any future CLI harness,
without the engine depending on either. The engine itself has no runtime deps.

## 0001 — Naming, workspace layout, Storybook as consumer

- Package `@vhult/graph`; internal name `graph` (class `Graph`, WGSL prefix
  `graph_`). SPEC.md §23 updated.
- npm workspaces: `packages/graph` (library), `packages/bench`,
  `apps/storybook`. Storybook consumes the **built** `dist/` exactly as an
  external app would, so it tests what ships.
- Storybook deps (storybook, @storybook/html-vite, vite) are dev-only in the
  Storybook app, approved explicitly. HTML renderer: no framework runtime in the
  preview iframe. vitest resolves its `vite` peer from the same hoisted install.

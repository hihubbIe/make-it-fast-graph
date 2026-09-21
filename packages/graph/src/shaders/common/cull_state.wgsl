// Layout of the cull state buffer (see ENGINE_CONSTANTS in Layouts.ts), shared by
// chunk_bounds.wgsl and transform_cull.wgsl. Every function takes `chunks`, the
// chunk count of the current frame, because section offsets depend on it.
//
// Counts live in "cells", laid out in draw order across all buckets:
//   BUCKET_NORMAL   SEGMENTS · chunks cells, (segment, scrambled chunk) order
//   other buckets   chunks cells each, chunk order
// One exclusive scan over all cells gives every node's draw slot directly;
// buckets are contiguous in the instance buffer (NORMAL first).
#include "common/layouts.wgsl"

@group(2) @binding(0) var<storage, read_write> scratch : array<u32>;

/** Draw-order segments per chunk (BUCKET_NORMAL only). */
const SEGMENTS : u32 = CHUNK_SIZE / DRAW_SEGMENT;
/** Cells per chunk: SEGMENTS for NORMAL + one for each other bucket. */
const CELLS_PER_CHUNK : u32 = SEGMENTS + NUM_BUCKETS - 1u;
/** Cells per workgroup in the device-wide scan (WORKGROUP_SIZE × ITEMS_PER_THREAD). */
const SCAN_BLOCK : u32 = CHUNK_SIZE;

fn numChunks() -> u32 {
  return (frame.nodeCount + CHUNK_SIZE - 1u) / CHUNK_SIZE;
}

fn numCells(chunks : u32) -> u32 {
  return CELLS_PER_CHUNK * chunks;
}

fn numScanBlocks(chunks : u32) -> u32 {
  return (numCells(chunks) + SCAN_BLOCK - 1u) / SCAN_BLOCK;
}

// Draw position of a NORMAL (segment, chunk) cell: segment-major, chunks
// scrambled so consecutive positions are far apart in Morton order (stride set
// by the CPU, see drawStride in Layouts.ts; chunk · stride < 2^32 for < 65536 chunks).
// DRAW_SCRAMBLE off puts NORMAL cells in plain (chunk, segment) order, i.e.
// spatial draw order. The scramble exists only to stop overlapping blended
// quads issuing back to back (docs/decisions.md 0020); LOD caps the drawn
// instance count, so whether it still pays is a question for measurement.
override DRAW_SCRAMBLE : bool = true;

fn drawIndex(segment : u32, chunk : u32, chunks : u32) -> u32 {
  if (DRAW_SCRAMBLE) {
    return segment * chunks + (chunk * scratch[SCRATCH_DRAW_STRIDE]) % chunks;
  }
  return chunk * SEGMENTS + segment;
}

/** First cell of bucket `b` (b == NUM_BUCKETS gives the cell count). */
fn bucketFirstCell(b : u32, chunks : u32) -> u32 {
  return select(SEGMENTS * chunks + (b - 1u) * chunks, 0u, b == 0u);
}

/** Cell of (bucket, chunk) for buckets other than NORMAL. */
fn chunkCell(b : u32, chunk : u32, chunks : u32) -> u32 {
  return bucketFirstCell(b, chunks) + chunk;
}

fn countsAt(chunks : u32) -> u32 {
  return SCRATCH_CHUNKS;
}

fn offsetsAt(chunks : u32) -> u32 {
  return SCRATCH_CHUNKS + numCells(chunks);
}

fn blockSumsAt(chunks : u32) -> u32 {
  return SCRATCH_CHUNKS + 2u * numCells(chunks);
}

fn totalsAt(chunks : u32) -> u32 {
  return blockSumsAt(chunks) + numScanBlocks(chunks);
}

fn listAt(chunks : u32) -> u32 {
  return totalsAt(chunks) + chunks;
}

fn chunkBoundsAt(chunk : u32, chunks : u32) -> u32 {
  return listAt(chunks) + chunks + chunk * CHUNK_BOUNDS_WORDS;
}

fn loadChunkBounds(chunk : u32, chunks : u32) -> ChunkBounds {
  let o = chunkBoundsAt(chunk, chunks);
  return ChunkBounds(
    vec2<f32>(bitcast<f32>(scratch[o]), bitcast<f32>(scratch[o + 1u])),
    vec2<f32>(bitcast<f32>(scratch[o + 2u]), bitcast<f32>(scratch[o + 3u])),
    bitcast<f32>(scratch[o + 4u]),
    scratch[o + 5u],
  );
}

fn storeChunkBounds(chunk : u32, chunks : u32, v : ChunkBounds) {
  let o = chunkBoundsAt(chunk, chunks);
  scratch[o] = bitcast<u32>(v.lo.x);
  scratch[o + 1u] = bitcast<u32>(v.lo.y);
  scratch[o + 2u] = bitcast<u32>(v.hi.x);
  scratch[o + 3u] = bitcast<u32>(v.hi.y);
  scratch[o + 4u] = bitcast<u32>(v.maxSize);
  scratch[o + 5u] = v.flags;
}

// Label candidates, last step: fill in each record's USER index (word 1) from
// its engine / sorted index (word 0) through `table` (the node `order`, or the
// edge order kept by EDGE_SORT). Label text is indexed by the user's order.
// Standalone module: no engine bindings.

@group(0) @binding(0) var<storage, read_write> candidates : array<u32>;
@group(0) @binding(1) var<storage, read> table : array<u32>;
/** x: capacity of `candidates` in records. */
@group(0) @binding(2) var<uniform> params : vec4<u32>;

/** Words before the records, and per record: LABEL_HEADER_WORDS, LabelRecord / 4. */
const HEADER_WORDS : u32 = 4u;
const RECORD_WORDS : u32 = 8u;

@compute @workgroup_size(256)
fn label_map(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= min(candidates[0], params.x)) {
    return;
  }
  let o = HEADER_WORDS + i * RECORD_WORDS;
  candidates[o + 1u] = table[candidates[o]];
}

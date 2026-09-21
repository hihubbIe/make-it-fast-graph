// Z-order (Morton) codes, shared by the node and edge sorts.

/** Interleave the low 16 bits of `v` with zeros: bit k moves to bit 2k. */
fn spread16(v : u32) -> u32 {
  var x = v & 0xFFFFu;
  x = (x | (x << 8u)) & 0x00FF00FFu;
  x = (x | (x << 4u)) & 0x0F0F0F0Fu;
  x = (x | (x << 2u)) & 0x33333333u;
  x = (x | (x << 1u)) & 0x55555555u;
  return x;
}

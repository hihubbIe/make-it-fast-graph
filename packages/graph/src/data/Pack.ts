/** CPU-side packing helpers matching the GPU layouts in `Layouts.ts`. */

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** IEEE-754 binary16 bits for `v`, round-to-nearest-even. */
export function toHalfBits(v: number): number {
  f32[0] = v;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const abs = x & 0x7fffffff;
  if (abs >= 0x7f800000) return sign | 0x7c00 | (abs > 0x7f800000 ? 0x200 : 0); // inf / nan
  const exp = (abs >>> 23) - 112;
  if (exp >= 31) return sign | 0x7c00; // overflow -> inf
  const mant = abs & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign; // underflow -> 0
    const m = (mant | 0x800000) >>> (1 - exp);
    return sign | ((m + 0xfff + ((m >>> 13) & 1)) >>> 13);
  }
  // `+` (not `|`) so a rounding carry propagates into the exponent.
  return sign | ((exp << 10) + ((mant + 0xfff + ((mant >>> 13) & 1)) >>> 13));
}

type Float16ArrayCtor = new (buffer: ArrayBufferLike, byteOffset?: number, length?: number) => { [i: number]: number };
const Float16 = (globalThis as { Float16Array?: Float16ArrayCtor }).Float16Array;

/**
 * Pack diameters into the `nodeSize` layout: low half = size (f16), high half =
 * ringWidth (f16, 0). Uses native `Float16Array` when available.
 */
export function packNodeSizes(sizes: Float32Array, out: Uint32Array): Uint32Array {
  const n = out.length;
  if (Float16) {
    const h = new Float16(out.buffer, out.byteOffset, n * 2);
    for (let i = 0; i < n; i++) {
      h[i * 2] = sizes[i]!;
      h[i * 2 + 1] = 0;
    }
  } else {
    for (let i = 0; i < n; i++) out[i] = toHalfBits(sizes[i]!);
  }
  return out;
}

/** Pack normalized RGBA [0..1] into an rgba8unorm word (little-endian: R in low byte). */
export function packRgba(r: number, g: number, b: number, a = 1): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (c(r) | (c(g) << 8) | (c(b) << 16) | (c(a) << 24)) >>> 0;
}

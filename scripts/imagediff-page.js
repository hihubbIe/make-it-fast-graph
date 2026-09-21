/**
 * Page-side half of `gpu.mjs imagediff` — DEVELOPMENT TOOL.
 *
 * Runs in a blank served page because that is where PNG decoding and canvas
 * pixel access exist without adding a dependency. Reads `globalThis.__diffInput`
 * ({ refUrl, testUrl }) and returns metrics plus base64 PNGs to write to disk.
 *
 * Aggregate means hid the artifact the owner could see, so this also reports:
 *   worstBlock  - the single worst 32 px block and WHERE it is, not just p95
 *   latticeScore- 2-D autocorrelation peak. One dot per equal-count cell is a
 *                 jittered lattice and peaks; irregular scatter does not.
 *   crops       - the densest region of each image, to look at directly
 */
const { refUrl, testUrl } = globalThis.__diffInput;
const BLOCK = 32;
const CROP_W = 640;
const CROP_H = 420;

async function load(url) {
  const im = await createImageBitmap(await (await fetch(url)).blob());
  const c = new OffscreenCanvas(im.width, im.height);
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(im, 0, 0);
  return { data: x.getImageData(0, 0, im.width, im.height).data, w: im.width, h: im.height, bitmap: im };
}

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
const sat = (d, i) => {
  const mx = Math.max(d[i], d[i + 1], d[i + 2]);
  const mn = Math.min(d[i], d[i + 1], d[i + 2]);
  return mx === 0 ? 0 : (mx - mn) / mx;
};

async function toBase64(canvas) {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Lattice detector: 2-D normalised autocorrelation of the luminance field over
 * a patch, for every (dx, dy) up to LATTICE_LAG.
 *
 * A 1-D row autocorrelation was tried first and gave a confidently WRONG answer:
 * it scored the artifact-free reference as MORE periodic than an image with an
 * obvious woven pattern, because fine dense noise self-correlates at short lags
 * whatever its structure. A regular arrangement of dots peaks at its lattice
 * vector in 2-D at ANY orientation; irregular scatter does not peak at all.
 */
const LATTICE_LAG = 20;
const LATTICE_PATCH = 160;

function latticeScore(img, px, py) {
  const { data, w, h } = img;
  const pw = Math.min(LATTICE_PATCH, w);
  const ph = Math.min(LATTICE_PATCH, h);
  const x0 = Math.min(Math.max(px - pw / 2, 0), w - pw);
  const y0 = Math.min(Math.max(py - ph / 2, 0), h - ph);
  const raw = new Float64Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) raw[y * pw + x] = lum(data, ((y0 + y) * w + (x0 + x)) * 4);
  }

  // High-pass first. Subtracting a local mean removes the smooth density
  // gradient, which otherwise correlates at EVERY small lag and swamps the
  // measurement — a plain autocorrelation scored the smooth reference higher
  // than a visibly woven image twice over. Only repeating structure survives.
  const R = 8;
  const blur = new Float64Array(pw * ph);
  const tmp = new Float64Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      let s = 0;
      let c = 0;
      for (let k = -R; k <= R; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < pw) {
          s += raw[y * pw + xx];
          c++;
        }
      }
      tmp[y * pw + x] = s / c;
    }
  }
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      let s = 0;
      let c = 0;
      for (let k = -R; k <= R; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < ph) {
          s += tmp[yy * pw + x];
          c++;
        }
      }
      blur[y * pw + x] = s / c;
    }
  }

  const f = new Float64Array(pw * ph);
  let mean = 0;
  for (let i = 0; i < f.length; i++) {
    f[i] = raw[i] - blur[i];
    mean += f[i];
  }
  mean /= f.length;
  let zero = 0;
  for (let i = 0; i < f.length; i++) {
    f[i] -= mean;
    zero += f[i] * f[i];
  }
  if (zero < 1e-9) return { peak: 0, vector: [0, 0] };
  const norm = (pw * ph) / zero;

  let best = 0;
  let bestV = [0, 0];
  for (let dy = 0; dy <= LATTICE_LAG; dy++) {
    for (let dx = -LATTICE_LAG; dx <= LATTICE_LAG; dx++) {
      if (dx * dx + dy * dy < 4) continue; // skip the trivial self-correlation core
      let s = 0;
      let cnt = 0;
      for (let y = 0; y + dy < ph; y++) {
        const yr = y * pw;
        const yo = (y + dy) * pw;
        for (let x = Math.max(0, -dx); x < pw && x + dx < pw; x++) {
          s += f[yr + x] * f[yo + x + dx];
          cnt++;
        }
      }
      if (cnt === 0) continue;
      const v = (s / cnt) * norm;
      if (v > best) {
        best = v;
        bestV = [dx, dy];
      }
    }
  }
  return { peak: +best.toFixed(4), vector: bestV };
}

const A = await load(refUrl);
const B = await load(testUrl);
if (A.w !== B.w || A.h !== B.h) throw new Error(`size mismatch ${A.w}x${A.h} vs ${B.w}x${B.h}`);

const bw = Math.ceil(A.w / BLOCK);
const bh = Math.ceil(A.h / BLOCK);
const blkA = new Float64Array(bw * bh);
const blkB = new Float64Array(bw * bh);
let absErr = 0;
let inkA = 0;
let inkB = 0;
let satA = 0;
let satB = 0;
const n = A.w * A.h;

for (let y = 0; y < A.h; y++) {
  for (let x = 0; x < A.w; x++) {
    const i = (y * A.w + x) * 4;
    absErr += Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]);
    const la = lum(A.data, i);
    const lb = lum(B.data, i);
    inkA += la;
    inkB += lb;
    satA += sat(A.data, i);
    satB += sat(B.data, i);
    const b = Math.floor(y / BLOCK) * bw + Math.floor(x / BLOCK);
    blkA[b] += la;
    blkB[b] += lb;
  }
}

// Worst block by relative density error, and the densest block (for the crop).
const rel = [];
let worst = { err: 0, bx: 0, by: 0, ref: 0, test: 0 };
let densest = { ink: -1, bx: 0, by: 0 };
for (let b = 0; b < blkA.length; b++) {
  if (blkA[b] > blkA.length * 0.0) {
    if (blkA[b] > densest.ink) densest = { ink: blkA[b], bx: b % bw, by: Math.floor(b / bw) };
  }
  if (blkA[b] > 1e-6) {
    const e = Math.abs(blkB[b] - blkA[b]) / blkA[b];
    rel.push(e);
    if (e > worst.err) worst = { err: e, bx: b % bw, by: Math.floor(b / bw), ref: blkA[b], test: blkB[b] };
  }
}
rel.sort((p, q) => p - q);

// Crop both images around the densest region, plus an amplified difference.
const cx = Math.min(Math.max(densest.bx * BLOCK - CROP_W / 2, 0), A.w - CROP_W);
const cy = Math.min(Math.max(densest.by * BLOCK - CROP_H / 2, 0), A.h - CROP_H);
const crop = async (img) => {
  const c = new OffscreenCanvas(CROP_W, CROP_H);
  c.getContext("2d").drawImage(img.bitmap, cx, cy, CROP_W, CROP_H, 0, 0, CROP_W, CROP_H);
  return toBase64(c);
};

const AMP = 8;
const dc = new OffscreenCanvas(A.w, A.h);
const dctx = dc.getContext("2d");
const out = dctx.createImageData(A.w, A.h);
for (let i = 0; i < n; i++) {
  const j = i * 4;
  out.data[j] = Math.min(255, Math.abs(A.data[j] - B.data[j]) * AMP);
  out.data[j + 1] = Math.min(255, Math.abs(A.data[j + 1] - B.data[j + 1]) * AMP);
  out.data[j + 2] = Math.min(255, Math.abs(A.data[j + 2] - B.data[j + 2]) * AMP);
  out.data[j + 3] = 255;
}
dctx.putImageData(out, 0, 0);

return {
  meanAbsError: +(absErr / (n * 3)).toFixed(2),
  inkRef: +(inkA / n).toFixed(3),
  inkTest: +(inkB / n).toFixed(3),
  inkError: +((inkB - inkA) / Math.max(inkA, 1e-6)).toFixed(4),
  satRef: +(satA / n).toFixed(4),
  satTest: +(satB / n).toFixed(4),
  satError: +((satB - satA) / Math.max(satA, 1e-6)).toFixed(4),
  blockP50: +(rel[Math.floor(rel.length * 0.5)] ?? NaN).toFixed(4),
  blockP95: +(rel[Math.floor(rel.length * 0.95)] ?? NaN).toFixed(4),
  worstBlock: { relError: +worst.err.toFixed(3), atPx: [worst.bx * BLOCK, worst.by * BLOCK] },
  latticeRef: latticeScore(A, densest.bx * BLOCK, densest.by * BLOCK),
  latticeTest: latticeScore(B, densest.bx * BLOCK, densest.by * BLOCK),
  cropAtPx: [cx, cy],
  images: { cropRef: await crop(A), cropTest: await crop(B), diffAmplified: await toBase64(dc) },
};

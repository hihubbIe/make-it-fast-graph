/**
 * Headless GPU runner — DEVELOPMENT TOOL, not part of the shipped package.
 *
 * Headless Edge (`--headless=new`) reaches the real GPU, so benchmarks and the
 * GPU correctness suite can run unattended and repeatably. Everything here is
 * built on Node's own primitives (http, child_process, global WebSocket): the
 * engine has no runtime deps and this script adds none.
 *
 * Why it serves a STATIC Storybook build instead of the dev server: the dev
 * server rebuilds and reloads the page on any source change, which kills a
 * running benchmark mid-flight (HANDOVER "how to verify"). A static build is
 * frozen for the duration of the run, so a measurement always describes one
 * known state of the code.
 *
 *   node scripts/gpu.mjs bench [--cases small,xlarge] [--out <file>]
 *   node scripts/gpu.mjs correctness [--count 2000000]
 *   node scripts/gpu.mjs eval <file.js>      # page-context script, for microbenchmarks
 *   node scripts/gpu.mjs shot --story <id> --file out.png   # screenshot any story
 *   node scripts/gpu.mjs shot --story <id> --setup "<js>" --file out.png
 *
 *   --url <u>        use an already-running server (skips build + serve)
 *   --no-build       serve the existing static build as-is
 *   --window WxH     canvas size, DPR 1 (default 2418x1112, the owner's viewport)
 *   --timeout <s>    per-evaluation timeout (default 900)
 *   --verbose        forward page console output
 *
 * Results are printed as JSON on stdout; everything else goes to stderr, so
 * `node scripts/gpu.mjs bench > run.json` yields a clean report.
 */
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_DIR = join(ROOT, "apps/storybook/storybook-static");

/** Owner's real viewport (HANDOVER "Owner's GPU & key numbers"), so headless numbers stay comparable. */
const DEFAULT_WINDOW = "2418x1112";

const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

const STORY = {
  bench: "developer-benchmark--benchmark",
  correctness: "developer-gpu-correctness--gpu-correctness",
};

/** Engine-free page served by the runner itself (microbenchmarks). */
const BLANK_PATH = "/__blank";
/** Screenshots captured this run, served back for in-page pixel comparison. */
const SHOT_PREFIX = "/__shot/";
const shots = new Map();

// ---- tiny arg parsing -------------------------------------------------------

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      opts._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (key.startsWith("no-")) {
      opts[key.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) opts[key] = true;
    else {
      opts[key] = next;
      i++;
    }
  }
  return opts;
}

const log = (...a) => console.error(...a);

// ---- static file server (COOP/COEP, so SharedArrayBuffer is available) -------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wgsl": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve `dir` with cross-origin isolation headers. Storybook's dev server sets
 * these via `core.crossOriginIsolated`; a static build has no server, so they
 * must be set here or the engine silently loses the SharedArrayBuffer input
 * ring and we would measure the postMessage fallback instead.
 */
function serveStatic(dir, shots) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    // Empty page for microbenchmarks: a standalone WebGPU device with no engine
    // running beside it, so nothing else contends for the GPU while measuring.
    if (path.startsWith(SHOT_PREFIX)) {
      const buf = shots.get(path.slice(SHOT_PREFIX.length));
      if (!buf) {
        res.writeHead(404).end("no such shot");
        return;
      }
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(buf);
      return;
    }
    if (path === BLANK_PATH) {
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      res.end("<!doctype html><meta charset=utf-8><title>blank</title>");
      return;
    }
    let file = join(dir, path === "/" ? "/index.html" : path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file) || !file.startsWith(dir)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      ok({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// ---- headless Edge + CDP ----------------------------------------------------

function findEdge() {
  const found = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error(`Edge not found. Looked in:\n  ${EDGE_CANDIDATES.join("\n  ")}`);
  return found;
}

function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

async function launchEdge(windowSize) {
  const profile = mkdtempSync(join(tmpdir(), "graph-edge-"));
  const child = spawn(
    findEdge(),
    [
      "--headless=new",
      // Port 0 = let the OS pick. A fixed port made back-to-back launches talk
      // to the previous, still-dying browser; Chromium writes the real port to
      // DevToolsActivePort in the profile directory.
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--enable-unsafe-webgpu",
      "--enable-webgpu-developer-features", // un-quantizes timestamp queries
      "--disable-gpu-vsync",
      "--disable-frame-rate-limit",
      `--window-size=${windowSize.replace("x", ",")}`,
      "--force-device-scale-factor=1",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const stop = async () => {
    killTree(child);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* the profile dir is in temp; leaking it on Windows file locks is harmless */
    }
  };
  // Wait for the debugging endpoint and learn which port it actually took.
  const portFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;
  let port = 0;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Edge exited with code ${child.exitCode}`);
    if (!port && existsSync(portFile)) {
      const first = readFileSync(portFile, "utf8").split(String.fromCharCode(10))[0].trim();
      if (first) port = Number(first);
    }
    if (port) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (r.ok) break;
      } catch {
        /* not listening yet */
      }
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error("Edge did not open its debugging port within 30 s");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { stop, port };
}

/** Minimal CDP client over one target's WebSocket. */
class Cdp {
  #ws;
  #next = 1;
  #pending = new Map();

  static async openPage(port, url, { verbose }) {
    // Chromium ≥ 111 requires PUT for /json/new.
    const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    if (!r.ok) throw new Error(`/json/new failed: ${r.status} ${await r.text()}`);
    const target = await r.json();
    const cdp = new Cdp();
    await cdp.#connect(target.webSocketDebuggerUrl, verbose);
    return cdp;
  }

  #connect(wsUrl, verbose) {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(wsUrl);
      this.#ws = ws;
      ws.addEventListener("open", () => ok());
      ws.addEventListener("error", () => fail(new Error(`CDP websocket failed: ${wsUrl}`)));
      ws.addEventListener("close", () => {
        for (const { fail: f } of this.#pending.values()) f(new Error("CDP connection closed"));
        this.#pending.clear();
      });
      ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== undefined) {
          const p = this.#pending.get(msg.id);
          if (!p) return;
          this.#pending.delete(msg.id);
          if (msg.error) p.fail(new Error(`${msg.error.message} (${msg.error.code})`));
          else p.ok(msg.result);
          return;
        }
        if (msg.method === "Runtime.exceptionThrown") {
          const d = msg.params.exceptionDetails;
          log(`  page exception: ${d.exception?.description ?? d.text}`);
        } else if (verbose && msg.method === "Runtime.consoleAPICalled") {
          log(`  page ${msg.params.type}:`, msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
        }
      });
    });
  }

  send(method, params = {}) {
    const id = this.#next++;
    return new Promise((ok, fail) => {
      this.#pending.set(id, { ok, fail });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate `expression` in the page; async expressions are awaited. */
  async evaluate(expression, timeoutSec) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutSec * 1000,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page threw: ${d.exception?.description ?? d.text}`);
    }
    return r.result.value;
  }

  /**
   * Wait until the page has a JS execution context. A freshly opened target can
   * accept CDP commands before one exists, and Runtime.evaluate then fails with
   * "Cannot find default execution context" (-32000).
   */
  async waitForContext(timeoutSec) {
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
      try {
        await this.send("Runtime.evaluate", { expression: "1", returnByValue: true });
        return;
      } catch (e) {
        if (Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  /** Poll `expression` until it is truthy. Returns its value. */
  async waitFor(expression, what, timeoutSec) {
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
      const v = await this.evaluate(`(() => { try { return ${expression}; } catch { return false; } })()`, 30);
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      /* already closed */
    }
  }
}

// ---- session ----------------------------------------------------------------

/**
 * Newest mtime under `dir`, or 0. Used to detect a static build that predates
 * the library it is supposed to contain.
 */
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const m = statSync(full).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  walk(dir);
  return newest;
}

/**
 * Storybook bundles the BUILT library, so skipping the build after touching
 * packages/graph silently measures old code. This bit me: two runs came back
 * byte-identical and I read it as "my change did nothing".
 */
function staticBuildIsStale() {
  const dist = newestMtime(join(ROOT, "packages/graph/dist"));
  const site = newestMtime(STATIC_DIR);
  return site === 0 || dist > site;
}

function buildStorybook() {
  log("Building Storybook (static, frozen for the run)…");
  const r = spawnSync("npm", ["run", "storybook:build"], { cwd: ROOT, stdio: "inherit", shell: true });
  if (r.status !== 0) throw new Error("Storybook build failed");
}

/**
 * Boot everything, open `path` on the served origin, hand the page to `body`,
 * then tear down. One page at a time by construction: two concurrent story
 * runs would drive the same camera (see Correctness.stories.ts).
 */
/**
 * Sweep profile directories left by earlier runs. Windows file locks make the
 * teardown delete fail often enough that they accumulate in the hundreds.
 */
function sweepProfiles() {
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith("graph-edge-")) continue;
      try {
        rmSync(join(tmpdir(), name), { recursive: true, force: true });
      } catch {
        /* still locked by a live browser */
      }
    }
  } catch {
    /* temp unreadable; nothing to sweep */
  }
}

/**
 * Open the page and run `body`, retrying with a fresh browser on a STARTUP
 * failure. Opening occasionally lands on an error document, which reports
 * crossOriginIsolated === false and would otherwise fail a whole measurement.
 * Failures from `body` itself are real results and are never retried.
 */
async function withPage(path, opts, body) {
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await withPageOnce(path, opts, body);
    } catch (e) {
      const startup = /cross-origin isolated|execution context|navigator\.gpu|debugging port|CDP/i.test(String(e));
      if (!startup || attempt >= attempts) throw e;
      log("  browser startup failed, retrying (" + attempt + "/" + (attempts - 1) + "): " + String(e).slice(0, 70));
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function withPageOnce(path, opts, body) {
  const timeout = Number(opts.timeout ?? 900);
  let base = opts.url;
  let server = null;
  if (!base) {
    if (opts.build === false && staticBuildIsStale()) {
      log("--no-build ignored: packages/graph/dist is newer than the static build.");
      opts = { ...opts, build: true };
    }
    if (opts.build !== false) buildStorybook();
    if (!existsSync(STATIC_DIR)) throw new Error(`No static build at ${STATIC_DIR}. Drop --no-build.`);
    server = await serveStatic(STATIC_DIR, shots);
    base = server.url;
  }
  sweepProfiles();
  const edge = await launchEdge(String(opts.window ?? DEFAULT_WINDOW));
  let cdp = null;
  try {
    const url = base + path;
    log(`Opening ${url}`);
    cdp = await Cdp.openPage(edge.port, url, { verbose: !!opts.verbose });
    await cdp.send("Runtime.enable");
    await cdp.waitForContext(60);
    await cdp.waitFor(`document.readyState === "complete"`, "page load", 120);

    // Guard the two ways a run can silently measure the wrong thing.
    const isolated = await cdp.evaluate("globalThis.crossOriginIsolated === true", 30);
    if (!isolated) throw new Error("page is not cross-origin isolated: SharedArrayBuffer input ring would be disabled");
    const gpu = await cdp.evaluate(`!!navigator.gpu`, 30);
    if (!gpu) throw new Error("navigator.gpu missing in headless Edge");

    return await body(cdp, timeout);
  } finally {
    cdp?.close();
    await edge.stop();
    await server?.close();
  }
}

// ---- commands ---------------------------------------------------------------

const storyPath = (id, args) => `/iframe.html?id=${id}&viewMode=story` + (args ? `&args=${encodeURIComponent(args)}` : "");

/**
 * Screenshot one story. The canvas belongs to the render worker, so the pixels
 * can only be read over CDP, never from page script.
 *
 *   node scripts/gpu.mjs shot --story <id> [--args "a:1;b:2"] [--file shot.png] [--settle 2500]
 */
async function cmdShot(opts) {
  const id = typeof opts.story === "string" ? opts.story : null;
  if (!id) throw new Error("usage: node scripts/gpu.mjs shot --story <id> [--args ...] [--file shot.png]");
  const settle = Number(opts.settle ?? 2500);
  // NOT --out: that is the runner-wide flag for the JSON result, and it would
  // overwrite the PNG with the report.
  const file = resolve(typeof opts.file === "string" ? opts.file : "shot.png");
  return withPage(storyPath(id, typeof opts.args === "string" ? opts.args : null), opts, async (cdp) => {
    await cdp.waitFor("!!globalThis.__graphStage", "__graphStage hook", 180);
    const err = await cdp.evaluate(
      `(async () => { const s = globalThis.__graphStage; const g = await s.ready; return g ? (s.errors[0] ?? null) : (s.errors[0] ?? "engine did not start"); })()`,
      180,
    );
    if (err) throw new Error(`story reported: ${err}`);
    // Optional page-context setup, so a story can be captured in a configured
    // state that its args cannot reach (Storybook URL args do not arrive —
    // docs/decisions.md 0028).
    if (typeof opts.setup === "string" && opts.setup) {
      await cdp.evaluate(`(async () => { ${opts.setup} })()`, 180);
    }
    await new Promise((r) => setTimeout(r, settle));
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    return { story: id, file, bytes: Buffer.from(shot.data, "base64").length };
  });
}

async function cmdBench(opts) {
  const cases = typeof opts.cases === "string" ? opts.cases.split(",").map((s) => s.trim()).filter(Boolean) : null;
  return withPage(storyPath(STORY.bench, typeof opts.args === "string" ? opts.args : null), opts, async (cdp, timeout) => {
    await cdp.waitFor("!!globalThis.__graphBench", "__graphBench hook", 180);
    const caps = await cdp.evaluate("JSON.stringify(globalThis.__graphBench.graph.caps)", 30);
    log(`Adapter: ${JSON.parse(caps).adapter}`);
    const selector = cases
      ? `globalThis.__graphBench.suite.filter(c => ${JSON.stringify(cases)}.includes(c.name))`
      : `undefined`;
    log(`Running ${cases ? cases.join(", ") : "full suite"}…`);
    return cdp.evaluate(`globalThis.__graphBench.run(${selector})`, timeout);
  });
}

async function cmdCorrectness(opts) {
  return withPage(storyPath(STORY.correctness), opts, async (cdp, timeout) => {
    await cdp.waitFor("!!globalThis.__graphCorrectness", "__graphCorrectness hook", 180);
    return cdp.evaluate("globalThis.__graphCorrectness.result", timeout);
  });
}

/**
 * Run an arbitrary page-context script; its returned value is the result.
 * Defaults to the engine-free blank page so a microbenchmark has the GPU to
 * itself; `--story <id>` runs it inside a story instead.
 */
async function cmdEval(opts) {
  const file = opts._[1];
  if (!file) throw new Error("usage: node scripts/gpu.mjs eval <file.js> [--story <id>]");
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(resolve(file), "utf8");
  const path = typeof opts.story === "string" ? storyPath(opts.story) : BLANK_PATH;
  return withPage(path, opts, (cdp, timeout) => cdp.evaluate(`(async () => {\n${source}\n})()`, timeout));
}

/**
 * Image diff: render the SAME views with LOD off (ground truth) and on, then
 * compare pixels. Screenshots are captured over CDP because the canvas is an
 * OffscreenCanvas owned by the worker, and compared inside a page because that
 * is where PNG decoding exists without adding a dependency.
 *
 * The metrics are chosen for the failure modes LOD actually has, not for a
 * generic PSNR number:
 *   inkError   - is total luminance preserved? (density lost or invented)
 *   satError   - is colour preserved? (averaging many hues greys them out)
 *   blockP95   - worst local 32px-block density error (structure lost anywhere)
 */
async function captureViews(cdp, views, count, tag) {
  await cdp.waitFor("!!globalThis.__graphBench", "__graphBench hook", 180);
  await cdp.waitFor(`globalThis.__graphBench.graph.readStats().nodeCount >= ${count}`, "dataset", 600);
  const meta = [];
  for (const v of views) {
    const visible = await cdp.evaluate(
      `(async () => {
         const g = globalThis.__graphBench.graph;
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         g.camera.fit();
         await sleep(500);
         const c = g.camera.getView();
         g.camera.setView({ x: c.x, y: c.y, zoom: c.zoom * ${v.zoom}, rotation: 0 });
         await sleep(700);
         return g.readStats().visibleNodes;
       })()`,
      120,
    );
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    shots.set(`${tag}-${v.name}.png`, Buffer.from(shot.data, "base64"));
    meta.push({ view: v.name, visible });
    log(`  ${tag} ${v.name}: ${visible.toLocaleString()} drawn`);
  }
  return meta;
}

async function cmdImageDiff(opts) {
  const count = Number(opts.count ?? 10_000_000);
  const target = String(opts.lod ?? "2");
  const saveDir = typeof opts.save === "string" ? resolve(opts.save) : null;
  const views = String(opts.views ?? "fit,z2,z8")
    .split(",")
    .map((name) => ({ name, zoom: name === "fit" ? 1 : Number(name.replace(/^z/, "")) }));
  const args = (lod) => `lodTargetPx:${lod};count:${count};dataset:clustered;path:standard`;
  const pageScript = readFileSync(join(ROOT, "scripts/imagediff-page.js"), "utf8");

  log("Reference pass (LOD off)...");
  const refMeta = await withPage(storyPath(STORY.bench, args(0)), opts, (cdp) => captureViews(cdp, views, count, "ref"));
  log(`Test pass (lodTargetPx=${target})...`);
  const testMeta = await withPage(storyPath(STORY.bench, args(target)), { ...opts, build: false }, (cdp) =>
    captureViews(cdp, views, count, "test"),
  );

  log("Comparing...");
  return withPage(BLANK_PATH, { ...opts, build: false }, async (cdp, timeout) => {
    const out = [];
    for (let i = 0; i < views.length; i++) {
      const v = views[i].name;
      await cdp.evaluate(
        `globalThis.__diffInput = { refUrl: "${SHOT_PREFIX}ref-${v}.png", testUrl: "${SHOT_PREFIX}test-${v}.png" };`,
        30,
      );
      const m = await cdp.evaluate(`(async () => {
${pageScript}
})()`, timeout);
      const images = m.images;
      delete m.images;
      if (saveDir) {
        mkdirSync(saveDir, { recursive: true });
        for (const [name, b64] of Object.entries(images)) {
          writeFileSync(join(saveDir, `${v}-${name}.png`), Buffer.from(b64, "base64"));
        }
        for (const tag of ["ref", "test"]) {
          writeFileSync(join(saveDir, `${v}-${tag}-full.png`), shots.get(`${tag}-${v}.png`));
        }
      }
      out.push({ view: v, drawnRef: refMeta[i].visible, drawnTest: testMeta[i].visible, ...m });
    }
    if (saveDir) log(`Wrote images to ${saveDir}`);
    return { count, lodTargetPx: Number(target), views: out };
  });
}

/**
 * Input -> frame latency. `graph.benchmark` drives the camera itself and never
 * touches the input ring, so it cannot see this: it reports a steady 60 fps for
 * a path that feels choppy by hand. Here real wheel/drag events are dispatched
 * through CDP, so they travel the production path (DOM -> PointerInput -> ring
 * -> worker), and the page times how long each one waits for a frame.
 */
async function cmdInput(opts) {
  const count = Number(opts.count ?? 10_000_000);
  const zoom = Number(opts.zoom ?? 70);
  const rateHz = Number(opts.rate ?? 30);
  const seconds = Number(opts.seconds ?? 3);
  const probe = readFileSync(join(ROOT, "scripts/input-probe.js"), "utf8");
  const args = `lodTargetPx:2;count:${count};dataset:clustered;path:standard`;

  return withPage(storyPath(STORY.bench, args), opts, async (cdp, timeout) => {
    await cdp.waitFor("!!globalThis.__graphBench", "__graphBench hook", 180);
    await cdp.waitFor(`globalThis.__graphBench.graph.readStats().nodeCount >= ${count}`, "dataset", 600);

    // Deep zoom: the view the owner reports as choppy by hand.
    await cdp.evaluate(
      `(async () => {
         const g = globalThis.__graphBench.graph;
         g.camera.fit();
         await new Promise((r) => setTimeout(r, 600));
         const c = g.camera.getView();
         g.camera.setView({ x: c.x, y: c.y, zoom: c.zoom * ${zoom}, rotation: 0 });
         await new Promise((r) => setTimeout(r, 600));
         return g.readStats().visibleNodes;
       })()`,
      120,
    );
    await cdp.evaluate(`(async () => {\n${probe}\n})()`, 60);

    const view = await cdp.evaluate(
      "JSON.stringify([globalThis.__graphBench.graph.readStats().viewportWidth, globalThis.__graphBench.graph.readStats().viewportHeight])",
      30,
    );
    const [w, h] = JSON.parse(view);
    const cx = Math.round(w / 2);
    const cy = Math.round(h / 2);
    const out = {};

    // --- wheel zoom at a fixed rate -------------------------------------
    await cdp.evaluate("globalThis.__inputProbe.arm()", 30);
    const gap = 1000 / rateHz;
    const total = Math.round(rateHz * seconds);
    for (let i = 0; i < total; i++) {
      const t0 = Date.now();
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: cx,
        y: cy,
        deltaX: 0,
        deltaY: i % 2 === 0 ? -100 : 100,
        pointerType: "mouse",
      });
      const wait = gap - (Date.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    await new Promise((r) => setTimeout(r, 400));
    await cdp.evaluate("globalThis.__inputProbe.disarm()", 30);
    out.wheel = await cdp.evaluate("globalThis.__inputProbe.result()", 60);

    // --- drag: continuous pointer motion ---------------------------------
    await cdp.evaluate("globalThis.__inputProbe.arm()", 30);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
    for (let i = 0; i < total; i++) {
      const t0 = Date.now();
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: cx + Math.round(Math.sin(i / 6) * 120),
        y: cy + Math.round(Math.cos(i / 6) * 80),
        button: "left",
        buttons: 1,
        pointerType: "mouse",
      });
      const wait = gap - (Date.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
    await new Promise((r) => setTimeout(r, 400));
    await cdp.evaluate("globalThis.__inputProbe.disarm()", 30);
    out.drag = await cdp.evaluate("globalThis.__inputProbe.result()", 60);

    return { count, zoom, rateHz, seconds, viewport: [w, h], ...out };
  });
}

// ---- main -------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const command = opts._[0];
const commands = { bench: cmdBench, correctness: cmdCorrectness, eval: cmdEval, imagediff: cmdImageDiff, input: cmdInput, shot: cmdShot };

if (!commands[command]) {
  log("usage: node scripts/gpu.mjs <bench|correctness|eval|imagediff|input|shot> [options]  (see header)");
  process.exit(1);
}

try {
  const t0 = Date.now();
  const result = await commands[command](opts);
  log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const json = JSON.stringify(result, null, 2);
  if (typeof opts.out === "string") {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(resolve(opts.out), json);
    log(`Wrote ${opts.out}`);
  } else {
    process.stdout.write(json + "\n");
  }
  process.exit(0);
} catch (e) {
  log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

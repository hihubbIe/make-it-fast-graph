/**
 * Render worker entry. Pure message dispatch — all logic lives in Engine.
 */
import { GraphError } from "../api/errors";
import { Engine } from "../engine/Engine";
import { InputRing, type InputRecord } from "./InputRing";
import type { FromWorker, ToWorker } from "./protocol";
import { createStateBuffer } from "./SharedState";

interface WorkerScope {
  postMessage(msg: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
  requestAnimationFrame?: (cb: (t: number) => void) => number;
  navigator: { gpu?: GPU };
  close(): void;
}

const scope = self as unknown as WorkerScope;
const post = (msg: FromWorker, transfer?: Transferable[]) => scope.postMessage(msg, transfer);

/** OffscreenCanvas workers get rAF in Chromium and Firefox; fall back to a timer elsewhere. */
const requestFrame: (cb: (t: number) => void) => void = scope.requestAnimationFrame
  ? (cb) => scope.requestAnimationFrame!(cb)
  : (cb) => setTimeout(() => cb(performance.now()), 16);

/** How often the non-shared state block is posted back (fallback path only). */
const STATE_POST_INTERVAL_MS = 200;

let engine: Engine | null = null;
let state: Float64Array | null = null;
let stateShared = false;
let stateTimer: ReturnType<typeof setInterval> | undefined;
const pending: ToWorker[] = [];
const fallbackRec: InputRecord = { type: 0, t: 0, x: 0, y: 0, dx: 0, dy: 0, buttons: 0, mods: 0 };

function fail(e: unknown, fatal: boolean): void {
  const err = e instanceof GraphError ? e : new GraphError("internal", e instanceof Error ? e.message : String(e));
  post({ t: "error", code: err.code, message: err.message, fatal });
}

async function init(msg: Extract<ToWorker, { t: "init" }>): Promise<void> {
  stateShared = msg.state !== null;
  state = msg.state ? new Float64Array(msg.state) : createStateBuffer(false);
  try {
    engine = await Engine.create({
      canvas: msg.canvas,
      width: msg.width,
      height: msg.height,
      pixelRatio: msg.pixelRatio,
      ring: msg.ring ? new InputRing(msg.ring) : null,
      state,
      options: msg.options,
      gpu: scope.navigator.gpu,
      requestFrame,
      onError: fail,
      onBenchmark: (id, result, transfer) => post({ t: "benchmark", id, result }, transfer),
    });
  } catch (e) {
    fail(e, true);
    return;
  }
  if (!stateShared) startStatePosting();
  post({ t: "ready", caps: engine.caps });
  for (const m of pending.splice(0)) dispatch(m);
}

function startStatePosting(): void {
  let lastFrame = -1;
  stateTimer = setInterval(() => {
    if (!state || state[0] === lastFrame) return;
    lastFrame = state[0]!;
    post({ t: "state", data: state.slice() });
  }, STATE_POST_INTERVAL_MS);
}

function dispatch(msg: ToWorker): void {
  const e = engine!;
  switch (msg.t) {
    case "resize":
      return e.resize(msg.width, msg.height, msg.pixelRatio);
    case "wake":
      return e.wake();
    case "input": {
      const [type, t, x, y, dx, dy, buttons, mods] = msg.r;
      Object.assign(fallbackRec, { type, t, x, y, dx, dy, buttons, mods });
      e.input(fallbackRec);
      return e.wake();
    }
    case "nodes":
      return e.setNodes(msg.count, msg);
    case "edges":
      return e.setEdges(msg.count, msg);
    case "nodeLabels":
      return e.setNodeLabels(msg.labels);
    case "edgeLabels":
      return e.setEdgeLabels(msg.labels);
    case "updatePositions":
      return e.updatePositions(msg.start, msg.data);
    case "updateColor":
      return e.updateColor(msg.index, msg.rgba);
    case "view":
      return e.setView(msg.view);
    case "fit":
      return e.fit(msg.padding);
    case "background":
      return e.setBackground(msg.rgba);
    case "nodeScale":
      return e.setNodeScale(msg.value);
    case "render":
      return e.requestRender();
    case "benchmark":
      return e.benchmark(msg.id, msg.options);
    case "destroy":
      clearInterval(stateTimer);
      e.destroy();
      engine = null;
      post({ t: "destroyed" });
      scope.close();
      return;
    case "init":
      return; // handled before dispatch
  }
}

scope.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.t === "init") {
    void init(msg);
    return;
  }
  if (!engine) {
    pending.push(msg);
    return;
  }
  try {
    dispatch(msg);
  } catch (e) {
    fail(e, false);
  }
};

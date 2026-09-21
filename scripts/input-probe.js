/**
 * Page-side half of `gpu.mjs input` — DEVELOPMENT TOOL.
 *
 * Measures the input -> frame path, which no benchmark covers: `graph.benchmark`
 * drives the camera itself and never touches the input ring, so it reports a
 * steady 60 fps for a path that feels choppy by hand.
 *
 * Timing is entirely page-side so there is one clock. A passive wheel/pointer
 * listener on the canvas sees the same DOM event `PointerInput` does and stamps
 * it; a MessageChannel poll (not setTimeout, which Chrome clamps to ~4 ms)
 * watches `renderedFrames` in the shared state and stamps the frame that the
 * event produced. The difference is what the user actually waits.
 *
 * `globalThis.__inputProbe`:
 *   arm()      start recording, clear history
 *   result()   { latencies, frames, events, spans }
 */
const graph = globalThis.__graphBench.graph;
const canvas = document.querySelector("canvas");

const state = {
  armed: false,
  pending: [],
  latencies: [],
  frameTimes: [],
  events: 0,
  lastFrames: -1,
  polling: false,
};

/** Unclamped yield to the task queue; setTimeout(0) is throttled to ~4 ms. */
function soon(fn) {
  const ch = new MessageChannel();
  ch.port1.onmessage = () => fn();
  ch.port2.postMessage(0);
}

function poll() {
  if (!state.armed) {
    state.polling = false;
    return;
  }
  const frames = graph.readStats().renderedFrames;
  if (frames !== state.lastFrames) {
    const now = performance.now();
    state.lastFrames = frames;
    state.frameTimes.push(now);
    // Every input still waiting is answered by this frame.
    for (const t of state.pending) state.latencies.push(now - t);
    state.pending.length = 0;
  }
  soon(poll);
}

function onInput() {
  if (!state.armed) return;
  state.events++;
  state.pending.push(performance.now());
}

canvas.addEventListener("wheel", onInput, { passive: true });
canvas.addEventListener("pointermove", onInput, { passive: true });

globalThis.__inputProbe = {
  arm() {
    state.armed = true;
    state.pending.length = 0;
    state.latencies.length = 0;
    state.frameTimes.length = 0;
    state.events = 0;
    state.lastFrames = graph.readStats().renderedFrames;
    if (!state.polling) {
      state.polling = true;
      soon(poll);
    }
  },
  disarm() {
    state.armed = false;
  },
  result() {
    const iv = [];
    for (let i = 1; i < state.frameTimes.length; i++) iv.push(state.frameTimes[i] - state.frameTimes[i - 1]);
    return {
      events: state.events,
      frames: state.frameTimes.length,
      latencies: state.latencies.slice(),
      intervals: iv,
      spanMs: state.frameTimes.length > 1 ? state.frameTimes[state.frameTimes.length - 1] - state.frameTimes[0] : 0,
    };
  },
};
return true;

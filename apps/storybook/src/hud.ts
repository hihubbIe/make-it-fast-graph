/**
 * Minimal stats overlay. Reads the engine's shared stats block (no messages,
 * no allocation per read) 4× per second and writes one text node only when the
 * text changed. It never runs per frame, so it cannot perturb what it measures.
 */
import type { Graph, GraphStats } from "@vhult/graph";

const POLL_MS = 250;
/**
 * Page memory is measured by the browser after a garbage collection, which can
 * take seconds: ask rarely, show the last answer.
 */
const PAGE_MEMORY_MS = 10_000;
const fmt = (n: number) => n.toLocaleString("en-US");
const ms = (v: number) => (Number.isNaN(v) ? "—" : v < 10 ? v.toFixed(2) : v.toFixed(1));
const bytes = (v: number) => (!(v >= 0) ? "—" : v >= 2 ** 30 ? `${(v / 2 ** 30).toFixed(2)} GB` : `${(v / 2 ** 20).toFixed(0)} MB`);

/** Chromium-only, and only on a cross-origin isolated page (Storybook is). */
type MemoryMeasure = () => Promise<{ bytes: number }>;
const measurePageMemory = (performance as unknown as { measureUserAgentSpecificMemory?: MemoryMeasure }).measureUserAgentSpecificMemory;
/** GB of device RAM, rounded and capped at 8 by the browser. */
const deviceMemory = (navigator as unknown as { deviceMemory?: number }).deviceMemory;

export class Hud {
  private readonly el: HTMLElement;
  private readonly stats = {} as GraphStats;
  private graph: Graph | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastFrames = 0;
  private lastT = 0;
  private lastText = "";
  private note = "";
  private loadMs: number | null = null;
  private genMs: number | null = null;
  private pageBytes = NaN;
  private memoryTimer: ReturnType<typeof setInterval> | undefined;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "stage-hud";
    this.el.textContent = "starting…";
    parent.append(this.el);
  }

  attach(graph: Graph): void {
    this.graph = graph;
    this.lastT = performance.now();
    this.timer = setInterval(this.poll, POLL_MS);
    if (measurePageMemory && globalThis.crossOriginIsolated) {
      this.measureMemory();
      this.memoryTimer = setInterval(this.measureMemory, PAGE_MEMORY_MS);
    }
  }

  detach(): void {
    clearInterval(this.timer);
    clearInterval(this.memoryTimer);
    this.graph = null;
  }

  /** Free-form line shown under the stats (e.g. dataset name). */
  setNote(note: string): void {
    this.note = note;
  }

  error(e: Error): void {
    this.note = `error: ${e.message}`;
  }

  /**
   * Time from a bulk upload call to the first frame that includes it.
   * Watches the shared stats with rAF only until that frame lands.
   */
  measureLoad(graph: Graph, genMs: number, expectedNodes: number): void {
    this.genMs = genMs;
    this.loadMs = null;
    const t0 = performance.now();
    const startFrames = graph.readStats(this.stats).renderedFrames;
    const check = (): void => {
      if (this.graph !== graph) return;
      const st = graph.readStats(this.stats);
      if (st.renderedFrames > startFrames && st.nodeCount === expectedNodes) {
        this.loadMs = performance.now() - t0;
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }

  private readonly measureMemory = (): void => {
    measurePageMemory!.call(performance).then(
      (r) => (this.pageBytes = r.bytes),
      () => clearInterval(this.memoryTimer),
    );
  };

  private readonly poll = (): void => {
    const g = this.graph;
    if (!g) return;
    const s = g.readStats(this.stats);
    const now = performance.now();
    const frames = s.renderedFrames - this.lastFrames;
    const fps = (frames * 1000) / (now - this.lastT);
    this.lastFrames = s.renderedFrames;
    this.lastT = now;

    const passes = Object.entries(s.passMs)
      .filter(([, v]) => !Number.isNaN(v))
      .map(([k, v]) => `${k} ${ms(v)}`)
      .join(" · ");
    const gpu = g.caps.timestampQuery ? `${ms(s.gpuMs)} ms  ${passes ? `(${passes})` : ""}` : "n/a (no timestamp-query)";

    const lines = [
      `fps      ${frames === 0 ? "idle (0 GPU work)" : fps.toFixed(0)}`,
      `gpu      ${gpu}`,
      `worker   ${ms(s.cpuMsAvg)} ms cpu/frame`,
      `visible  ${Number.isNaN(s.visibleNodes) ? "—" : fmt(s.visibleNodes)} / ${fmt(s.nodeCount)} nodes`,
      `         ${s.edgeCount === 0 ? "no edges" : `${Number.isNaN(s.visibleEdges) ? "—" : fmt(s.visibleEdges)} / ${fmt(s.edgeCount)} edges`}`,
      `viewport ${s.viewportWidth}×${s.viewportHeight} px @${s.pixelRatio}x`,
      `memory   gpu ${bytes(s.gpuBytes)} (engine) · page ${bytes(this.pageBytes)}${deviceMemory ? ` · device ${deviceMemory >= 8 ? "≥8" : deviceMemory} GB` : ""}`,
      `load     ${this.loadMs === null ? "—" : `${this.loadMs.toFixed(0)} ms upload→frame`}${this.genMs ? ` (gen ${this.genMs.toFixed(0)} ms)` : ""}`,
      `adapter  ${g.caps.adapter}`,
      `shm      ${g.caps.sharedMemory ? "SharedArrayBuffer" : "postMessage fallback"}`,
      this.note,
    ];
    const text = lines.join("\n");
    if (text !== this.lastText) {
      this.el.textContent = text;
      this.lastText = text;
    }
  };
}

/**
 * Benchmark runner + panel for the Bench stories. All measurement happens in
 * the render worker (`graph.benchmark`); this module only loads data, starts
 * runs, summarizes the per-frame series and renders/downloads the report.
 */
import type { BenchmarkResult, Graph } from "@vhult/graph";
import { PATHS, summarize, type GeneratorName, type PathName, type Summary } from "@vhult/graph-bench";
import { loadDataset } from "./data";

export interface BenchCase {
  name: string;
  dataset: GeneratorName;
  count: number;
  path: PathName;
  /** SPEC §2 target for p99 frame time, ms (node-only until edges land in M5). */
  targetP99Ms?: number;
}

/** SPEC §2 datasets (nodes only for now — edge counts join in M5). */
export const SUITE: readonly BenchCase[] = [
  { name: "small", dataset: "clustered", count: 10_000, path: "standard", targetP99Ms: 1.0 },
  { name: "medium", dataset: "clustered", count: 250_000, path: "standard", targetP99Ms: 2.5 },
  { name: "large", dataset: "clustered", count: 1_000_000, path: "standard", targetP99Ms: 6.0 },
  { name: "xlarge", dataset: "clustered", count: 10_000_000, path: "standard", targetP99Ms: 16.0 },
  { name: "deep-zoom", dataset: "clustered", count: 10_000_000, path: "deepZoom", targetP99Ms: 8.0 },
  { name: "xlarge-zoom", dataset: "clustered", count: 10_000_000, path: "zoomSweep", targetP99Ms: 16.0 },
  { name: "large-zoom", dataset: "clustered", count: 1_000_000, path: "zoomSweep", targetP99Ms: 6.0 },
];

export interface CaseRun {
  case: BenchCase;
  result: BenchmarkResult;
}

export async function runCase(graph: Graph, c: BenchCase): Promise<CaseRun> {
  const { data } = loadDataset(c.dataset, c.count);
  graph.setNodes(data, { copy: true });
  graph.camera.fit();
  const path = PATHS[c.path];
  const result = await graph.benchmark({ path: path.keys, frames: path.frames });
  return { case: c, result };
}

interface Row {
  label: string;
  summary: Summary;
  unit: "ms" | "count";
}

function rows(r: BenchmarkResult): Row[] {
  const out: Row[] = [
    { label: "frame interval", summary: summarize(r.intervalMs), unit: "ms" },
    { label: "gpu total", summary: summarize(r.gpuMs), unit: "ms" },
  ];
  for (const [name, series] of Object.entries(r.passMs)) out.push({ label: `  gpu · ${name}`, summary: summarize(series), unit: "ms" });
  out.push({ label: "worker cpu", summary: summarize(r.cpuMs), unit: "ms" });
  out.push({ label: "visible nodes", summary: summarize(r.visibleNodes), unit: "count" });
  return out;
}

const num = (v: number, unit: Row["unit"]) =>
  Number.isNaN(v) ? "—" : unit === "count" ? Math.round(v).toLocaleString("en-US") : v < 10 ? v.toFixed(3) : v.toFixed(2);

function table(run: CaseRun): HTMLElement {
  const wrap = document.createElement("div");
  const r = run.result;
  const gpu = summarize(r.gpuMs);
  const target = run.case.targetP99Ms;
  const verdict =
    target === undefined || Number.isNaN(gpu.p99) ? "" : gpu.p99 <= target ? `  ✓ gpu p99 ≤ ${target} ms` : `  ✗ gpu p99 > ${target} ms`;
  const caption = document.createElement("div");
  caption.className = "caption";
  caption.textContent = `${run.case.name} · ${run.case.dataset} ${r.nodeCount.toLocaleString("en-US")} · path ${run.case.path} · ${r.frames} frames${verdict}`;
  wrap.append(caption);

  const t = document.createElement("table");
  t.innerHTML = "<thead><tr><th></th><th>mean</th><th>p50</th><th>p95</th><th>p99</th><th>max</th></tr></thead>";
  const body = document.createElement("tbody");
  for (const row of rows(r)) {
    const tr = document.createElement("tr");
    const s = row.summary;
    for (const cell of [row.label, num(s.mean, row.unit), num(s.p50, row.unit), num(s.p95, row.unit), num(s.p99, row.unit), num(s.max, row.unit)]) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.append(td);
    }
    body.append(tr);
  }
  t.append(body);
  wrap.append(t);
  return wrap;
}

/** JSON report: summaries plus the raw per-frame series. */
export function report(graph: Graph, runs: readonly CaseRun[]): object {
  return {
    schema: 1,
    date: new Date().toISOString(),
    userAgent: navigator.userAgent,
    adapter: graph.caps.adapter,
    timestampQuery: graph.caps.timestampQuery,
    runs: runs.map(({ case: c, result: r }) => ({
      case: c,
      nodeCount: r.nodeCount,
      viewport: r.viewport,
      frames: r.frames,
      warmup: r.warmup,
      summary: Object.fromEntries(rows(r).map((row) => [row.label.trim(), row.summary])),
      series: {
        intervalMs: Array.from(r.intervalMs),
        gpuMs: Array.from(r.gpuMs),
        cpuMs: Array.from(r.cpuMs),
        visibleNodes: Array.from(r.visibleNodes),
        passMs: Object.fromEntries(Object.entries(r.passMs).map(([k, v]) => [k, Array.from(v)])),
      },
    })),
  };
}

function download(name: string, data: object): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Overlay with Run / Run suite / Download buttons and result tables. */
export class BenchPanel {
  private readonly el: HTMLElement;
  private readonly status: HTMLElement;
  private readonly results: HTMLElement;
  private readonly buttons: HTMLButtonElement[] = [];
  private runs: CaseRun[] = [];
  private busy = false;

  constructor(
    parent: HTMLElement,
    private readonly graph: Graph,
    private readonly currentCase: () => BenchCase,
  ) {
    this.el = document.createElement("div");
    this.el.className = "bench-panel";
    const bar = document.createElement("div");
    this.button(bar, "Run", () => this.run([this.currentCase()]));
    this.button(bar, "Run suite", () => this.run(SUITE));
    this.button(bar, "Download JSON", () => {
      // Browsers can only write to the download folder, so the file is named for
      // where it belongs: move it into packages/bench/results/ to keep the trace.
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      download(`desktop-${stamp}.json`, report(this.graph, this.runs));
    });
    this.status = document.createElement("div");
    this.status.className = "muted";
    this.status.textContent = graph.caps.timestampQuery
      ? "Ready. GPU timings via timestamp-query (quantized unless WebGPU developer features are enabled)."
      : "Ready. timestamp-query unavailable: GPU columns will be empty; frame interval still valid.";
    this.results = document.createElement("div");
    this.el.append(bar, this.status, this.results);
    parent.append(this.el);

    // Automation hook (headless benchmark runs): same code path as the buttons.
    (globalThis as { __graphBench?: unknown }).__graphBench = {
      graph: this.graph,
      suite: SUITE,
      run: async (cases: readonly BenchCase[] = SUITE) => {
        await this.run(cases);
        return report(this.graph, this.runs);
      },
    };
  }

  private button(parent: HTMLElement, label: string, onClick: () => void): void {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", onClick);
    this.buttons.push(b);
    parent.append(b);
  }

  private async run(cases: readonly BenchCase[]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    for (const b of this.buttons) b.disabled = true;
    this.runs = [];
    this.results.replaceChildren();
    try {
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i]!;
        this.status.textContent = `Running ${i + 1}/${cases.length}: ${c.name} (${c.count.toLocaleString("en-US")} nodes, ${c.path})…`;
        const run = await runCase(this.graph, c);
        this.runs.push(run);
        this.results.append(table(run));
      }
      this.status.textContent = `Done. ${this.runs.length} run(s). Download JSON, then move it into packages/bench/results/ to keep the trace.`;
    } catch (e) {
      this.status.textContent = `Failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      this.busy = false;
      for (const b of this.buttons) b.disabled = false;
    }
  }
}

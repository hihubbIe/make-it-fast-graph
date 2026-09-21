/**
 * End-to-end GPU correctness against the CPU reference (@vhult/graph-bench).
 *
 * Exercises, through the public API only: bulk upload, GPU Morton sort +
 * permutation into engine order, chunk bounds, the three-phase cull, and
 * user-indexed partial updates through the rank table. Every view must match
 * the CPU count exactly; any mismatch is a bug (or a driver bug — see
 * docs/decisions.md 0019, found exactly this way).
 *
 * Runs automatically on open; automation awaits `globalThis.__graphCorrectness.result`
 * (never start a second run concurrently: both would drive the same camera).
 */
import type { Meta, StoryObj } from "@storybook/html-vite";
import type { Graph } from "@vhult/graph";
import { clustered, cpuVisibleCount, sizesAsF16, type NodeDataset } from "@vhult/graph-bench";
import { stage } from "../../src/stage";

interface Args {
  count: number;
}

interface Check {
  name: string;
  gpu: number;
  cpu: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Profiler samples land 1–3 frames after the frame; the engine then idles. */
const SETTLE_MS = 400;

function bounds(d: NodeDataset) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < d.count; i++) {
    const x = d.positions[2 * i]!, y = d.positions[2 * i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

async function runChecks(graph: Graph, count: number, report: (c: Check[]) => void): Promise<Check[]> {
  const d = clustered(count, 24, 7);
  graph.setNodes(d, { copy: true });
  graph.camera.fit();
  await sleep(1500);
  const sizes = sizesAsF16(d.sizes);
  const b = bounds(d);
  const checks: Check[] = [];
  const stats = graph.readStats();
  const vw = stats.viewportWidth, vh = stats.viewportHeight;
  const fitZoom = Math.min((vw - 48) / (b.maxX - b.minX), (vh - 48) / (b.maxY - b.minY));

  const views: [number, number, number][] = [
    [0.5, 0.5, 1], [0.5, 0.5, 10], [0.62, 0.41, 70], [0.3, 0.7, 30], [0.45, 0.55, 70], [0.9, 0.1, 5], [0.2, 0.3, 200],
  ];
  const probe = async (label: string, fx: number, fy: number, z: number) => {
    const x = b.minX + fx * (b.maxX - b.minX), y = b.minY + fy * (b.maxY - b.minY), zoom = fitZoom * z;
    graph.camera.setView({ x, y, zoom, rotation: 0 });
    await sleep(SETTLE_MS);
    checks.push({ name: `${label} (${fx}, ${fy}) ×${z}`, gpu: graph.readStats(stats).visibleNodes, cpu: cpuVisibleCount(d, { x, y, zoom, viewportWidth: vw, viewportHeight: vh }, sizes) });
    report(checks);
  };
  for (const [fx, fy, z] of views) await probe("view", fx, fy, z);

  // Partial updates in user order, applied on the GPU through the rank table.
  const moves: [number, number][] = [[Math.floor(count * 0.12), Math.min(5000, Math.floor(count * 0.005))], [Math.floor(count * 0.9), 100]];
  for (const [start, n] of moves) {
    const upd = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) {
      upd[2 * k] = b.maxX * 10 + k;
      upd[2 * k + 1] = b.maxY * 10;
      d.positions[2 * (start + k)] = upd[2 * k]!;
      d.positions[2 * (start + k) + 1] = upd[2 * k + 1]!;
    }
    graph.updateNodePositions(start, upd);
  }
  for (const [fx, fy, z] of [views[0]!, views[1]!, views[4]!]) await probe("after partial update", fx, fy, z);
  return checks;
}

function renderChecks(panel: HTMLElement, checks: Check[], done: boolean): void {
  const failed = checks.filter((c) => c.gpu !== c.cpu).length;
  const rows = checks
    .map((c) => `<tr><td>${c.name}</td><td>${c.gpu.toLocaleString("en-US")}</td><td>${c.cpu.toLocaleString("en-US")}</td><td>${c.gpu === c.cpu ? "✓" : "✗"}</td></tr>`)
    .join("");
  const status = !done ? "running…" : failed === 0 ? `PASS — ${checks.length} checks exact` : `FAIL — ${failed} of ${checks.length} mismatched`;
  panel.innerHTML = `<div class="caption">GPU vs CPU reference: ${status}</div><table><thead><tr><th>check</th><th>gpu</th><th>cpu</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

const meta: Meta<Args> = {
  title: "Developer/GPU correctness",
  render: (args, ctx) =>
    stage(args, ctx, {
      // LOD off: the oracle counts NODES, and LOD deliberately draws merged
      // clusters instead, so the two are only comparable with it disabled.
      // What this proves is that the cull itself is still exact; what LOD costs
      // visually is a separate, image-based question.
      options: () => ({ lodTargetPx: 0 }),
      setup: async (graph, a, hud, root) => {
        const panel = document.createElement("div");
        panel.className = "bench-panel";
        root.append(panel);
        hud.setNote(`correctness · ${a.count.toLocaleString("en-US")} nodes`);
        const run = async () => {
          const checks = await runChecks(graph, a.count, (c) => renderChecks(panel, c, false));
          renderChecks(panel, checks, true);
          return { passed: checks.every((c) => c.gpu === c.cpu), checks };
        };
        (globalThis as { __graphCorrectness?: unknown }).__graphCorrectness = { result: run() };
      },
    }),
  argTypes: {
    count: { control: "select", options: [100_000, 1_000_000, 5_000_000] },
  },
  args: {
    count: 1_000_000,
  },
};

export default meta;
type Story = StoryObj<Args>;

export const GpuCorrectness: Story = { name: "GPU correctness" };

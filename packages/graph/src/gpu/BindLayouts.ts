/**
 * GPUBindGroupLayouts for the public binding contract (§8), derived from
 * `Layouts.ts` so the TS and WGSL sides cannot drift.
 */
import { FRAME_BINDINGS, GRAPH_BINDINGS, type BindingDef } from "../data/Layouts";

const ALL_STAGES = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;

function entry(b: BindingDef): GPUBindGroupLayoutEntry {
  switch (b.kind) {
    case "uniform":
      return { binding: b.binding, visibility: ALL_STAGES, buffer: { type: "uniform" } };
    case "sampler":
      return { binding: b.binding, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, sampler: {} };
    case "storage-read":
      return { binding: b.binding, visibility: ALL_STAGES, buffer: { type: "read-only-storage" } };
  }
}

export interface ContractLayouts {
  frame: GPUBindGroupLayout;
  graph: GPUBindGroupLayout;
}

export function createContractLayouts(device: GPUDevice): ContractLayouts {
  return {
    frame: device.createBindGroupLayout({ label: "group0/frame", entries: FRAME_BINDINGS.map(entry) }),
    graph: device.createBindGroupLayout({ label: "group1/graph", entries: GRAPH_BINDINGS.map(entry) }),
  };
}

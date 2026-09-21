/** Preprocess + compile engine shader modules, surfacing diagnostics with original file:line. */
import { GraphError } from "../api/errors";
import { SHADERS } from "../shaders";
import { formatDiagnostic, preprocess } from "../shaders/preprocess/Preprocessor";

export async function createShaderModule(device: GPUDevice, entry: string): Promise<GPUShaderModule> {
  const pre = preprocess(SHADERS, entry);
  const module = device.createShaderModule({ label: entry, code: pre.code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === "error");
  if (errors.length > 0) {
    throw new GraphError("internal", `Shader "${entry}" failed to compile:\n${errors.map((m) => formatDiagnostic(pre, m)).join("\n")}`);
  }
  return module;
}

/**
 * WGSL preprocessor (§16.3). Currently implements:
 *   1. `#include "path"` against a virtual FS, include-once, with cycle detection.
 *   4. A per-output-line origin map for remapping compilation diagnostics.
 * Hook substitution (2) and override injection (3) arrive with M7.
 */

export type ShaderFs = Readonly<Record<string, string>>;

export interface LineOrigin {
  file: string;
  /** 1-based line in `file`. */
  line: number;
}

export interface Preprocessed {
  code: string;
  /** `origins[i]` is the source of output line `i + 1`. */
  origins: LineOrigin[];
}

export class ShaderPreprocessError extends Error {
  override readonly name = "ShaderPreprocessError";
}

const INCLUDE = /^\s*#include\s+"([^"]+)"\s*$/;

export function preprocess(fs: ShaderFs, entry: string): Preprocessed {
  const lines: string[] = [];
  const origins: LineOrigin[] = [];
  const done = new Set<string>();
  const stack: string[] = [];

  const visit = (file: string): void => {
    if (stack.includes(file)) {
      throw new ShaderPreprocessError(`#include cycle: ${[...stack, file].join(" -> ")}`);
    }
    if (done.has(file)) return;
    const src = fs[file];
    if (src === undefined) {
      const from = stack.length ? ` (included from ${stack[stack.length - 1]})` : "";
      throw new ShaderPreprocessError(`#include not found: "${file}"${from}`);
    }
    stack.push(file);
    const srcLines = src.split(/\r?\n/);
    for (let i = 0; i < srcLines.length; i++) {
      const m = INCLUDE.exec(srcLines[i]!);
      if (m) {
        visit(m[1]!);
        continue;
      }
      lines.push(srcLines[i]!);
      origins.push({ file, line: i + 1 });
    }
    stack.pop();
    done.add(file);
  };

  visit(entry);
  return { code: lines.join("\n"), origins };
}

/** Format a GPUCompilationMessage using the origin map. */
export function formatDiagnostic(p: Preprocessed, msg: { lineNum: number; linePos: number; message: string; type: string }): string {
  const o = p.origins[msg.lineNum - 1];
  const where = o ? `${o.file}:${o.line}:${msg.linePos}` : `<generated>:${msg.lineNum}:${msg.linePos}`;
  return `${msg.type} at ${where}: ${msg.message}`;
}

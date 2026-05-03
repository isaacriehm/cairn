/**
 * Spawners for actually executing setup steps from `harness init`.
 *
 * Each function inherits stdio so the operator sees curl / pnpm / docker
 * progress live. Returns success/failure; the caller surfaces the result
 * in the wizard summary.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
/** dist/init/setup-runners.js → walk up to package root. */
const PKG_ROOT = resolve(HERE, "..", "..");

const WHISPER_MODEL_DIR = join(homedir(), ".local", "harness", "models");
const WHISPER_MODEL_FILE = "ggml-large-v3-turbo-q5_0.bin";
const WHISPER_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin?download=true";

export interface RunResult {
  ok: boolean;
  exit_code: number | null;
  /** Optional human-readable note (skipped reason / failure summary). */
  note?: string;
}

export async function downloadWhisperModel(): Promise<RunResult> {
  mkdirSync(WHISPER_MODEL_DIR, { recursive: true });
  const out = join(WHISPER_MODEL_DIR, WHISPER_MODEL_FILE);
  if (existsSync(out)) {
    return { ok: true, exit_code: 0, note: "model already on disk" };
  }
  return runInherit("curl", ["-fL", "-o", out, WHISPER_MODEL_URL]);
}

export async function pullOllamaModel(model: string): Promise<RunResult> {
  return runInherit("ollama", ["pull", model]);
}

export async function runHarnessSetupScript(
  script:
    | "setup-whisper"
    | "setup-uat-browsers"
    | "setup-uat-sql"
    | "setup-uat-docker",
  extraArgs: string[] = [],
): Promise<RunResult> {
  const scriptPath = join(PKG_ROOT, "scripts", `${script}.ts`);
  if (!existsSync(scriptPath)) {
    return {
      ok: false,
      exit_code: null,
      note: `script not found: ${scriptPath}`,
    };
  }
  // pnpm exec resolves tsx from the harness pkg's node_modules; we stay
  // in PKG_ROOT so workspace-style filtering doesn't matter.
  return runInherit(
    "pnpm",
    ["exec", "tsx", scriptPath, ...extraArgs],
    PKG_ROOT,
  );
}

export async function offerInstallOllama(): Promise<RunResult> {
  // Best-effort detect of brew so we don't spawn it on systems that
  // don't have it.
  const brewCheck = await runInherit("which", ["brew"]);
  if (!brewCheck.ok) {
    return {
      ok: false,
      exit_code: null,
      note: "brew not on PATH — install Ollama manually from ollama.com",
    };
  }
  return runInherit("brew", ["install", "ollama"]);
}

function runInherit(
  command: string,
  args: string[],
  cwd?: string,
): Promise<RunResult> {
  return new Promise((resolveP) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...(cwd !== undefined ? { cwd } : {}),
    });
    child.on("error", (err) => {
      resolveP({ ok: false, exit_code: null, note: String(err) });
    });
    child.on("exit", (code) => {
      resolveP({ ok: code === 0, exit_code: code });
    });
  });
}

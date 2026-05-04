/**
 * Spawners for actually executing setup steps from `harness init`.
 *
 * Each function inherits stdio so the operator sees curl / pnpm / docker
 * progress live. Returns success/failure; the caller surfaces the result
 * in the wizard summary.
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { startProgress } from "./visual.js";

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
  return downloadWithProgress({
    url: WHISPER_MODEL_URL,
    destPath: out,
    label: "Downloading whisper model",
  });
}

interface DownloadOpts {
  url: string;
  destPath: string;
  label: string;
}

/**
 * Stream-download a URL to disk, showing a cli-progress bar with bytes +
 * transfer rate. Falls back to a single-line in-place update on non-TTY.
 *
 * Uses the global `fetch()` available in Node 22+. No new deps.
 */
async function downloadWithProgress(opts: DownloadOpts): Promise<RunResult> {
  let response: Response;
  try {
    response = await fetch(opts.url);
  } catch (err) {
    return {
      ok: false,
      exit_code: null,
      note: `fetch failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      exit_code: response.status,
      note: `HTTP ${response.status} ${response.statusText}`,
    };
  }
  const lenHeader = response.headers.get("content-length");
  const total =
    lenHeader !== null && Number.isFinite(Number.parseInt(lenHeader, 10))
      ? Number.parseInt(lenHeader, 10)
      : 0;

  if (response.body === null) {
    return { ok: false, exit_code: null, note: "empty response body" };
  }

  const sink = createWriteStream(opts.destPath, { flags: "w" });
  const progress = startProgress({ label: opts.label, total: Math.max(total, 1) });
  let received = 0;
  const startedAt = Date.now();
  try {
    const reader = response.body.getReader();
    let last = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      sink.write(value);
      const now = Date.now();
      if (now - last > 80) {
        const elapsedSec = Math.max((now - startedAt) / 1000, 0.001);
        const speedMb = (received / elapsedSec / 1_048_576).toFixed(1);
        progress.set(received, { speedMb });
        last = now;
      }
    }
    sink.end();
    await new Promise<void>((resolveP) => sink.on("close", () => resolveP()));
    progress.set(received, {
      speedMb: ((received / Math.max((Date.now() - startedAt) / 1000, 0.001) / 1_048_576).toFixed(1)),
    });
    progress.stop(true, `whisper model downloaded (${(received / 1_048_576).toFixed(0)}MB)`);
    return { ok: true, exit_code: 0 };
  } catch (err) {
    progress.stop(false, "download failed");
    try {
      sink.end();
    } catch {
      // ignore
    }
    try {
      if (existsSync(opts.destPath) && statSync(opts.destPath).size < (total || Infinity)) {
        unlinkSync(opts.destPath);
      }
    } catch {
      // ignore
    }
    return {
      ok: false,
      exit_code: null,
      note: err instanceof Error ? err.message : String(err),
    };
  }
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

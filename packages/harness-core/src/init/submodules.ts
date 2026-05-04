/**
 * Pre-walk submodule detection.
 *
 * If `.gitmodules` exists at the repo root and any submodule is uninitialized
 * (`git submodule status` line starts with `-`), the init walker would see
 * empty directories and the mapper would have only a fraction of the
 * codebase. This module surfaces that state and offers to run
 * `git submodule update --init --recursive` before any walk happens.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface SubmoduleInfo {
  /** Submodule path relative to repo root, e.g. "core" or "platform/web". */
  path: string;
  /** True when `git submodule status` line starts with `-`. */
  uninitialized: boolean;
  /** Last 7 chars of the recorded SHA, when available. */
  shortSha: string | null;
}

export interface SubmoduleScan {
  /** True when `.gitmodules` exists at repo root. */
  hasGitmodules: boolean;
  /** Parsed `git submodule status` output. Empty when no .gitmodules. */
  submodules: SubmoduleInfo[];
}

/**
 * Inspect the repo for submodules. Never throws — when git is unavailable or
 * the command fails, returns `{ hasGitmodules: <bool>, submodules: [] }` and
 * the caller falls back gracefully.
 */
export async function scanSubmodules(repoRoot: string): Promise<SubmoduleScan> {
  const hasGitmodules = existsSync(join(repoRoot, ".gitmodules"));
  if (!hasGitmodules) return { hasGitmodules: false, submodules: [] };

  const output = await runGit(["submodule", "status"], repoRoot);
  if (output === null) return { hasGitmodules, submodules: [] };

  const submodules: SubmoduleInfo[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) continue;
    // Status line shapes:
    //   " 9e3f4a2... path/to/sub (tag)"  — initialized, in sync
    //   "-9e3f4a2... path/to/sub"        — uninitialized
    //   "+9e3f4a2... path/to/sub"        — initialized, dirty
    //   "U9e3f4a2... path/to/sub"        — merge conflict
    const head = line.charAt(0);
    const uninitialized = head === "-";
    const rest = line.slice(1).trim();
    const m = rest.match(/^([0-9a-fA-F]{7,40})\s+(\S+)/);
    if (!m) continue;
    const [, sha, path] = m;
    if (typeof path !== "string" || path.length === 0) continue;
    submodules.push({
      path,
      uninitialized,
      shortSha: typeof sha === "string" ? sha.slice(0, 7) : null,
    });
  }
  return { hasGitmodules, submodules };
}

export interface InitSubmodulesResult {
  ok: boolean;
  /** Stderr summary when the command failed. */
  errorSummary: string | null;
}

/**
 * Run `git submodule update --init --recursive`. Streams `progress` callbacks
 * for each submodule path as git reports it ("Submodule 'core' (...) registered for path 'core'", etc.).
 *
 * Resolves with `{ ok: true }` on exit code 0; `{ ok: false, errorSummary }`
 * otherwise. Never throws.
 */
export function runGitSubmoduleUpdate(opts: {
  repoRoot: string;
  onProgress?: (event: { kind: "registered" | "checkout" | "info"; line: string }) => void;
}): Promise<InitSubmodulesResult> {
  return new Promise((resolveP) => {
    const errChunks: string[] = [];
    let child;
    try {
      child = spawn(
        "git",
        ["submodule", "update", "--init", "--recursive", "--progress"],
        {
          cwd: opts.repoRoot,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (err) {
      resolveP({
        ok: false,
        errorSummary: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    let stdoutBuffer = "";
    let stderrBuffer = "";

    const flushLines = (
      buffer: string,
      onLine: (line: string) => void,
    ): string => {
      let buf = buffer;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        if (line.length > 0) onLine(line);
        buf = buf.slice(nl + 1);
      }
      return buf;
    };

    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer = flushLines(stdoutBuffer + chunk, (line) => {
        opts.onProgress?.(classifyLine(line));
      });
    });
    child.stderr?.on("data", (chunk: string) => {
      stderrBuffer = flushLines(stderrBuffer + chunk, (line) => {
        errChunks.push(line);
        opts.onProgress?.(classifyLine(line));
      });
    });

    child.on("error", (err) => {
      resolveP({
        ok: false,
        errorSummary: err instanceof Error ? err.message : String(err),
      });
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolveP({ ok: true, errorSummary: null });
      } else {
        const summary =
          errChunks.length > 0
            ? errChunks.slice(-3).join(" ").slice(0, 200)
            : `exit code ${code ?? "null"}`;
        resolveP({ ok: false, errorSummary: summary });
      }
    });
  });
}

function classifyLine(line: string): {
  kind: "registered" | "checkout" | "info";
  line: string;
} {
  if (/^Submodule '/.test(line)) return { kind: "registered", line };
  if (/Cloning into|Submodule path/.test(line)) return { kind: "checkout", line };
  return { kind: "info", line };
}

function runGit(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolveP) => {
    let child;
    try {
      child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolveP(null);
      return;
    }
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", () => resolveP(null));
    child.on("close", (code) => {
      if (code === 0) resolveP(Buffer.concat(chunks).toString("utf8"));
      else resolveP(null);
    });
  });
}

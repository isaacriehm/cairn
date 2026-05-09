/**
 * Post-git-init configuration helper.
 *
 * Cairn drives a `git init` only when adoption starts in a directory
 * that isn't already a working tree (cairn-adopt skill, Step 2). On
 * WSL+Windows volumes the freshly-initialized repo's owner uid often
 * differs from the WSL user, and `git` then refuses to operate with
 * `fatal: detected dubious ownership in repository`. The fix is per-
 * clone, idempotent, and silent if already set:
 *
 *   git config --local safe.directory <abs-path>
 *   git config --local core.fileMode false
 *
 * `applyPostInitGitConfig` is callable two ways:
 *
 *   1. Right after Cairn drives a `git init` — run unconditionally.
 *   2. From Phase 1 detect, when WSL-from-Windows is active — run
 *      whether or not Cairn drove the init.
 *
 * The git runner is injectable so smokes can record argv without a
 * real fork.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], cwd: string) => GitRunResult;

export interface PostGitInitOptions {
  repoRoot: string;
  /** Test injection. Defaults to `spawnSync("git", args, {cwd})`. */
  gitRunner?: GitRunner;
}

export interface PostGitInitResult {
  /** One entry per `git config` call attempted. */
  applied: { command: string[]; ok: boolean; stderr: string }[];
}

const defaultGitRunner: GitRunner = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

export function applyPostInitGitConfig(
  opts: PostGitInitOptions,
): PostGitInitResult {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const abs = resolve(opts.repoRoot);
  const calls: string[][] = [
    ["config", "--local", "safe.directory", abs],
    ["config", "--local", "core.fileMode", "false"],
  ];
  const applied: PostGitInitResult["applied"] = [];
  for (const args of calls) {
    const r = runner(args, abs);
    applied.push({ command: ["git", ...args], ok: r.ok, stderr: r.stderr });
  }
  return { applied };
}

export interface WslDetectOptions {
  platform?: NodeJS.Platform;
  /** Test injection. Defaults to reading `/proc/version`. */
  procVersionReader?: () => string | null;
}

const defaultProcVersionReader = (): string | null => {
  if (!existsSync("/proc/version")) return null;
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return null;
  }
};

const WSL_PROC_RE = /Microsoft|WSL/;

/**
 * `true` when the current process is Linux running inside WSL.
 * Defaults to live `process.platform` + `/proc/version` lookup; tests
 * inject both.
 */
export function detectWsl(opts: WslDetectOptions = {}): boolean {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") return false;
  const reader = opts.procVersionReader ?? defaultProcVersionReader;
  const text = reader();
  if (typeof text !== "string") return false;
  return WSL_PROC_RE.test(text);
}

/**
 * `harness join` — per-clone bootstrap.
 *
 * Spec: PLUGIN_ARCHITECTURE §17 Layer 2.
 *
 * Idempotent. Safe to re-run on every install (the package.json `prepare`
 * script runs it on every `npm install` / `pnpm install`).
 *
 * Steps:
 *   1. Locate the harness-adopted repo root (walk up from cwd for `.harness/`).
 *   2. Verify the local CLI's version against `.harness/config.yaml`'s
 *      `harness_version`. Strict-equal for now (no semver spread); a mismatch
 *      returns kind="version-mismatch" without blocking — caller decides.
 *   3. `git config core.hooksPath .harness/git-hooks` (per-clone activation).
 *   4. chmod +x the three git hooks (best-effort; FS may not support).
 *   5. Ensure `.harness/sessions/` exists (per-clone session-state dir).
 *
 * Returns a structured result so the CLI / plugin can render exactly what
 * happened. Never throws on recoverable issues — every step has a status.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { VERSION } from "../index.js";
import { logger } from "../logger.js";

const log = logger("join");

export type JoinStepStatus = "ok" | "skipped" | "error" | "warn";

export interface JoinStep {
  step: string;
  status: JoinStepStatus;
  detail: string;
}

export interface JoinResult {
  /** Repo root we acted on, or null when none was found. */
  repoRoot: string | null;
  /** True iff every step is "ok" or "skipped". */
  bootstrapped: boolean;
  steps: JoinStep[];
  /** Convenience: from `.harness/config.yaml`'s harness_version. */
  projectHarnessVersion: string | null;
  /** Convenience: this CLI's VERSION. */
  cliVersion: string;
}

export interface RunJoinArgs {
  /** Override starting directory; default = process.cwd(). */
  cwd?: string;
  /** Explicit repo root — skips the upward walk. */
  repoRoot?: string;
  /** When true, no filesystem / git side-effects (still reports detection). */
  dryRun?: boolean;
  /**
   * When true, exits with a non-zero status if a recoverable warning fires
   * (e.g. version mismatch). Default false: print + continue.
   */
  strict?: boolean;
}

const HOOK_FILES = ["pre-commit", "post-commit", "commit-msg"] as const;

export function runJoin(args: RunJoinArgs = {}): JoinResult {
  const cwd = args.cwd ?? process.cwd();
  const steps: JoinStep[] = [];

  const repoRoot = args.repoRoot ?? findHarnessRoot(cwd);
  if (repoRoot === null) {
    steps.push({
      step: "locate-repo",
      status: "error",
      detail:
        "no .harness/ found from cwd upward — run `harness init` first or cd into a harness-adopted project",
    });
    return {
      repoRoot: null,
      bootstrapped: false,
      steps,
      projectHarnessVersion: null,
      cliVersion: VERSION,
    };
  }
  steps.push({
    step: "locate-repo",
    status: "ok",
    detail: repoRoot,
  });

  const projectVersion = readProjectVersion(repoRoot);
  if (projectVersion === null) {
    steps.push({
      step: "version-check",
      status: "skipped",
      detail: ".harness/config.yaml missing harness_version (legacy adoption?)",
    });
  } else if (projectVersion !== VERSION) {
    steps.push({
      step: "version-check",
      status: "warn",
      detail: `project pinned to ${projectVersion}; this CLI is ${VERSION} — upgrade with \`npm install -g @devplusllc/harness@${projectVersion}\``,
    });
  } else {
    steps.push({
      step: "version-check",
      status: "ok",
      detail: `harness_version=${projectVersion}`,
    });
  }

  if (args.dryRun === true) {
    steps.push({
      step: "dry-run",
      status: "ok",
      detail: "dry-run set — no filesystem or git side-effects performed",
    });
    return {
      repoRoot,
      bootstrapped: true,
      steps,
      projectHarnessVersion: projectVersion,
      cliVersion: VERSION,
    };
  }

  const hooksDir = join(repoRoot, ".harness", "git-hooks");
  if (!existsSync(hooksDir)) {
    steps.push({
      step: "set-hooks-path",
      status: "error",
      detail: `${hooksDir} missing — run \`harness init\` to seed hooks first`,
    });
    return {
      repoRoot,
      bootstrapped: false,
      steps,
      projectHarnessVersion: projectVersion,
      cliVersion: VERSION,
    };
  }

  const setHooks = setGitHooksPath(repoRoot);
  steps.push(setHooks);

  const chmodStep = chmodHooks(hooksDir);
  steps.push(chmodStep);

  const sessionStep = ensureSessionDir(repoRoot);
  steps.push(sessionStep);

  const bootstrapped = steps.every(
    (s) => s.status === "ok" || s.status === "skipped",
  );
  return {
    repoRoot,
    bootstrapped,
    steps,
    projectHarnessVersion: projectVersion,
    cliVersion: VERSION,
  };
}

/* -------------------------------------------------------------------------- */
/* Step helpers                                                               */
/* -------------------------------------------------------------------------- */

function findHarnessRoot(start: string): string | null {
  let cur = resolve(start);
  for (let i = 0; i < 80; i++) {
    if (existsSync(join(cur, ".harness"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

function readProjectVersion(repoRoot: string): string | null {
  const path = join(repoRoot, ".harness", "config.yaml");
  if (!existsSync(path)) return null;
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
    const v = parsed?.["harness_version"];
    return typeof v === "string" ? v : null;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "config.yaml unreadable",
    );
    return null;
  }
}

function setGitHooksPath(repoRoot: string): JoinStep {
  if (!existsSync(join(repoRoot, ".git"))) {
    return {
      step: "set-hooks-path",
      status: "warn",
      detail: "no .git/ at repoRoot — skipping git config (initialize git first?)",
    };
  }
  try {
    execFileSync("git", ["config", "core.hooksPath", ".harness/git-hooks"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      step: "set-hooks-path",
      status: "ok",
      detail: "core.hooksPath = .harness/git-hooks",
    };
  } catch (err) {
    return {
      step: "set-hooks-path",
      status: "error",
      detail: `git config failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function chmodHooks(hooksDir: string): JoinStep {
  let okCount = 0;
  const failed: string[] = [];
  for (const name of HOOK_FILES) {
    const abs = join(hooksDir, name);
    if (!existsSync(abs)) continue;
    try {
      chmodSync(abs, 0o755);
      okCount += 1;
    } catch (err) {
      failed.push(`${name} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (failed.length > 0) {
    return {
      step: "chmod-hooks",
      status: "warn",
      detail: `chmod failed for: ${failed.join(", ")} — git may still execute via index mode`,
    };
  }
  return {
    step: "chmod-hooks",
    status: "ok",
    detail: `${okCount} hook${okCount === 1 ? "" : "s"} marked executable`,
  };
}

function ensureSessionDir(repoRoot: string): JoinStep {
  const dir = join(repoRoot, ".harness", "sessions");
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      return { step: "ensure-sessions-dir", status: "ok", detail: `created ${dir}` };
    }
    const st = statSync(dir);
    if (!st.isDirectory()) {
      return {
        step: "ensure-sessions-dir",
        status: "error",
        detail: `${dir} exists but is not a directory`,
      };
    }
    return { step: "ensure-sessions-dir", status: "skipped", detail: "exists" };
  } catch (err) {
    return {
      step: "ensure-sessions-dir",
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Inspection helper for plugin SessionStart degraded-mode detection.         */
/* -------------------------------------------------------------------------- */

export interface InspectJoinStateArgs {
  repoRoot: string;
}

export interface JoinState {
  /** True when `git config core.hooksPath` reports `.harness/git-hooks`. */
  hooksPathSet: boolean;
  /** Raw value reported by git, or null when git failed / unset. */
  hooksPathValue: string | null;
  /** From `.harness/config.yaml` — null if absent / unreadable. */
  projectHarnessVersion: string | null;
  /** True when projectHarnessVersion === current CLI VERSION. */
  versionMatches: boolean;
  /** True when sessions dir exists. */
  sessionsDirReady: boolean;
}

export function inspectJoinState(args: InspectJoinStateArgs): JoinState {
  const repoRoot = args.repoRoot;
  const hooksPathValue = readGitConfigValue(repoRoot, "core.hooksPath");
  const projectHarnessVersion = readProjectVersion(repoRoot);
  return {
    hooksPathSet: hooksPathValue === ".harness/git-hooks",
    hooksPathValue,
    projectHarnessVersion,
    versionMatches: projectHarnessVersion === VERSION,
    sessionsDirReady: existsSync(join(repoRoot, ".harness", "sessions")),
  };
}

function readGitConfigValue(repoRoot: string, key: string): string | null {
  if (!existsSync(join(repoRoot, ".git"))) return null;
  try {
    const out = execFileSync("git", ["config", "--get", key], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed.length === 0 ? null : trimmed;
  } catch {
    return null;
  }
}

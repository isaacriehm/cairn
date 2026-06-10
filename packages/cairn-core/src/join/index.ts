/**
 * `cairn join` — per-clone bootstrap.
 *
 * Spec: PLUGIN_ARCHITECTURE §17 Layer 2.
 *
 * Idempotent. Safe to re-run on every install (the package.json `prepare`
 * script runs it on every `npm install` / `pnpm install`).
 *
 * Steps:
 *   1. Locate the cairn-adopted repo root (walk up from cwd for `.cairn/`).
 *   2. Verify the local CLI's version against `.cairn/config.yaml`'s
 *      `cairn_version`. Strict-equal for now (no semver spread); a mismatch
 *      returns kind="version-mismatch" without blocking — caller decides.
 *   3. `git config core.hooksPath .cairn/git-hooks` (per-clone activation).
 *   4. chmod +x the three git hooks (best-effort; FS may not support).
 *   5. Ensure `.cairn/sessions/` exists (per-clone session-state dir).
 *
 * Returns a structured result so the CLI / plugin can render exactly what
 * happened. Never throws on recoverable issues — every step has a status.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { seedAttestedCommits } from "../hooks/seed-attested.js";
import { VERSION } from "../index.js";
import { rebuildDerived } from "../state/rebuild-derived.js";
import { readConfigPin } from "../migrate/config-io.js";
import {
  cairnDir,
  cairnHooksPathForConfig,
  COMMITTED_HOOKS_PATH,
} from "@isaacriehm/cairn-state";

export type JoinStepStatus = "ok" | "skipped" | "error" | "warn";

export interface JoinStep {
  step: string;
  status: JoinStepStatus;
  detail: string;
}

export interface JoinResult {
  /** Repo root we acted on, or null when none was found. */
  repoRoot: string | null;
  /**
   * True iff no step errored. Warnings (e.g. version mismatch) are
   * advisory and do not flip this to false — the hooks still get
   * activated, the sessions dir still lands. Caller can inspect `steps`
   * for individual statuses to decide whether to print the warnings.
   */
  bootstrapped: boolean;
  steps: JoinStep[];
  /** Convenience: from `.cairn/config.yaml`'s cairn_version. */
  projectCairnVersion: string | null;
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

  const repoRoot = args.repoRoot ?? findCairnRoot(cwd);
  if (repoRoot === null) {
    steps.push({
      step: "locate-repo",
      status: "error",
      detail:
        "no .cairn/ found from cwd upward — run `cairn init` first or cd into a cairn-adopted project",
    });
    return {
      repoRoot: null,
      bootstrapped: false,
      steps,
      projectCairnVersion: null,
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
      detail: ".cairn/config.yaml missing cairn_version — re-run init",
    });
  } else if (projectVersion !== VERSION) {
    steps.push({
      step: "version-check",
      status: "warn",
      detail: `project pinned to ${projectVersion}; this CLI is ${VERSION} — upgrade with \`npm install -g @isaacriehm/cairn@${projectVersion}\``,
    });
  } else {
    steps.push({
      step: "version-check",
      status: "ok",
      detail: `cairn_version=${projectVersion}`,
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
      projectCairnVersion: projectVersion,
      cliVersion: VERSION,
    };
  }

  const hooksDir = cairnDir(repoRoot, "git-hooks");
  if (!existsSync(hooksDir)) {
    steps.push({
      step: "set-hooks-path",
      status: "error",
      detail: `${hooksDir} missing — run \`cairn init\` to seed hooks first`,
    });
    return {
      repoRoot,
      bootstrapped: false,
      steps,
      projectCairnVersion: projectVersion,
      cliVersion: VERSION,
    };
  }

  const setHooks = setGitHooksPath(repoRoot);
  steps.push(setHooks);

  const chmodStep = chmodHooks(hooksDir);
  steps.push(chmodStep);

  const sessionStep = ensureSessionDir(repoRoot);
  steps.push(sessionStep);

  // `.cairn/.attested-commits` is gitignored + per-clone, so each fresh
  // clone needs its own seed of all reachable HEAD SHAs. Without this,
  // the Stop-hook bypass detector flags every pre-existing commit as a
  // `--no-verify` bypass on the contributor's first session.
  const attestedSeed = seedAttestedCommits(repoRoot);
  steps.push({
    step: "seed-attested-commits",
    status: attestedSeed.status,
    detail: attestedSeed.detail,
  });

  // `.cairn/.cli-path` lets the git hooks resolve the bundled
  // `dist/cli.mjs` path without requiring a global `cairn` binary on
  // PATH (the plugin model has none). Gitignored, per-clone — hooks
  // read it on every commit; if absent they fall back to `command -v
  // cairn`.
  const cliPathStep = writeCliPathFile(repoRoot);
  steps.push(cliPathStep);

  // Derived ground state (ledgers, scope-index, manifest, sot-bindings,
  // sot-cache, file-candidates) is gitignored + per-clone as of v0.15.0
  // — a fresh clone ships none of it. Rebuild from the committed DEC/INV
  // sources so the contributor's first session has working scope / lens
  // / sensor lookups.
  try {
    const rebuilt = rebuildDerived(repoRoot);
    steps.push({
      step: "rebuild-derived",
      status: "ok",
      detail: `rebuilt ${rebuilt.decisions} DEC + ${rebuilt.invariants} INV → ${rebuilt.bindings} bindings, ${rebuilt.cacheEntries} cache entries`,
    });
  } catch (err) {
    steps.push({
      step: "rebuild-derived",
      status: "warn",
      detail: `derived rebuild failed (regenerates next SessionStart): ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const bootstrapped = steps.every((s) => s.status !== "error");
  return {
    repoRoot,
    bootstrapped,
    steps,
    projectCairnVersion: projectVersion,
    cliVersion: VERSION,
  };
}

/* -------------------------------------------------------------------------- */
/* Step helpers                                                               */
/* -------------------------------------------------------------------------- */

function findCairnRoot(start: string): string | null {
  let cur = resolve(start);
  for (let i = 0; i < 80; i++) {
    // Repo-root discovery probe: physical in-repo `.cairn/` (committed mode).
    // Literal join is intentional — ghost resolves via the global registry.
    if (existsSync(join(cur, ".cairn"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

// Single `cairn_version` pin reader, shared with the migration runner + doctor.
function readProjectVersion(repoRoot: string): string | null {
  return readConfigPin(repoRoot);
}

function setGitHooksPath(repoRoot: string): JoinStep {
  if (!existsSync(join(repoRoot, ".git"))) {
    return {
      step: "set-hooks-path",
      status: "warn",
      detail: "no .git/ at repoRoot — skipping git config (initialize git first?)",
    };
  }
  // Committed: relative `.cairn/git-hooks` (tracked, portable per-clone).
  // Ghost: the ABSOLUTE out-of-repo `<cairnHome>/git-hooks` — the hooks live
  // outside the repo tree, so a relative path would not resolve. Local git
  // config either way (never committed).
  const hooksPathValue = cairnHooksPathForConfig(repoRoot);

  // ── Clobber guard ──────────────────────────────────────────────────────
  // git allows exactly ONE core.hooksPath. If the client repo already points
  // it somewhere that isn't Cairn's (husky, lefthook, a custom dir), blindly
  // overwriting it silently disables the client's hooks for this operator.
  // That's worst in ghost — the whole premise is leaving the client's setup
  // untouched — but it's a latent hazard in committed mode too. Refuse +
  // warn; never override. (Chaining the prior hook is a future enhancement;
  // v1 hands the operator a clear remediation. ghost-mode design.)
  const existing = readGitConfigValue(repoRoot, "core.hooksPath");
  if (
    existing !== null &&
    existing.length > 0 &&
    !isCairnHooksPath(existing, repoRoot)
  ) {
    return {
      step: "set-hooks-path",
      status: "warn",
      detail:
        `core.hooksPath already set to '${existing}' (husky/lefthook/custom hooks?) — ` +
        `Cairn will NOT override it, so Cairn's git-hook sensor sweep is inactive ` +
        `for this clone. To run both, chain '${existing}' into Cairn's hooks, or ` +
        `clear core.hooksPath and re-run join.`,
    };
  }

  try {
    execFileSync("git", ["config", "core.hooksPath", hooksPathValue], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Soft conflict: husky is configured (`.husky/` present) but core.hooksPath
    // was unset — a later `husky`/`npm install` resets it and clobbers Cairn's
    // path. Cairn is wired now; warn so the operator chains proactively.
    if (existsSync(join(repoRoot, ".husky"))) {
      return {
        step: "set-hooks-path",
        status: "warn",
        detail:
          `core.hooksPath = ${hooksPathValue} (set), but a .husky/ directory exists — ` +
          `a future husky install resets core.hooksPath and disables Cairn's hooks. ` +
          `Chain them to keep both active.`,
      };
    }
    return {
      step: "set-hooks-path",
      status: "ok",
      detail: `core.hooksPath = ${hooksPathValue}`,
    };
  } catch (err) {
    return {
      step: "set-hooks-path",
      status: "error",
      detail: `git config failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * True when a `core.hooksPath` value is already Cairn's own. Committed stores
 * the relative `.cairn/git-hooks`; ghost the absolute out-of-repo path
 * (`cairnDir` yields exactly that, and `<repoRoot>/.cairn/git-hooks` in
 * committed). Anything else is a foreign hooks path we must not clobber.
 */
function isCairnHooksPath(value: string, repoRoot: string): boolean {
  // Accept BOTH forms regardless of current mode — this is the clobber guard
  // asking "is this value one of ours?", not "is it wired for this mode?"
  return value === COMMITTED_HOOKS_PATH || value === cairnDir(repoRoot, "git-hooks");
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

export function writeCliPathFile(repoRoot: string): JoinStep {
  const cliArgv = process.argv[1];
  if (typeof cliArgv !== "string" || cliArgv.length === 0) {
    return {
      step: "write-cli-path",
      status: "skipped",
      detail: "process.argv[1] empty — hooks will fall back to global cairn",
    };
  }
  const isModule = /\.[mc]?js$/.test(cliArgv);
  // Quote the path so eval'ing the .cli-path content from a hook
  // survives a CLI install location with spaces (operators with
  // spaces anywhere in their home, or local-marketplace plugin caches
  // resolved through symlinked dev paths).
  const invocation = isModule ? `node "${cliArgv}"` : `"${cliArgv}"`;
  const path = cairnDir(repoRoot, ".cli-path");
  const desired = `${invocation}\n`;
  // SessionStart calls this every session, but the CLI invocation rarely
  // changes — skip the mkdir + write when the file already matches (hot path).
  try {
    if (existsSync(path) && readFileSync(path, "utf8") === desired) {
      return {
        step: "write-cli-path",
        status: "skipped",
        detail: `cli invocation unchanged: ${invocation}`,
      };
    }
    mkdirSync(cairnDir(repoRoot), { recursive: true });
    writeFileSync(path, desired, "utf8");
  } catch (err) {
    return {
      step: "write-cli-path",
      status: "error",
      detail: `write ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    step: "write-cli-path",
    status: "ok",
    detail: `cli invocation: ${invocation}`,
  };
}

function ensureSessionDir(repoRoot: string): JoinStep {
  const dir = cairnDir(repoRoot, "sessions");
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
  /** True when `git config core.hooksPath` reports `.cairn/git-hooks`. */
  hooksPathSet: boolean;
  /**
   * True when `core.hooksPath` is set to a NON-Cairn value (husky / lefthook /
   * custom). A terminal state, not a not-yet-bootstrapped one: Cairn refuses to
   * clobber it (§3.3 seam 5), so re-running join can never flip `hooksPathSet`.
   * Callers use this to stop retrying the bootstrap and to surface the conflict
   * instead of a false "hooks wired" banner.
   */
  hooksPathConflict: boolean;
  /** Raw value reported by git, or null when git failed / unset. */
  hooksPathValue: string | null;
  /** From `.cairn/config.yaml` — null if absent / unreadable. */
  projectCairnVersion: string | null;
  /** True when projectCairnVersion === current CLI VERSION. */
  versionMatches: boolean;
  /** True when sessions dir exists. */
  sessionsDirReady: boolean;
}

export function inspectJoinState(args: InspectJoinStateArgs): JoinState {
  const repoRoot = args.repoRoot;
  const hooksPathValue = readGitConfigValue(repoRoot, "core.hooksPath");
  const projectCairnVersion = readProjectVersion(repoRoot);
  // The value join would write for THIS repo's mode. `hooksPathSet` is the
  // mode-exact check (is it wired for this mode?); `isCairnHooksPath` below is
  // the mode-agnostic clobber guard (is it ours at all?) — kept distinct.
  const expectedHooksPath = cairnHooksPathForConfig(repoRoot);
  return {
    hooksPathSet: hooksPathValue === expectedHooksPath,
    hooksPathConflict:
      hooksPathValue !== null &&
      hooksPathValue.length > 0 &&
      !isCairnHooksPath(hooksPathValue, repoRoot),
    hooksPathValue,
    projectCairnVersion,
    versionMatches: projectCairnVersion === VERSION,
    sessionsDirReady: existsSync(cairnDir(repoRoot, "sessions")),
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

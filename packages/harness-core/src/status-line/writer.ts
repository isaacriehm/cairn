import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { normalizeProjectName, projectStatePath } from "../mirror/index.js";
import type { StatusJson } from "./index.js";

/**
 * Resolve the absolute path to `status.json` for the given repo root.
 * Slug is derived from `basename(repoRoot)` via `normalizeProjectName`.
 */
export function statusJsonPath(repoRoot: string): string {
  const slug = normalizeProjectName(basename(repoRoot));
  return join(projectStatePath(slug), "status.json");
}

/**
 * Patch `status.json` for the project at `repoRoot`. Reads the existing file
 * (if present and valid JSON), shallow-merges `patch` over it, and writes the
 * pretty-printed result back. Creates the state directory if missing.
 *
 * v1: best-effort write; no atomic-rename ceremony. The status file is
 * cosmetic — torn writes self-heal on the next daemon tick.
 */
export function writeStatusJson(
  repoRoot: string,
  patch: Partial<StatusJson>,
): void {
  const slug = normalizeProjectName(basename(repoRoot));
  writeStatusJsonForSlug(slug, patch);
}

/**
 * Slug-keyed variant for callers (the daemon supervisor) that already know
 * the normalized project slug — avoids re-deriving via `basename(repoRoot)`
 * which can disagree when the operator's working tree is a different name
 * than the canonical slug.
 */
export function writeStatusJsonForSlug(
  slug: string,
  patch: Partial<StatusJson>,
): void {
  const stateDir = projectStatePath(slug);
  const filePath = join(stateDir, "status.json");

  let existing: Partial<StatusJson> = {};
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        existing = parsed as Partial<StatusJson>;
      }
    } catch {
      existing = {};
    }
  }

  const merged: Partial<StatusJson> = { ...existing, ...patch };

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

/**
 * Default StatusJson all daemons should write on startup. Subsequent patches
 * (heartbeat updated_at, last_run_at, etc.) merge over this baseline so the
 * shape-validating reader always sees a complete object.
 */
export function defaultStatusJson(daemonAlive: boolean): StatusJson {
  return {
    updated_at: new Date().toISOString(),
    daemon_alive: daemonAlive,
    ctx_tokens_used: 0,
    ctx_tokens_budget: 0,
    decisions_in_scope: 0,
    invariants_in_scope: 0,
    task_state: "idle",
    task_module: null,
    gc_running: false,
    attention_count: 0,
    last_run_result: null,
    last_run_at: null,
  };
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionStateDir } from "../paths/index.js";
import { emptyEventCounters, type StatusJson } from "./index.js";
import { cairnDir } from "@isaacriehm/cairn-state";

/**
 * Resolve the absolute path to `status.json` for a session inside the
 * adopted repo at `repoRoot`. Per PLUGIN_ARCHITECTURE §7, status lives
 * under `.cairn/sessions/<session-id>/status.json` and is owned by
 * exactly one session for that session's lifetime.
 */
export function statusJsonPath(repoRoot: string, sessionId: string): string {
  return join(sessionStateDir(repoRoot, sessionId), "status.json");
}

/**
 * Patch the per-session `status.json`. Reads the existing file (if
 * present and valid JSON), shallow-merges `patch` over it, and writes
 * the pretty-printed result back. Creates the per-session directory if
 * missing.
 *
 * Refuses to write when the repo's `.cairn/` directory is missing — a
 * caller that forgot to gate on `resolveRepoRoot` would otherwise
 * `mkdir -p` a phantom `.cairn/sessions/` tree in a non-adopted
 * project.
 *
 * Best-effort write; no atomic-rename ceremony. The status file is
 * cosmetic — torn writes self-heal on the next hook tick.
 */
export function writeStatusJson(
  repoRoot: string,
  sessionId: string,
  patch: Partial<StatusJson>,
): void {
  if (!existsSync(cairnDir(repoRoot))) return;

  const stateDir = sessionStateDir(repoRoot, sessionId);
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
 * Default StatusJson the SessionStart hook writes on session creation.
 * Subsequent patches (heartbeat updated_at, attention_count, etc.)
 * merge over this baseline so the shape-validating reader always sees
 * a complete object.
 */
export function defaultStatusJson(): StatusJson {
  return {
    updated_at: new Date().toISOString(),
    decisions_in_scope: 0,
    invariants_in_scope: 0,
    task_state: "idle",
    task_id: null,
    task_module: null,
    gc_running: false,
    attention_count: 0,
    bypass_count: 0,
    last_run_result: null,
    last_run_at: null,
    current_event: null,
    event_counters: emptyEventCounters(),
    haiku_unavailable: false,
    recent_events: [],
  };
}

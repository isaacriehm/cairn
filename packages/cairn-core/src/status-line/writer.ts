import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionStateDir } from "../paths/index.js";
import type { StatusJson } from "./index.js";

/**
 * Resolve the absolute path to `status.json` for a session inside the
 * adopted repo at `repoRoot`. Per PLUGIN_ARCHITECTURE §7, status lives
 * under `.harness/sessions/<session-id>/status.json` and is owned by
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
 * Best-effort write; no atomic-rename ceremony. The status file is
 * cosmetic — torn writes self-heal on the next hook tick.
 */
export function writeStatusJson(
  repoRoot: string,
  sessionId: string,
  patch: Partial<StatusJson>,
): void {
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
 *
 * `ctx_tokens_budget` defaults to 4000 — the SessionStart
 * additionalContext cap (Section 0–7 budget). Hooks may overwrite once
 * a tighter per-session value is computed.
 *
 * `daemon_alive` is retained on the wire for status-line format
 * back-compat; the daemon itself is dormant. SessionStart writes
 * `true` to indicate the session is live.
 */
export function defaultStatusJson(sessionAlive: boolean): StatusJson {
  return {
    updated_at: new Date().toISOString(),
    daemon_alive: sessionAlive,
    ctx_tokens_used: 0,
    ctx_tokens_budget: 4000,
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

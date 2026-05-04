import { existsSync, readFileSync } from "node:fs";
import { formatStatus } from "./format.js";
import type { StatusJson, TaskState } from "./index.js";
import { statusJsonPath } from "./writer.js";

const PLACEHOLDER = "⬡ harness  daemon:down  ○";

const TASK_STATES: readonly TaskState[] = [
  "idle",
  "running",
  "queued",
  "tightening",
  "sensing",
  "reviewing",
  "backprop",
];

function isTaskState(v: unknown): v is TaskState {
  return typeof v === "string" && (TASK_STATES as readonly string[]).includes(v);
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function isLastRunResult(v: unknown): v is "succeeded" | "failed" | null {
  return v === null || v === "succeeded" || v === "failed";
}

function isStatusJson(x: unknown): x is StatusJson {
  if (x === null || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o["updated_at"] === "string" &&
    typeof o["daemon_alive"] === "boolean" &&
    typeof o["ctx_tokens_used"] === "number" &&
    typeof o["ctx_tokens_budget"] === "number" &&
    typeof o["decisions_in_scope"] === "number" &&
    typeof o["invariants_in_scope"] === "number" &&
    isTaskState(o["task_state"]) &&
    isStringOrNull(o["task_module"]) &&
    typeof o["gc_running"] === "boolean" &&
    typeof o["attention_count"] === "number" &&
    isLastRunResult(o["last_run_result"]) &&
    isStringOrNull(o["last_run_at"])
  );
}

/**
 * Render the current status-line string for a session inside the
 * adopted repo at `repoRoot`. `sessionId` is the Claude Code session id
 * (passed via the status-line hook's stdin payload).
 *
 * Returns the placeholder `⬡ harness  daemon:down  ○` when:
 *   - `sessionId` is null/empty (status-line invoked outside a session)
 *   - the per-session status.json is missing
 *   - the file is unreadable, malformed JSON, or fails shape validation
 *
 * Hot path — invoked on every Claude Code prompt. Keep this cheap.
 */
export function readStatusForCLI(repoRoot: string, sessionId: string | null): string {
  if (sessionId === null || sessionId.length === 0) return PLACEHOLDER;
  const filePath = statusJsonPath(repoRoot, sessionId);
  if (!existsSync(filePath)) return PLACEHOLDER;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return PLACEHOLDER;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return PLACEHOLDER;
  }

  if (!isStatusJson(parsed)) return PLACEHOLDER;

  return formatStatus(parsed);
}

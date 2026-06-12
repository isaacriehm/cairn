/**
 * Active-task summary reader for the per-session statusline + Section-0
 * resume payload. Walks `.cairn/tasks/active/` and returns the first
 * task whose `status.yaml` is in flight.
 *
 * Phase mapping aligns `status.yaml`'s vocabulary with the StatusJson
 * `task_state` enum. Terminal phases (succeeded/failed/aborted) and
 * unrecognized values collapse to `idle` so the surface stays quiet
 * when nothing is actually in flight.
 */

import { type Dirent, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { cairnDir, parseFrontmatter } from "@isaacriehm/cairn-state";
import type { TaskState } from "../status-line/index.js";

import { z } from "zod";

const StatusFileSchema = z.object({
  phase: z.string().optional(),
}).passthrough();

export interface ActiveTaskSummary {
  taskId: string;
  taskState: TaskState;
  /** Title pulled from spec.tightened.md `# Heading`; falls back to taskId. */
  taskModule: string;
}

const ACTIVE_PHASES: ReadonlySet<string> = new Set([
  "queued",
  "tightening",
  "running",
  "sensor_check",
  "reviewing",
  "backprop",
]);

function mapPhase(phase: string): TaskState {
  switch (phase) {
    case "queued":
    case "tightening":
    case "running":
    case "reviewing":
    case "backprop":
      return phase;
    case "sensor_check":
      return "sensing";
    default:
      return "idle";
  }
}

export function readActiveTaskSummary(repoRoot: string): ActiveTaskSummary | null {
  const activeDir = cairnDir(repoRoot, "tasks", "active");
  if (!existsSync(activeDir)) return null;

  let dirents: Dirent[];
  try {
    dirents = readdirSync(activeDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return null;
  }

  for (const e of dirents) {
    if (!e.isDirectory()) continue;
    const summary = summarizeActiveTask(join(activeDir, e.name), e.name);
    if (summary !== null) return summary;
  }

  return null;
}

/**
 * Summary for one specific active task id, or null when it is not
 * in-flight. Used by the working-context header to render the task this
 * session is actually on (resolved by session affinity) rather than the
 * first/arbitrary active task.
 */
export function readTaskSummaryById(
  repoRoot: string,
  taskId: string,
): ActiveTaskSummary | null {
  return summarizeActiveTask(cairnDir(repoRoot, "tasks", "active", taskId), taskId);
}

/**
 * Resolve which active task THIS session is on, for multi-task /
 * multi-window correctness. Among in-flight tasks, prefer one this
 * session created or last journaled (`created_by_session` /
 * `last_journal_session` on status.yaml); fall back to the most-recently
 * touched active task. Returns null when nothing is in flight.
 *
 * Without this, two Claude windows on one checkout would both surface
 * whichever task was globally first/most-recent — wrong frame.
 */
export function resolveSessionTaskId(
  repoRoot: string,
  sessionId: string | null,
): string | null {
  const activeDir = cairnDir(repoRoot, "tasks", "active");
  if (!existsSync(activeDir)) return null;

  let dirents: Dirent[];
  try {
    dirents = readdirSync(activeDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return null;
  }

  const sid = sessionId !== null && sessionId.length > 0 ? sessionId : null;
  const candidates: Array<{ taskId: string; mtimeMs: number; owned: boolean }> = [];
  for (const e of dirents) {
    if (!e.isDirectory()) continue;
    const statusPath = join(activeDir, e.name, "status.yaml");
    if (!existsSync(statusPath)) continue;
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(statusPath, "utf8"));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const o = parsed as Record<string, unknown>;
    const phase = o["phase"];
    if (typeof phase !== "string" || !ACTIVE_PHASES.has(phase)) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(statusPath).mtimeMs;
    } catch {
      // keep 0 — undated tasks sort last
    }
    const owned =
      sid !== null &&
      (o["last_journal_session"] === sid || o["created_by_session"] === sid);
    candidates.push({ taskId: e.name, mtimeMs, owned });
  }
  if (candidates.length === 0) return null;

  const byRecent = (
    a: { mtimeMs: number },
    b: { mtimeMs: number },
  ): number => b.mtimeMs - a.mtimeMs;
  const owned = candidates.filter((c) => c.owned).sort(byRecent);
  if (owned.length > 0) return owned[0]!.taskId;
  return candidates.sort(byRecent)[0]!.taskId;
}

/** Read one active task dir into a summary, or null when not in-flight. */
function summarizeActiveTask(taskDir: string, taskId: string): ActiveTaskSummary | null {
  const statusPath = join(taskDir, "status.yaml");
  if (!existsSync(statusPath)) return null;

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(statusPath, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const phase = (parsed as { phase?: unknown }).phase;
  if (typeof phase !== "string" || !ACTIVE_PHASES.has(phase)) return null;

  let title = taskId;
  const specPath = join(taskDir, "spec.tightened.md");
  if (existsSync(specPath)) {
    try {
      const specText = readFileSync(specPath, "utf8");
      const body = parseFrontmatter(specText).body;
      const m = body.match(/^#\s+(.+)$/m);
      if (m && m[1]) title = m[1].trim();
    } catch {
      // fall through to taskId
    }
  }

  return { taskId, taskState: mapPhase(phase), taskModule: title };
}

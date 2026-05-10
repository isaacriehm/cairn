import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  countDonePhases,
  findActiveMission,
  readMissionState,
  readRoadmap,
} from "@isaacriehm/cairn-state";
import { readProgress } from "../init/progress.js";
import {
  type CtxMeterInput,
  type MissionCursorInput,
  formatStatus,
  renderCtxMeter,
  renderMissionSegment,
} from "./format.js";
import { emptyEventCounters, type StatusJson, type TaskState } from "./index.js";
import { defaultStatusJson, statusJsonPath } from "./writer.js";

/**
 * Read the active mission's cursor for the statusline. Returns null
 * when no mission is active (no segment rendered).
 *
 * Hot path — invoked on every Claude Code prompt; bail fast on the
 * common "no active mission" case before parsing roadmap/state.
 */
function readMissionCursorForStatusline(repoRoot: string): MissionCursorInput | null {
  const id = findActiveMission(repoRoot);
  if (id === null) return null;
  const state = readMissionState(repoRoot, id);
  const roadmap = readRoadmap(repoRoot, id);
  if (state === null || roadmap === null) return null;
  if (state.cursor.active_phase === null) return null;
  // Slug = "MIS-<slug>-<hash7>" → strip prefix + suffix
  const slug = id.replace(/^MIS-/, "").replace(/-[0-9a-f]{7}$/, "");
  return {
    slug,
    phase_id: state.cursor.active_phase,
    done: countDonePhases(state),
    total: roadmap.frontmatter.phases.length,
  };
}

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

function isStatusJsonCore(x: unknown): x is Partial<StatusJson> {
  if (x === null || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o["updated_at"] === "string" &&
    typeof o["decisions_in_scope"] === "number" &&
    typeof o["invariants_in_scope"] === "number" &&
    isTaskState(o["task_state"]) &&
    isStringOrNull(o["task_id"]) &&
    isStringOrNull(o["task_module"]) &&
    typeof o["gc_running"] === "boolean" &&
    typeof o["attention_count"] === "number" &&
    typeof o["bypass_count"] === "number" &&
    isLastRunResult(o["last_run_result"]) &&
    isStringOrNull(o["last_run_at"])
  );
}

/**
 * Backfill v0.5.0 fields (`current_event`, `event_counters`, `recent_events`,
 * `haiku_unavailable`) when reading a status.json that was written by an
 * older cairn — keeps the format renderer from crashing on undefined
 * event_counters in mid-upgrade sessions.
 */
function normalizeStatusJson(partial: Partial<StatusJson>): StatusJson {
  const base = defaultStatusJson();
  return {
    ...base,
    ...partial,
    event_counters: { ...emptyEventCounters(), ...(partial.event_counters ?? {}) },
    recent_events: partial.recent_events ?? [],
    current_event: partial.current_event ?? null,
    haiku_unavailable: partial.haiku_unavailable ?? false,
  };
}

/**
 * Ground-state fallback when no per-session status.json is available.
 * Counts pending drafts from `_inbox/`; renders `⬡ cairn  ⚑ N drafts` or
 * just `⬡ cairn`. Returns empty string when `.cairn/` is absent.
 *
 * Mid-adoption: `.cairn/init/progress.json` exists and overrides everything
 * else with the live `⏳ adopt …` indicator so the operator sees motion
 * during long ingestion phases.
 *
 * Ctx meter is appended when supplied — operator-side dropdown stays
 * informative even when the session hook hasn't written status yet.
 */
function groundStateFallback(repoRoot: string, ctx?: CtxMeterInput): string {
  const cairnDir = join(repoRoot, ".cairn");
  if (!existsSync(cairnDir)) return "";

  const progress = readProgress(repoRoot);
  if (progress !== null) {
    return formatStatus(defaultStatusJson(), ctx, progress);
  }

  let drafts = 0;
  const inboxDir = join(cairnDir, "ground", "decisions", "_inbox");
  if (existsSync(inboxDir)) {
    try {
      drafts = readdirSync(inboxDir, { encoding: "utf8" }).filter((f) =>
        f.endsWith(".draft.md"),
      ).length;
    } catch {
      drafts = 0;
    }
  }

  const mission = readMissionCursorForStatusline(repoRoot);

  const parts: string[] = ["⬡ cairn"];
  if (drafts > 0) {
    const noun = drafts === 1 ? "draft" : "drafts";
    parts.push(`⚑ ${drafts} ${noun}`);
  }
  if (mission !== null) parts.push(renderMissionSegment(mission));
  if (ctx) parts.push(renderCtxMeter(ctx));
  return parts.join("  ");
}

/**
 * Render the current status-line string for a session inside the
 * adopted repo at `repoRoot`. `sessionId` is the Claude Code session id
 * (passed via the status-line hook's stdin payload). `ctx` is the
 * decoded `context_window` block from the same payload.
 *
 * Falls back to ground-state summary when:
 *   - `sessionId` is null/empty
 *   - the per-session status.json is missing, unreadable, or malformed
 *
 * Returns empty string when `.cairn/` doesn't exist (cairn not adopted).
 *
 * Hot path — invoked on every Claude Code prompt. Keep this cheap.
 */
export function readStatusForCLI(
  repoRoot: string,
  sessionId: string | null,
  ctx?: CtxMeterInput,
): string {
  if (sessionId === null || sessionId.length === 0) return groundStateFallback(repoRoot, ctx);
  const filePath = statusJsonPath(repoRoot, sessionId);
  if (!existsSync(filePath)) return groundStateFallback(repoRoot, ctx);

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return groundStateFallback(repoRoot, ctx);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return groundStateFallback(repoRoot, ctx);
  }

  if (!isStatusJsonCore(parsed)) return groundStateFallback(repoRoot, ctx);

  // Mid-adoption: live progress wins over the per-session signal.
  const progress = readProgress(repoRoot);
  const mission = readMissionCursorForStatusline(repoRoot);
  return formatStatus(normalizeStatusJson(parsed), ctx, progress, Date.now(), mission);
}

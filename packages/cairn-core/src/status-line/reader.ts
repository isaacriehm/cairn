import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cairnDir,
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
  const cursor = state.cursor.active_phase;
  if (cursor === null) return null;
  const phaseDef = roadmap.frontmatter.phases.find((p) => p.id === cursor);
  const phase_title = phaseDef?.title ?? cursor;
  return {
    phase_title,
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
 * Read per-repo adoption state from the Claude Code plugin data dir.
 *
 * The cairn-adopt skill records operator consent picks in
 * `~/.claude/plugins/data/cairn-*-cairn/projects.json` keyed by absolute
 * repo path. We don't know the marketplace slug at read time (multiple
 * plugin installs can coexist), so glob every `cairn-*` data dir and
 * pick the most recent record for this repo. Returns:
 *
 *   - "adopted"  → `.cairn/` exists on disk (no projects.json needed)
 *   - "declined" → most recent record is `decline-never`
 *   - "deferred" → most recent record is `decline-temp` (re-prompt later)
 *   - "fresh"    → no record, no `.cairn/` → operator hasn't decided
 */
export type AdoptionState = "adopted" | "declined" | "deferred" | "fresh";

export function readAdoptionState(repoRoot: string): AdoptionState {
  if (existsSync(cairnDir(repoRoot))) return "adopted";

  const dataRoot = join(homedir(), ".claude", "plugins", "data");
  if (!existsSync(dataRoot)) return "fresh";

  let mostRecent: { state: string; ts: number } | null = null;
  let candidates: string[];
  try {
    candidates = readdirSync(dataRoot);
  } catch {
    return "fresh";
  }
  for (const slug of candidates) {
    if (!slug.startsWith("cairn-") || !slug.endsWith("-cairn")) continue;
    const path = join(dataRoot, slug, "projects.json");
    if (!existsSync(path)) continue;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const rec = (parsed as Record<string, unknown>)[repoRoot];
    if (rec === null || typeof rec !== "object") continue;
    const r = rec as Record<string, unknown>;
    const state = typeof r["state"] === "string" ? r["state"] : "";
    const tsStr = typeof r["ts"] === "string" ? r["ts"] : "";
    const tsMs = tsStr.length > 0 ? Date.parse(tsStr) : 0;
    if (mostRecent === null || tsMs > mostRecent.ts) {
      mostRecent = { state, ts: tsMs };
    }
  }
  if (mostRecent === null) return "fresh";
  if (mostRecent.state === "decline-never") return "declined";
  if (mostRecent.state === "decline-temp") return "deferred";
  return "fresh";
}

/**
 * Render a minimal `⬡ cairn` badge variant when the project is not
 * fully adopted. Operator asked the bar to always show:
 *
 *   - declined → `⬡ cairn  ⊘ off`           (operator opted out — permanent)
 *   - deferred → `⬡ cairn  ⊝ later`         (decline-temp; will re-prompt)
 *   - fresh    → `⬡ cairn  ⊝ not adopted`   (no decision yet)
 *
 * `⊘` (U+2298 CIRCLED DIVISION SLASH) is the universal "off / not in
 * use" glyph; renders cleanly in monospace. Prior attempts: `💤`
 * (emoji, tofu-box risk), `☾` (crescent, ambiguous with night-mode),
 * `⏸` (PAUSE — misleading because it implies temporary suspension
 * when decline-never is permanent for this repo).
 */
function renderUnadoptedBadge(state: AdoptionState, ctx?: CtxMeterInput): string {
  const tail: string =
    state === "declined"
      ? "⊘ off"
      : state === "deferred"
        ? "⊝ later"
        : "⊝ not adopted";
  const parts: string[] = ["⬡ cairn", tail];
  if (ctx) parts.push(renderCtxMeter(ctx));
  return parts.join("  ");
}

/**
 * Ground-state fallback when no per-session status.json is available.
 * Counts pending drafts from `_inbox/`; renders `⬡ cairn  ⚑ N drafts` or
 * just `⬡ cairn`. Always renders something — when `.cairn/` is absent
 * we surface adoption state instead of going dark.
 *
 * Mid-adoption: `.cairn/init/progress.json` exists and overrides everything
 * else with the live `⏳ adopt …` indicator so the operator sees motion
 * during long ingestion phases.
 *
 * Ctx meter is appended when supplied — operator-side dropdown stays
 * informative even when the session hook hasn't written status yet.
 */
function groundStateFallback(repoRoot: string, ctx?: CtxMeterInput): string {
  const repoHome = cairnDir(repoRoot);
  if (!existsSync(repoHome)) {
    return renderUnadoptedBadge(readAdoptionState(repoRoot), ctx);
  }

  const progress = readProgress(repoRoot);
  if (progress !== null) {
    return formatStatus(defaultStatusJson(), ctx, progress);
  }

  let drafts = 0;
  const inboxDir = join(repoHome, "ground", "decisions", "_inbox");
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

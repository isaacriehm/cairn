/**
 * Working-context header — the context engine's stage-1 surface.
 *
 * Per prompt (UserPromptSubmit), the server injects a compact "what am
 * I working on" frame so the agent never has to call `cairn_in_scope` /
 * `cairn_mission_get` to know its frame. This module builds that text +
 * a fingerprint; the runner injects it only when the fingerprint
 * changed (per-session dedup via session/seen.ts).
 *
 * The header is the PERSISTENT in-scope id INDEX (every prompt) — ids
 * only, no bodies. The stage-2 read-enricher shows each DEC/INV/
 * component BODY once per session. So the agent always knows WHAT is in
 * scope (this header) even after a body scrolled off (D13).
 *
 * Pure-FS, zero LLM — safe to run on every prompt inside a hook.
 *
 * Spec: docs/CONTEXT_ENGINE.md (stage 1), CAIRN_REBUILD §6 / D11–D13.
 */

import {
  cairnDir,
  findActiveMission,
  readMissionState,
  readRoadmap,
} from "@isaacriehm/cairn-state";
import { resolveSessionTaskId, readTaskSummaryById } from "./task-summary.js";
import { readTaskMissionAnchor } from "../missions/index.js";
import { readTaskSpec } from "../tasks/spec-reader.js";
import { fingerprintText } from "../session/seen.js";

export interface WorkingHeader {
  text: string;
  fingerprint: string;
}

const GOAL_MAX = 120;
const ID_LIST_CAP = 12;

/** Truncate at a word boundary, appending `…` when cut. */
function truncateAtWord(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const slice = flat.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/** Render up to `cap` ids, then `(+N more)`. Empty → "". */
function renderIdList(ids: string[], cap: number): string {
  if (ids.length === 0) return "";
  const head = ids.slice(0, cap);
  const extra = ids.length - head.length;
  const base = head.join(", ");
  return extra > 0 ? `${base} (+${extra} more)` : base;
}

/**
 * Build the working-context header for the repo's current frame, or
 * null when there is no active task AND no active mission (D11 — inject
 * nothing extra). When a task is active but has no in-scope ids, the
 * "In scope" line is omitted (active-task line only).
 */
export function buildWorkingHeader(
  repoRoot: string,
  sessionId: string | null,
): WorkingHeader | null {
  // Resolve the task THIS session is on (affinity), not a global pick —
  // correct when multiple tasks are active across windows.
  const taskId = resolveSessionTaskId(repoRoot, sessionId);
  const active = taskId !== null ? readTaskSummaryById(repoRoot, taskId) : null;

  // Mission: prefer the resolved task's own anchor (the mission + phase
  // this session is working) over a global scan — correct when several
  // missions are active. Fall back to the single active mission only
  // when there's no task to anchor on.
  const anchor =
    active !== null ? readTaskMissionAnchor(repoRoot, active.taskId) : null;
  const missionId = anchor?.mission_id ?? findActiveMission(repoRoot);
  const preferredPhaseId = anchor?.phase_id ?? null;

  if (active === null && missionId === null) return null;

  const lines: string[] = ["## Cairn — working context"];

  let hasInScope = false;

  if (active !== null) {
    const spec = readTaskSpec(cairnDir(repoRoot, "tasks", "active", active.taskId));
    const goal = spec !== null && spec.goal.length > 0 ? spec.goal : "";
    const parts: string[] = [`Active: ${active.taskId} (${active.taskState})`];
    if (goal.length > 0) parts.push(`— ${truncateAtWord(goal, GOAL_MAX)}`);
    if (active.taskModule.length > 0 && active.taskModule !== active.taskId) {
      parts.push(`· module ${active.taskModule}`);
    }
    lines.push(parts.join(" "));

    const decs = spec?.inScopeDecisions ?? [];
    const invs = spec?.inScopeInvariants ?? [];
    if (decs.length > 0 || invs.length > 0) {
      hasInScope = true;
      const segs: string[] = [];
      if (decs.length > 0) segs.push(renderIdList(decs, ID_LIST_CAP));
      if (invs.length > 0) segs.push(renderIdList(invs, ID_LIST_CAP));
      lines.push(`In scope: ${segs.join(" · ")}`);
    }
  }

  if (missionId !== null) {
    const missionLine = renderMissionLine(repoRoot, missionId, preferredPhaseId);
    if (missionLine !== null) lines.push(missionLine);
  }

  if (hasInScope) {
    lines.push("Bodies on demand: cairn_decision_get / cairn_invariant_get.");
  }

  const text = lines.join("\n");
  return { text, fingerprint: fingerprintText(text) };
}

/**
 * `Mission: <title> — phase <i>/<n> "<phase title>"`. Degrades to a
 * title-only line when the cursor phase can't be located, and to null
 * when the mission state/roadmap is unreadable (D-graceful: never throw).
 */
function renderMissionLine(
  repoRoot: string,
  missionId: string,
  preferredPhaseId: string | null,
): string | null {
  const roadmap = readRoadmap(repoRoot, missionId);
  const state = readMissionState(repoRoot, missionId);
  if (roadmap === null) return null;

  const title = roadmap.frontmatter.title;
  const phases = roadmap.frontmatter.phases;
  // The task anchor's phase wins (the phase THIS session is working);
  // fall back to the mission cursor when there's no task anchor.
  const activePhase = preferredPhaseId ?? state?.cursor.active_phase ?? null;

  if (activePhase !== null) {
    const idx = phases.findIndex((p) => p.id === activePhase);
    if (idx >= 0) {
      const phase = phases[idx];
      const phaseTitle = phase !== undefined ? phase.title : activePhase;
      return `Mission: ${title} — phase ${idx + 1}/${phases.length} "${phaseTitle}"`;
    }
  }
  return `Mission: ${title}`;
}

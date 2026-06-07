/**
 * Mission-system I/O — schema-validated reads + writes for the
 * mission surfaces: `.cairn/ground/missions/<id>/roadmap.md`
 * (committed) and `.cairn/missions/<id>/{state.json,spec.md,journal.jsonl}`
 * (per-clone).
 *
 * Pure low-level I/O; no MCP, no hooks, no LLM calls. The MCP layer in
 * `cairn-core` composes these primitives into the operator-facing
 * `cairn_mission_*` tools.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseFrontmatterRecord } from "./frontmatter.js";
import {
  missionBriefPath,
  missionGroundDir,
  missionRoadmapPath,
  missionRuntimeDir,
  missionSpecPath,
  missionStatePath,
  missionJournalPath,
  missionsGroundDoneRoot,
  missionsGroundRoot,
  missionsRuntimeDoneRoot,
  missionsRuntimeRoot,
} from "./paths.js";
import {
  type MissionExitGate,
  type MissionJournalEntry,
  type MissionPhase,
  type MissionPhaseProgressEntry,
  MissionPhaseBrief,
  MissionRoadmapFrontmatter,
  MissionState,
} from "./schemas.js";

export interface ParsedRoadmap {
  frontmatter: MissionRoadmapFrontmatter;
  prose: string;
}

/* -------------------------------------------------------------------------- */
/* Roadmap (committed `.cairn/ground/missions/<id>/roadmap.md`)               */
/* -------------------------------------------------------------------------- */

/**
 * Parse a roadmap.md source string into validated frontmatter + prose
 * body. Throws when frontmatter is missing or fails schema validation —
 * roadmap.md is the contract; an unreadable roadmap is a hard error,
 * not a soft fallback.
 */
export function parseRoadmap(source: string): ParsedRoadmap {
  const { fm, body } = parseFrontmatterRecord(source);
  if (Object.keys(fm).length === 0) {
    throw new Error("roadmap.md is missing frontmatter");
  }
  const result = MissionRoadmapFrontmatter.safeParse(fm);
  if (!result.success) {
    throw new Error(`roadmap.md frontmatter invalid: ${result.error.message}`);
  }
  return { frontmatter: result.data, prose: body };
}

export function serializeRoadmap(
  frontmatter: MissionRoadmapFrontmatter,
  prose: string = "",
): string {
  const yaml = stringifyYaml(frontmatter);
  const trimmedProse = prose.replace(/^\n+/, "");
  return `---\n${yaml}---\n\n${trimmedProse}`;
}

export function readRoadmap(
  repoRoot: string,
  missionId: string,
): ParsedRoadmap | null {
  const path = missionRoadmapPath(repoRoot, missionId);
  if (!existsSync(path)) return null;
  const source = readFileSync(path, "utf8");
  return parseRoadmap(source);
}

export function writeRoadmap(
  repoRoot: string,
  missionId: string,
  frontmatter: MissionRoadmapFrontmatter,
  prose: string = "",
): void {
  const path = missionRoadmapPath(repoRoot, missionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeRoadmap(frontmatter, prose), "utf8");
}

/* -------------------------------------------------------------------------- */
/* Per-phase brief (committed `.cairn/ground/missions/<id>/briefs/<id>.md`)    */
/* -------------------------------------------------------------------------- */

export interface ParsedPhaseBrief {
  frontmatter: MissionPhaseBrief;
  prose: string;
}

export function parsePhaseBrief(source: string): ParsedPhaseBrief {
  const { fm, body } = parseFrontmatterRecord(source);
  if (Object.keys(fm).length === 0) {
    throw new Error("phase brief is missing frontmatter");
  }
  const result = MissionPhaseBrief.safeParse(fm);
  if (!result.success) {
    throw new Error(`phase brief frontmatter invalid: ${result.error.message}`);
  }
  return { frontmatter: result.data, prose: body };
}

/**
 * Render a human-readable brief: YAML frontmatter (the canonical
 * machine surface) plus a mirrored markdown body so the file reads
 * cleanly in a diff or editor. The body is derived from the frontmatter
 * on every write — it is never the source of truth.
 */
export function serializePhaseBrief(
  brief: MissionPhaseBrief,
  prose: string = "",
): string {
  const yaml = stringifyYaml(brief);
  const sections: string[] = [`# Phase brief — ${brief.phase_id}`, ""];
  if (brief.decisions.length > 0) {
    sections.push("## Decisions", "");
    for (const d of brief.decisions) {
      sections.push(
        `- **${d.question}** → ${d.choice}${d.rationale ? ` _(${d.rationale})_` : ""}`,
      );
    }
    sections.push("");
  }
  if (brief.constraints.length > 0) {
    sections.push("## Constraints", "");
    for (const c of brief.constraints) sections.push(`- ${c}`);
    sections.push("");
  }
  if (brief.acceptance.length > 0) {
    sections.push("## Acceptance", "");
    for (const a of brief.acceptance) sections.push(`- ${a}`);
    sections.push("");
  }
  const cites = [...brief.cite_decisions, ...brief.cite_invariants];
  if (cites.length > 0) {
    sections.push("## In-scope ground state", "");
    sections.push(cites.map((c) => `\`${c}\``).join(" · "));
    sections.push("");
  }
  const extraProse = prose.replace(/^\n+/, "").trimEnd();
  const body = extraProse.length > 0
    ? `${sections.join("\n")}\n${extraProse}\n`
    : `${sections.join("\n")}\n`;
  return `---\n${yaml}---\n\n${body}`;
}

export function readPhaseBrief(
  repoRoot: string,
  missionId: string,
  phaseId: string,
): MissionPhaseBrief | null {
  const path = missionBriefPath(repoRoot, missionId, phaseId);
  if (!existsSync(path)) return null;
  try {
    return parsePhaseBrief(readFileSync(path, "utf8")).frontmatter;
  } catch {
    return null;
  }
}

export function writePhaseBrief(
  repoRoot: string,
  missionId: string,
  brief: MissionPhaseBrief,
  prose: string = "",
): void {
  const path = missionBriefPath(repoRoot, missionId, brief.phase_id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializePhaseBrief(brief, prose), "utf8");
}

/* -------------------------------------------------------------------------- */
/* Mission state (per-clone `.cairn/missions/<id>/state.json`)                */
/* -------------------------------------------------------------------------- */

export function readMissionState(
  repoRoot: string,
  missionId: string,
): MissionState | null {
  const path = missionStatePath(repoRoot, missionId);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = MissionState.safeParse(parsed);
  return result.success ? result.data : null;
}

export function writeMissionState(
  repoRoot: string,
  missionId: string,
  state: MissionState,
): void {
  const path = missionStatePath(repoRoot, missionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/* -------------------------------------------------------------------------- */
/* Spec snapshot (per-clone `.cairn/missions/<id>/spec.md`)                   */
/* -------------------------------------------------------------------------- */

export function readMissionSpec(
  repoRoot: string,
  missionId: string,
): string | null {
  const path = missionSpecPath(repoRoot, missionId);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function writeMissionSpec(
  repoRoot: string,
  missionId: string,
  source: string,
): void {
  const path = missionSpecPath(repoRoot, missionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf8");
}

/* -------------------------------------------------------------------------- */
/* Mission journal (per-clone `.cairn/missions/<id>/journal.jsonl`)           */
/* -------------------------------------------------------------------------- */

export function appendMissionJournal(
  repoRoot: string,
  missionId: string,
  entry: MissionJournalEntry,
): void {
  const path = missionJournalPath(repoRoot, missionId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

export function readMissionJournal(
  repoRoot: string,
  missionId: string,
): MissionJournalEntry[] {
  const path = missionJournalPath(repoRoot, missionId);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: MissionJournalEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as MissionJournalEntry;
      if (typeof parsed === "object" && parsed !== null && typeof parsed.ts === "string") {
        out.push(parsed);
      }
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Discovery + cursor helpers                                                 */
/* -------------------------------------------------------------------------- */

function listMissionsIn(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith("MIS-"))
    .map((e) => e.name);
}

/** Mission ids present in `.cairn/ground/missions/` (excluding `_done`). */
export function listActiveMissionIds(repoRoot: string): string[] {
  return listMissionsIn(missionsGroundRoot(repoRoot));
}

/** Mission ids present in `.cairn/ground/missions/_done/`. */
export function listDoneMissionIds(repoRoot: string): string[] {
  return listMissionsIn(missionsGroundDoneRoot(repoRoot));
}

/**
 * Find the single active mission id for this clone, if any. v1 enforces
 * one active mission per repo. When multiple mission dirs exist,
 * returns the one whose state.json reports `outcome: active` and a
 * non-null `cursor.active_phase`. Falls back to the lexically first
 * active id when ambiguous; mismatch is a state corruption operators
 * surface via `cairn doctor`.
 */
export function findActiveMission(repoRoot: string): string | null {
  const ids = listActiveMissionIds(repoRoot);
  for (const id of ids) {
    const state = readMissionState(repoRoot, id);
    if (state === null) continue;
    if (state.outcome === "active") return id;
  }
  return null;
}

/**
 * Resolve the effective exit gate for a phase: per-phase override on the
 * roadmap entry takes precedence, falls through to the mission-level
 * `frontmatter.exit_gate`.
 */
export function effectivePhaseExitGate(
  roadmap: MissionRoadmapFrontmatter,
  phaseId: string,
): MissionExitGate | null {
  const phase = roadmap.phases.find((p) => p.id === phaseId);
  if (phase === undefined) return null;
  return phase.exit_gate ?? roadmap.exit_gate;
}

/**
 * Compute the next pending phase whose `depends_on` set is fully
 * satisfied (all listed phases sit at `state: done` in
 * `phase_progress`). Returns null when no eligible phase exists —
 * either every phase is done, or all remaining are blocked by
 * unresolved dependencies (which is a soft conflict surfaced as
 * mission_drift).
 *
 * Walks roadmap order; the first eligible pending phase wins. Operators
 * can re-order phases by hand-editing roadmap.md.
 */
export function nextPendingPhase(
  roadmap: MissionRoadmapFrontmatter,
  state: MissionState,
): MissionPhase | null {
  for (const phase of roadmap.phases) {
    const progress = state.phase_progress[phase.id];
    const phaseState = progress?.state ?? "pending";
    if (phaseState !== "pending") continue;
    const depsSatisfied = phase.depends_on.every((dep) => {
      const depProgress = state.phase_progress[dep];
      return depProgress?.state === "done";
    });
    if (depsSatisfied) return phase;
  }
  return null;
}

/**
 * Number of phases at `state: done`. Used by statusline `(N/M)` and the
 * SessionStart cursor banner.
 */
export function countDonePhases(state: MissionState): number {
  let n = 0;
  for (const entry of Object.values(state.phase_progress)) {
    if (entry.state === "done") n += 1;
  }
  return n;
}

/**
 * Initial empty `phase_progress` map for a fresh mission — every
 * roadmap phase id present at `state: pending` with no task_ids.
 */
export function initialPhaseProgress(
  roadmap: MissionRoadmapFrontmatter,
): Record<string, MissionPhaseProgressEntry> {
  const out: Record<string, MissionPhaseProgressEntry> = {};
  for (const phase of roadmap.phases) {
    out[phase.id] = { state: "pending", task_ids: [] };
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Archive / restore                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Move a closed mission's ground roadmap dir + per-clone runtime dir
 * under their respective `_done/` archives. Idempotent on already-
 * archived missions (returns false).
 */
export function archiveMission(repoRoot: string, missionId: string): boolean {
  const groundFrom = missionGroundDir(repoRoot, missionId);
  const runtimeFrom = missionRuntimeDir(repoRoot, missionId);
  let moved = false;
  if (existsSync(groundFrom)) {
    const dest = `${missionsGroundDoneRoot(repoRoot)}/${missionId}`;
    mkdirSync(missionsGroundDoneRoot(repoRoot), { recursive: true });
    renameSync(groundFrom, dest);
    moved = true;
  }
  if (existsSync(runtimeFrom)) {
    const dest = `${missionsRuntimeDoneRoot(repoRoot)}/${missionId}`;
    mkdirSync(missionsRuntimeDoneRoot(repoRoot), { recursive: true });
    renameSync(runtimeFrom, dest);
    moved = true;
  }
  return moved;
}

/**
 * Reverse of `archiveMission` — move the mission's archived dirs back
 * into the live locations. Returns false if neither archive is
 * present.
 */
export function restoreMission(repoRoot: string, missionId: string): boolean {
  const groundFrom = `${missionsGroundDoneRoot(repoRoot)}/${missionId}`;
  const runtimeFrom = `${missionsRuntimeDoneRoot(repoRoot)}/${missionId}`;
  let moved = false;
  if (existsSync(groundFrom)) {
    mkdirSync(missionsGroundRoot(repoRoot), { recursive: true });
    renameSync(groundFrom, missionGroundDir(repoRoot, missionId));
    moved = true;
  }
  if (existsSync(runtimeFrom)) {
    mkdirSync(missionsRuntimeRoot(repoRoot), { recursive: true });
    renameSync(runtimeFrom, missionRuntimeDir(repoRoot, missionId));
    moved = true;
  }
  return moved;
}

/**
 * Locate a mission id whether it's live or archived. Returns the
 * matching scope so callers can decide to read from `_done` paths.
 */
export function locateMission(
  repoRoot: string,
  missionId: string,
): "active" | "done" | null {
  if (existsSync(missionGroundDir(repoRoot, missionId))) return "active";
  if (existsSync(`${missionsGroundDoneRoot(repoRoot)}/${missionId}`)) return "done";
  return null;
}

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Re-parse the live roadmap and return phase ids the mission's current
 * `phase_progress` references that no longer appear in roadmap.md.
 * These are the `mission_drift` candidates — phases the operator
 * deleted from the roadmap mid-mission. Empty array on no drift.
 */
export function detectRoadmapDrift(
  roadmap: MissionRoadmapFrontmatter,
  state: MissionState,
): string[] {
  const liveIds = new Set(roadmap.phases.map((p) => p.id));
  return Object.keys(state.phase_progress).filter((id) => !liveIds.has(id));
}

/**
 * Slice the per-clone spec.md by phase heading. Returns the body text
 * under the `## <phase title>` heading or `## <phase id>` heading,
 * stopping at the next `##` heading. Returns null if no slice matches.
 *
 * Used by cairn_mission_resume to prime fresh chats with only the
 * relevant phase section instead of the whole spec doc.
 */
export function slicePhaseSection(
  spec: string,
  phase: MissionPhase,
): string | null {
  const lines = spec.split(/\r?\n/);
  const matchTitles = [phase.title, phase.id]
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]?.match(/^##\s+(.+?)\s*$/);
    if (m === null || m === undefined) continue;
    const heading = (m[1] ?? "").toLowerCase();
    if (matchTitles.some((t) => heading.includes(t))) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]?.match(/^##\s+/)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

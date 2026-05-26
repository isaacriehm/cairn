/**
 * `buildSessionStartContext` — composes the SessionStart payload from
 * a cairn-adopted repo's state. Read-only; no side effects beyond
 * filesystem reads.
 */

import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildHandoffBlock } from "../context/index.js";
import {
  buildDecisionsLedger,
  buildInvariantsLedger,
  countDonePhases,
  detectRoadmapDrift,
  effectivePhaseExitGate,
  findActiveMission,
  parseFrontmatter,
  readMissionState,
  readRoadmap,
} from "@isaacriehm/cairn-state";
import { allPhaseTasksDone } from "../missions/cursor.js";
import { loadSensorRegistry } from "../sensors/catalog.js";
import {
  CODE_CHANGE_CONTRACT,
  SESSION_START_HEADER,
  TWO_ZONE_REMINDER_BASE,
} from "./templates.js";

type SessionStartSource = "startup" | "resume" | "clear" | "compact" | string;

export type SessionStartSection =
  | "first_session_onboarding"
  | "run_handoff"
  | "header"
  | "code_change_contract"
  | "two_zone_reminder"
  | "brand_and_positioning"
  | "decisions_in_scope"
  | "invariants_active"
  | "current_task"
  | "quality_grades_tail"
  | "pending_drafts"
  | "active_mission";

export interface BuildSessionStartContextArgs {
  /** Resolved repo root (the dir containing `.cairn/`). */
  repoRoot: string;
  /** Optional cwd-relative subdir for narrowing decisions/invariants scope. */
  scopeRelPath?: string;
  /** Hook source per Claude Code SessionStart payload. */
  source?: SessionStartSource;
  /** Total char cap. Default 12000 (~3K tokens). */
  maxChars?: number;
}

export interface BuildSessionStartContextResult {
  /** Final assembled `additionalContext` string. */
  additionalContext: string;
  /** Sections that survived truncation, in render order. */
  sectionsRendered: SessionStartSection[];
  /** Sections that were dropped due to budget. */
  sectionsDropped: SessionStartSection[];
  /** Char count of the final string. */
  totalChars: number;
  /** Diagnostic counts for telemetry. */
  counts: {
    decisions: number;
    invariants: number;
    pendingDrafts: number;
    qualityGrades: number;
    activeTasks: number;
    /** Findings in the latest baseline sensor audit (un-suppressed). */
    baselineFindings: number;
    /** Sum of `drift_count` across all quality grades. */
    driftFindings: number;
  };
  /** Soft warnings (e.g. malformed frontmatter). Logged, not blocking. */
  warnings: string[];
}

const DEFAULT_MAX_CHARS = 12_000;
const DECISIONS_CAP = 15;
const INVARIANTS_CAP = 10;
const DRAFTS_CAP = 5;
const QUALITY_TAIL_CAP = 3;
const TASK_BODY_CAP = 800;

/**
 * Resolve to the canonical adopted-cairn checkout for the given `cwd`.
 *
 * Adoption is identified by `.cairn/config.yaml` — the file Phase 3b-seed
 * writes. A bare `.cairn/` directory without `config.yaml` is template
 * content (e.g. `cairn-core/templates/.cairn/`), NOT a real adopted
 * project; skip it so hooks running against the cairn source tree don't
 * false-positive on the template.
 *
 * **Worktree handling.** When `cwd` is a git worktree (`git worktree add`
 * checkout), the worktree has its own `.cairn/` checkout from the tracked
 * tree — but `.cairn/.attested-commits`, `.cairn/sessions/`,
 * `.cairn/missions/<id>/state.json`, and other per-clone state files are
 * gitignored and live ONLY on the main checkout. Treating the worktree
 * as a separate `repoRoot` splits per-clone state between two locations:
 * the MCP server (cwd-pinned at startup → main) writes to one `.cairn/`
 * while the Stop hook (payload.cwd → worktree) reads from another. The
 * resulting "5 commits not attested" cue re-fires forever because each
 * side only sees half the picture.
 *
 * Fix: prefer `git rev-parse --git-common-dir` and take its parent. Git's
 * common-dir is the same `.git` for main + every worktree, so its parent
 * is the canonical main checkout. From the main checkout `git-common-dir`
 * returns `.git` (relative); from a worktree it returns `<main>/.git`
 * (absolute). Both resolve to `<main>`. Worktrees share main's `.cairn/`.
 *
 * Falls back to the legacy ancestor-walk when git lookup fails (init
 * runs before `git init`, non-git contexts, missing git binary).
 *
 * Returns the dir containing the adopted `.cairn/` or null if none
 * found within 12 ancestors.
 */
export function resolveRepoRoot(cwd: string): string | null {
  const gitMain = resolveMainViaGitCommonDir(cwd);
  if (gitMain !== null && isAdoptedCairnDir(gitMain)) {
    return gitMain;
  }
  let dir = resolve(cwd);
  for (let i = 0; i < 12; i++) {
    if (isAdoptedCairnDir(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function isAdoptedCairnDir(dir: string): boolean {
  const cairnDir = join(dir, ".cairn");
  return (
    existsSync(cairnDir) &&
    statSync(cairnDir).isDirectory() &&
    existsSync(join(cairnDir, "config.yaml"))
  );
}

/**
 * Walk to the main checkout via `git rev-parse --git-common-dir`. Same
 * `.git` for every worktree, so its parent is the canonical main repo.
 * Returns null when the cwd is not inside a git working tree, the git
 * binary is unavailable, or the lookup otherwise fails.
 */
function resolveMainViaGitCommonDir(cwd: string): string | null {
  try {
    const out = execFileSync(
      "git",
      ["rev-parse", "--git-common-dir"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (out.length === 0) return null;
    const isAbsolute = out.startsWith("/") || /^[A-Za-z]:[\\/]/.test(out);
    const commonDir = isAbsolute ? out : resolve(cwd, out);
    return dirname(commonDir);
  } catch {
    return null;
  }
}

export async function buildSessionStartContext(
  args: BuildSessionStartContextArgs,
): Promise<BuildSessionStartContextResult> {
  const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS;
  const warnings: string[] = [];

  const counts: BuildSessionStartContextResult["counts"] = {
    decisions: 0,
    invariants: 0,
    pendingDrafts: 0,
    qualityGrades: 0,
    activeTasks: 0,
    baselineFindings: 0,
    driftFindings: 0,
  };

  const sectionsRendered: SessionStartSection[] = [];
  const sectionsDropped: SessionStartSection[] = [];

  // ── Section 0 — run handoff (CONTEXT_CONTINUITY_SPEC §4) ─────────────
  // Inject the prior-run handoff block when the hook source indicates a
  // boundary that benefits from it. `null` → no in-flight run / no
  // commits since sha_pin → section omitted entirely.
  let runHandoffSection: string | null = null;
  if (args.source === "resume" || args.source === "compact" || args.source === "startup") {
    try {
      runHandoffSection = await buildHandoffBlock(args.repoRoot);
    } catch (err) {
      warnings.push(
        `handoff builder failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const fixedHeader = SESSION_START_HEADER;
  const fixedTwoZone = TWO_ZONE_REMINDER_BASE;

  // ── Section 2 — decisions in scope ─────────────────────────────────
  // Only render the bodies when a `scopeRelPath` is supplied (task-in-
  // flight context). For idle sessions, ship only a summary line so the
  // operator's context isn't bloated by every accepted decision every
  // session — bare `§DEC-NNNN` / `§INV-NNNN` tokens in source resolve
  // on-demand via the read-enricher PostToolUse hook.
  const decisionEntries = safeBuildDecisionsLedger(args.repoRoot, warnings);
  counts.decisions = decisionEntries.length;
  const invariantEntries = safeBuildInvariantsLedger(args.repoRoot, warnings);
  counts.invariants = invariantEntries.length;

  let decisionsSection: string | null = null;
  let invariantsSection: string | null = null;

  const hasScope =
    typeof args.scopeRelPath === "string" &&
    args.scopeRelPath.length > 0 &&
    args.scopeRelPath !== ".";

  if (hasScope) {
    const filteredDecisions = filterDecisionsToScope(
      decisionEntries,
      args.scopeRelPath,
    );
    decisionsSection = renderDecisionsSection(filteredDecisions);

    const decisionScopeById = scopeMapFromDecisions(decisionEntries);
    const filteredInvariants = filterInvariantsToScope(
      invariantEntries,
      decisionScopeById,
      args.scopeRelPath,
    );
    invariantsSection = renderInvariantsSection(filteredInvariants);
  } else if (counts.decisions > 0 || counts.invariants > 0) {
    decisionsSection = renderGroundStateSummary(
      counts.decisions,
      counts.invariants,
    );
  }

  // ── Section 4 — current task ───────────────────────────────────────
  const tasks = listActiveTasks(args.repoRoot);
  counts.activeTasks = tasks.length;
  const currentTaskSection = renderCurrentTaskSection(args.repoRoot, tasks);

  // ── Section 5 — quality grades ─────────────────────────────────────
  const grades = readQualityGrades(args.repoRoot, warnings);
  counts.qualityGrades = grades.length;
  counts.driftFindings = grades.reduce((n, g) => n + g.drift_count, 0);
  const qualityGradesSection = renderQualityGradesSection(grades);

  // ── Section 6 — pending drafts ─────────────────────────────────────
  const drafts = listPendingDrafts(args.repoRoot, warnings);
  counts.pendingDrafts = drafts.length;
  const pendingDraftsSection = renderPendingDraftsSection(drafts);

  // ── Section 7 — active mission cursor ─────────────────────────────
  const activeMissionSection = renderActiveMissionSection(args.repoRoot, warnings);

  // Baseline findings drive the attention surface alongside drafts +
  // drift. Only HARD findings count — soft findings (e.g. the
  // commented-block-3-plus-lines pattern that fires on every
  // 3+-line commented block in the repo) are inventory for the
  // attestation cross-check, not actionable attention. Surfacing
  // 500+ soft findings as "⚑ N pending" gives the operator a count
  // they can't drain item-by-item.
  const latestBaseline = readLatestBaselineAudit(args.repoRoot, warnings);
  counts.baselineFindings = latestBaseline?.hardFindings ?? 0;

  // ── Section 1.5 — brand + product positioning (always injected) ───
  const brandAndPositioningSection = readBrandAndPositioning(args.repoRoot, warnings);

  // ── First-session onboarding block ────────────────────────────────
  // Fires once: decisions_count === 0 AND invariants_count === 0 AND a
  // baseline audit yaml exists. After the first DEC is accepted, the
  // condition no longer holds and this section disappears for good.
  let firstSessionOnboardingSection: string | null = null;
  if (counts.decisions === 0 && counts.invariants === 0) {
    firstSessionOnboardingSection = renderFirstSessionOnboarding({
      repoRoot: args.repoRoot,
      pendingDrafts: counts.pendingDrafts,
      warnings,
    });
  }

  // Truncation strategy per spec: always include 1 + 7; then 4, 2, 3,
  // 6, 5; drop in reverse order if over cap.
  const orderedSections: { id: SessionStartSection; body: string }[] = [];
  if (firstSessionOnboardingSection !== null) {
    orderedSections.push({
      id: "first_session_onboarding",
      body: firstSessionOnboardingSection,
    });
  }
  if (runHandoffSection !== null) {
    orderedSections.push({ id: "run_handoff", body: runHandoffSection });
  }
  orderedSections.push({ id: "header", body: fixedHeader });
  orderedSections.push({ id: "code_change_contract", body: CODE_CHANGE_CONTRACT });
  orderedSections.push({ id: "two_zone_reminder", body: fixedTwoZone });
  if (brandAndPositioningSection !== null) {
    orderedSections.push({ id: "brand_and_positioning", body: brandAndPositioningSection });
  }
  if (activeMissionSection !== null) {
    orderedSections.push({ id: "active_mission", body: activeMissionSection });
  }
  if (currentTaskSection !== null) {
    orderedSections.push({ id: "current_task", body: currentTaskSection });
  }
  if (decisionsSection !== null) {
    orderedSections.push({ id: "decisions_in_scope", body: decisionsSection });
  }
  if (invariantsSection !== null) {
    orderedSections.push({ id: "invariants_active", body: invariantsSection });
  }
  if (pendingDraftsSection !== null) {
    orderedSections.push({ id: "pending_drafts", body: pendingDraftsSection });
  }
  if (qualityGradesSection !== null) {
    orderedSections.push({ id: "quality_grades_tail", body: qualityGradesSection });
  }

  // Greedy fill within budget; dropping in reverse order lets us keep
  // the load-bearing sections (header / reminder / tools) while
  // shedding optional context first.
  const dropPriority: SessionStartSection[] = [
    "quality_grades_tail",
    "pending_drafts",
    "brand_and_positioning",
    "invariants_active",
    "decisions_in_scope",
    "current_task",
    "active_mission",
    "two_zone_reminder",
    "header",
    "code_change_contract",
    "run_handoff",
    "first_session_onboarding",
  ];

  let kept = orderedSections.slice();
  while (computeTotalChars(kept) > maxChars && kept.length > 0) {
    let dropped = false;
    for (const candidate of dropPriority) {
      const idx = kept.findIndex((s) => s.id === candidate);
      if (idx !== -1) {
        sectionsDropped.push(candidate);
        kept.splice(idx, 1);
        dropped = true;
        break;
      }
    }
    if (!dropped) break;
  }

  for (const s of kept) sectionsRendered.push(s.id);
  // Anything in orderedSections that ended up not in `kept` is in
  // sectionsDropped above; deduplicate while preserving order.
  const seenDropped = new Set<SessionStartSection>(sectionsDropped);
  for (const s of orderedSections) {
    if (!sectionsRendered.includes(s.id) && !seenDropped.has(s.id)) {
      sectionsDropped.push(s.id);
      seenDropped.add(s.id);
    }
  }

  const additionalContext = kept.map((s) => s.body).join("\n\n");
  return {
    additionalContext,
    sectionsRendered,
    sectionsDropped,
    totalChars: additionalContext.length,
    counts,
    warnings,
  };
}

function renderActiveMissionSection(repoRoot: string, warnings: string[]): string | null {
  let missionId: string | null;
  try {
    missionId = findActiveMission(repoRoot);
  } catch (err) {
    warnings.push(`mission lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (missionId === null) return null;
  let roadmap: ReturnType<typeof readRoadmap>;
  let state: ReturnType<typeof readMissionState>;
  try {
    roadmap = readRoadmap(repoRoot, missionId);
    state = readMissionState(repoRoot, missionId);
  } catch (err) {
    warnings.push(`mission read failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (roadmap === null || state === null) return null;

  const cursorPhaseId = state.cursor.active_phase;
  const cursorPhase =
    cursorPhaseId === null
      ? null
      : roadmap.frontmatter.phases.find((p) => p.id === cursorPhaseId) ?? null;
  const done = countDonePhases(state);
  const total = roadmap.frontmatter.phases.length;
  const drift = detectRoadmapDrift(roadmap.frontmatter, state);

  const lines: string[] = [];
  lines.push(`## Active mission — ${roadmap.frontmatter.title}`);
  lines.push("");
  lines.push(`- mission: \`${missionId}\``);
  lines.push(
    `- progress: ${done} of ${total} phases done · exit_gate: ${roadmap.frontmatter.exit_gate}`,
  );
  if (cursorPhase !== null) {
    lines.push(`- cursor phase: \`${cursorPhase.id}\` — ${cursorPhase.title}`);
    lines.push(`  - exit_criteria: ${cursorPhase.exit_criteria}`);
    const phaseProg = state.phase_progress[cursorPhase.id];
    const taskIds = phaseProg?.task_ids ?? [];
    const doneTaskIds = taskIds.filter((id) =>
      existsSync(join(repoRoot, ".cairn", "tasks", "done", id)),
    );
    if (taskIds.length > 0) {
      lines.push(
        `  - tasks linked: ${taskIds.length} (${doneTaskIds.length} graduated, ${taskIds.length - doneTaskIds.length} in-flight)`,
      );
    } else {
      lines.push(`  - tasks linked: 0 (no work attempted yet under this phase)`);
    }
    // Phase-ready hint — re-derived from live state each session so the
    // operator gets the prompt back after `/clear` (the Stop-hook
    // pending file is session-scoped + consume-once).
    const gate = effectivePhaseExitGate(roadmap.frontmatter, cursorPhase.id);
    const tasksDone =
      taskIds.length > 0 &&
      allPhaseTasksDone(state, cursorPhase.id, (id) =>
        existsSync(join(repoRoot, ".cairn", "tasks", "done", id)),
      );
    // PR-slug cross-check: if exit_criteria enumerates PR refs, every
    // ref must have a graduated task before phase-ready fires (bug-mine
    // report #13). Falls through cleanly when exit_criteria is free-form
    // prose with no PR-shaped tokens.
    const prCoverage = computePhasePrCoverage(
      cursorPhase.exit_criteria ?? "",
      taskIds,
    );
    const phaseReady =
      gate === "prompt" &&
      tasksDone &&
      prCoverage.missing.length === 0 &&
      !isMissionPhaseDeferActive(repoRoot, missionId, cursorPhase.id);
    if (phaseReady) {
      lines.push("");
      lines.push(
        `**Phase ready to exit** — all ${taskIds.length} linked task(s) graduated. Use \`AskUserQuestion\` to confirm, then call \`cairn_mission_advance({phase_id: "${cursorPhase.id}", choice: "exit"})\` to graduate, or \`choice: "not_yet"\` / \`"defer"\` to keep the cursor.`,
      );
    } else if (
      gate === "prompt" &&
      tasksDone &&
      prCoverage.missing.length > 0 &&
      !isMissionPhaseDeferActive(repoRoot, missionId, cursorPhase.id)
    ) {
      lines.push("");
      lines.push(
        `**Phase tasks graduated but exit_criteria PR refs missing**: ${prCoverage.missing.map((s) => `\`${s}\``).join(", ")}. Phase-exit prompt held; ship the named PRs first.`,
      );
    }
  } else {
    lines.push(`- cursor phase: (none — mission ready to close)`);
  }
  lines.push(`- spec: \`${roadmap.frontmatter.spec_path}\``);
  if (drift.length > 0) {
    lines.push("");
    lines.push(
      `**Mission drift** — ${drift.length} phase id(s) in state.json no longer appear in roadmap.md: ${drift.map((id) => `\`${id}\``).join(", ")}. Resolve via \`cairn-attention\` (\`mission_drift\`).`,
    );
  }
  lines.push("");
  lines.push(
    "Tasks under this cursor inherit `mission_id` + `phase_id` automatically. Side-tasks (regression fixes, refactors unrelated to the phase exit_criteria) must pass `mission_id: \"\"` to `cairn_task_create` so they don't pollute `phase_progress.task_ids`.",
  );
  return lines.join("\n");
}

/**
 * Returns the PR slugs named in `exitCriteria` (e.g. `3.5-MK2`,
 * `3.5-MK3`) along with the subset that is NOT covered by any
 * graduated task id. Matching is case-insensitive — the bare PR token
 * (`mk2`) must appear as a kebab-delimited segment OR the full
 * dot-replaced slug (`3-5-mk2`) must appear as a substring of the
 * task id. The cairn-direction Step 2.6b auto-pick embeds the PR
 * token into the task slug directly.
 *
 * Free-form `exitCriteria` with no PR-shaped tokens returns
 * `{ slugs: [], missing: [] }` — caller treats this as "no PR
 * accounting needed" and falls back to plain task-count logic.
 */
const PHASE_PR_SLUG_RE = /\b\d+\.\d+-[A-Z]+\d+\b/g;

function computePhasePrCoverage(
  exitCriteria: string,
  taskIds: string[],
): { slugs: string[]; missing: string[] } {
  const matches = exitCriteria.match(PHASE_PR_SLUG_RE);
  if (matches === null || matches.length === 0) {
    return { slugs: [], missing: [] };
  }
  const seen = new Set<string>();
  const slugs: string[] = [];
  for (const m of matches) {
    if (seen.has(m)) continue;
    seen.add(m);
    slugs.push(m);
  }
  const missing: string[] = [];
  for (const slug of slugs) {
    if (!taskIdsCoverPrSlug(taskIds, slug)) missing.push(slug);
  }
  return { slugs, missing };
}

function taskIdsCoverPrSlug(taskIds: string[], prSlug: string): boolean {
  const fullKebab = prSlug.replace(/\./g, "-").toLowerCase();
  const bareToken = prSlug.split("-").slice(1).join("-").toLowerCase();
  for (const id of taskIds) {
    const lower = id.toLowerCase();
    if (lower.includes(fullKebab)) return true;
    if (
      bareToken.length > 0 &&
      new RegExp(`(^|-)${bareToken}(-|$)`).test(lower)
    ) {
      return true;
    }
  }
  return false;
}

function isMissionPhaseDeferActive(
  repoRoot: string,
  missionId: string,
  phaseId: string,
): boolean {
  const path = join(repoRoot, ".cairn", ".mission-phase-deferred-until");
  if (!existsSync(path)) return false;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const o = parsed as Record<string, unknown>;
  if (o["mission_id"] !== missionId || o["phase_id"] !== phaseId) return false;
  const until = typeof o["deferred_until"] === "string" ? Date.parse(o["deferred_until"]) : NaN;
  if (Number.isNaN(until)) return false;
  return Date.now() < until;
}

function readBrandAndPositioning(repoRoot: string, warnings: string[]): string | null {
  const brandPath = join(repoRoot, ".cairn", "ground", "brand", "overview.md");
  const positioningPath = join(repoRoot, ".cairn", "ground", "product", "positioning.md");

  // Read both files first, then dedupe.
  //
  // Phase 6-brand currently pre-fills overview.md and positioning.md with
  // the same domain summary (operator's free-form Q1 answer). When the
  // operator hasn't diverged them yet, surfacing both verbatim wastes
  // ~150-300 tokens of SessionStart context per session. Render once
  // under a merged heading when bodies match (whitespace-collapsed); fall
  // back to separate sections only when operator has actually edited
  // one of the files. Bug-mine: a consumer's SessionStart was emitting
  // the brand paragraph twice (overview heading + positioning heading,
  // identical body).
  interface Section {
    label: string;
    body: string;
    draftHint: string;
  }
  const sections: Section[] = [];
  for (const [label, path] of [
    ["Brand overview", brandPath] as const,
    ["Product positioning", positioningPath] as const,
  ]) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8");
      const parsed = parseFrontmatter(text);
      const fm = (parsed.frontmatter ?? {}) as Record<string, unknown>;
      const status = typeof fm["status"] === "string" ? (fm["status"] as string) : null;
      const body = parsed.body.trim();
      if (body.length === 0) continue;
      const draftHint =
        status === "draft"
          ? "  [DRAFT — operator has not filled this in; ask before making design decisions]"
          : "";
      sections.push({ label, body, draftHint });
    } catch (err) {
      warnings.push(
        `${label} read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (sections.length === 0) return null;

  // Dedupe by normalized body. Strip leading `#`-headings + collapse
  // whitespace so `# Brand overview\n\nfoo` and `# Product positioning\n\nfoo`
  // are recognized as identical prose under different titles. Phase
  // 6-brand pre-fills both files from the same Q1 answer; in practice
  // adopted repos ship a SessionStart with the same paragraph appearing
  // twice under two headings until the operator manually diverges them.
  // Render once with a merged label.
  const normalize = (s: string): string =>
    s
      .replace(/^\s*#{1,6}\s+.*$/gm, "") // drop H1-H6 lines entirely
      .replace(/\s+/g, " ")
      .trim();
  const uniqBodies = new Set(sections.map((s) => normalize(s.body)));
  if (uniqBodies.size === 1 && sections.length > 1) {
    const first = sections[0]!;
    const mergedLabel = sections.map((s) => s.label).join(" / ");
    return `## Brand and product context\n\n### ${mergedLabel}${first.draftHint}\n\n${first.body}`;
  }

  const parts = sections.map((s) => `### ${s.label}${s.draftHint}\n\n${s.body}`);
  return `## Brand and product context\n\n${parts.join("\n\n")}`;
}

function computeTotalChars(sections: { body: string }[]): number {
  return sections.reduce((sum, s) => sum + s.body.length + 2, 0);
}

interface DecisionEntry {
  id: string;
  title: string;
  status: string;
  scope_globs?: string[];
  supersedes?: string | null;
  superseded_by?: string | null;
}

function safeBuildDecisionsLedger(repoRoot: string, warnings: string[]): DecisionEntry[] {
  try {
    return buildDecisionsLedger({ repoRoot }) as DecisionEntry[];
  } catch (err) {
    warnings.push(`decisions ledger read failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

interface InvariantEntry {
  id: string;
  title: string;
  status: string;
  source_decision?: string | null;
}

function safeBuildInvariantsLedger(repoRoot: string, warnings: string[]): InvariantEntry[] {
  try {
    return buildInvariantsLedger({ repoRoot }) as InvariantEntry[];
  } catch (err) {
    warnings.push(`invariants ledger read failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function scopeMapFromDecisions(decisions: DecisionEntry[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of decisions) {
    if (d.scope_globs && d.scope_globs.length > 0) out.set(d.id, d.scope_globs);
  }
  return out;
}

function filterDecisionsToScope(
  decisions: DecisionEntry[],
  scopeRelPath: string | undefined,
): DecisionEntry[] {
  if (!scopeRelPath || scopeRelPath.length === 0 || scopeRelPath === ".") return decisions;
  const filtered = decisions.filter((d) => {
    const globs = d.scope_globs ?? [];
    if (globs.length === 0) return true;
    return globs.some((g) => relPathOverlapsGlob(scopeRelPath, g));
  });
  return filtered.length > 0 ? filtered : decisions;
}

function filterInvariantsToScope(
  invariants: InvariantEntry[],
  decisionScopeById: Map<string, string[]>,
  scopeRelPath: string | undefined,
): InvariantEntry[] {
  if (!scopeRelPath || scopeRelPath.length === 0 || scopeRelPath === ".") return invariants;
  const filtered = invariants.filter((inv) => {
    if (!inv.source_decision) return true;
    const globs = decisionScopeById.get(inv.source_decision);
    if (!globs || globs.length === 0) return true;
    return globs.some((g) => relPathOverlapsGlob(scopeRelPath, g));
  });
  return filtered.length > 0 ? filtered : invariants;
}

function relPathOverlapsGlob(relPath: string, glob: string): boolean {
  const globPrefix = glob.replace(/\*\*.*$/, "").replace(/\*+$/, "");
  if (globPrefix.length === 0) return true;
  return relPath.startsWith(globPrefix) || globPrefix.startsWith(relPath);
}

/**
 * Compact summary line for sessions with no scopeRelPath. Replaces the
 * old "ship all accepted DECs + all active invariants" payload that
 * scaled linearly with project size and defeated the bare-symbol design.
 */
function renderGroundStateSummary(
  decisionsCount: number,
  invariantsCount: number,
): string {
  const lines: string[] = [];
  lines.push("## Cairn ground state");
  lines.push("");
  const decTxt =
    decisionsCount === 1
      ? "1 accepted decision"
      : `${decisionsCount} accepted decisions`;
  const invTxt =
    invariantsCount === 1
      ? "1 active invariant"
      : `${invariantsCount} active invariants`;
  lines.push(`${decTxt}, ${invTxt} in this project.`);
  lines.push("");
  lines.push(
    "Bare `§DEC-NNNN` and `§INV-NNNN` citations in source files resolve " +
      "automatically when you Read them — the PostToolUse(Read) hook " +
      "prepends a legend with each citation's title + status. Use " +
      "`cairn_in_scope({path_globs, types?})` for path-targeted lookups " +
      "(omit `types` for both DECs + INVs, or filter by " +
      "`types: [\"decision\"]` / `[\"invariant\"]`), `cairn_search(query)` " +
      "for free-text.",
  );
  return lines.join("\n");
}

function renderDecisionsSection(decisions: DecisionEntry[]): string | null {
  if (decisions.length === 0) return null;
  const lines: string[] = [];
  lines.push(`## Decisions in scope (${decisions.length} accepted)`);
  lines.push("");
  const slice = decisions.slice(0, DECISIONS_CAP);
  for (const d of slice) {
    const scope = d.scope_globs && d.scope_globs.length > 0 ? d.scope_globs.join(", ") : "(no scope)";
    const supersedes = d.supersedes ? d.supersedes : "—";
    lines.push(`- **${d.id}** — ${d.title}`);
    lines.push(`  status: ${d.status}; scope: ${scope}; supersedes: ${supersedes}`);
  }
  if (decisions.length > DECISIONS_CAP) {
    lines.push(
      `…${decisions.length - DECISIONS_CAP} additional decision${decisions.length - DECISIONS_CAP === 1 ? "" : "s"} — call \`cairn_in_scope({path_globs, types: ["decision"]})\` for the rest.`,
    );
  }
  return lines.join("\n");
}

function renderInvariantsSection(invariants: InvariantEntry[]): string | null {
  if (invariants.length === 0) return null;
  const lines: string[] = [];
  lines.push(`## §INV invariants active (${invariants.length})`);
  lines.push("");
  const slice = invariants.slice(0, INVARIANTS_CAP);
  for (const inv of slice) {
    lines.push(
      `- **${inv.id}** — ${inv.title}  source_decision: ${inv.source_decision ?? "(none)"}`,
    );
  }
  if (invariants.length > INVARIANTS_CAP) {
    lines.push(
      `…${invariants.length - INVARIANTS_CAP} additional — call \`cairn_in_scope({path_globs, types: ["invariant"]})\`.`,
    );
  }
  return lines.join("\n");
}

interface ActiveTask {
  id: string;
  specPath: string;
  specBody: string;
  status: string | null;
  mtime: number;
}

function listActiveTasks(repoRoot: string): ActiveTask[] {
  const dir = join(repoRoot, ".cairn", "tasks", "active");
  if (!existsSync(dir)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const out: ActiveTask[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidates = [
      join(dir, e.name, "spec.tightened.md"),
      join(dir, e.name, "spec.md"),
    ];
    let target: string | null = null;
    for (const c of candidates) {
      if (existsSync(c)) {
        target = c;
        break;
      }
    }
    if (!target) continue;
    let text = "";
    let mtime = 0;
    try {
      text = readFileSync(target, "utf8");
      mtime = statSync(target).mtimeMs;
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(text);
    const fm = (parsed.frontmatter ?? {}) as Record<string, unknown>;
    const status = typeof fm["status"] === "string" ? (fm["status"] as string) : null;
    out.push({
      id: e.name,
      specPath: target.startsWith(repoRoot) ? target.slice(repoRoot.length + 1) : target,
      specBody: parsed.body,
      status,
      mtime,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function renderCurrentTaskSection(_repoRoot: string, tasks: ActiveTask[]): string | null {
  if (tasks.length === 0) return null;
  const lines: string[] = [];
  if (tasks.length === 1) {
    const t = tasks[0];
    if (t === undefined) return null;
    lines.push("## Current task");
    lines.push("");
    lines.push(`ID: ${t.id}`);
    if (t.status !== null) lines.push(`Status: ${t.status}`);
    lines.push(`Path: ${t.specPath.replace(/\\/g, "/")}`);
    lines.push("");
    const body = t.specBody.trim();
    const cap =
      body.length > TASK_BODY_CAP
        ? `${body.slice(0, TASK_BODY_CAP).trimEnd()}\n…[truncated; full spec via cairn_get_full({id, kind:"task"})]`
        : body;
    lines.push(cap);
    return lines.join("\n");
  }
  lines.push(`## Active tasks (${tasks.length})`);
  lines.push("");
  for (const t of tasks.slice(0, 8)) {
    const titleMatch = t.specBody.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1] ?? t.id;
    lines.push(`- **${t.id}** — ${title}  status: ${t.status ?? "—"}`);
  }
  if (tasks.length > 8) lines.push(`…${tasks.length - 8} more.`);
  lines.push("");
  lines.push("Multiple active tasks; call `cairn_get_full({id, kind:\"task\"})` to read any.");
  return lines.join("\n");
}

interface QualityGrade {
  module: string;
  score: number;
  pass_rate: number;
  drift_count: number;
}

function readQualityGrades(repoRoot: string, warnings: string[]): QualityGrade[] {
  const path = join(repoRoot, ".cairn", "ground", "quality-grades.yaml");
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    warnings.push(`quality-grades.yaml unparseable: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const modulesRaw = (parsed as { modules?: unknown }).modules;
  if (!Array.isArray(modulesRaw)) return [];
  const out: QualityGrade[] = [];
  for (const m of modulesRaw) {
    if (typeof m !== "object" || m === null) continue;
    const mm = m as Record<string, unknown>;
    if (typeof mm["module"] !== "string") continue;
    if (typeof mm["score"] !== "number") continue;
    out.push({
      module: mm["module"],
      score: mm["score"],
      pass_rate: typeof mm["pass_rate"] === "number" ? mm["pass_rate"] : 0,
      drift_count: typeof mm["drift_count"] === "number" ? mm["drift_count"] : 0,
    });
  }
  out.sort((a, b) => a.score - b.score);
  return out;
}

function renderQualityGradesSection(grades: QualityGrade[]): string | null {
  if (grades.length === 0) return null;
  const tail = grades.slice(0, QUALITY_TAIL_CAP);
  const lines: string[] = [];
  lines.push(`## Quality grades — weakest module${tail.length === 1 ? "" : "s"}`);
  lines.push("");
  for (const g of tail) {
    lines.push(
      `- ${g.module}: score ${g.score}/100, pass_rate ${g.pass_rate.toFixed(2)}, drift_count ${g.drift_count}`,
    );
  }
  return lines.join("\n");
}

interface DraftEntry {
  id: string;
  title: string;
  capture_source: string | null;
  decided_at: string | null;
}

function listPendingDrafts(repoRoot: string, warnings: string[]): DraftEntry[] {
  const dir = join(repoRoot, ".cairn", "ground", "decisions", "_inbox");
  if (!existsSync(dir)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const out: DraftEntry[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".draft.md")) continue;
    const abs = join(dir, e.name);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch (err) {
      warnings.push(`draft ${e.name} unreadable: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const parsed = parseFrontmatter(text);
    const fm = (parsed.frontmatter ?? {}) as Record<string, unknown>;
    const id = typeof fm["id"] === "string" ? (fm["id"] as string) : e.name.replace(/\.draft\.md$/, "");
    const title = typeof fm["title"] === "string" ? (fm["title"] as string) : "(untitled draft)";
    const captureSource = typeof fm["capture_source"] === "string" ? (fm["capture_source"] as string) : null;
    const decidedAt = typeof fm["decided_at"] === "string" ? (fm["decided_at"] as string) : null;
    out.push({ id, title, capture_source: captureSource, decided_at: decidedAt });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

interface OnboardingArgs {
  repoRoot: string;
  pendingDrafts: number;
  warnings: string[];
}

function renderFirstSessionOnboarding(args: OnboardingArgs): string | null {
  const audit = readLatestBaselineAudit(args.repoRoot, args.warnings);
  if (audit === null) return null;

  const projectName = readProjectSlug(args.repoRoot) ?? basename(args.repoRoot);
  const minutesAgo = audit.runAt !== null ? minutesSince(audit.runAt) : null;
  const sensorIds = readActiveSensorIds(args.repoRoot, args.warnings);

  const lines: string[] = [];
  lines.push(`⬡ Cairn active — ${projectName}`);
  lines.push("");
  if (minutesAgo !== null) {
    lines.push(
      `  This project was adopted ${humanizeMinutes(minutesAgo)}. Project brain is new.`,
    );
  } else {
    lines.push("  This project was adopted recently. Project brain is new.");
  }
  lines.push("");

  if (sensorIds.length > 0) {
    const head = sensorIds.slice(0, 3).join(" · ");
    const more =
      sensorIds.length > 3
        ? ` + ${sensorIds.length - 3} more`
        : "";
    lines.push(
      "  Sensors active (run on complete diff after you emit attestation.yaml):",
    );
    lines.push(`    ${head}${more}`);
    lines.push("");
  }

  if (audit.totalFindings > 0) {
    const breakdown =
      audit.hardFindings > 0 || audit.softFindings > 0
        ? ` (${audit.hardFindings} hard · ${audit.softFindings} soft)`
        : "";
    lines.push(
      `  Baseline debt: ${audit.totalFindings} pre-Cairn violation${audit.totalFindings === 1 ? "" : "s"}${breakdown} found in existing code.`,
    );
    if (audit.hardFindings > 0) {
      lines.push(
        "  Invoke the cairn-attention skill to triage hard findings; soft findings are inventory, drained in bulk.",
      );
    } else {
      lines.push(
        "  All findings are soft (inventory only). No hard violations to triage.",
      );
    }
    lines.push("");
  } else {
    lines.push(
      `  Baseline scan ran clean — no pre-Cairn violations on ${audit.filesScanned} source file${audit.filesScanned === 1 ? "" : "s"}.`,
    );
    lines.push("");
  }

  if (args.pendingDrafts > 0) {
    lines.push(
      `  DEC drafts awaiting review: ${args.pendingDrafts}`,
    );
    lines.push(
      "  Invoke the cairn-attention skill so the operator can accept, edit, or reject each draft inline.",
    );
    lines.push("");
  }

  lines.push(
    "  To capture a new decision during this session: `/cairn-direction <your instruction>`",
  );
  return lines.join("\n");
}

interface BaselineSummary {
  runAt: string | null;
  totalFindings: number;
  /** Only `severity: hard` findings — these are real action items. */
  hardFindings: number;
  /**
   * `severity: soft` findings — inventory for the attestation cross-check,
   * NOT actionable attention. Excluded from `attention_count` so the
   * statusline doesn't surface 500+ commented-block matches as "pending"
   * when the operator can't action them individually.
   */
  softFindings: number;
  filesScanned: number;
}

function readLatestBaselineAudit(
  repoRoot: string,
  warnings: string[],
): BaselineSummary | null {
  const dir = join(repoRoot, ".cairn", "baseline");
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir, { encoding: "utf8" });
  } catch (err) {
    warnings.push(
      `baseline dir read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  const matching = entries
    .filter((name) => /^sensor-audit-.*\.yaml$/.test(name))
    .sort();
  const latest = matching.at(-1);
  if (latest === undefined) return null;
  const abs = join(dir, latest);
  try {
    const parsed = parseYaml(readFileSync(abs, "utf8")) as Record<string, unknown>;
    const runAt =
      typeof parsed["run_at"] === "string" ? (parsed["run_at"] as string) : null;
    const totalFindings =
      typeof parsed["total_findings"] === "number"
        ? (parsed["total_findings"] as number)
        : 0;
    const filesScanned =
      typeof parsed["files_scanned"] === "number"
        ? (parsed["files_scanned"] as number)
        : 0;
    const { hard, soft } = countFindingsBySeverity(parsed["sensors"]);
    return { runAt, totalFindings, hardFindings: hard, softFindings: soft, filesScanned };
  } catch (err) {
    warnings.push(
      `baseline audit unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Walk the audit's `sensors[].findings[]` and tally by severity. Defensive
 * against schema drift — anything that isn't string `"hard"` or `"soft"`
 * is silently ignored rather than counted under the wrong bucket.
 */
function countFindingsBySeverity(sensorsRaw: unknown): { hard: number; soft: number } {
  let hard = 0;
  let soft = 0;
  if (!Array.isArray(sensorsRaw)) return { hard, soft };
  for (const sensor of sensorsRaw) {
    if (typeof sensor !== "object" || sensor === null) continue;
    const findings = (sensor as Record<string, unknown>)["findings"];
    if (!Array.isArray(findings)) continue;
    for (const f of findings) {
      if (typeof f !== "object" || f === null) continue;
      const sev = (f as Record<string, unknown>)["severity"];
      if (sev === "hard") hard += 1;
      else if (sev === "soft") soft += 1;
    }
  }
  return { hard, soft };
}

function readActiveSensorIds(repoRoot: string, warnings: string[]): string[] {
  try {
    const reg = loadSensorRegistry(repoRoot);
    const disabled = new Set(reg.disabled_per_project ?? []);
    return reg.sensors
      .map((s) => s.id)
      .filter((id) => id.length > 0)
      .filter((id) => !disabled.has(id));
  } catch (err) {
    warnings.push(
      `sensor registry read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

function readProjectSlug(repoRoot: string): string | null {
  const path = join(repoRoot, ".cairn", "config.yaml");
  if (!existsSync(path)) return null;
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof parsed["slug"] === "string") return parsed["slug"] as string;
    return null;
  } catch {
    return null;
  }
}

function minutesSince(iso: string): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const diffMs = Date.now() - t;
  if (diffMs < 0) return 0;
  return Math.floor(diffMs / 60_000);
}

function humanizeMinutes(minutes: number): string {
  if (minutes < 1) return "moments ago";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function renderPendingDraftsSection(drafts: DraftEntry[]): string | null {
  if (drafts.length === 0) return null;
  const lines: string[] = [];
  lines.push(`## Decision drafts pending operator confirm (${drafts.length})`);
  lines.push("");
  const slice = drafts.slice(0, DRAFTS_CAP);
  for (const d of slice) {
    const meta: string[] = [];
    if (d.capture_source) meta.push(`capture_source: ${d.capture_source}`);
    if (d.decided_at) meta.push(`received: ${d.decided_at}`);
    lines.push(`- **${d.id}** (draft) — ${d.title}${meta.length > 0 ? `; ${meta.join("; ")}` : ""}`);
  }
  if (drafts.length > DRAFTS_CAP) {
    lines.push(`…${drafts.length - DRAFTS_CAP} more in _inbox/.`);
  }
  lines.push("");
  lines.push(
    "These have been captured but not operator-confirmed. Do not assume their content is binding.",
  );
  return lines.join("\n");
}

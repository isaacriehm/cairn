/**
 * Spec-delta computation — answers "what changed in ground state since the
 * affected code was last touched?" for a task scope.
 *
 * Spec: docs/CONTEXT_CONTINUITY_SPEC.md §10.
 *
 * Mechanical: resolve scope → find oldest last-touch SHA across paths →
 * diff `decisions.ledger.yaml` and `invariants.ledger.yaml` between that
 * cutoff and HEAD → stat brand/product files for newer mtimes. No LLM.
 *
 * Returns null when the input scope is empty, when no path has any commits,
 * or when the resulting delta is empty (nothing to inject).
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  buildDecisionsLedger,
  buildInvariantsLedger,
  matchAnyGlob,
} from "@isaacriehm/cairn-state";

const DecisionLedgerEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  scope_globs: z.array(z.string()).optional(),
  supersedes: z.string().nullable().optional(),
  superseded_by: z.string().nullable().optional(),
}).passthrough();

const InvariantLedgerEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  source_decision: z.string().nullable().optional(),
  superseded_by: z.string().nullable().optional(),
}).passthrough();

const TASK_PATH_CAP = 100;

export interface SpecDelta {
  cutoffSha: string;
  cutoffAgeDays: number;
  scopeSummary: string;
  decisions: {
    added: { id: string; title: string; scopeGlobs: string[] }[];
    superseded: { id: string; supersededBy: string; title: string }[];
  };
  invariants: {
    added: { id: string; title: string; sourceDecision: string | null }[];
    superseded: { id: string; supersededBy: string; title: string }[];
  };
  brand: { path: string; mtimeIso: string }[];
}

/** Minimal ledger entry shape (matches `ground/schemas.ts` but no zod cost). */
interface DecisionLedgerEntryLike {
  id: string;
  title: string;
  status: string;
  scope_globs?: string[];
  supersedes?: string | null;
  superseded_by?: string | null;
}

interface InvariantLedgerEntryLike {
  id: string;
  title: string;
  status: string;
  source_decision?: string | null;
  superseded_by?: string | null;
}

/** Brand/product paths SessionStart's spec-delta scan stats for mtime newer than cutoff. */
const BRAND_FILES = [
  ".cairn/ground/brand/overview.md",
  ".cairn/ground/brand/voice.md",
  ".cairn/ground/product/positioning.md",
  ".cairn/ground/product/personas.yaml",
];

export async function buildSpecDelta(
  repoRoot: string,
  taskScopePaths: string[],
): Promise<SpecDelta | null> {
  if (taskScopePaths.length === 0) return null;
  const paths = taskScopePaths.slice(0, TASK_PATH_CAP);

  const git = simpleGit({ baseDir: repoRoot });

  // Step 2: per-path last-touch hash + date. Skip paths with no history.
  const lastTouches: { hash: string; date: string }[] = [];
  for (const p of paths) {
    try {
      const r = await git.log({ file: p, maxCount: 1 });
      const first = r.all[0];
      if (first === undefined) continue;
      lastTouches.push({ hash: first.hash, date: first.date });
    } catch {
      continue;
    }
  }
  if (lastTouches.length === 0) return null;

  // Step 3: cutoff = oldest by date.
  let oldest = lastTouches[0];
  if (oldest === undefined) return null;
  for (let i = 1; i < lastTouches.length; i++) {
    const candidate = lastTouches[i];
    if (candidate === undefined) continue;
    if (new Date(candidate.date).getTime() < new Date(oldest.date).getTime()) {
      oldest = candidate;
    }
  }
  const cutoffFullSha = oldest.hash;
  const cutoffDate = new Date(oldest.date);

  // Step 4: read ledgers at HEAD.
  let headDecisions: DecisionLedgerEntryLike[] = [];
  let headInvariants: InvariantLedgerEntryLike[] = [];
  try {
    const rawDec = buildDecisionsLedger({ repoRoot });
    const decResult = z.array(DecisionLedgerEntrySchema).safeParse(rawDec);
    if (decResult.success) {
      headDecisions = decResult.data.map((d) => ({
        id: d.id,
        title: d.title,
        status: d.status,
        ...(d.scope_globs ? { scope_globs: d.scope_globs } : {}),
        ...(d.supersedes ? { supersedes: d.supersedes } : {}),
        ...(d.superseded_by ? { superseded_by: d.superseded_by } : {}),
      }));
    }
  } catch {
    /* headDecisions = [] */
  }
  try {
    const rawInv = buildInvariantsLedger({ repoRoot });
    const invResult = z.array(InvariantLedgerEntrySchema).safeParse(rawInv);
    if (invResult.success) {
      headInvariants = invResult.data.map((i) => ({
        id: i.id,
        title: i.title,
        status: i.status,
        ...(i.source_decision ? { source_decision: i.source_decision } : {}),
        ...(i.superseded_by ? { superseded_by: i.superseded_by } : {}),
      }));
    }
  } catch {
    /* headInvariants = [] */
  }

  // Step 5: read ledgers at cutoff via `git show`.
  const cutoffDecisionsRaw = await readLedgerAtSha<z.infer<typeof DecisionLedgerEntrySchema>>(
    git,
    cutoffFullSha,
    ".cairn/ground/decisions/decisions.ledger.yaml"
  );
  const cutoffDecisions: DecisionLedgerEntryLike[] = cutoffDecisionsRaw.map((d) => ({
    id: d.id,
    title: d.title,
    status: d.status,
    ...(d.scope_globs ? { scope_globs: d.scope_globs } : {}),
    ...(d.supersedes ? { supersedes: d.supersedes } : {}),
    ...(d.superseded_by ? { superseded_by: d.superseded_by } : {}),
  }));

  const cutoffInvariantsRaw = await readLedgerAtSha<z.infer<typeof InvariantLedgerEntrySchema>>(
    git,
    cutoffFullSha,
    ".cairn/ground/invariants/invariants.ledger.yaml"
  );
  const cutoffInvariants: InvariantLedgerEntryLike[] = cutoffInvariantsRaw.map((i) => ({
    id: i.id,
    title: i.title,
    status: i.status,
    ...(i.source_decision ? { source_decision: i.source_decision } : {}),
    ...(i.superseded_by ? { superseded_by: i.superseded_by } : {}),
  }));

  // Build lookup map of HEAD decisions for invariant scope resolution.
  const headDecisionById = new Map<string, DecisionLedgerEntryLike>();
  for (const d of headDecisions) headDecisionById.set(d.id, d);

  // Step 6: compute diffs.
  const cutoffDecisionIds = new Set(cutoffDecisions.map((d) => d.id));
  const cutoffInvariantIds = new Set(cutoffInvariants.map((i) => i.id));
  const headDecisionIds = new Set(headDecisions.map((d) => d.id));
  const headInvariantIds = new Set(headInvariants.map((i) => i.id));

  // decisions.added: in HEAD but not in cutoff, scope-overlap.
  const decisionsAdded: { id: string; title: string; scopeGlobs: string[] }[] = [];
  for (const d of headDecisions) {
    if (cutoffDecisionIds.has(d.id)) continue;
    const scope = d.scope_globs ?? [];
    if (scope.length === 0) continue;
    const overlaps = paths.some((p) => matchAnyGlob(p, scope));
    if (!overlaps) continue;
    decisionsAdded.push({ id: d.id, title: d.title, scopeGlobs: scope });
  }

  // decisions.superseded: in cutoff (accepted+active) but missing from HEAD
  // (HEAD ledger only contains accepted-active, so dropouts = superseded).
  // Scope-overlap via cutoff entry's scope_globs.
  const decisionsSuperseded: { id: string; supersededBy: string; title: string }[] = [];
  for (const d of cutoffDecisions) {
    if (headDecisionIds.has(d.id)) continue;
    const scope = d.scope_globs ?? [];
    if (scope.length === 0) continue;
    const overlaps = paths.some((p) => matchAnyGlob(p, scope));
    if (!overlaps) continue;
    decisionsSuperseded.push({
      id: d.id,
      supersededBy: d.superseded_by ?? "",
      title: d.title,
    });
  }

  // invariants.added: in HEAD but not in cutoff. Scope via source_decision lookup.
  const invariantsAdded: { id: string; title: string; sourceDecision: string | null }[] = [];
  for (const inv of headInvariants) {
    if (cutoffInvariantIds.has(inv.id)) continue;
    const sourceDecision = inv.source_decision ?? null;
    if (sourceDecision === null) continue;
    const decision = headDecisionById.get(sourceDecision);
    const scope = decision?.scope_globs ?? [];
    if (scope.length === 0) continue;
    const overlaps = paths.some((p) => matchAnyGlob(p, scope));
    if (!overlaps) continue;
    invariantsAdded.push({
      id: inv.id,
      title: inv.title,
      sourceDecision,
    });
  }

  // invariants.superseded: in cutoff but not in HEAD (or with superseded_by in HEAD).
  // Scope via the cutoff inv's source_decision → look up in HEAD decisions.
  const invariantsSuperseded: { id: string; supersededBy: string; title: string }[] = [];
  for (const inv of cutoffInvariants) {
    const headEntry = headInvariants.find((h) => h.id === inv.id);
    const droppedFromHead = !headInvariantIds.has(inv.id);
    const supersededInHead =
      headEntry?.superseded_by !== undefined && headEntry?.superseded_by !== null;
    if (!droppedFromHead && !supersededInHead) continue;
    const sourceDecision = inv.source_decision ?? null;
    if (sourceDecision === null) continue;
    const decision = headDecisionById.get(sourceDecision);
    const scope = decision?.scope_globs ?? [];
    if (scope.length === 0) continue;
    const overlaps = paths.some((p) => matchAnyGlob(p, scope));
    if (!overlaps) continue;
    invariantsSuperseded.push({
      id: inv.id,
      supersededBy: headEntry?.superseded_by ?? "",
      title: inv.title,
    });
  }

  // Step 8: brand/product files.
  const brand: { path: string; mtimeIso: string }[] = [];
  const cutoffMs = cutoffDate.getTime();
  for (const rel of BRAND_FILES) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.mtimeMs > cutoffMs) {
      brand.push({ path: rel, mtimeIso: stat.mtime.toISOString() });
    }
  }

  // Step 9: empty delta → null.
  const empty =
    decisionsAdded.length === 0 &&
    decisionsSuperseded.length === 0 &&
    invariantsAdded.length === 0 &&
    invariantsSuperseded.length === 0 &&
    brand.length === 0;
  if (empty) return null;

  return {
    cutoffSha: cutoffFullSha.slice(0, 7),
    cutoffAgeDays: Math.floor((Date.now() - cutoffMs) / 86_400_000),
    scopeSummary: summarizeScope(paths),
    decisions: {
      added: decisionsAdded,
      superseded: decisionsSuperseded,
    },
    invariants: {
      added: invariantsAdded,
      superseded: invariantsSuperseded,
    },
    brand,
  };
}

async function readLedgerAtSha<T>(
  git: ReturnType<typeof simpleGit>,
  sha: string,
  relPath: string,
): Promise<T[]> {
  let raw: string;
  try {
    raw = await git.show([`${sha}:${relPath}`]);
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed as T[];
}

function summarizeScope(paths: string[]): string {
  if (paths.length === 1) {
    const p = paths[0];
    return p ?? "1 path";
  }
  if (paths.length <= 3) return paths.join(", ");
  return `${paths.length} paths`;
}

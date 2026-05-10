/**
 * Confidence scoring for source-comment-derived DEC drafts and
 * invariant proposals.
 *
 * Phase 7b emits one DEC draft per "rationale"-class essay comment and
 * one invariant per "constraint"-class essay comment. On a busy
 * monorepo the classifier easily produces 400+ drafts — no human will
 * sort through that interactively, so we score each draft by a small
 * set of heuristics and bulk-accept the obvious ones during attention
 * drain. Operator triages only the medium / low-confidence remainder.
 *
 * Heuristic stance:
 *   - **DEC drafts** are attribution-of-existing-prose. Cost of keeping
 *     a borderline draft is near zero (queryable rationale metadata).
 *     Bias accepts upward — score ≥7 → high.
 *   - **Invariants** become enforcement signals; false positives turn
 *     into noise during sensor sweeps. Bias accepts downward —
 *     stricter signal required (modal verb + reason + high-stakes
 *     location) before high-confidence accept.
 *
 * Scoring is pure. Inputs are the parsed draft fields; no filesystem.
 */

import { matchAnyGlob } from "@isaacriehm/cairn-state";
import type { ProjectGlobs } from "../sensors/types.js";

export type DraftConfidence = "high" | "medium" | "low";

export interface DraftScoreInput {
  /** Repo-relative path to the source file the draft was extracted from. */
  sourceFile: string;
  /** Comment prose (markers stripped). */
  prose: string;
  /** Suggested DEC title or invariant text. */
  title: string;
  /** Raw block including markers + JSDoc tags. */
  rawComment: string;
  /** Project globs from `.cairn/config.yaml`. */
  globs: ProjectGlobs;
}

const DECISION_VERBS =
  /\b(chose|chosen|choose|decided|prefer|preferred|because|locked|enforce|enforced|require|required|adopt|adopted|standardize|standardized|switch|migrated|deprecate|reject|rejected)\b/i;

const JSDOC_TAGS = /@(domain|scope|orgScope|see|param|returns|throws|deprecated|since|module|namespace|file|fileoverview|public|private|protected|internal|readonly|override|sealed|immutable|invariant)\b/;

const INVARIANT_MODALS =
  /\b(MUST|MUSTN'T|MUST NOT|NEVER|ALWAYS|SHALL|SHALL NOT|CANNOT|FORBID|FORBIDDEN|REQUIRED|REQUIRES)\b/i;

const REASON_MARKERS = /\b(because|to (prevent|ensure|avoid|guarantee|preserve|enforce|stop)|otherwise)\b/i;

function inHighStakes(file: string, globs: ProjectGlobs): boolean {
  return matchAnyGlob(file, globs.high_stakes_globs ?? []);
}

function inRoutesOrDtos(file: string, globs: ProjectGlobs): boolean {
  const combined = [
    ...(globs.route_handler_globs ?? []),
    ...(globs.dto_globs ?? []),
  ];
  return matchAnyGlob(file, combined);
}

/**
 * Score a DEC draft. Max 8 / threshold 7→high / 4→medium.
 */
export function scoreDecDraft(input: DraftScoreInput): DraftConfidence {
  let score = 0;
  if (inHighStakes(input.sourceFile, input.globs)) score += 3;
  if (inRoutesOrDtos(input.sourceFile, input.globs)) score += 1;
  const proseLen = input.prose.trim().length;
  if (proseLen >= 80 && proseLen <= 800) score += 2;
  const titleLen = input.title.trim().length;
  if (titleLen >= 10 && titleLen <= 80) score += 1;
  if (DECISION_VERBS.test(input.prose)) score += 2;
  if (JSDOC_TAGS.test(input.rawComment)) score += 1;

  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  return "low";
}

/**
 * Score an invariant proposal. Max 9 / threshold 7→high / 4→medium.
 * Stricter than DEC scoring: requires modal verb + reason + high-stakes
 * location for high confidence, since false-positive invariants become
 * sensor-sweep noise downstream.
 */
export function scoreInvariant(input: DraftScoreInput): DraftConfidence {
  let score = 0;
  if (inHighStakes(input.sourceFile, input.globs)) score += 3;
  const modalText = `${input.title}\n${input.prose}`;
  if (INVARIANT_MODALS.test(modalText)) score += 3;
  if (REASON_MARKERS.test(input.prose)) score += 2;
  const proseLen = input.prose.trim().length;
  if (proseLen >= 50 && proseLen <= 600) score += 1;

  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  return "low";
}

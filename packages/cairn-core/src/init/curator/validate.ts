/**
 * Curator pipeline — strict per-entry validators.
 *
 * Phase 9c-emit feeds every reducer-output entry through
 * `normalizeFinalEntry` (cosmetic title repair) and then `validateEntry`
 * before writing it to `.cairn/ground/decisions/` or
 * `.cairn/ground/invariants/`. Operator's auto-accept directive
 * (curator plan §"Decision log" Q2) requires a high quality bar — when
 * an entry fails any check it is dropped silently with a counter
 * logged, never falling back to `_inbox/`.
 *
 * IMPORTANT — normalize before you validate. The curator subagent is
 * *asked* for ≤80-char, capitalized titles (see the `curator-reduce` /
 * `curator-map` agent prompts) but does not comply reliably: long
 * descriptive titles and titles that lead with a lowercase code
 * identifier (`tsc …`, `loadConfig …`) are routine. Those are
 * FORMATTING defects on otherwise well-synthesized entries, not quality
 * failures — dropping them silently discarded the bulk of a good ledger
 * (21 of 23 lost to `title-length` on one observed adoption). So the
 * `title-length` / `title-no-cap` / `title-trailing-punct` reasons below
 * now fire only as safety nets: `normalizeFinalEntry` repairs the
 * normalizable cases first, and only genuinely broken titles (empty,
 * `...`-truncated, `{/*` JSX leak) reach the hard drop.
 *
 * Failure modes encoded by `rejectReason`:
 *   - `title-length`              — empty or > 80 chars (post-normalize)
 *   - `title-no-cap`              — does not start with an uppercase letter
 *   - `title-trailing-punct`      — ends in `,` `:` `;`
 *   - `title-truncated-or-jsx`    — ends in `...` or starts with `{/*` (JSX
 *                                   block-comment leakage)
 *   - `body-missing-<section>`    — required heading missing
 *   - `jsdoc-tag-leak`            — body contains `@domain`, `@orgScope`,
 *                                   `@softDelete`, `@see`, `@param`,
 *                                   `@returns`, `@throws` (curator pasted
 *                                   raw scaffolding)
 *   - `title-pasted-in-body`      — body contains the title verbatim
 *                                   (indicates unsynthesized pass-through)
 *   - `no-scope-globs`            — empty `scope_globs`
 *
 * Evidence existence is NOT a hard gate. A curator candidate synthesized
 * from a doc or rule cites the source it was derived from — often a code
 * path the model inferred from prose, or a file that lives in a git
 * submodule not checked out at the root. Hard-dropping on a missing
 * evidence path can discard nearly the entire decision ledger when the
 * corpus is docs/rules and the candidates cite unverifiable code refs.
 * Evidence is corroboration, not a quality gate: `filterExistingEvidence`
 * strips refs that don't resolve on disk, and `9c-emit` keeps the entry
 * regardless. A doc-derived decision with zero surviving evidence is
 * still a real decision — its `scope_globs` + body carry the weight.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface FinalEntry {
  kind: "DEC" | "INV";
  title: string;
  body: string;
  scope_globs: string[];
  evidence_files: string[];
  topic_tags: string[];
}

export interface ValidationResult {
  valid: boolean;
  rejectReason?: string;
}

/** Hard title length cap — shared by the normalizer and the validator. */
export const TITLE_CAP = 80;

/**
 * Cosmetic pre-pass run by `9c-emit` BEFORE `validateEntry`. Repairs the
 * title's normalizable defects so a well-synthesized entry with a
 * slightly-off title is kept rather than silently dropped (see module
 * header). Normalizes ONLY the title, only in lossless ways:
 *
 *   - collapse internal whitespace
 *   - truncate an over-cap title at a word boundary to ≤ `TITLE_CAP` chars
 *     (no marker — the body keeps the full detail)
 *   - strip trailing `,` `:` `;`
 *   - sentence-case a lowercase first letter (the exact symbol survives in
 *     the body / evidence, so casing the title's lead letter is lossless)
 *
 * It deliberately leaves a `...`-truncated or `{/*`-prefixed title alone —
 * those signal broken synthesis and stay hard drops in `validateEntry` —
 * and an empty title stays empty (dropped as `title-length`). Body, scope,
 * and evidence are untouched.
 */
export function normalizeFinalEntry(e: FinalEntry): FinalEntry {
  return { ...e, title: normalizeTitle(e.title) };
}

function normalizeTitle(raw: string): string {
  let t = raw.replace(/\s+/g, " ").trim();
  if (t.length > TITLE_CAP) {
    const slice = t.slice(0, TITLE_CAP);
    const lastSpace = slice.lastIndexOf(" ");
    t = (lastSpace > TITLE_CAP * 0.5 ? slice.slice(0, lastSpace) : slice).trimEnd();
  }
  t = t.replace(/[,:;]+$/, "").trimEnd();
  if (/^[a-z]/.test(t)) t = t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}

export function validateEntry(e: FinalEntry): ValidationResult {
  // Title — order matters: catch the most-specific failure modes
  // (truncation / JSX leakage) BEFORE the generic capitalization check
  // so a JSX-prefixed title doesn't get reported as merely
  // `title-no-cap`.
  if (e.title.length === 0 || e.title.length > TITLE_CAP) {
    return { valid: false, rejectReason: "title-length" };
  }
  if (/\.\.\.$/.test(e.title) || /^\{\/\*/.test(e.title)) {
    return { valid: false, rejectReason: "title-truncated-or-jsx" };
  }
  if (!/^[A-Z]/.test(e.title)) {
    return { valid: false, rejectReason: "title-no-cap" };
  }
  if (/[,:;]$/.test(e.title)) {
    return { valid: false, rejectReason: "title-trailing-punct" };
  }

  // Body sections
  const requiredSections = e.kind === "INV"
    ? ["## Context", "## Invariant", "## Why"]
    : ["## Context", "## Decision", "## Why"];
  for (const sec of requiredSections) {
    if (!e.body.includes(sec)) {
      return { valid: false, rejectReason: `body-missing-${sec}` };
    }
  }

  // No JSDoc tag leak
  if (/@(domain|orgScope|softDelete|see|param|returns|throws)\b/.test(e.body)) {
    return { valid: false, rejectReason: "jsdoc-tag-leak" };
  }

  // No title-in-body paste
  if (e.body.includes(e.title)) {
    return { valid: false, rejectReason: "title-pasted-in-body" };
  }

  // scope_globs nonempty — drives in-scope surfacing; an entry with no
  // scope never resolves into a working set, so this stays a hard gate.
  if (e.scope_globs.length === 0) {
    return { valid: false, rejectReason: "no-scope-globs" };
  }

  // Evidence existence is intentionally NOT validated here — see the
  // module header. `9c-emit` calls `filterExistingEvidence` to drop
  // unresolvable refs, then keeps the entry whether or not any survive.
  return { valid: true };
}

/**
 * Strip evidence refs that don't resolve to a file on disk, returning the
 * surviving subset (deduped, order-preserving). Used by `9c-emit` instead
 * of the old hard `evidence-missing` reject so a doc/rule-derived entry
 * citing an unverifiable or submodule-only path is still emitted — minus
 * the dangling ref. Returns `[]` when nothing resolves; the entry is kept.
 */
export function filterExistingEvidence(
  evidence: string[],
  repoRoot: string,
): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const ev of evidence) {
    if (seen.has(ev)) continue;
    seen.add(ev);
    if (existsSync(join(repoRoot, stripLineRange(ev)))) kept.push(ev);
  }
  return kept;
}

/**
 * Strip the `:42-58` or `#L42-L58` line-range suffix off an evidence
 * file reference. Both forms are accepted on input; the validator
 * resolves to the bare path before checking file existence.
 */
export function stripLineRange(evidenceFile: string): string {
  // GitHub-style anchor: `path/to/file.ts#L42-L58`
  const hashIdx = evidenceFile.indexOf("#");
  if (hashIdx !== -1) return evidenceFile.slice(0, hashIdx);
  // Colon-style range: `path/to/file.ts:42-58`. Only strip when the
  // suffix is digit-only (avoids clobbering Windows drive letters
  // `C:/...` — but those are absolute and should never appear in a
  // repo-relative evidence path; defensive anyway).
  const colonIdx = evidenceFile.lastIndexOf(":");
  if (colonIdx > 1 && /^\d+(?:-\d+)?$/.test(evidenceFile.slice(colonIdx + 1))) {
    return evidenceFile.slice(0, colonIdx);
  }
  return evidenceFile;
}

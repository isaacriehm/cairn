/**
 * Curator pipeline — strict per-entry validators.
 *
 * Phase 9c-emit feeds every reducer-output entry through `validateEntry`
 * before writing it to `.cairn/ground/decisions/` or
 * `.cairn/ground/invariants/`. Operator's auto-accept directive
 * (curator plan §"Decision log" Q2) requires a high quality bar — when
 * an entry fails any check it is dropped silently with a counter
 * logged, never falling back to `_inbox/`.
 *
 * Failure modes encoded by `rejectReason`:
 *   - `title-length`              — empty or > 80 chars
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
 *   - `no-evidence`               — empty `evidence_files`
 *   - `evidence-missing:<path>`   — cited evidence file does not exist
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

export function validateEntry(
  e: FinalEntry,
  repoRoot: string,
): ValidationResult {
  // Title — order matters: catch the most-specific failure modes
  // (truncation / JSX leakage) BEFORE the generic capitalization check
  // so a JSX-prefixed title doesn't get reported as merely
  // `title-no-cap`.
  if (e.title.length === 0 || e.title.length > 80) {
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

  // scope_globs nonempty
  if (e.scope_globs.length === 0) {
    return { valid: false, rejectReason: "no-scope-globs" };
  }

  // evidence_files nonempty + exist
  if (e.evidence_files.length === 0) {
    return { valid: false, rejectReason: "no-evidence" };
  }
  for (const ev of e.evidence_files) {
    const path = stripLineRange(ev);
    if (!existsSync(join(repoRoot, path))) {
      return { valid: false, rejectReason: `evidence-missing:${path}` };
    }
  }

  return { valid: true };
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

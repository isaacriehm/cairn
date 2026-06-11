/**
 * Glob path-resolution helper for migrations.
 *
 * A "dead-path" glob is one anchored at a literal directory that does not
 * exist on disk — it matches zero files, so it contributes nothing to any
 * sensor / gate / GC class. Such an entry is config noise (a path that was
 * mis-rooted at adoption, or a location that has since been renamed away).
 *
 * We judge ONLY globs with a concrete multi-segment literal base. Two carve-
 * outs keep the check conservative:
 *   - A glob whose first segment is already a wildcard (`** / x`) has no
 *     groundable anchor — kept.
 *   - A single-segment literal base (`dist/`, `node_modules/`, `coverage/`)
 *     is a generic ignore that may be transiently absent (an unbuilt output
 *     dir) — kept. Only a base of two or more concrete segments is eligible.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** Path segment characters that make a segment a wildcard, not a literal. */
const WILDCARD_RE = /[*?[\]{}]/;

/**
 * The leading run of wildcard-free path segments. `core/x/*.ts` → `core/x`;
 * `**​/auth/**` → `` (empty — no literal anchor); `a/b.ts` → `a/b.ts`.
 */
export function literalBase(glob: string): string {
  const literal: string[] = [];
  for (const seg of glob.split("/")) {
    if (WILDCARD_RE.test(seg)) break;
    literal.push(seg);
  }
  return literal.filter((s) => s.length > 0).join("/");
}

/**
 * True when `glob` is anchored at a concrete path (≥2 literal segments) that
 * does not resolve under `repoRoot`. Wildcard-anchored and single-segment
 * globs are never judged dead (see module header).
 */
export function isDeadPathGlob(repoRoot: string, glob: string): boolean {
  const base = literalBase(glob);
  if (base.length === 0) return false;
  if (base.split("/").length < 2) return false;
  return !existsSync(join(repoRoot, base));
}

/**
 * GC pass — scope-coverage.
 *
 * Surfaces drift between the source tree and `.harness/ground/scope-index.yaml`:
 *   1. Source files with no scope-index entry → `scope_uncovered`.
 *   2. Index entries pointing at paths that no longer exist → `scope_drift_orphan`.
 *
 * If the scope-index file itself is missing, emits a single
 * `scope_index_missing` finding telling the operator to rebuild it.
 *
 * Spec: docs/DOCS_SPEC.md §3.8.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { lookupScope, readScopeIndex } from "../ground/scope-index.js";
import type { GcFinding } from "./types.js";
import { walkSourceTree } from "./walk-source.js";

const PASS_ID = "scope-coverage" as const;
const MAX_FINDINGS_PER_KIND = 50;

export interface ScopeCoverageOptions {
  repoRoot: string;
}

export interface ScopeCoverageResult {
  findings: GcFinding[];
}

export function runScopeCoverage(
  opts: ScopeCoverageOptions,
): ScopeCoverageResult {
  const findings: GcFinding[] = [];
  const index = readScopeIndex(opts.repoRoot);
  if (index === null) {
    findings.push({
      pass: PASS_ID,
      kind: "scope_index_missing",
      path: ".harness/ground/scope-index.yaml",
      detail:
        "scope-index.yaml not found — run `harness scope rebuild` to populate",
      severity: "warn",
    });
    return { findings };
  }

  // 1. Files in the source tree without an entry.
  const sourceFiles = walkSourceTree(opts.repoRoot);
  let uncoveredCount = 0;
  for (const rel of sourceFiles) {
    if (uncoveredCount >= MAX_FINDINGS_PER_KIND) break;
    const entry = lookupScope(index, rel);
    if (entry === null) {
      findings.push({
        pass: PASS_ID,
        kind: "scope_uncovered",
        path: rel,
        detail: `${rel} has no scope-index entry — uncovered by decisions/invariants mapping`,
        severity: "warn",
      });
      uncoveredCount++;
    }
    // entry.unscoped === true is fine — the operator explicitly marked it.
  }

  // 2. Index entries pointing at missing files.
  let orphanCount = 0;
  for (const path of Object.keys(index.files)) {
    if (orphanCount >= MAX_FINDINGS_PER_KIND) break;
    const abs = join(opts.repoRoot, path);
    if (!existsSync(abs)) {
      findings.push({
        pass: PASS_ID,
        kind: "scope_drift_orphan",
        path,
        detail: `${path} appears in scope-index but does not exist in the working tree`,
        severity: "warn",
      });
      orphanCount++;
    }
  }

  return { findings };
}

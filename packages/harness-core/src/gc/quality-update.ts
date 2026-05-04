/**
 * GC pass 5 — quality grades update.
 *
 * Rebuilds `.harness/ground/quality-grades.yaml` from terminal-run history at
 * `.harness/runs/terminal/*`. The grounding daemon also writes this file on
 * watch events, so GC's job is to ensure a fresh write lands on the GC cron
 * and that any drift between the file's content and the latest reality is
 * captured as a safe-class commit.
 *
 * Implementation: build the grades structure in-memory, compare against the
 * file currently on disk (modules array as JSON, ignoring `generated:`
 * timestamp churn), and emit a commit proposal only when content differs.
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { buildQualityGrades } from "../ground/quality-grades.js";
import { qualityGradesPath } from "../ground/paths.js";
import type { GcCommitProposal, GcFinding } from "./types.js";

const PASS_ID = "quality-grades" as const;

export interface QualityUpdateOptions {
  repoRoot: string;
  recentRunCount?: number;
}

export interface QualityUpdateResult {
  findings: GcFinding[];
  proposals: GcCommitProposal[];
}

export function runQualityGradesUpdate(
  opts: QualityUpdateOptions,
): QualityUpdateResult {
  const findings: GcFinding[] = [];
  const proposals: GcCommitProposal[] = [];

  const grades = buildQualityGrades({
    repoRoot: opts.repoRoot,
    ...(opts.recentRunCount !== undefined ? { recentRunCount: opts.recentRunCount } : {}),
  });
  const newContent = stringifyYaml(grades);
  const filePath = qualityGradesPath(opts.repoRoot);
  const relPath = ".harness/ground/quality-grades.yaml";

  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const existingModules = existing.length > 0 ? safeParseModules(existing) : [];
  const existingModulesJson = JSON.stringify(existingModules);
  const newModulesJson = JSON.stringify(grades.modules);

  if (existingModulesJson === newModulesJson) {
    return { findings, proposals };
  }

  const finding: GcFinding = {
    pass: PASS_ID,
    kind: "quality_update",
    path: relPath,
    detail: `quality-grades.yaml modules changed (${grades.modules.length} module${grades.modules.length === 1 ? "" : "s"} graded)`,
    severity: "info",
  };
  findings.push(finding);

  proposals.push({
    pass: PASS_ID,
    class: "safe",
    paths: [relPath],
    patch: { [relPath]: newContent },
    commit_message:
      `chore(gc): refresh quality-grades.yaml (${grades.modules.length} modules)\n\n` +
      `GC quality-grades pass — recomputed from .harness/runs/terminal/.\n` +
      `Auto-applied as safe-class per L16 (PRIMER §12.2).\n`,
    findings: [finding],
  });

  return { findings, proposals };
}

function safeParseModules(text: string): unknown[] {
  try {
    const parsed = parseYaml(text);
    if (typeof parsed === "object" && parsed !== null) {
      const m = (parsed as { modules?: unknown }).modules;
      return Array.isArray(m) ? m : [];
    }
  } catch {
    // fall through
  }
  return [];
}

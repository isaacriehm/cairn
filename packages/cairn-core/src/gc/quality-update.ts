/**
 * GC pass 5 — quality grades update.
 *
 * Rebuilds `.cairn/ground/quality-grades.yaml` from terminal-run history at
 * `.cairn/runs/terminal/*`. The MCP record-decision tool also writes this
 * file on quality-grade changes, but this pass captures runs that
 * completed outside the MCP (cli adoptions, manual fix-align runs) to keep
 * the project health dashboard accurate.
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { buildQualityGrades, qualityGradesPath } from "@isaacriehm/cairn-state";
import type { GcCommitProposal, GcFinding } from "./types.js";

const PASS_ID = "quality-grades" as const;

export interface QualityUpdateOptions {
  repoRoot: string;
  recentRunCount?: number;
}

/** Run the quality-grades update pass. */
export async function runQualityUpdate(
  opts: QualityUpdateOptions,
): Promise<{ findings: GcFinding[]; proposals: GcCommitProposal[] }> {
  const findings: GcFinding[] = [];
  const proposals: GcCommitProposal[] = [];

  const filePath = qualityGradesPath(opts.repoRoot);
  const relPath = ".cairn/ground/quality-grades.yaml";

  const grades = buildQualityGrades({
    repoRoot: opts.repoRoot,
    ...(opts.recentRunCount !== undefined ? { recentRunCount: opts.recentRunCount } : {}),
  });
  const newContent = stringifyYaml(grades);

  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const existingModulesJson = JSON.stringify(safeParseModules(existing));
  const newModulesJson = JSON.stringify(grades.modules);

  if (existingModulesJson === newModulesJson) {
    return { findings, proposals };
  }

  const finding: GcFinding = {
    pass: PASS_ID,
    kind: "quality_grades_rebuilt",
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
      `GC quality-grades pass — recomputed from .cairn/runs/terminal/.\n` +
      `Auto-applied as safe-class (GC auto-merge policy).\n`,
    findings: [finding],
  });

  return { findings, proposals };
}

function safeParseModules(text: string): unknown[] {
  if (text.length === 0) return [];
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

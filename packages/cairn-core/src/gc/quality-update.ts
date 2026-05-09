/**
 * GC pass 5 — quality grades update.
 *
 * Rebuilds `.cairn/ground/quality-grades.yaml` from terminal-run history at
 * `.cairn/runs/terminal/*`. The MCP record-decision tool also writes this
 * file on quality-grade changes, but this pass captures runs that
 * completed outside the MCP (cli adoptions, manual fix-align runs) to keep
 * the project health dashboard accurate.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { buildQualityGrades, qualityGradesPath } from "@isaacriehm/cairn-state";
import type { GcCommitProposal, GcFinding } from "./types.js";
import { z } from "zod";

const PASS_ID = "quality-grades" as const;

const ModulesSchema = z.object({
  modules: z.array(z.unknown()),
}).passthrough();

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

  const currentPath = qualityGradesPath(opts.repoRoot);
  const before = existsSync(currentPath) ? readFileSync(currentPath, "utf8") : "";

  // 1. Compute new grades from history.
  const grades = buildQualityGrades({ repoRoot: opts.repoRoot });
  const after = stringifyYaml(grades);

  // 2. If changed, emit proposal.
  if (before !== after) {
    const bModules = safeParseModules(before);
    const aModules = grades.modules;

    const proposal: GcCommitProposal = {
      pass: PASS_ID,
      class: "safe",
      paths: [currentPath],
      patch: { [currentPath]: after },
      commit_message: `cairn: update quality grades (rebuilt from ${aModules.length} modules)`,
      findings: [],
    };
    proposals.push(proposal);

    findings.push({
      pass: PASS_ID,
      kind: "quality_grades_rebuilt",
      path: ".cairn/ground/quality-grades.yaml",
      detail: `Quality grades rebuilt from history (${bModules.length} → ${aModules.length} modules)`,
      severity: "soft",
    });
  }

  return { findings, proposals };
}

function safeParseModules(text: string): unknown[] {
  if (text.length === 0) return [];
  try {
    const parsed: unknown = parseYaml(text);
    const result = ModulesSchema.safeParse(parsed);
    return result.success ? result.data.modules : [];
  } catch {
    return [];
  }
}

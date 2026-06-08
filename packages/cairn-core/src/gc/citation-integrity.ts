/**
 * GC pass — citation integrity.
 *
 * Walks every source file in the repo and scans for cairn citations
 * (§INV invariants, §DEC decisions, TODO(TSK-...) linked todos). Each
 * citation is resolved against the appropriate source of truth:
 *
 *   - §INV-<hash>  resolved against `invariants.ledger.yaml` (Active/Superseded)
 *   - §DEC-<hash>  resolved against `decisions.ledger.yaml` (Accepted/Superseded)
 *   - TODO(TSK-) resolved against `tasks/{active,done}/`
 *
 * Findings surface orphaned citations (target missing) or stale citations
 * (target superseded by a newer version).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildDecisionsLedger,
  buildInvariantsLedger,
  decisionsLedgerPath,
  invariantsLedgerPath,
  knownExtensions,
} from "@isaacriehm/cairn-state";
import { walkSourceTree } from "./walk-source.js";
import type { GcFinding } from "./types.js";
import { z } from "zod";

const PASS_ID = "citation-integrity" as const;

const LedgerEntrySchema = z.object({
  id: z.string(),
  superseded_by: z.string().nullable().optional(),
}).passthrough();

interface LedgerInfo {
  active: Set<string>;
  superseded: Map<string, string>;
}

function loadInvariants(repoRoot: string): LedgerInfo {
  const active = new Set<string>();
  for (const e of buildInvariantsLedger({ repoRoot })) {
    active.add(e.id);
  }
  const superseded = new Map<string, string>();
  const path = invariantsLedgerPath(repoRoot);
  if (!existsSync(path)) return { active, superseded };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = parseYaml(raw);
    const result = z.array(LedgerEntrySchema).safeParse(parsed);
    if (result.success) {
      for (const e of result.data) {
        const id = e.id;
        const supBy = e.superseded_by ?? null;
        if (supBy !== null && supBy.length > 0) {
          superseded.set(id, supBy);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return { active, superseded };
}

function loadDecisions(repoRoot: string): LedgerInfo {
  const active = new Set<string>();
  for (const e of buildDecisionsLedger({ repoRoot })) {
    active.add(e.id);
  }
  const superseded = new Map<string, string>();
  const path = decisionsLedgerPath(repoRoot);
  if (!existsSync(path)) return { active, superseded };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = parseYaml(raw);
    const result = z.array(LedgerEntrySchema).safeParse(parsed);
    if (result.success) {
      for (const e of result.data) {
        const id = e.id;
        const supBy = e.superseded_by ?? null;
        if (supBy !== null && supBy.length > 0) {
          superseded.set(id, supBy);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return { active, superseded };
}

function fileExt(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? "" : path.slice(idx).toLowerCase();
}

// Code extensions come from the shared language registry (single source);
// the markup/style extras have no language profile but still carry citations.
const SOURCE_EXTENSIONS = new Set<string>([
  ...knownExtensions(),
  ".html",
  ".css",
  ".scss",
]);

const INV_RE = /§INV-([0-9a-f]{7,})\b/g;
const DEC_RE = /§DEC-([0-9a-f]{7,})\b/g;
// Format: `TSK-<slug>-<7-hex>`. The directory lookup is the source
// of truth; the regex is just a "looks like a task id" gate.
const TSK_RE = /TODO\((TSK-[a-z0-9-]+-[0-9a-f]{7})\)/g;

/** Run citation-integrity against all source files in repoRoot. */
export async function runCitationIntegrity(opts: {
  repoRoot: string;
}): Promise<{ findings: GcFinding[] }> {
  const files = walkSourceTree(opts.repoRoot);
  const invariants = loadInvariants(opts.repoRoot);
  const decisions = loadDecisions(opts.repoRoot);

  const findings: GcFinding[] = [];

  for (const rel of files) {
    if (!SOURCE_EXTENSIONS.has(fileExt(rel))) continue;
    const abs = join(opts.repoRoot, rel);
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i] ?? "";
      const lineNumber = i + 1;

      // 1. Invariants
      for (const m of lineText.matchAll(INV_RE)) {
        const id = `INV-${m[1]}`;
        if (invariants.active.has(id)) continue;
        const supBy = invariants.superseded.get(id);
        if (supBy !== undefined) {
          findings.push({
            pass: PASS_ID,
            kind: "stale_citation",
            path: rel,
            detail: `${rel}:${lineNumber} references ${id}, which is superseded by ${supBy}`,
            severity: "warn",
            line: lineNumber,
          });
        } else {
          findings.push({
            pass: PASS_ID,
            kind: "orphaned_citation",
            path: rel,
            detail: `${rel}:${lineNumber} references ${id}, which is not in the active ledger`,
            severity: "warn",
            line: lineNumber,
          });
        }
      }

      // 2. Decisions
      for (const m of lineText.matchAll(DEC_RE)) {
        const id = `DEC-${m[1]}`;
        if (decisions.active.has(id)) continue;
        const supBy = decisions.superseded.get(id);
        if (supBy !== undefined) {
          findings.push({
            pass: PASS_ID,
            kind: "stale_citation",
            path: rel,
            detail: `${rel}:${lineNumber} references ${id}, which is superseded by ${supBy}`,
            severity: "warn",
            line: lineNumber,
          });
        } else {
          findings.push({
            pass: PASS_ID,
            kind: "orphaned_citation",
            path: rel,
            detail: `${rel}:${lineNumber} references ${id}, which is not in the accepted ledger`,
            severity: "warn",
            line: lineNumber,
          });
        }
      }

      // 3. Task todos
      for (const m of lineText.matchAll(TSK_RE)) {
        const taskId = m[1];
        if (taskId === undefined) continue;
        const activeDir = join(opts.repoRoot, ".cairn", "tasks", "active", taskId);
        const doneDir = join(opts.repoRoot, ".cairn", "tasks", "done", taskId);
        if (existsSync(activeDir)) continue;
        if (existsSync(doneDir)) continue;
        findings.push({
          pass: PASS_ID,
          kind: "orphaned_citation",
          path: rel,
          detail: `${rel}:${lineNumber} references ${taskId}, which is not in tasks/{active,done}/`,
          severity: "warn",
          line: lineNumber,
        });
      }
    }
  }

  return { findings };
}

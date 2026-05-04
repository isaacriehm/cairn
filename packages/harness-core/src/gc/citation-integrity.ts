/**
 * GC pass — citation integrity.
 *
 * Walks every source file in the repo and scans for harness citations
 * (§V invariants, TODO(TSK-...) linked todos, banned DEC-N comments).
 * Each citation is resolved against the appropriate source of truth:
 *   - §V<N>  → invariants.ledger.yaml. Missing → orphaned. superseded_by set
 *               anywhere in the ledger → superseded citation.
 *   - DEC-<N> → always a policy violation per PRIMER §10 (DEC-id inline
 *               comments are banned).
 *   - TODO(TSK-<id>) → tasks/{active,done}/<id>/. Missing → orphan; "done"
 *                       isn't a finding (TODO will be removed when the agent
 *                       gets to it; flagging is noisy).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildInvariantsLedger } from "../ground/index.js";
import { invariantsLedgerPath } from "../ground/paths.js";
import { scanCitations } from "../hooks/post-tool-use/citation-scanner.js";
import type { GcFinding } from "./types.js";
import { walkSourceTree } from "./walk-source.js";

const PASS_ID = "citation-integrity" as const;

const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".swift", ".kt", ".sh", ".bash", ".zsh",
  ".sql", ".html", ".vue", ".svelte", ".css", ".scss",
]);

export interface CitationIntegrityOptions {
  repoRoot: string;
  /** Cap on file size to scan (bytes). Default 256 KB. */
  maxFileBytes?: number;
}

export interface CitationIntegrityResult {
  findings: GcFinding[];
}

interface InvariantInfo {
  active: Set<string>;        // ids of currently-active entries
  superseded: Map<string, string>;  // id → supersededBy
}

function loadInvariants(repoRoot: string): InvariantInfo {
  const active = new Set<string>();
  for (const e of buildInvariantsLedger({ repoRoot })) {
    active.add(e.id);
  }
  const superseded = new Map<string, string>();
  const path = invariantsLedgerPath(repoRoot);
  if (!existsSync(path)) {
    return { active, superseded };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return { active, superseded };
  }
  if (!Array.isArray(parsed)) return { active, superseded };
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e["id"] === "string" ? (e["id"] as string) : null;
    const supBy = typeof e["superseded_by"] === "string" ? (e["superseded_by"] as string) : null;
    if (id !== null && supBy !== null && supBy.length > 0) {
      superseded.set(id, supBy);
    }
  }
  return { active, superseded };
}

function fileExt(path: string): string {
  const idx = path.lastIndexOf(".");
  if (idx === -1) return "";
  return path.slice(idx).toLowerCase();
}

export function runCitationIntegrity(opts: CitationIntegrityOptions): CitationIntegrityResult {
  const findings: GcFinding[] = [];
  const maxBytes = opts.maxFileBytes ?? 256 * 1024;

  const invariants = loadInvariants(opts.repoRoot);

  const files = walkSourceTree(opts.repoRoot);
  for (const rel of files) {
    if (!TEXT_EXTS.has(fileExt(rel))) continue;
    const abs = join(opts.repoRoot, rel);
    let size: number;
    try {
      size = statSync(abs).size;
    } catch {
      continue;
    }
    if (size > maxBytes) continue;

    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (content.length === 0) continue;

    const matches = scanCitations(content);

    // §V invariants
    for (const m of matches.invariants) {
      if (invariants.superseded.has(m.id)) {
        const supBy = invariants.superseded.get(m.id) ?? "(unknown)";
        findings.push({
          pass: PASS_ID,
          kind: "superseded_citation",
          path: rel,
          detail: `${rel}:${m.line} cites §${m.id}, which is superseded by §${supBy}`,
          severity: "warn",
          line: m.line,
        });
        continue;
      }
      if (!invariants.active.has(m.id)) {
        findings.push({
          pass: PASS_ID,
          kind: "orphaned_citation",
          path: rel,
          detail: `${rel}:${m.line} cites §${m.id}, which is not in the invariants ledger`,
          severity: "warn",
          line: m.line,
        });
      }
    }

    // DEC-N inline comments — always a policy violation per PRIMER §10
    for (const m of matches.decIds) {
      findings.push({
        pass: PASS_ID,
        kind: "banned_dec_comment",
        path: rel,
        detail: `${rel}:${m.line} contains ${m.id} inline comment — DEC-id citations are banned per PRIMER §10`,
        severity: "warn",
        line: m.line,
      });
    }

    // TODO(TSK-...) — check active/done dirs
    for (const m of matches.todos) {
      const taskId = m.id; // already "TSK-..."
      const activeDir = join(opts.repoRoot, ".harness", "tasks", "active", taskId);
      const doneDir = join(opts.repoRoot, ".harness", "tasks", "done", taskId);
      if (existsSync(activeDir)) continue;   // active TODO — fine
      if (existsSync(doneDir)) continue;     // done — agent will remove eventually; not a finding
      findings.push({
        pass: PASS_ID,
        kind: "orphaned_citation",
        path: rel,
        detail: `${rel}:${m.line} references ${taskId}, which is not in tasks/{active,done}/`,
        severity: "warn",
        line: m.line,
      });
    }
  }

  return { findings };
}

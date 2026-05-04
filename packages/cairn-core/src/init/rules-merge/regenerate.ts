/**
 * Phase 7c — regenerate CLAUDE.md and AGENTS.md from ground state.
 *
 * Per spec §6 Phase 7c: "post-adoption: harness regenerates CLAUDE.md and
 * AGENTS.md from ground state on each `harness sweep`; operator-written
 * sections preserved between `<!-- harness:keep-start -->` and
 * `<!-- harness:keep-end -->` markers".
 *
 * This module owns the template rendering primitive. The sweep CLI (or skill
 * driving it) calls `regenerateRulesFiles({ repoRoot })` and writes the
 * returned content to disk under the per-write flock.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDecisionsLedger,
  buildInvariantsLedger,
} from "../../ground/ledgers.js";
import type {
  DecisionLedgerEntry,
  InvariantLedgerEntry,
} from "../../ground/schemas.js";
import { extractKeepBlocks, reapplyKeepBlocks } from "./keep-markers.js";

export interface RegenerateRulesArgs {
  repoRoot: string;
  /** Optional brand name; when present, used in the CLAUDE.md heading. */
  brandName?: string;
  /** Optional 1-line positioning summary. */
  positioning?: string;
  /** Override `Date.now()` for deterministic output (smokes). */
  nowIso?: string;
}

export interface RegenerateRulesResult {
  claudeMdPath: string;
  agentsMdPath: string;
  claudeMdContent: string;
  agentsMdContent: string;
  decisions: DecisionLedgerEntry[];
  invariants: InvariantLedgerEntry[];
  keepBlocksClaudeMd: number;
  keepBlocksAgentsMd: number;
}

export function regenerateRulesFiles(args: RegenerateRulesArgs): RegenerateRulesResult {
  const repoRoot = args.repoRoot;
  const decisions = buildDecisionsLedger({ repoRoot });
  const invariants = buildInvariantsLedger({ repoRoot });
  const generatedAt = args.nowIso ?? new Date().toISOString();

  const claudeMdPath = join(repoRoot, "CLAUDE.md");
  const agentsMdPath = join(repoRoot, "AGENTS.md");

  const existingClaudeMd = readIfExists(claudeMdPath);
  const existingAgentsMd = readIfExists(agentsMdPath);

  const keepClaudeMd = existingClaudeMd !== null ? extractKeepBlocks(existingClaudeMd) : [];
  const keepAgentsMd = existingAgentsMd !== null ? extractKeepBlocks(existingAgentsMd) : [];

  const claudeBody = renderClaudeMd({
    brandName: args.brandName,
    positioning: args.positioning,
    decisions,
    invariants,
    keepCount: keepClaudeMd.length,
    generatedAt,
  });
  const agentsBody = renderAgentsMd({
    brandName: args.brandName,
    decisions,
    invariants,
    keepCount: keepAgentsMd.length,
    generatedAt,
  });

  const claudeFinal = reapplyKeepBlocks(claudeBody, keepClaudeMd);
  const agentsFinal = reapplyKeepBlocks(agentsBody, keepAgentsMd);

  return {
    claudeMdPath,
    agentsMdPath,
    claudeMdContent: claudeFinal,
    agentsMdContent: agentsFinal,
    decisions,
    invariants,
    keepBlocksClaudeMd: keepClaudeMd.length,
    keepBlocksAgentsMd: keepAgentsMd.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Templates                                                                  */
/* -------------------------------------------------------------------------- */

interface RenderArgs {
  brandName: string | undefined;
  positioning?: string | undefined;
  decisions: DecisionLedgerEntry[];
  invariants: InvariantLedgerEntry[];
  keepCount: number;
  generatedAt: string;
}

function renderClaudeMd(a: RenderArgs): string {
  const lines: string[] = [];
  const heading = a.brandName !== undefined ? `# ${a.brandName} — Project Rules` : "# Project Rules";
  lines.push(heading);
  lines.push("");
  lines.push("<!--");
  lines.push("  This file is regenerated from .harness/ground/ on each sweep.");
  lines.push(`  Generated at: ${a.generatedAt}.`);
  lines.push("  Operator content lives between <!-- harness:keep-start --> markers.");
  lines.push("-->");
  lines.push("");
  if (a.positioning !== undefined && a.positioning.length > 0) {
    lines.push(`> ${a.positioning}`);
    lines.push("");
  }
  lines.push("## Authoritative state");
  lines.push("");
  lines.push("- Decisions ledger: `.harness/ground/decisions/decisions.ledger.yaml`");
  lines.push("- Invariants ledger: `.harness/ground/invariants/invariants.ledger.yaml`");
  lines.push("- Brand + voice: `.harness/ground/brand/`");
  lines.push("- Canonical map: `.harness/ground/canonical-map/topics.yaml`");
  lines.push("");
  lines.push("Agents query the harness MCP surface, not these files directly.");
  lines.push("");
  lines.push("## Active decisions");
  lines.push("");
  if (a.decisions.length === 0) {
    lines.push("_(none yet — run `/harness-direction` to capture one)_");
  } else {
    for (const d of a.decisions) {
      lines.push(`- **${d.id}** — ${escapeMd(d.title)}`);
    }
  }
  lines.push("");
  lines.push("## Active invariants");
  lines.push("");
  if (a.invariants.length === 0) {
    lines.push("_(none yet)_");
  } else {
    for (const v of a.invariants) {
      lines.push(`- **${v.id}** — ${escapeMd(v.title)}`);
    }
  }
  lines.push("");
  lines.push("## Operator sections");
  lines.push("");
  for (let i = 0; i < a.keepCount; i++) {
    lines.push(`<!-- harness:keep-anchor:${i} -->`);
    lines.push("");
  }
  if (a.keepCount === 0) {
    lines.push("_(no operator-preserved sections — wrap content in `<!-- harness:keep-start --> … <!-- harness:keep-end -->` to preserve)_");
    lines.push("");
  }
  lines.push("");
  return lines.join("\n");
}

function renderAgentsMd(a: RenderArgs): string {
  const lines: string[] = [];
  const heading = a.brandName !== undefined ? `# ${a.brandName} — Agent TOC` : "# Agent TOC";
  lines.push(heading);
  lines.push("");
  lines.push("<!--");
  lines.push("  Regenerated from .harness/ground/ on each sweep.");
  lines.push(`  Generated at: ${a.generatedAt}.`);
  lines.push("-->");
  lines.push("");
  lines.push("## Locations");
  lines.push("");
  lines.push("| What | Where |");
  lines.push("|------|-------|");
  lines.push("| Decisions | `.harness/ground/decisions/` |");
  lines.push("| Invariants | `.harness/ground/invariants/` |");
  lines.push("| Brand | `.harness/ground/brand/` |");
  lines.push("| Canonical-map | `.harness/ground/canonical-map/` |");
  lines.push("| Tasks (active) | `.harness/tasks/active/` |");
  lines.push("");
  lines.push(
    `Currently: ${a.decisions.length} active decision${a.decisions.length === 1 ? "" : "s"}, ` +
      `${a.invariants.length} active invariant${a.invariants.length === 1 ? "" : "s"}.`,
  );
  lines.push("");
  lines.push("## Operator sections");
  lines.push("");
  for (let i = 0; i < a.keepCount; i++) {
    lines.push(`<!-- harness:keep-anchor:${i} -->`);
    lines.push("");
  }
  lines.push("");
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function readIfExists(p: string): string | null {
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|").trim();
}

#!/usr/bin/env tsx
/**
 * smoke-rules-merge — Phase 7c discovery + section parser + keep-marker
 * preservation + regenerate templates.
 *
 * No real Haiku calls — `mockClassify` returns deterministic outputs.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KEEP_END_MARKER,
  KEEP_START_MARKER,
  discoverRuleSources,
  extractKeepBlocks,
  parseRuleSections,
  reapplyKeepBlocks,
  regenerateRulesFiles,
  renderKeepBlock,
  runRulesMerge,
  type RuleClassification,
  type RuleSection,
  type RuleSourceFile,
} from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    cleanup();
    process.exit(1);
  }
}

function cleanup(): void {
  for (const path of cleanups.reverse()) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function mkRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-rulesmerge-"));
  cleanups.push(dir);
  return dir;
}

function writeFile(repoRoot: string, rel: string, body: string): string {
  const abs = join(repoRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
  return abs;
}

function step(label: string): void {
  console.log(`── ${label}`);
}

async function main(): Promise<void> {
  step("Step 1 — discover rule sources");
  const repoRoot = mkRepoRoot();
  writeFile(repoRoot, "CLAUDE.md", "# Top\n");
  writeFile(repoRoot, "AGENTS.md", "# Agents\n");
  writeFile(repoRoot, ".claude/CLAUDE.md", "# Inner\n");
  writeFile(repoRoot, ".claude/rules/auth.md", "# Auth\n");
  writeFile(repoRoot, ".claude/rules/sub/billing.md", "# Billing\n");

  const sources = discoverRuleSources(repoRoot);
  const kinds = sources.map((s) => s.kind).sort();
  assert(kinds.includes("claude-md-root"), "discovered claude-md-root");
  assert(kinds.includes("agents-md-root"), "discovered agents-md-root");
  assert(kinds.includes("claude-md-claude-dir"), "discovered claude-md-claude-dir");
  const ruleFiles = sources.filter((s) => s.kind === "rule");
  assert(ruleFiles.length === 2, "discovered 2 rule files");
  console.log(`  ✓ Step 1 — discover (${sources.length} sources)`);

  step("Step 2 — parse markdown sections");
  const sample = `# Top heading\n\nIntro.\n\n## Section A\n\nA body line.\n\n### A.1\n\nDetail.\n\n## Section B\n\nB body.\n`;
  const parsed = parseRuleSections(sample);
  const titles = parsed.map((s) => s.title);
  assert(titles.includes("Section A"), "Section A captured");
  assert(titles.includes("A.1"), "A.1 captured (H3)");
  assert(titles.includes("Section B"), "Section B captured");
  console.log(`  ✓ Step 2 — parsed ${parsed.length} sections`);

  step("Step 3 — keep-marker extraction + reapply");
  const original = `# Title\n\n${KEEP_START_MARKER}\nThis is operator content.\n${KEEP_END_MARKER}\n\n## H2\n\nbody\n`;
  const keep = extractKeepBlocks(original);
  assert(keep.length === 1, "one keep block");
  assert(keep[0]?.body.trim() === "This is operator content.", "keep body preserved");

  // Regenerate-style template with anchors.
  const template = `# Title\n\n## Operator sections\n\n<!-- cairn:keep-anchor:0 -->\n\n## H2\n\nbody\n`;
  const reapplied = reapplyKeepBlocks(template, keep);
  assert(reapplied.includes(KEEP_START_MARKER), "reapplied has start marker");
  assert(reapplied.includes("This is operator content."), "reapplied content present");
  console.log("  ✓ Step 3 — keep-marker extract/reapply");

  step("Step 4 — keep-marker labels + orphan appendix");
  const labelled = `${renderKeepBlock("First", "alpha")}\n\n${renderKeepBlock("Second", "beta")}\n`;
  const blocks = extractKeepBlocks(labelled);
  assert(blocks.length === 2, "two labelled blocks");
  assert(blocks[0]?.label === "alpha", "label alpha");
  assert(blocks[1]?.label === "beta", "label beta");
  // Template has only one anchor — second should land in orphan appendix.
  const partialTemplate = `# T\n\n<!-- cairn:keep-anchor:0 -->\n`;
  const reapplied2 = reapplyKeepBlocks(partialTemplate, blocks);
  assert(reapplied2.includes("First"), "first block placed at anchor");
  assert(reapplied2.includes("Second"), "second block placed (orphan appendix)");
  assert(reapplied2.includes("Operator-preserved sections"), "orphan appendix heading");
  console.log("  ✓ Step 4 — labels + orphan appendix");

  step("Step 5 — runRulesMerge classifies + writes audit + DEC drafts");
  const repoRoot2 = mkRepoRoot();
  writeFile(
    repoRoot2,
    "CLAUDE.md",
    [
      "# Top",
      "",
      "## Brand voice",
      "",
      "Always write in active voice. Avoid filler.",
      "",
      "## Architecture",
      "",
      "TOC link to docs/.",
      "",
      `${KEEP_START_MARKER}`,
      "Operator hand-written ops note.",
      KEEP_END_MARKER,
    ].join("\n") + "\n",
  );

  const mockClassify = (
    section: RuleSection,
    source: RuleSourceFile,
  ): RuleClassification => {
    if (section.title === "Brand voice") {
      return {
        source: source.path,
        level: section.level,
        title: section.title,
        startOffset: section.startOffset,
        kind: "rule-net-new",
        proposedDecTitle: "Always write in active voice",
        proposedRationale: "Active voice keeps copy direct and easy to scan.",
        conflictsWith: "",
        failed: false,
      };
    }
    return {
      source: source.path,
      level: section.level,
      title: section.title,
      startOffset: section.startOffset,
      kind: "informational",
      proposedDecTitle: "",
      proposedRationale: "",
      conflictsWith: "",
      failed: false,
    };
  };

  const result = await runRulesMerge({ repoRoot: repoRoot2, mockClassify });
  assert(result.kindCounts["rule-net-new"] === 1, "one rule-net-new");
  assert(result.decDraftsWritten.length === 1, "one DEC draft written");
  const draftRel = result.decDraftsWritten[0]?.path;
  assert(typeof draftRel === "string", "draft path string");
  const draftAbs = join(repoRoot2, draftRel ?? "");
  assert(existsSync(draftAbs), "draft file exists");
  const draft = readFileSync(draftAbs, "utf8");
  assert(draft.includes("active voice"), "draft body includes title text");
  assert(draft.includes("status: draft-from-rules-merge"), "draft tagged rules-merge");
  // operator-keep section ought to be classified as such (within keep block).
  const operatorKeep = result.classifications.find((c) => c.kind === "operator-keep");
  assert(operatorKeep !== undefined, "operator-keep classification present");
  console.log("  ✓ Step 5 — runRulesMerge persists DEC drafts + audit");

  step("Step 6 — regenerateRulesFiles produces CLAUDE.md + AGENTS.md");
  const repoRoot3 = mkRepoRoot();
  writeFile(
    repoRoot3,
    "CLAUDE.md",
    `# Existing\n\n${KEEP_START_MARKER}\nKeep this verbatim.\n${KEEP_END_MARKER}\n`,
  );
  // Seed a decision file directly so buildDecisionsLedger picks it up.
  writeFile(
    repoRoot3,
    ".cairn/ground/decisions/DEC-a3f7b2c.md",
    [
      "---",
      "id: DEC-a3f7b2c",
      "title: Always sign with HS512",
      "type: adr",
      "status: accepted",
      "audience: dual",
      "generated: 2026-01-01T00:00:00Z",
      "verified-at: 2026-01-01T00:00:00Z",
      "decided_at: 2026-01-01T00:00:00Z",
      "decided_by: smoke",
      "---",
      "",
      "# DEC-a3f7b2c",
      "",
    ].join("\n"),
  );
  const regen = regenerateRulesFiles({
    repoRoot: repoRoot3,
    brandName: "Cairn",
    positioning: "State + context for AI orchestration.",
    nowIso: "2026-05-04T00:00:00Z",
  });
  assert(regen.decisions.length === 1, "ledger picked up DEC-a3f7b2c");
  assert(regen.claudeMdContent.includes("DEC-a3f7b2c"), "CLAUDE.md cites DEC-a3f7b2c");
  assert(regen.claudeMdContent.includes("State + context"), "CLAUDE.md cites positioning");
  assert(regen.claudeMdContent.includes("Keep this verbatim."), "CLAUDE.md preserves keep block");
  assert(regen.agentsMdContent.includes("Decisions"), "AGENTS.md includes decisions row");
  assert(regen.keepBlocksClaudeMd === 1, "one keep block tracked for CLAUDE.md");
  console.log("  ✓ Step 6 — regenerate preserves keep + lists ground state");

  step("Cleanup");
  cleanup();
  console.log("\nsmoke-rules-merge — pass");
}

main().catch((err) => {
  console.error("smoke-rules-merge — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});

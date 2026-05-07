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
  // .claude/CLAUDE.md is owned by phase 6 (kind=doc) under v0.5.0; phase 7c
  // discover should NOT pick it up.
  writeFile(repoRoot, ".claude/CLAUDE.md", "# Inner\n");
  writeFile(repoRoot, ".claude/rules/auth.md", "# Auth\n");
  writeFile(repoRoot, ".claude/rules/sub/billing.md", "# Billing\n");

  const sources = discoverRuleSources(repoRoot);
  const kinds = sources.map((s) => s.kind).sort();
  assert(kinds.includes("claude-md-root"), "discovered claude-md-root");
  assert(kinds.includes("agents-md-root"), "discovered agents-md-root");
  assert(
    !sources.some((s) => s.path === ".claude/CLAUDE.md"),
    ".claude/CLAUDE.md NOT discovered by phase 7c",
  );
  const ruleFiles = sources.filter((s) => s.kind === "rule");
  assert(ruleFiles.length === 2, "discovered 2 rule files");
  console.log(`  ✓ Step 1 — discover (${sources.length} sources, .claude/CLAUDE.md excluded)`);

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

  step("Step 5 — runRulesMerge emits verbatim DEC + cite-existing + conflict file");
  const repoRoot2 = mkRepoRoot();
  writeFile(
    repoRoot2,
    "CLAUDE.md",
    [
      "# Top",
      "",
      "## Brand voice",
      "",
      "Always write in active voice. Avoid filler. Lead with the verb every time.",
      "",
      "## Architecture",
      "",
      "TOC link to docs/. Walk through layers before reading the code.",
      "",
      `${KEEP_START_MARKER}`,
      "Operator hand-written ops note.",
      KEEP_END_MARKER,
    ].join("\n") + "\n",
  );

  // Phase 5b prerequisite — seed the topic-index + anchor-map for the
  // CLAUDE.md sections so phase 7c can find them. Mirrors what phase 5b
  // would emit on a real run.
  const {
    topicSlug,
    bodyContentHash,
    emptyTopicIndex,
    emptyAnchorMap,
    setTopic,
    setAnchor,
    writeTopicIndex,
    writeAnchorMap,
  } = await import("@isaacriehm/cairn-core");

  const brandBody =
    "Always write in active voice. Avoid filler. Lead with the verb every time.";
  const archBody =
    "TOC link to docs/. Walk through layers before reading the code.";
  const brandSlug = topicSlug(brandBody);
  const archSlug = topicSlug(archBody);

  let seedTopic = emptyTopicIndex();
  seedTopic = setTopic(seedTopic, brandSlug, {
    slug: brandSlug,
    sot_source: "CLAUDE.md",
    candidates: [
      {
        file: "CLAUDE.md",
        kind: "claudemd",
        line_range: [3, 5],
        anchor: "brand-voice",
      },
    ],
    created_at: new Date().toISOString(),
  });
  seedTopic = setTopic(seedTopic, archSlug, {
    slug: archSlug,
    sot_source: "CLAUDE.md",
    candidates: [
      {
        file: "CLAUDE.md",
        kind: "claudemd",
        line_range: [7, 9],
        anchor: "architecture",
      },
    ],
    created_at: new Date().toISOString(),
  });
  writeTopicIndex(repoRoot2, seedTopic);

  let seedAnchor = emptyAnchorMap();
  seedAnchor = setAnchor(seedAnchor, brandSlug, {
    file: "CLAUDE.md",
    current_anchor: "brand-voice",
    content_hash: bodyContentHash(brandBody),
    line_range: [3, 5],
    kind: "claudemd",
  });
  seedAnchor = setAnchor(seedAnchor, archSlug, {
    file: "CLAUDE.md",
    current_anchor: "architecture",
    content_hash: bodyContentHash(archBody),
    line_range: [7, 9],
    kind: "claudemd",
  });
  writeAnchorMap(repoRoot2, seedAnchor);

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
        slug: "",
        kind: "decision",
        failed: false,
      };
    }
    return {
      source: source.path,
      level: section.level,
      title: section.title,
      startOffset: section.startOffset,
      slug: "",
      kind: "informational",
      failed: false,
    };
  };

  const result = await runRulesMerge({ repoRoot: repoRoot2, mockClassify });
  assert(result.decsWritten.length === 1, "one DEC emitted from rule-net-new");
  assert(result.invsWritten.length === 0, "no INV emitted on this fixture");
  const decId = result.decsWritten[0]?.id;
  assert(typeof decId === "string" && /^DEC-[0-9a-f]{7,}$/.test(decId), "DEC id hash form");
  assert(result.decsWritten[0]?.status === "accepted", "auto-promoted to accepted");
  const decRel = result.decsWritten[0]?.path;
  assert(typeof decRel === "string", "DEC path string");
  const dec = readFileSync(join(repoRoot2, decRel ?? ""), "utf8");
  assert(dec.includes("active voice"), "DEC body cites verbatim section text");
  assert(dec.includes("status: accepted"), "DEC frontmatter status: accepted");
  assert(dec.includes("sot_kind: path"), "sot_kind: path");
  assert(dec.includes("sot_path: CLAUDE.md#brand-voice"), "sot_path: CLAUDE.md#brand-voice");
  assert(dec.includes("capture_source: init-rules-merge"), "capture_source: init-rules-merge");
  // CLAUDE.md is operator-curated narrative — phase 7c never rewrites it.
  const claudeMd = readFileSync(join(repoRoot2, "CLAUDE.md"), "utf8");
  assert(claudeMd.includes("Always write in active voice"), "CLAUDE.md untouched (no source rewrite)");
  // operator-keep section ought to be classified as such (within keep block).
  const operatorKeep = result.classifications.find((c) => c.kind === "operator-keep");
  assert(operatorKeep !== undefined, "operator-keep classification present");
  console.log("  ✓ Step 5 — verbatim DEC + sot_path: CLAUDE.md#anchor + auto-promote + no rewrite");

  step("Step 5b — cite-existing short-circuit (slug already SoT'd by docs)");
  const citeRoot = mkRepoRoot();
  const ciSection =
    "Always write in active voice. Avoid filler. Lead with the verb every time.";
  writeFile(
    citeRoot,
    "CLAUDE.md",
    `# Top\n\n## Brand voice\n\n${ciSection}\n`,
  );

  const ciSlug = topicSlug(ciSection);
  const seededDecId = "DEC-1234567";
  let citeTopic = emptyTopicIndex();
  citeTopic = setTopic(citeTopic, ciSlug, {
    slug: ciSlug,
    dec_id: seededDecId,
    sot_source: "docs/style.md",
    candidates: [
      { file: "docs/style.md", kind: "doc", line_range: [10, 12], anchor: "voice" },
      { file: "CLAUDE.md", kind: "claudemd", line_range: [3, 5], anchor: "brand-voice" },
    ],
    created_at: new Date().toISOString(),
  });
  writeTopicIndex(citeRoot, citeTopic);

  const citeResult = await runRulesMerge({
    repoRoot: citeRoot,
    mockClassify: (section, source) => ({
      source: source.path,
      level: section.level,
      title: section.title,
      startOffset: section.startOffset,
      slug: "",
      kind: section.title === "Brand voice" ? "decision" : "informational",
      failed: false,
    }),
  });
  assert(citeResult.decsWritten.length === 0, "no new DEC — short-circuited to docs SoT");
  assert(citeResult.citesEmitted.length === 1, "one cite emitted");
  assert(
    citeResult.citesEmitted[0]?.id === seededDecId,
    `cite resolves to seeded docs DEC (got ${citeResult.citesEmitted[0]?.id})`,
  );
  const citeClaude = readFileSync(join(citeRoot, "CLAUDE.md"), "utf8");
  assert(
    citeClaude.includes("Always write in active voice"),
    "cite-existing: CLAUDE.md narrative preserved verbatim",
  );
  console.log("  ✓ Step 5b — cite-existing short-circuit + no source rewrite");

  step("Step 5c — contradiction judge → conflict file (no source rewrite)");
  const conflictRoot = mkRepoRoot();
  // Operator's CLAUDE.md asserts a rule. Both bodies share heavy technical
  // overlap (sign, tokens, HS512, RS256, asymmetric, signing, JWT) so the
  // Jaccard pre-filter clears the threshold and the contradiction judge
  // gets called on the candidate.
  const newSection =
    "Always sign tokens with HS512 for signing JWT auth tokens. Never use RS256 for asymmetric signing.";
  writeFile(
    conflictRoot,
    "CLAUDE.md",
    `# Top\n\n## Token signing\n\n${newSection}\n`,
  );

  // Phase 5b seed for the new section.
  const newSlug = topicSlug(newSection);
  let confTopic = emptyTopicIndex();
  confTopic = setTopic(confTopic, newSlug, {
    slug: newSlug,
    sot_source: "CLAUDE.md",
    candidates: [
      { file: "CLAUDE.md", kind: "claudemd", line_range: [3, 5], anchor: "token-signing" },
    ],
    created_at: new Date().toISOString(),
  });
  writeTopicIndex(conflictRoot, confTopic);

  let confAnchor = emptyAnchorMap();
  confAnchor = setAnchor(confAnchor, newSlug, {
    file: "CLAUDE.md",
    current_anchor: "token-signing",
    content_hash: bodyContentHash(newSection),
    line_range: [3, 5],
    kind: "claudemd",
  });
  writeAnchorMap(conflictRoot, confAnchor);

  // Pre-existing accepted DEC contradicting the new section. Pre-seed
  // sot-cache so the Jaccard pre-filter catches it.
  const otherId = "DEC-9999999";
  const otherBody =
    "We sign tokens with RS256 for signing JWT auth tokens because we need asymmetric verification. HS512 is forbidden for signing.";
  writeFile(
    conflictRoot,
    `.cairn/ground/decisions/${otherId}.md`,
    [
      "---",
      `id: ${otherId}`,
      "title: Use RS256 for token signing",
      "type: adr",
      "status: accepted",
      "audience: dual",
      "generated: 2026-01-01T00:00:00Z",
      "verified-at: 2026-01-01T00:00:00Z",
      "decided_at: 2026-01-01T00:00:00Z",
      "decided_by: smoke",
      "sot_kind: ledger",
      "sot_path: ledger",
      `sot_content_hash: ${bodyContentHash(otherBody)}`,
      "capture_source: smoke",
      "---",
      "",
      otherBody,
      "",
    ].join("\n"),
  );
  // Seed sot-cache + sot-bindings for the candidate.
  const {
    emptySotCache,
    setSotCacheEntry,
    writeSotCache,
    emptySotBindings,
    bindDec,
    writeSotBindings,
    tokenize,
  } = await import("@isaacriehm/cairn-core");
  let confCache = emptySotCache();
  confCache = setSotCacheEntry(confCache, otherId, {
    dec_id: otherId,
    sot_path: "ledger",
    body_hash: bodyContentHash(otherBody),
    tokens: Array.from(tokenize(otherBody, { codeAware: true })),
    shingles: [],
    mtime_ms: Date.now(),
  });
  writeSotCache(conflictRoot, confCache);
  let confBindings = emptySotBindings();
  confBindings = bindDec(confBindings, otherId, "ledger");
  writeSotBindings(conflictRoot, confBindings);

  const confResult = await runRulesMerge({
    repoRoot: conflictRoot,
    mockClassify: (section, source) => ({
      source: source.path,
      level: section.level,
      title: section.title,
      startOffset: section.startOffset,
      slug: "",
      kind: section.title === "Token signing" ? "decision" : "informational",
      failed: false,
    }),
    mockContradictionJudge: async ({ candidateId }) => {
      // Only contradict the pre-seeded DEC.
      return candidateId === otherId ? "contradict" : "unrelated";
    },
  });
  assert(confResult.decsWritten.length === 1, "phase 7c emits the new DEC");
  assert(confResult.conflicts.length === 1, "exactly one conflict file");
  const conflictRow = confResult.conflicts[0];
  assert(conflictRow !== undefined, "conflict row populated");
  assert(conflictRow!.otherId === otherId, "conflict points at pre-seeded DEC");
  const conflictAbs = join(conflictRoot, conflictRow!.conflictPath);
  assert(existsSync(conflictAbs), "conflict file written to .cairn/ground/conflicts/");
  const conflictBody = readFileSync(conflictAbs, "utf8");
  assert(conflictBody.includes(conflictRow!.newId), "conflict file names new DEC id");
  assert(conflictBody.includes(otherId), "conflict file names other DEC id");
  assert(conflictBody.includes("HS512"), "conflict file preserves new prose");
  assert(conflictBody.includes("RS256"), "conflict file preserves other prose");
  // CLAUDE.md untouched.
  const confClaude = readFileSync(join(conflictRoot, "CLAUDE.md"), "utf8");
  assert(confClaude.includes("Always sign tokens with HS512"), "CLAUDE.md untouched");
  console.log("  ✓ Step 5c — conflict file written, no source rewrite");

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
      "sot_kind: ledger",
      "sot_path: ledger",
      'sot_content_hash: "0000000000000000000000000000000000000000000000000000000000000000"',
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

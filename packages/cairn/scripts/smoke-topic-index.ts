#!/usr/bin/env tsx
/**
 * smoke-topic-index — phase 5b walker + resolver + writer.
 *
 * Mocks the Haiku judge so the pre-flight verbatim-vs-semantic logic
 * can be exercised deterministically. Validates:
 *   - Verbatim collision: same content in docs + CLAUDE.md collapses
 *     to one topic with docs/* as SoT.
 *   - Semantic collision: Jaccard ≥ 0.6 across kinds → judge call,
 *     `same` verdict merges into one topic; `different` keeps them
 *     distinct.
 *   - Priority order: docs/* > CLAUDE.md > AGENTS.md > .claude/rules.
 *   - Anchor-map writes the SoT location with stable content_hash.
 *   - Topic-index entry's candidates list every occurrence.
 *   - File outputs land at .cairn/ground/topic-index.yaml +
 *     anchor-map.yaml and parse cleanly.
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
import { parse as parseYaml } from "yaml";
import {
  buildTopicIndex,
  bodyContentHash,
  topicSlug,
  type ProseBlock,
  type SemanticJudge,
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
  for (const dir of cleanups) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }
}

function mkFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-topic-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn", "ground"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
  return dir;
}

function writeMd(file: string, body: string): void {
  mkdirSync(join(file, "..").replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(file, body, "utf8");
}

const VERBATIM_PROSE = `## bcrypt over scrypt

We chose bcrypt over scrypt because every supported language ships a
maintained bcrypt library while scrypt support is still patchy outside
the JVM ecosystem. Library breadth wins over the marginal security
upgrade scrypt offers in our threat model.`;

const SEMANTIC_VARIANT = `## Password hashing choice

The team selected bcrypt instead of scrypt. Every supported runtime
already has a battle-tested bcrypt library; scrypt's library
ecosystem is uneven outside the JVM. The marginal hardening scrypt
provides isn't worth that integration risk for our threat model.`;

const DISTINCT_PROSE = `## Session token storage

Session tokens live in an httpOnly secure cookie scoped to the auth
domain. We picked cookies over Authorization headers because we want
SameSite=strict and CSRF protection from browsers without spending
engineering budget on a token-replay defense.`;

async function runSmoke(): Promise<void> {
  console.log("smoke-topic-index — start");

  // ── Step 1 — verbatim collision: docs vs CLAUDE.md identical ─────
  {
    const repoRoot = mkFixture();
    writeFileSync(join(repoRoot, "docs", "auth.md"), VERBATIM_PROSE, "utf8");
    writeFileSync(join(repoRoot, "CLAUDE.md"), VERBATIM_PROSE, "utf8");

    const calls: number[] = [];
    const judge: SemanticJudge = async () => {
      calls.push(1);
      return "different";
    };

    const result = await buildTopicIndex({ repoRoot, judge });

    assert(
      result.verbatimCollisions === 1,
      `Step 1: expected 1 verbatim collision, got ${result.verbatimCollisions}`,
    );
    assert(
      calls.length === 0,
      `Step 1: verbatim collisions should not invoke the judge, got ${calls.length} calls`,
    );

    const slugs = Object.keys(result.topicIndex.topics);
    assert(slugs.length === 1, `Step 1: expected 1 topic, got ${slugs.length}`);
    const slug = slugs[0]!;
    const entry = result.topicIndex.topics[slug]!;
    assert(
      entry.sot_source === "docs/auth.md",
      `Step 1: SoT should be docs/auth.md (priority), got ${entry.sot_source}`,
    );
    assert(
      entry.candidates.length === 2,
      `Step 1: expected 2 candidates, got ${entry.candidates.length}`,
    );

    const anchor = result.anchorMap.anchors[slug]!;
    assert(
      anchor !== undefined && anchor.file === "docs/auth.md",
      `Step 1: anchor-map should point at docs/auth.md, got ${anchor?.file}`,
    );
    assert(
      anchor.content_hash.length === 64,
      `Step 1: content_hash should be 64-char sha256, got length ${anchor.content_hash.length}`,
    );

    console.log("  ✓ Step 1 — verbatim collision merges to docs SoT");
  }

  // ── Step 2 — semantic similarity, judge says same ────────────────
  {
    const repoRoot = mkFixture();
    writeFileSync(join(repoRoot, "docs", "auth.md"), VERBATIM_PROSE, "utf8");
    writeFileSync(join(repoRoot, "CLAUDE.md"), SEMANTIC_VARIANT, "utf8");

    const judgeArgs: { a: string; b: string }[] = [];
    const judge: SemanticJudge = async ({ a, b }) => {
      judgeArgs.push({ a: a.file, b: b.file });
      return "same";
    };

    const result = await buildTopicIndex({ repoRoot, judge, similarityThreshold: 0.2 });

    assert(
      result.verbatimCollisions === 0,
      `Step 2: expected 0 verbatim collisions, got ${result.verbatimCollisions}`,
    );
    assert(
      result.semanticCollisions >= 1,
      `Step 2: expected at least 1 semantic collision, got ${result.semanticCollisions}`,
    );
    assert(
      judgeArgs.length >= 1,
      `Step 2: expected the judge to be invoked, got ${judgeArgs.length} calls`,
    );

    const topics = Object.values(result.topicIndex.topics);
    assert(
      topics.length === 1,
      `Step 2: expected 1 topic after merge, got ${topics.length}`,
    );
    const entry = topics[0]!;
    assert(
      entry.sot_source === "docs/auth.md",
      `Step 2: merged SoT should be docs/auth.md, got ${entry.sot_source}`,
    );
    const candidateFiles = entry.candidates.map((c) => c.file).sort();
    assert(
      candidateFiles.length === 2 && candidateFiles[0] === "CLAUDE.md" && candidateFiles[1] === "docs/auth.md",
      `Step 2: candidates should include both files, got ${JSON.stringify(candidateFiles)}`,
    );
    console.log("  ✓ Step 2 — semantic same → merge under docs SoT");
  }

  // ── Step 3 — semantic similarity, judge says different ───────────
  {
    const repoRoot = mkFixture();
    writeFileSync(join(repoRoot, "docs", "auth.md"), VERBATIM_PROSE, "utf8");
    writeFileSync(join(repoRoot, "AGENTS.md"), DISTINCT_PROSE, "utf8");

    const judge: SemanticJudge = async () => "different";
    const result = await buildTopicIndex({ repoRoot, judge });

    const topics = Object.values(result.topicIndex.topics);
    assert(
      topics.length === 2,
      `Step 3: expected 2 distinct topics when judge says different, got ${topics.length}`,
    );
    console.log("  ✓ Step 3 — distinct topics survive a 'different' verdict");
  }

  // ── Step 4 — priority: docs > CLAUDE.md > AGENTS.md > rule ───────
  {
    const blocks: ProseBlock[] = [
      makeBlock("rule-file.md", "rule", VERBATIM_PROSE, "rule-anchor"),
      makeBlock("AGENTS.md", "agentsmd", VERBATIM_PROSE, "agents-anchor"),
      makeBlock("CLAUDE.md", "claudemd", VERBATIM_PROSE, "claude-anchor"),
      makeBlock("docs/auth.md", "doc", VERBATIM_PROSE, "doc-anchor"),
    ];
    const judge: SemanticJudge = async () => "different";
    const repoRoot = mkFixture();
    const result = await buildTopicIndex({ repoRoot, judge, blocks });
    const slug = Object.keys(result.topicIndex.topics)[0]!;
    const entry = result.topicIndex.topics[slug]!;
    assert(
      entry.sot_source === "docs/auth.md",
      `Step 4: priority order should pick docs/auth.md, got ${entry.sot_source}`,
    );
    assert(
      entry.candidates.length === 4,
      `Step 4: expected 4 candidates, got ${entry.candidates.length}`,
    );
    console.log("  ✓ Step 4 — priority order docs > CLAUDE > AGENTS > rule");
  }

  // ── Step 4b — dynamic walk: any `.md` outside rule paths counts ──
  {
    const repoRoot = mkFixture();
    // Operator picks a non-standard layout. Walker must still index them.
    mkdirSync(join(repoRoot, "official_docs"), { recursive: true });
    mkdirSync(join(repoRoot, "documentation"), { recursive: true });
    mkdirSync(join(repoRoot, "notes", "engineering"), { recursive: true });
    writeFileSync(join(repoRoot, "official_docs", "auth.md"), VERBATIM_PROSE, "utf8");
    writeFileSync(join(repoRoot, "documentation", "api.md"), DISTINCT_PROSE, "utf8");
    writeFileSync(
      join(repoRoot, "notes", "engineering", "scratch.md"),
      `# Scratch\n\nThis is a long-enough paragraph about caching strategies and how we balance memory pressure against hit-rate so the topic-index walker actually picks it up under the 80-character / 10-unique-token threshold.`,
      "utf8",
    );
    // Read me at the root level to confirm root-level docs land too.
    writeFileSync(
      join(repoRoot, "README.md"),
      `# Project\n\nCairn is the project's state and context-loading layer for AI coding agents — it curates ground-state files and exposes them via an MCP server. Same project, different file layout entirely.`,
      "utf8",
    );

    const judge: SemanticJudge = async () => "different";
    const result = await buildTopicIndex({ repoRoot, judge });

    const sources = new Set(
      Object.values(result.topicIndex.topics).map((e) => e.sot_source),
    );
    assert(
      sources.has("official_docs/auth.md"),
      `Step 4b: walker should find official_docs/auth.md, got ${JSON.stringify([...sources])}`,
    );
    assert(
      sources.has("documentation/api.md"),
      `Step 4b: walker should find documentation/api.md, got ${JSON.stringify([...sources])}`,
    );
    assert(
      sources.has("notes/engineering/scratch.md"),
      `Step 4b: walker should find notes/engineering/scratch.md, got ${JSON.stringify([...sources])}`,
    );
    assert(
      sources.has("README.md"),
      `Step 4b: walker should find root-level README.md, got ${JSON.stringify([...sources])}`,
    );

    for (const entry of Object.values(result.topicIndex.topics)) {
      const sot = entry.candidates.find((c) => c.file === entry.sot_source);
      assert(
        sot !== undefined && sot.kind === "doc",
        `Step 4b: every emitted entry's SoT should be kind=doc, got ${sot?.kind}`,
      );
    }
    console.log("  ✓ Step 4b — dynamic walk covers any non-rule .md layout");
  }

  // ── Step 5 — file outputs parse + match contract ─────────────────
  {
    const repoRoot = mkFixture();
    writeFileSync(join(repoRoot, "docs", "auth.md"), VERBATIM_PROSE, "utf8");

    const judge: SemanticJudge = async () => "different";
    const result = await buildTopicIndex({ repoRoot, judge });

    const topicsRaw = readFileSync(result.topicIndexPath, "utf8");
    const topicsParsed = parseYaml(topicsRaw) as { version: number; topics: Record<string, unknown> };
    assert(
      topicsParsed.version === 1,
      `Step 5: topic-index.yaml should be version 1, got ${topicsParsed.version}`,
    );
    assert(
      Object.keys(topicsParsed.topics).length === 1,
      `Step 5: topic-index.yaml should record 1 topic, got ${Object.keys(topicsParsed.topics).length}`,
    );

    const anchorsRaw = readFileSync(result.anchorMapPath, "utf8");
    const anchorsParsed = parseYaml(anchorsRaw) as { version: number; anchors: Record<string, unknown> };
    assert(
      anchorsParsed.version === 1,
      `Step 5: anchor-map.yaml should be version 1, got ${anchorsParsed.version}`,
    );
    console.log("  ✓ Step 5 — yaml outputs parse cleanly");
  }

  console.log("smoke-topic-index — pass");
}

function makeBlock(
  file: string,
  kind: ProseBlock["kind"],
  body: string,
  anchor?: string,
): ProseBlock {
  return {
    file,
    kind,
    title: body.split("\n")[0] ?? "",
    line_range: [1, body.split("\n").length],
    body,
    content_hash: bodyContentHash(body),
    slug: topicSlug(body),
    ...(anchor !== undefined ? { anchor } : {}),
  };
}

runSmoke()
  .then(() => cleanup())
  .catch((err: unknown) => {
    console.error("smoke-topic-index failed:", err);
    cleanup();
    process.exit(1);
  });

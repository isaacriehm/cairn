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
 *   - PHASE_6_REDESIGN §4.2: file-candidates-map.yaml lands with
 *     correct per-file unpromoted counts.
 *   - PHASE_6_REDESIGN §4.2: `_rejected.yaml` GC drops slugs whose
 *     source no longer exists in the freshly-built topic-index.
 *   - Walker stamps `marker_kind` on prose blocks under frontmatter
 *     `cairn.kind` and on blocks with inline `<!-- cairn:decision -->`
 *     comments within 3 lines of the heading.
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
  fileCandidatesMapPath,
  rejectedYamlPath,
  topicSlug,
  walkProseBlocks,
  writeRejectedYaml,
  type ProseBlock,
  type RejectedYaml,
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

  // ── Step 6 — file-candidates-map.yaml landed with right counts ───
  // PHASE_6_REDESIGN §4.2: the topic-index build is responsible for
  // emitting `file-candidates-map.yaml`. Counts unpromoted (no
  // `dec_id`) topic-index candidates per file. read-enrich uses it
  // to decide whether to inject the "you've got candidates here"
  // hint when an operator opens a doc.
  {
    const repoRoot = mkFixture();
    writeFileSync(join(repoRoot, "docs", "auth.md"), VERBATIM_PROSE, "utf8");
    writeFileSync(
      join(repoRoot, "CLAUDE.md"),
      `${VERBATIM_PROSE}\n\n${DISTINCT_PROSE}`,
      "utf8",
    );
    writeFileSync(join(repoRoot, "AGENTS.md"), DISTINCT_PROSE, "utf8");

    const judge: SemanticJudge = async () => "different";
    const result = await buildTopicIndex({ repoRoot, judge });

    const mapPath = fileCandidatesMapPath(repoRoot);
    assert(
      existsSync(mapPath),
      `Step 6: file-candidates-map.yaml should exist at ${mapPath}`,
    );
    const mapRaw = readFileSync(mapPath, "utf8");
    const mapParsed = parseYaml(mapRaw) as {
      version: number;
      generated: string;
      file_candidates: Record<string, number>;
    };
    assert(
      mapParsed.version === 1,
      `Step 6: file-candidates-map version should be 1, got ${mapParsed.version}`,
    );

    // The map buckets by SoT only — read-enrich's question is "is
    // this file the canonical source for any unpromoted topic?", not
    // "is this file mentioned anywhere in the topic-index". Topics:
    //   - VERBATIM_PROSE: docs/auth.md + CLAUDE.md collapse (verbatim) →
    //     SoT = docs/auth.md (priority docs > CLAUDE > AGENTS)
    //   - DISTINCT_PROSE: CLAUDE.md + AGENTS.md collapse (verbatim) →
    //     SoT = CLAUDE.md
    // Expected SoT counts: docs/auth.md=1, CLAUDE.md=1, AGENTS.md
    // omitted (0 SoT-of-unpromoted-topic, omitted from the map).
    const counts = mapParsed.file_candidates;
    assert(
      counts["docs/auth.md"] === 1,
      `Step 6: docs/auth.md should have 1 SoT-of-unpromoted, got ${counts["docs/auth.md"]}`,
    );
    assert(
      counts["CLAUDE.md"] === 1,
      `Step 6: CLAUDE.md should have 1 SoT-of-unpromoted, got ${counts["CLAUDE.md"]}`,
    );
    assert(
      counts["AGENTS.md"] === undefined,
      `Step 6: AGENTS.md is not SoT of any unpromoted topic, should be omitted, got ${counts["AGENTS.md"]}`,
    );

    // Also confirm `result.fileCandidatesMapPath` round-trips.
    assert(
      result.fileCandidatesMapPath === mapPath,
      `Step 6: result should expose the file-candidates-map path`,
    );
    console.log("  ✓ Step 6 — file-candidates-map.yaml lands with per-file counts");
  }

  // ── Step 7 — `_rejected.yaml` GC drops dead slugs ────────────────
  // PHASE_6_REDESIGN §4.2: at the end of phase 5b we GC entries
  // whose `sot_source` no longer points at any block in the freshly
  // walked topic-index. Stops zombie rejections from re-firing if
  // the operator deletes a rejected source then re-adds different
  // content there later.
  {
    const repoRoot = mkFixture();
    writeFileSync(join(repoRoot, "docs", "auth.md"), VERBATIM_PROSE, "utf8");

    // Walk the freshly-written docs to capture the real slug for the
    // surviving topic — that's the slug that lives in the topic-index
    // post-build, which the GC keeps. The "dead" rejection points at
    // a synthetic slug that the topic-index will never contain.
    const liveBlocks = walkProseBlocks(repoRoot);
    const liveSlug = liveBlocks[0]!.slug;

    const seeded = new Map<string, import("@isaacriehm/cairn-core").RejectedEntry>();
    const now = new Date().toISOString();
    seeded.set(liveSlug, {
      slug: liveSlug,
      rejected_at: now,
      rejected_by: "operator",
      reason: "operator wanted a different framing",
      sot_source: "docs/auth.md",
    });
    seeded.set("dead-slug", {
      slug: "dead-slug",
      rejected_at: now,
      rejected_by: "operator",
      reason: "we deleted that file",
      sot_source: "docs/dead.md",
    });
    writeRejectedYaml(repoRoot, seeded);

    const judge: SemanticJudge = async () => "different";
    const result = await buildTopicIndex({ repoRoot, judge });

    const rejectedRaw = readFileSync(rejectedYamlPath(repoRoot), "utf8");
    const rejectedParsed = parseYaml(rejectedRaw) as RejectedYaml;
    const slugs = rejectedParsed.rejected.map((r) => r.slug).sort();
    assert(
      slugs.length === 1 && slugs[0] === liveSlug,
      `Step 7: GC should drop dead-slug, keep liveSlug=${liveSlug}. Got: ${JSON.stringify(slugs)}`,
    );
    assert(
      result.rejectedGcDropped.length === 1 && result.rejectedGcDropped[0] === "dead-slug",
      `Step 7: result.rejectedGcDropped should be ['dead-slug'], got ${JSON.stringify(result.rejectedGcDropped)}`,
    );
    console.log("  ✓ Step 7 — _rejected.yaml GC drops dead-source slugs");
  }

  // ── Step 8 — walker stamps `marker_kind` for operator markers ────
  // PHASE_6_REDESIGN §4.5: phase 5b walker honors two marker
  // surfaces. Phase 6 Stage 3 fast-paths these to draft emit
  // without Haiku, so the marker has to actually land on the block.
  {
    const repoRoot = mkFixture();

    // Surface 1: file-level frontmatter `cairn.kind: decision`.
    const frontmatterFile = join(repoRoot, "docs", "decisions-file.md");
    writeFileSync(
      frontmatterFile,
      `---\ncairn:\n  kind: decision\n---\n\n${VERBATIM_PROSE}\n`,
      "utf8",
    );

    // Surface 2: block-level HTML comment within 3 lines of the
    // heading. The walker buckets blank-line-separated paragraphs, so
    // the marker has to sit inside the same buffer as the body — no
    // blank line between heading, marker, and the prose underneath.
    const blockFile = join(repoRoot, "docs", "marker-block.md");
    const distinctBody = DISTINCT_PROSE.split("\n").slice(1).join("\n").trim();
    writeFileSync(
      blockFile,
      `# Doc\n\n## Block-marked rule\n<!-- cairn:rule -->\n${distinctBody}\n`,
      "utf8",
    );

    // Plain doc — no marker, used as control.
    writeFileSync(
      join(repoRoot, "docs", "plain.md"),
      `# Plain\n\n${VERBATIM_PROSE.replace(/^## .*/m, "## Different heading")}\n`,
      "utf8",
    );

    const blocks = walkProseBlocks(repoRoot);

    const fmBlock = blocks.find((b) => b.file === "docs/decisions-file.md");
    assert(
      fmBlock !== undefined && fmBlock.marker_kind === "decision",
      `Step 8: frontmatter cairn.kind=decision should stamp marker_kind=decision, got ${fmBlock?.marker_kind}`,
    );

    const blkBlock = blocks.find((b) => b.file === "docs/marker-block.md");
    assert(
      blkBlock !== undefined && blkBlock.marker_kind === "rule",
      `Step 8: <!-- cairn:rule --> within 3 lines should stamp marker_kind=rule, got ${blkBlock?.marker_kind}`,
    );

    const plainBlock = blocks.find((b) => b.file === "docs/plain.md");
    assert(
      plainBlock !== undefined && plainBlock.marker_kind === undefined,
      `Step 8: unmarked block should have no marker_kind, got ${plainBlock?.marker_kind}`,
    );

    console.log("  ✓ Step 8 — walker stamps marker_kind on frontmatter + block markers");
  }

  // ── Step 9 — marker_kind survives end-to-end into topic-index ────
  // The walker stamp is only useful if `resolveTopics` propagates
  // marker_kind onto the chosen TopicIndexEntry (with the SoT
  // priority kicker — block markers override file-level inheritance,
  // and equivalence-class members can lend their marker if the SoT
  // didn't carry one).
  {
    const repoRoot = mkFixture();
    writeFileSync(
      join(repoRoot, "docs", "auth.md"),
      `---\ncairn:\n  kind: decision\n---\n\n${VERBATIM_PROSE}\n`,
      "utf8",
    );

    const judge: SemanticJudge = async () => "different";
    const result = await buildTopicIndex({ repoRoot, judge });

    const entry = Object.values(result.topicIndex.topics)[0]!;
    assert(
      entry.marker_kind === "decision",
      `Step 9: topic-index entry should carry marker_kind=decision, got ${entry.marker_kind}`,
    );
    assert(
      typeof entry.content_hash === "string" && entry.content_hash.length === 64,
      `Step 9: topic-index entry should carry 64-char content_hash, got ${entry.content_hash}`,
    );
    console.log("  ✓ Step 9 — marker_kind + content_hash propagate to TopicIndexEntry");
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

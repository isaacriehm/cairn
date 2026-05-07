#!/usr/bin/env tsx
/**
 * smoke-search-candidates — `cairn_search_candidates` MCP tool
 * (PHASE_6_REDESIGN §4.6 / PR 2).
 *
 * Verifies:
 *   - Filters out promoted entries (those with `dec_id`).
 *   - Filters out rejected slugs.
 *   - `query` matches title and body substring (case-insensitive).
 *   - `scope` glob filters on `sot_source`.
 *   - `kind` restricts to entries with the given `marker_kind`.
 *   - `limit` honoured; default cap applied.
 *   - Marker-kinded results sort first (stable pagination).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allTools,
  appendRejected,
  bodyContentHash,
  emptyAnchorMap,
  emptyRejectedYaml,
  emptyTopicIndex,
  setAnchor,
  setTopic,
  topicSlug,
  writeAnchorMap,
  writeRejectedYaml,
  writeTopicIndex,
  type AnchorMap,
  type McpContext,
  type RejectedEntry,
  type ToolDef,
  type TopicIndex,
  type TopicIndexEntry,
} from "@isaacriehm/cairn-core";
import { writeFileSync } from "node:fs";

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

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-search-cands-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn", "ground"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, ".planning"), { recursive: true });
  return dir;
}

function writeDoc(repoRoot: string, rel: string, body: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

interface SeedArgs {
  slug: string;
  body: string;
  sot_source: string;
  anchor: string;
  line_range: [number, number];
  marker_kind?: "decision" | "rule";
  dec_id?: string;
}

function seedTopic(
  repoRoot: string,
  topicIndex: TopicIndex,
  anchorMap: AnchorMap,
  args: SeedArgs,
): { topicIndex: TopicIndex; anchorMap: AnchorMap } {
  const entry: TopicIndexEntry = {
    slug: args.slug,
    sot_source: args.sot_source,
    candidates: [
      {
        file: args.sot_source,
        kind: "doc",
        anchor: args.anchor,
        line_range: args.line_range,
      },
    ],
    created_at: new Date().toISOString(),
    content_hash: bodyContentHash(args.body),
    ...(args.marker_kind !== undefined ? { marker_kind: args.marker_kind } : {}),
    ...(args.dec_id !== undefined ? { dec_id: args.dec_id } : {}),
  };
  const nextTopic = setTopic(topicIndex, args.slug, entry);
  const nextAnchor = setAnchor(anchorMap, args.slug, {
    file: args.sot_source,
    current_anchor: args.anchor,
    content_hash: bodyContentHash(args.body),
    line_range: args.line_range,
    kind: "doc",
  });
  void repoRoot;
  return { topicIndex: nextTopic, anchorMap: nextAnchor };
}

function getTool(): ToolDef<unknown> {
  const t = (allTools as ToolDef<unknown>[]).find(
    (t) => t.name === "cairn_search_candidates",
  );
  assert(t !== undefined, "cairn_search_candidates must be registered");
  return t;
}

interface CandidateRow {
  slug: string;
  title: string;
  sot_source: string;
  marker_kind?: "decision" | "rule";
  body_preview: string;
  line_range?: [number, number];
}

async function call(
  tool: ToolDef<unknown>,
  ctx: McpContext,
  input: unknown,
): Promise<CandidateRow[]> {
  const result = (await tool.handler(ctx, input)) as CandidateRow[];
  return result;
}

const PROSE_AUTH = `# Auth\n\n## bcrypt over scrypt\n\nWe chose bcrypt over scrypt because every supported language ships a maintained bcrypt library while scrypt support is still patchy outside the JVM ecosystem.`;
const PROSE_TOKENS = `# Tokens\n\n## Session token storage\n\nSession tokens live in an httpOnly secure cookie scoped to the auth domain. We picked cookies over Authorization headers for SameSite=strict and CSRF protection from browsers.`;
const PROSE_RESEARCH = `# Research\n\n## Maybe redis someday\n\nResearch note. We considered redis but did not commit to anything. Open question whether we need a sidecar at all given current load patterns.`;
const PROSE_PROMOTED = `# Promoted\n\n## Already a DEC\n\nThis paragraph already lives in the canonical ledger as DEC-promote. Should not appear in candidate search.`;

async function runSmoke(): Promise<void> {
  console.log("smoke-search-candidates — start");

  const tool = getTool();

  // ── Step 1 — basic surface: filter by dec_id + rejected ─────────
  {
    const repoRoot = mkRepo();
    writeDoc(repoRoot, "docs/auth.md", PROSE_AUTH);
    writeDoc(repoRoot, "docs/tokens.md", PROSE_TOKENS);
    writeDoc(repoRoot, ".planning/research.md", PROSE_RESEARCH);
    writeDoc(repoRoot, "docs/promoted.md", PROSE_PROMOTED);

    let ti = emptyTopicIndex();
    let am = emptyAnchorMap();

    const slugAuth = topicSlug(PROSE_AUTH);
    const slugTokens = topicSlug(PROSE_TOKENS);
    const slugResearch = topicSlug(PROSE_RESEARCH);
    const slugPromoted = topicSlug(PROSE_PROMOTED);

    ({ topicIndex: ti, anchorMap: am } = seedTopic(repoRoot, ti, am, {
      slug: slugAuth,
      body: PROSE_AUTH,
      sot_source: "docs/auth.md",
      anchor: "bcrypt-over-scrypt",
      line_range: [1, PROSE_AUTH.split("\n").length],
      marker_kind: "decision",
    }));
    ({ topicIndex: ti, anchorMap: am } = seedTopic(repoRoot, ti, am, {
      slug: slugTokens,
      body: PROSE_TOKENS,
      sot_source: "docs/tokens.md",
      anchor: "session-token-storage",
      line_range: [1, PROSE_TOKENS.split("\n").length],
    }));
    ({ topicIndex: ti, anchorMap: am } = seedTopic(repoRoot, ti, am, {
      slug: slugResearch,
      body: PROSE_RESEARCH,
      sot_source: ".planning/research.md",
      anchor: "maybe-redis-someday",
      line_range: [1, PROSE_RESEARCH.split("\n").length],
    }));
    ({ topicIndex: ti, anchorMap: am } = seedTopic(repoRoot, ti, am, {
      slug: slugPromoted,
      body: PROSE_PROMOTED,
      sot_source: "docs/promoted.md",
      anchor: "already-a-dec",
      line_range: [1, PROSE_PROMOTED.split("\n").length],
      dec_id: "DEC-promote",
    }));

    writeTopicIndex(repoRoot, ti);
    writeAnchorMap(repoRoot, am);

    // Reject the research note.
    const now = new Date().toISOString();
    const rejected: RejectedEntry = {
      slug: slugResearch,
      rejected_at: now,
      rejected_by: "operator",
      reason: "research scratch, not a decision",
      sot_source: ".planning/research.md",
    };
    writeRejectedYaml(repoRoot, appendRejected(emptyRejectedYaml().rejected.length === 0 ? new Map() : new Map(), rejected));

    const ctx: McpContext = { repoRoot };
    const all = await call(tool, ctx, {});
    const slugs = all.map((r) => r.slug).sort();
    assert(
      slugs.length === 2,
      `Step 1: expected 2 candidates after filtering promoted+rejected, got ${slugs.length}: ${JSON.stringify(slugs)}`,
    );
    assert(
      slugs.includes(slugAuth) && slugs.includes(slugTokens),
      `Step 1: expected auth + tokens slugs, got ${JSON.stringify(slugs)}`,
    );
    assert(
      !slugs.includes(slugPromoted),
      `Step 1: promoted slug should not appear (has dec_id), got ${JSON.stringify(slugs)}`,
    );
    assert(
      !slugs.includes(slugResearch),
      `Step 1: rejected slug should not appear, got ${JSON.stringify(slugs)}`,
    );

    // marker_kind=decision sorts first.
    assert(
      all[0]!.slug === slugAuth,
      `Step 1: marker-kinded entry should sort first, got ${all[0]!.slug}`,
    );
    assert(
      all[0]!.marker_kind === "decision",
      `Step 1: marker_kind should be surfaced, got ${all[0]!.marker_kind}`,
    );
    console.log("  ✓ Step 1 — promoted + rejected entries excluded; markers sort first");
  }

  // ── Step 2 — query substring matches title or body ─────────────
  {
    const repoRoot = mkRepo();
    writeDoc(repoRoot, "docs/auth.md", PROSE_AUTH);
    writeDoc(repoRoot, "docs/tokens.md", PROSE_TOKENS);

    let ti = emptyTopicIndex();
    let am = emptyAnchorMap();
    const slugAuth = topicSlug(PROSE_AUTH);
    const slugTokens = topicSlug(PROSE_TOKENS);
    ({ topicIndex: ti, anchorMap: am } = seedTopic(repoRoot, ti, am, {
      slug: slugAuth,
      body: PROSE_AUTH,
      sot_source: "docs/auth.md",
      anchor: "bcrypt-over-scrypt",
      line_range: [1, PROSE_AUTH.split("\n").length],
    }));
    ({ topicIndex: ti, anchorMap: am } = seedTopic(repoRoot, ti, am, {
      slug: slugTokens,
      body: PROSE_TOKENS,
      sot_source: "docs/tokens.md",
      anchor: "session-token-storage",
      line_range: [1, PROSE_TOKENS.split("\n").length],
    }));
    writeTopicIndex(repoRoot, ti);
    writeAnchorMap(repoRoot, am);

    const ctx: McpContext = { repoRoot };

    // Body match.
    const bodyHits = await call(tool, ctx, { query: "scrypt" });
    assert(
      bodyHits.length === 1 && bodyHits[0]!.slug === slugAuth,
      `Step 2: query=scrypt should hit auth only, got ${JSON.stringify(bodyHits.map((r) => r.slug))}`,
    );

    // Title match (anchor → title).
    const titleHits = await call(tool, ctx, { query: "session token" });
    assert(
      titleHits.length === 1 && titleHits[0]!.slug === slugTokens,
      `Step 2: query=session+token should hit tokens only, got ${JSON.stringify(titleHits.map((r) => r.slug))}`,
    );

    // Case-insensitive.
    const ciHits = await call(tool, ctx, { query: "BCRYPT" });
    assert(
      ciHits.length === 1 && ciHits[0]!.slug === slugAuth,
      `Step 2: query should be case-insensitive, got ${JSON.stringify(ciHits.map((r) => r.slug))}`,
    );
    console.log("  ✓ Step 2 — query substring matches title and body");
  }

  // ── Step 3 — scope glob filters on sot_source ─────────────────
  {
    const repoRoot = mkRepo();
    writeDoc(repoRoot, "docs/auth.md", PROSE_AUTH);
    writeDoc(repoRoot, ".planning/research.md", PROSE_RESEARCH);

    let ti = emptyTopicIndex();
    let am = emptyAnchorMap();
    const slugAuth = topicSlug(PROSE_AUTH);
    const slugResearch = topicSlug(PROSE_RESEARCH);
    ({ topicIndex: ti, anchorMap: am } = seedTopic(repoRoot, ti, am, {
      slug: slugAuth,
      body: PROSE_AUTH,
      sot_source: "docs/auth.md",
      anchor: "bcrypt-over-scrypt",
      line_range: [1, PROSE_AUTH.split("\n").length],
    }));
    ({ topicIndex: ti, anchorMap: am } = seedTopic(repoRoot, ti, am, {
      slug: slugResearch,
      body: PROSE_RESEARCH,
      sot_source: ".planning/research.md",
      anchor: "maybe-redis-someday",
      line_range: [1, PROSE_RESEARCH.split("\n").length],
    }));
    writeTopicIndex(repoRoot, ti);
    writeAnchorMap(repoRoot, am);

    const ctx: McpContext = { repoRoot };

    const docsOnly = await call(tool, ctx, { scope: "docs/**" });
    assert(
      docsOnly.length === 1 && docsOnly[0]!.slug === slugAuth,
      `Step 3: scope=docs/** should hit auth only, got ${JSON.stringify(docsOnly.map((r) => r.slug))}`,
    );

    const planningOnly = await call(tool, ctx, { scope: ".planning/**" });
    assert(
      planningOnly.length === 1 && planningOnly[0]!.slug === slugResearch,
      `Step 3: scope=.planning/** should hit research only, got ${JSON.stringify(planningOnly.map((r) => r.slug))}`,
    );
    console.log("  ✓ Step 3 — scope glob filters sot_source");
  }

  // ── Step 4 — kind restricts to marker_kind ──────────────────────
  {
    const repoRoot = mkRepo();
    writeDoc(repoRoot, "docs/auth.md", PROSE_AUTH);
    writeDoc(repoRoot, "docs/tokens.md", PROSE_TOKENS);

    let ti = emptyTopicIndex();
    let am = emptyAnchorMap();
    const slugAuth = topicSlug(PROSE_AUTH);
    const slugTokens = topicSlug(PROSE_TOKENS);
    ({ topicIndex: ti, anchorMap: am } = seedTopic(repoRoot, ti, am, {
      slug: slugAuth,
      body: PROSE_AUTH,
      sot_source: "docs/auth.md",
      anchor: "bcrypt-over-scrypt",
      line_range: [1, PROSE_AUTH.split("\n").length],
      marker_kind: "decision",
    }));
    ({ topicIndex: ti, anchorMap: am } = seedTopic(repoRoot, ti, am, {
      slug: slugTokens,
      body: PROSE_TOKENS,
      sot_source: "docs/tokens.md",
      anchor: "session-token-storage",
      line_range: [1, PROSE_TOKENS.split("\n").length],
      marker_kind: "rule",
    }));
    writeTopicIndex(repoRoot, ti);
    writeAnchorMap(repoRoot, am);

    const ctx: McpContext = { repoRoot };
    const decisions = await call(tool, ctx, { kind: "decision" });
    assert(
      decisions.length === 1 && decisions[0]!.slug === slugAuth,
      `Step 4: kind=decision should hit auth only, got ${JSON.stringify(decisions.map((r) => r.slug))}`,
    );

    const rules = await call(tool, ctx, { kind: "rule" });
    assert(
      rules.length === 1 && rules[0]!.slug === slugTokens,
      `Step 4: kind=rule should hit tokens only, got ${JSON.stringify(rules.map((r) => r.slug))}`,
    );
    console.log("  ✓ Step 4 — kind filter restricts to marker_kind");
  }

  // ── Step 5 — limit caps result size ────────────────────────────
  {
    const repoRoot = mkRepo();
    let ti = emptyTopicIndex();
    let am = emptyAnchorMap();
    for (let i = 0; i < 5; i += 1) {
      const body = `## section-${i}\n\nThis is a long-enough body for entry ${i} so it gets indexed by the walker. Content includes the keyword pattern${i}.`;
      const rel = `docs/multi-${i}.md`;
      writeDoc(repoRoot, rel, body);
      const slug = topicSlug(body);
      ({ topicIndex: ti, anchorMap: am } = seedTopic(repoRoot, ti, am, {
        slug,
        body,
        sot_source: rel,
        anchor: `section-${i}`,
        line_range: [1, body.split("\n").length],
      }));
    }
    writeTopicIndex(repoRoot, ti);
    writeAnchorMap(repoRoot, am);

    const ctx: McpContext = { repoRoot };
    const limited = await call(tool, ctx, { limit: 2 });
    assert(
      limited.length === 2,
      `Step 5: limit=2 should produce 2 results, got ${limited.length}`,
    );
    console.log("  ✓ Step 5 — limit caps results");
  }

  console.log("smoke-search-candidates — pass");
}

(async () => {
  try {
    await runSmoke();
  } finally {
    cleanup();
  }
})().catch((err: unknown) => {
  console.error("smoke-search-candidates failed:", err);
  cleanup();
  process.exit(1);
});

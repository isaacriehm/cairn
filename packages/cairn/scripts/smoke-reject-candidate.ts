#!/usr/bin/env tsx
/**
 * smoke-reject-candidate — `cairn_reject_candidate` MCP tool
 * (PHASE_6_REDESIGN §4.6 / PR 2).
 *
 * Verifies:
 *   - Slug not in topic-index → { ok:false, reason:"not_found" }.
 *   - Append: first writer lands a record under
 *     `.cairn/ground/_rejected.yaml` with rejected_by="ai-curator",
 *     reason verbatim, sot_source carried through.
 *   - Dedup: second writer for the same slug refreshes
 *     `rejected_at` only and surfaces the existing reason in
 *     `warning` so the AI knows the prior rationale lives on.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  allTools,
  bodyContentHash,
  emptyAnchorMap,
  emptyTopicIndex,
  rejectedYamlPath,
  setAnchor,
  setTopic,
  topicSlug,
  writeAnchorMap,
  writeTopicIndex,
  type AnchorMap,
  type McpContext,
  type RejectedYaml,
  type ToolDef,
  type TopicIndex,
  type TopicIndexEntry,
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

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-reject-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn", "ground"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  return dir;
}

function writeDoc(repoRoot: string, rel: string, body: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function seedTopic(
  topicIndex: TopicIndex,
  anchorMap: AnchorMap,
  args: { slug: string; body: string; sot_source: string; anchor: string; line_range: [number, number] },
): { topicIndex: TopicIndex; anchorMap: AnchorMap } {
  const realHash = bodyContentHash(args.body);
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
    content_hash: realHash,
  };
  return {
    topicIndex: setTopic(topicIndex, args.slug, entry),
    anchorMap: setAnchor(anchorMap, args.slug, {
      file: args.sot_source,
      current_anchor: args.anchor,
      content_hash: realHash,
      line_range: args.line_range,
      kind: "doc",
    }),
  };
}

function getTool(): ToolDef<unknown> {
  const t = (allTools as ToolDef<unknown>[]).find(
    (t) => t.name === "cairn_reject_candidate",
  );
  assert(t !== undefined, "cairn_reject_candidate must be registered");
  return t;
}

interface RejectResult {
  ok: boolean;
  slug?: string;
  reason?: string;
  detail?: string;
  warning?: string;
}

async function call(
  tool: ToolDef<unknown>,
  ctx: McpContext,
  input: unknown,
): Promise<RejectResult> {
  return (await tool.handler(ctx, input)) as RejectResult;
}

const PROSE = `## Maybe redis someday

Research note. We considered redis but did not commit to anything. Open question whether we need a sidecar at all given current load patterns.`;

async function runSmoke(): Promise<void> {
  console.log("smoke-reject-candidate — start");

  const tool = getTool();

  // ── Step 1 — unknown slug → not_found ──────────────────────────
  {
    const repoRoot = mkRepo();
    writeTopicIndex(repoRoot, emptyTopicIndex());
    writeAnchorMap(repoRoot, emptyAnchorMap());
    const ctx: McpContext = { repoRoot };
    const result = await call(tool, ctx, { slug: "ghost", reason: "test" });
    assert(
      result.ok === false && result.reason === "not_found",
      `Step 1: expected not_found, got ${JSON.stringify(result)}`,
    );
    assert(
      !existsSync(rejectedYamlPath(repoRoot)),
      `Step 1: rejected.yaml should NOT be created on a not_found refusal`,
    );
    console.log("  ✓ Step 1 — unknown slug → not_found");
  }

  // ── Step 2 — first append lands record ─────────────────────────
  {
    const repoRoot = mkRepo();
    writeDoc(repoRoot, ".planning/research.md", PROSE);
    let ti = emptyTopicIndex();
    let am = emptyAnchorMap();
    const slug = topicSlug(PROSE);
    ({ topicIndex: ti, anchorMap: am } = seedTopic(ti, am, {
      slug,
      body: PROSE,
      sot_source: ".planning/research.md",
      anchor: "maybe-redis-someday",
      line_range: [1, PROSE.split("\n").length],
    }));
    writeTopicIndex(repoRoot, ti);
    writeAnchorMap(repoRoot, am);

    const ctx: McpContext = { repoRoot };
    const result = await call(tool, ctx, {
      slug,
      reason: "research scratch — open question, not a decision",
    });
    assert(
      result.ok === true && result.slug === slug,
      `Step 2: expected ok+slug, got ${JSON.stringify(result)}`,
    );
    assert(
      result.warning === undefined,
      `Step 2: first writer should not surface a warning, got ${result.warning}`,
    );

    const raw = readFileSync(rejectedYamlPath(repoRoot), "utf8");
    const parsed = parseYaml(raw) as RejectedYaml;
    assert(
      parsed.rejected.length === 1 &&
        parsed.rejected[0]?.slug === slug &&
        parsed.rejected[0]?.rejected_by === "ai-curator" &&
        parsed.rejected[0]?.reason.includes("research scratch") &&
        parsed.rejected[0]?.sot_source === ".planning/research.md",
      `Step 2: first record incorrect, got ${JSON.stringify(parsed.rejected)}`,
    );
    console.log("  ✓ Step 2 — first append lands record");
  }

  // ── Step 3 — second append dedups by slug ──────────────────────
  // First-writer wins the `reason`; second writer surfaces the
  // existing reason in `warning` so the AI knows it didn't overwrite.
  {
    const repoRoot = mkRepo();
    writeDoc(repoRoot, ".planning/research.md", PROSE);
    let ti = emptyTopicIndex();
    let am = emptyAnchorMap();
    const slug = topicSlug(PROSE);
    ({ topicIndex: ti, anchorMap: am } = seedTopic(ti, am, {
      slug,
      body: PROSE,
      sot_source: ".planning/research.md",
      anchor: "maybe-redis-someday",
      line_range: [1, PROSE.split("\n").length],
    }));
    writeTopicIndex(repoRoot, ti);
    writeAnchorMap(repoRoot, am);

    const ctx: McpContext = { repoRoot };
    const first = await call(tool, ctx, {
      slug,
      reason: "operator-flagged — not canonical",
    });
    assert(first.ok === true, `Step 3: first call should succeed`);

    // Wait one tick so timestamps differ.
    await new Promise((r) => setTimeout(r, 10));

    const second = await call(tool, ctx, {
      slug,
      reason: "second writer — tries to overwrite reason",
    });
    assert(second.ok === true, `Step 3: second call should succeed`);
    assert(
      typeof second.warning === "string" &&
        second.warning.includes("already rejected") &&
        second.warning.includes("operator-flagged"),
      `Step 3: warning should surface original reason, got ${second.warning}`,
    );

    const raw = readFileSync(rejectedYamlPath(repoRoot), "utf8");
    const parsed = parseYaml(raw) as RejectedYaml;
    assert(
      parsed.rejected.length === 1,
      `Step 3: dedup should keep one record, got ${parsed.rejected.length}`,
    );
    assert(
      parsed.rejected[0]?.reason === "operator-flagged — not canonical",
      `Step 3: first writer's reason must survive, got ${parsed.rejected[0]?.reason}`,
    );
    console.log("  ✓ Step 3 — second writer refreshes timestamp, preserves reason");
  }

  console.log("smoke-reject-candidate — pass");
}

(async () => {
  try {
    await runSmoke();
  } finally {
    cleanup();
  }
})().catch((err: unknown) => {
  console.error("smoke-reject-candidate failed:", err);
  cleanup();
  process.exit(1);
});

#!/usr/bin/env tsx
/**
 * smoke-propose-decision — `cairn_propose_decision` MCP tool
 * (PHASE_6_REDESIGN §4.6 / §5.4 / PR 2).
 *
 * Verifies:
 *   - Slug not in topic-index → { ok:false, reason:"not_found" }.
 *   - Slug in `_rejected.yaml` → { ok:false, reason:"rejected" }.
 *   - Drift check fires when source body changed since index build.
 *   - Successful emit writes a verbatim-body draft to `_inbox/`,
 *     stamps `dec_id` on the topic-index entry, and returns the
 *     locked "DO NOT enforce" warning verbatim.
 *   - Idempotent: a second call for the same slug returns the same
 *     `dec_id` with the "already exists" warning instead of writing
 *     another draft.
 *   - file-candidates-map.yaml is refreshed post-emit (count drops
 *     to zero for a one-candidate fixture).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  allTools,
  appendRejected,
  bodyContentHash,
  emptyAnchorMap,
  emptyTopicIndex,
  fileCandidatesMapPath,
  setAnchor,
  setTopic,
  topicSlug,
  writeAnchorMap,
  writeFileCandidatesMap,
  writeRejectedYaml,
  writeTopicIndex,
  type AnchorMap,
  type FileCandidatesMap,
  type McpContext,
  type RejectedEntry,
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
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-propose-"));
  cleanups.push(dir);
  // bootstrap-guard waits for `.git` AND `.cairn/config.yaml` AND
  // `core.hooksPath != .cairn/git-hooks`. Skip both — no `.git`, no
  // config.yaml — so the guard short-circuits to null and we don't
  // need a real `cairn join`.
  mkdirSync(join(dir, ".cairn", "ground"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
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
  /** Override the content_hash on the topic entry to simulate drift. */
  content_hash_override?: string;
}

function seedTopic(
  topicIndex: TopicIndex,
  anchorMap: AnchorMap,
  args: SeedArgs,
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
    content_hash: args.content_hash_override ?? realHash,
    ...(args.marker_kind !== undefined ? { marker_kind: args.marker_kind } : {}),
    ...(args.dec_id !== undefined ? { dec_id: args.dec_id } : {}),
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
    (t) => t.name === "cairn_propose_decision",
  );
  assert(t !== undefined, "cairn_propose_decision must be registered");
  return t;
}

interface ProposeResult {
  ok: boolean;
  dec_id?: string;
  path?: string;
  reason?: string;
  detail?: string;
  warning?: string;
}

async function call(
  tool: ToolDef<unknown>,
  ctx: McpContext,
  input: unknown,
): Promise<ProposeResult> {
  return (await tool.handler(ctx, input)) as ProposeResult;
}

const PROSE = `## bcrypt over scrypt

We chose bcrypt over scrypt because every supported language ships a maintained bcrypt library while scrypt support is still patchy outside the JVM ecosystem. Library breadth wins over the marginal security upgrade scrypt offers in our threat model.`;

async function runSmoke(): Promise<void> {
  console.log("smoke-propose-decision — start");

  const tool = getTool();

  // ── Step 1 — slug not in topic-index → not_found ────────────────
  {
    const repoRoot = mkRepo();
    writeTopicIndex(repoRoot, emptyTopicIndex());
    writeAnchorMap(repoRoot, emptyAnchorMap());
    const ctx: McpContext = { repoRoot };
    const result = await call(tool, ctx, { slug: "ghost" });
    assert(
      result.ok === false && result.reason === "not_found",
      `Step 1: expected not_found, got ${JSON.stringify(result)}`,
    );
    console.log("  ✓ Step 1 — unknown slug → not_found");
  }

  // ── Step 2 — rejected slug → rejected ──────────────────────────
  {
    const repoRoot = mkRepo();
    writeDoc(repoRoot, "docs/auth.md", PROSE);
    let ti = emptyTopicIndex();
    let am = emptyAnchorMap();
    const slug = topicSlug(PROSE);
    ({ topicIndex: ti, anchorMap: am } = seedTopic(ti, am, {
      slug,
      body: PROSE,
      sot_source: "docs/auth.md",
      anchor: "bcrypt-over-scrypt",
      line_range: [1, PROSE.split("\n").length],
    }));
    writeTopicIndex(repoRoot, ti);
    writeAnchorMap(repoRoot, am);

    const now = new Date().toISOString();
    const rejected: RejectedEntry = {
      slug,
      rejected_at: now,
      rejected_by: "operator",
      reason: "research scratch, not a decision",
      sot_source: "docs/auth.md",
    };
    writeRejectedYaml(repoRoot, appendRejected(new Map(), rejected));

    const ctx: McpContext = { repoRoot };
    const result = await call(tool, ctx, { slug });
    assert(
      result.ok === false && result.reason === "rejected",
      `Step 2: expected rejected, got ${JSON.stringify(result)}`,
    );
    assert(
      typeof result.detail === "string" && result.detail.includes("research"),
      `Step 2: detail should surface the original reason, got ${result.detail}`,
    );
    console.log("  ✓ Step 2 — rejected slug refused");
  }

  // ── Step 3 — drift detection ───────────────────────────────────
  // Seed the topic-index with a synthetic content_hash that does NOT
  // match the current body. The tool must surface "drifted" instead
  // of silently anchoring the draft to stale prose.
  {
    const repoRoot = mkRepo();
    writeDoc(repoRoot, "docs/auth.md", PROSE);
    let ti = emptyTopicIndex();
    let am = emptyAnchorMap();
    const slug = topicSlug(PROSE);
    ({ topicIndex: ti, anchorMap: am } = seedTopic(ti, am, {
      slug,
      body: PROSE,
      sot_source: "docs/auth.md",
      anchor: "bcrypt-over-scrypt",
      line_range: [1, PROSE.split("\n").length],
      content_hash_override:
        "0".repeat(64), // 64-char zero hex — guaranteed mismatch
    }));
    writeTopicIndex(repoRoot, ti);
    writeAnchorMap(repoRoot, am);

    const ctx: McpContext = { repoRoot };
    const result = await call(tool, ctx, { slug });
    assert(
      result.ok === false && result.reason === "drifted",
      `Step 3: expected drifted, got ${JSON.stringify(result)}`,
    );
    assert(
      typeof result.detail === "string" && result.detail.includes("cairn index"),
      `Step 3: detail should reference cairn index, got ${result.detail}`,
    );
    console.log("  ✓ Step 3 — drift refused with cairn index hint");
  }

  // ── Step 4 — happy path emits draft + stamps topic-index ───────
  {
    const repoRoot = mkRepo();
    writeDoc(repoRoot, "docs/auth.md", PROSE);
    let ti = emptyTopicIndex();
    let am = emptyAnchorMap();
    const slug = topicSlug(PROSE);
    ({ topicIndex: ti, anchorMap: am } = seedTopic(ti, am, {
      slug,
      body: PROSE,
      sot_source: "docs/auth.md",
      anchor: "bcrypt-over-scrypt",
      line_range: [1, PROSE.split("\n").length],
    }));
    writeTopicIndex(repoRoot, ti);
    writeAnchorMap(repoRoot, am);
    // Pre-write the file-candidates-map so we can confirm the tool refreshes it.
    writeFileCandidatesMap(repoRoot, ti);

    const beforeMap = parseYaml(
      readFileSync(fileCandidatesMapPath(repoRoot), "utf8"),
    ) as FileCandidatesMap;
    assert(
      beforeMap.file_candidates["docs/auth.md"] === 1,
      `Step 4: pre-state map should count docs/auth.md=1, got ${JSON.stringify(beforeMap.file_candidates)}`,
    );

    const ctx: McpContext = { repoRoot };
    const result = await call(tool, ctx, { slug, title: "bcrypt over scrypt" });
    assert(
      result.ok === true,
      `Step 4: expected ok, got ${JSON.stringify(result)}`,
    );
    assert(
      typeof result.dec_id === "string" && result.dec_id.startsWith("DEC-"),
      `Step 4: dec_id should be DEC-<hash>, got ${result.dec_id}`,
    );
    assert(
      typeof result.path === "string" &&
        result.path === `.cairn/ground/decisions/_inbox/${result.dec_id}.draft.md`,
      `Step 4: path should be inbox-relative, got ${result.path}`,
    );
    assert(
      typeof result.warning === "string" &&
        result.warning.includes("DO NOT enforce") &&
        result.warning.includes("draft") &&
        result.warning.includes("proposed"),
      `Step 4: warning must contain locked DO NOT enforce wording, got ${result.warning}`,
    );

    const draftAbs = join(repoRoot, result.path!);
    assert(existsSync(draftAbs), `Step 4: draft file should exist at ${draftAbs}`);
    const draft = readFileSync(draftAbs, "utf8");
    assert(
      draft.includes("status: draft"),
      `Step 4: draft frontmatter should mark status=draft, got ${draft.slice(0, 200)}`,
    );
    assert(
      draft.includes("capture_source: ai-proposed"),
      `Step 4: draft should record capture_source=ai-proposed`,
    );
    assert(
      draft.includes("decided_by: ai-curator"),
      `Step 4: draft should record decided_by=ai-curator`,
    );
    // Body must be VERBATIM — no AI paraphrasing.
    assert(
      draft.includes("bcrypt over scrypt"),
      `Step 4: body should include the verbatim heading "bcrypt over scrypt"`,
    );
    assert(
      draft.includes("Library breadth wins over the marginal security upgrade"),
      `Step 4: body should include verbatim source prose`,
    );

    // Topic-index dec_id stamped.
    const tiRaw = readFileSync(
      join(repoRoot, ".cairn", "ground", "topic-index.yaml"),
      "utf8",
    );
    const tiParsed = parseYaml(tiRaw) as TopicIndex;
    assert(
      tiParsed.topics[slug]?.dec_id === result.dec_id,
      `Step 4: topic-index entry should be stamped with the new dec_id, got ${tiParsed.topics[slug]?.dec_id}`,
    );

    // file-candidates-map refreshed — the only candidate is now promoted.
    const afterMap = parseYaml(
      readFileSync(fileCandidatesMapPath(repoRoot), "utf8"),
    ) as FileCandidatesMap;
    assert(
      afterMap.file_candidates["docs/auth.md"] === undefined,
      `Step 4: file-candidates-map should drop docs/auth.md after promote, got ${JSON.stringify(afterMap.file_candidates)}`,
    );
    console.log("  ✓ Step 4 — emit lands draft, stamps topic-index, refreshes map");
  }

  // ── Step 5 — idempotent re-call ────────────────────────────────
  {
    const repoRoot = mkRepo();
    writeDoc(repoRoot, "docs/auth.md", PROSE);
    let ti = emptyTopicIndex();
    let am = emptyAnchorMap();
    const slug = topicSlug(PROSE);
    ({ topicIndex: ti, anchorMap: am } = seedTopic(ti, am, {
      slug,
      body: PROSE,
      sot_source: "docs/auth.md",
      anchor: "bcrypt-over-scrypt",
      line_range: [1, PROSE.split("\n").length],
    }));
    writeTopicIndex(repoRoot, ti);
    writeAnchorMap(repoRoot, am);

    const ctx: McpContext = { repoRoot };
    const first = await call(tool, ctx, { slug });
    assert(first.ok === true, `Step 5: first call should succeed`);
    const second = await call(tool, ctx, { slug });
    assert(
      second.ok === true && second.dec_id === first.dec_id,
      `Step 5: second call should return same dec_id, got ${JSON.stringify(second)}`,
    );
    assert(
      typeof second.warning === "string" && second.warning.includes("already exists"),
      `Step 5: second call warning should mention "already exists", got ${second.warning}`,
    );
    console.log("  ✓ Step 5 — second call is idempotent");
  }

  console.log("smoke-propose-decision — pass");
}

(async () => {
  try {
    await runSmoke();
  } finally {
    cleanup();
  }
})().catch((err: unknown) => {
  console.error("smoke-propose-decision failed:", err);
  cleanup();
  process.exit(1);
});

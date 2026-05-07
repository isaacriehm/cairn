#!/usr/bin/env tsx
/**
 * smoke-conflicts-queue — verifies cairn_resolve_attention's conflict
 * resolution paths (plan §5.4.1).
 *
 * Each step mounts a fresh fixture with two accepted DECs + a conflict
 * file that pairs them, exercises one of the four operator choices, and
 * asserts the on-disk outcome:
 *
 *   [a] keep A → B superseded by A, conflict deleted
 *   [b] keep B → A superseded by B, conflict deleted
 *   [c] merge → fresh DEC supersedes both, conflict deleted
 *   [d] archive both → both DECs archived, conflict moved to _archived/
 *
 * Hard rule: source files are NEVER rewritten by any of these paths.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  allTools,
  type McpContext,
  type ToolDef,
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
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-conflicts-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn", "ground", "decisions"), { recursive: true });
  mkdirSync(join(dir, ".cairn", "ground", "conflicts"), { recursive: true });
  // Touch bootstrap marker so requireBootstrap() lets the tool through.
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), "[core]\n\thooksPath = .cairn/git-hooks\n", "utf8");
  mkdirSync(join(dir, ".cairn", "git-hooks"), { recursive: true });
  return dir;
}

function writeDec(repoRoot: string, id: string, body: string, sotPath: string): void {
  const fm: Record<string, unknown> = {
    id,
    title: `Smoke ${id}`,
    type: "adr",
    status: "accepted",
    audience: "dual",
    generated: "2026-01-01T00:00:00Z",
    "verified-at": "2026-01-01T00:00:00Z",
    decided_at: "2026-01-01T00:00:00Z",
    decided_by: "smoke",
    sot_kind: sotPath === "ledger" ? "ledger" : "path",
    sot_path: sotPath,
    sot_content_hash:
      "0000000000000000000000000000000000000000000000000000000000000000",
    capture_source: "smoke",
  };
  const out = `---\n${stringifyYaml(fm).trimEnd()}\n---\n\n${body}\n`;
  writeFileSync(
    join(repoRoot, ".cairn", "ground", "decisions", `${id}.md`),
    out,
    "utf8",
  );
}

function writeConflictFile(
  repoRoot: string,
  aId: string,
  bId: string,
  aBody: string,
  bBody: string,
  reasoning: string,
): string {
  const filename = `${aId}__${bId}.md`;
  const fm: Record<string, unknown> = {
    a_id: aId,
    a_source: "CLAUDE.md",
    a_capture_source: "init-rules-merge",
    b_id: bId,
    b_sot_path: "ledger",
    detected_at: "2026-01-01T00:00:00Z",
    detector: "phase-7c-contradiction-judge",
    severity: "soft",
    reasoning,
  };
  const lines: string[] = [];
  lines.push("---");
  lines.push(stringifyYaml(fm).trimEnd());
  lines.push("---");
  lines.push("");
  lines.push(`# Conflict — ${aId} vs ${bId}`);
  lines.push("");
  lines.push(`## ${aId} (just captured from \`CLAUDE.md\`)`);
  lines.push("");
  lines.push("```");
  lines.push(aBody);
  lines.push("```");
  lines.push("");
  lines.push(`## ${bId} (already accepted, sot_path: \`ledger\`)`);
  lines.push("");
  lines.push("```");
  lines.push(bBody);
  lines.push("```");
  lines.push("");
  lines.push("## Judge reasoning");
  lines.push("");
  lines.push(reasoning);
  lines.push("");
  const path = join(repoRoot, ".cairn", "ground", "conflicts", filename);
  writeFileSync(path, lines.join("\n"), "utf8");
  return filename;
}

function readDecFm(repoRoot: string, id: string): Record<string, unknown> | null {
  const abs = join(repoRoot, ".cairn", "ground", "decisions", `${id}.md`);
  if (!existsSync(abs)) return null;
  const raw = readFileSync(abs, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (m === null || m[1] === undefined) return null;
  const parsed = parseYaml(m[1]);
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : null;
}

function getResolveTool(): ToolDef<unknown> {
  const tool = (allTools as ToolDef<unknown>[]).find(
    (t) => t.name === "cairn_resolve_attention",
  );
  assert(tool !== undefined, "cairn_resolve_attention should be registered in allTools");
  return tool;
}

async function call(
  tool: ToolDef<unknown>,
  ctx: McpContext,
  input: unknown,
): Promise<{ ok?: boolean; resolved_kind?: string; [k: string]: unknown }> {
  return (await tool.handler(ctx, input)) as {
    ok?: boolean;
    resolved_kind?: string;
    [k: string]: unknown;
  };
}

async function main(): Promise<void> {
  console.log("smoke-conflicts-queue — start");
  const tool = getResolveTool();

  // ── Step 1 — choice [a] keep A, supersede B ──────────────────────
  {
    const repoRoot = mkRepoRoot();
    const aId = "DEC-aaa1111";
    const bId = "DEC-bbb1111";
    const aBody = "Always sign tokens with HS512. Never RS256 in production.";
    const bBody = "We sign tokens with RS256 because asymmetric. HS512 forbidden.";
    writeDec(repoRoot, aId, aBody, "CLAUDE.md#token-signing");
    writeDec(repoRoot, bId, bBody, "ledger");
    const filename = writeConflictFile(repoRoot, aId, bId, aBody, bBody, "A says HS512 only; B forbids HS512 — contradictory.");
    // Write CLAUDE.md so we can verify it stays untouched.
    const claudeMd = `# Top\n\n## Token signing\n\n${aBody}\n`;
    writeFileSync(join(repoRoot, "CLAUDE.md"), claudeMd, "utf8");

    const ctx: McpContext = { repoRoot, sessionId: "smoke-a" };
    const result = await call(tool, ctx, {
      kind: "conflict",
      item_id: filename.replace(/\.md$/, ""),
      choice: "a",
    });
    assert(result.ok === true, `Step 1: ok=true expected, got ${JSON.stringify(result)}`);
    assert(result.resolved_kind === "conflict_supersede", "Step 1: resolved_kind=conflict_supersede");
    assert(result.winner_id === aId, "Step 1: winner=A");
    assert(result.loser_id === bId, "Step 1: loser=B");

    const aFm = readDecFm(repoRoot, aId);
    const bFm = readDecFm(repoRoot, bId);
    assert(aFm !== null && bFm !== null, "Step 1: both DECs still on disk");
    assert(aFm!.supersedes === bId, `Step 1: A.supersedes=B, got ${String(aFm!.supersedes)}`);
    assert(bFm!.status === "superseded", `Step 1: B.status=superseded, got ${String(bFm!.status)}`);
    assert(bFm!.superseded_by === aId, "Step 1: B.superseded_by=A");
    assert(
      !existsSync(join(repoRoot, ".cairn", "ground", "conflicts", filename)),
      "Step 1: conflict file deleted",
    );
    // CLAUDE.md untouched.
    const claudeAfter = readFileSync(join(repoRoot, "CLAUDE.md"), "utf8");
    assert(claudeAfter === claudeMd, "Step 1: CLAUDE.md untouched");
    console.log("  ✓ Step 1 — choice [a] supersede B with A, conflict deleted, source intact");
  }

  // ── Step 2 — choice [b] keep B, supersede A ──────────────────────
  {
    const repoRoot = mkRepoRoot();
    const aId = "DEC-aaa2222";
    const bId = "DEC-bbb2222";
    const aBody = "Encrypt PII at rest with column-level keys.";
    const bBody = "Encrypt PII at rest with table-level keys instead.";
    writeDec(repoRoot, aId, aBody, "CLAUDE.md#encryption");
    writeDec(repoRoot, bId, bBody, "ledger");
    const filename = writeConflictFile(repoRoot, aId, bId, aBody, bBody, "Different key granularity strategies.");

    const ctx: McpContext = { repoRoot, sessionId: "smoke-b" };
    const result = await call(tool, ctx, {
      kind: "conflict",
      item_id: filename.replace(/\.md$/, ""),
      choice: "b",
      rationale: "B's prior decision stands",
    });
    assert(result.ok === true, "Step 2: ok=true");
    assert(result.resolved_kind === "conflict_supersede", "Step 2: resolved_kind");
    assert(result.winner_id === bId && result.loser_id === aId, "Step 2: B wins, A loses");
    const aFm = readDecFm(repoRoot, aId);
    const bFm = readDecFm(repoRoot, bId);
    assert(aFm!.status === "superseded" && aFm!.superseded_by === bId, "Step 2: A superseded by B");
    assert(bFm!.supersedes === aId, "Step 2: B.supersedes=A");
    assert(
      !existsSync(join(repoRoot, ".cairn", "ground", "conflicts", filename)),
      "Step 2: conflict file deleted",
    );
    console.log("  ✓ Step 2 — choice [b] supersede A with B");
  }

  // ── Step 3 — choice [c] merge → fresh DEC supersedes both ────────
  {
    const repoRoot = mkRepoRoot();
    const aId = "DEC-aaa3333";
    const bId = "DEC-bbb3333";
    const aBody = "Rate limit anonymous traffic to 60 req/min.";
    const bBody = "Rate limit anonymous traffic to 100 req/min.";
    writeDec(repoRoot, aId, aBody, "CLAUDE.md#rate-limit");
    writeDec(repoRoot, bId, bBody, "ledger");
    const filename = writeConflictFile(repoRoot, aId, bId, aBody, bBody, "Different limits.");

    const ctx: McpContext = { repoRoot, sessionId: "smoke-c" };
    const result = await call(tool, ctx, {
      kind: "conflict",
      item_id: filename.replace(/\.md$/, ""),
      choice: "c",
      rationale: "Pick 80 req/min as the tradeoff between the two limits.",
    });
    assert(result.ok === true, "Step 3: ok=true");
    assert(result.resolved_kind === "conflict_merge", "Step 3: resolved_kind=conflict_merge");
    const mergedId = String(result.merged_id ?? "");
    assert(/^DEC-[0-9a-f]{7,}$/.test(mergedId), `Step 3: merged_id format, got ${mergedId}`);
    const mergedFm = readDecFm(repoRoot, mergedId);
    assert(mergedFm !== null, "Step 3: merged DEC file exists");
    assert(mergedFm!.status === "accepted", "Step 3: merged DEC status=accepted");
    assert(mergedFm!.capture_source === "conflict-merge", "Step 3: capture_source=conflict-merge");
    const mergedBody = readFileSync(
      join(repoRoot, ".cairn", "ground", "decisions", `${mergedId}.md`),
      "utf8",
    );
    assert(mergedBody.includes(aBody), "Step 3: merged body includes A's prose");
    assert(mergedBody.includes(bBody), "Step 3: merged body includes B's prose");
    assert(mergedBody.includes("80 req/min"), "Step 3: merged body includes operator's rationale");

    const aFm = readDecFm(repoRoot, aId);
    const bFm = readDecFm(repoRoot, bId);
    assert(aFm!.status === "superseded" && aFm!.superseded_by === mergedId, "Step 3: A superseded by merged");
    assert(bFm!.status === "superseded" && bFm!.superseded_by === mergedId, "Step 3: B superseded by merged");
    assert(
      !existsSync(join(repoRoot, ".cairn", "ground", "conflicts", filename)),
      "Step 3: conflict file deleted after merge",
    );
    console.log(`  ✓ Step 3 — choice [c] merge → fresh ${mergedId}, both old superseded`);
  }

  // ── Step 4 — choice [d] archive both → conflict file → _archived/ ─
  {
    const repoRoot = mkRepoRoot();
    const aId = "DEC-aaa4444";
    const bId = "DEC-bbb4444";
    const aBody = "Use threading for I/O-heavy workloads.";
    const bBody = "Use async/await everywhere; never threads.";
    writeDec(repoRoot, aId, aBody, "CLAUDE.md#concurrency");
    writeDec(repoRoot, bId, bBody, "ledger");
    const filename = writeConflictFile(repoRoot, aId, bId, aBody, bBody, "Threads vs async strategies disagree.");

    const ctx: McpContext = { repoRoot, sessionId: "smoke-d" };
    const result = await call(tool, ctx, {
      kind: "conflict",
      item_id: filename.replace(/\.md$/, ""),
      choice: "d",
      rationale: "Reopen later — neither side is committed.",
    });
    assert(result.ok === true, "Step 4: ok=true");
    assert(result.resolved_kind === "conflict_archive", "Step 4: resolved_kind=conflict_archive");
    const archivedRel = String(result.archived_path ?? "");
    assert(archivedRel.endsWith(filename), `Step 4: archived path ends with ${filename}`);
    assert(
      existsSync(join(repoRoot, archivedRel)),
      `Step 4: archived conflict at ${archivedRel}`,
    );
    assert(
      !existsSync(join(repoRoot, ".cairn", "ground", "conflicts", filename)),
      "Step 4: conflict no longer at conflicts/<file>.md",
    );
    const aFm = readDecFm(repoRoot, aId);
    const bFm = readDecFm(repoRoot, bId);
    assert(aFm!.status === "archived", `Step 4: A status=archived, got ${String(aFm!.status)}`);
    assert(bFm!.status === "archived", `Step 4: B status=archived, got ${String(bFm!.status)}`);
    console.log("  ✓ Step 4 — choice [d] both archived, conflict moved to _archived/");
  }

  // ── Step 5 — d on non-conflict kind rejected ────────────────────
  {
    const repoRoot = mkRepoRoot();
    const ctx: McpContext = { repoRoot, sessionId: "smoke-d-reject" };
    const result = await call(tool, ctx, {
      kind: "decision_draft",
      item_id: "DEC-1234567",
      choice: "d",
    });
    // mcpError returns an error envelope with `error: { code, message }`.
    const error = (result as { error?: { code?: string } }).error;
    assert(
      error !== undefined && error.code === "VALIDATION_FAILED",
      `Step 5: choice=d on decision_draft must reject, got ${JSON.stringify(result)}`,
    );
    console.log("  ✓ Step 5 — choice [d] rejected on non-conflict kinds");
  }

  // ── Step 6 — missing conflict file → FILE_NOT_FOUND ─────────────
  {
    const repoRoot = mkRepoRoot();
    const ctx: McpContext = { repoRoot, sessionId: "smoke-missing" };
    const result = await call(tool, ctx, {
      kind: "conflict",
      item_id: "DEC-9999999__DEC-8888888",
      choice: "a",
    });
    const error = (result as { error?: { code?: string } }).error;
    assert(
      error !== undefined && error.code === "FILE_NOT_FOUND",
      `Step 6: missing file must FILE_NOT_FOUND, got ${JSON.stringify(result)}`,
    );
    console.log("  ✓ Step 6 — missing conflict file errors cleanly");
  }

  cleanup();
  console.log("\nsmoke-conflicts-queue — pass");
}

main().catch((err) => {
  console.error("smoke-conflicts-queue — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});

void readdirSync; // keep import for future "list conflicts" assertions

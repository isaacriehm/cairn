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
import { dirname, join } from "node:path";
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

function readDriftEvents(repoRoot: string): Array<Record<string, unknown>> {
  const path = join(repoRoot, ".cairn", "staleness", "log.jsonl");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const out: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      /* best-effort */
    }
  }
  return out;
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
    // No orphan drift event — winner A was path-SoT but A is the survivor;
    // loser B was ledger-SoT, no orphan source prose to surface.
    const driftA = readDriftEvents(repoRoot);
    assert(
      driftA.length === 0,
      `Step 1: no orphan drift expected (loser=ledger), got ${JSON.stringify(driftA)}`,
    );
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
    // Loser A was sot_kind=path → orphan_path drift event recorded.
    const drift = readDriftEvents(repoRoot);
    const orphanA = drift.find(
      (e) => e["kind"] === "orphan_path" && e["dec_id"] === aId,
    );
    assert(orphanA !== undefined, `Step 2: orphan_path drift for ${aId} expected`);
    assert(
      String(orphanA["path"]).startsWith("CLAUDE.md"),
      "Step 2: drift path = original sot_path",
    );
    console.log(`  ✓ Step 2 — choice [b] supersede A with B + orphan_path drift for ${aId}`);
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
    // Both old DECs superseded; only A was sot_kind=path → exactly one
    // orphan_path drift event for A.
    const drift = readDriftEvents(repoRoot);
    const orphans = drift.filter((e) => e["kind"] === "orphan_path");
    assert(orphans.length === 1, `Step 3: one orphan drift expected, got ${orphans.length}`);
    assert(orphans[0]?.["dec_id"] === aId, "Step 3: orphan drift refs A (path-SoT side)");
    console.log(`  ✓ Step 3 — choice [c] merge → fresh ${mergedId}, both old superseded, A orphan drift`);
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
    // Both archived; only A was sot_kind=path → one orphan_path drift.
    const drift = readDriftEvents(repoRoot);
    const orphans = drift.filter((e) => e["kind"] === "orphan_path");
    assert(orphans.length === 1, `Step 4: one orphan drift expected, got ${orphans.length}`);
    assert(orphans[0]?.["dec_id"] === aId, "Step 4: orphan drift refs A (path-SoT side)");
    console.log("  ✓ Step 4 — choice [d] both archived, conflict moved to _archived/, A orphan drift");
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

  // ── Step 7 — alignment_pending tier3 [a] decision → fresh DEC + cite
  {
    const repoRoot = mkRepoRoot();
    // Mount a source file with a JSDoc block whose offsets we'll seed
    // into the pending file's frontmatter.
    const source = [
      "/**",
      " * The retry budget for upstream API calls follows an exponential",
      " * backoff starting at 200ms and capping at 5s per request. We chose",
      " * this curve over linear because the error spike profile is heavy-tailed.",
      " */",
      "export function retry() {}",
    ].join("\n") + "\n";
    const sourceAbs = join(repoRoot, "src/retry.ts");
    mkdirSync(dirname(sourceAbs), { recursive: true });
    writeFileSync(sourceAbs, source, "utf8");
    // Compute byte offsets of the JSDoc block.
    const startOffset = source.indexOf("/**");
    const endOffset = source.indexOf(" */") + " */".length;
    const blockRaw = source.slice(startOffset, endOffset);
    const blockProse =
      "The retry budget for upstream API calls follows an exponential\n" +
      "backoff starting at 200ms and capping at 5s per request. We chose\n" +
      "this curve over linear because the error spike profile is heavy-tailed.";

    // Pending file fixture.
    const slug = "abcdef012345";
    const pendingAbs = join(
      repoRoot,
      ".cairn",
      "ground",
      "alignment-pending",
      `${slug}.md`,
    );
    mkdirSync(dirname(pendingAbs), { recursive: true });
    const fm: Record<string, unknown> = {
      slug,
      kind: "tier3-ambiguous",
      source_file: "src/retry.ts",
      source_range: "1-5",
      start_line: 1,
      end_line: 5,
      start_offset: startOffset,
      end_offset: endOffset,
      lang: "js",
      raw: blockRaw,
      detected_at: "2026-01-01T00:00:00Z",
      detector: "layer-a-pass2-ambiguous",
      severity: "soft",
    };
    const pendingBody = [
      "---",
      stringifyYaml(fm).trimEnd(),
      "---",
      "",
      "# Alignment pending",
      "",
      "## Block (just written at `src/retry.ts:1-5`)",
      "",
      "```",
      blockProse,
      "```",
      "",
    ].join("\n");
    writeFileSync(pendingAbs, pendingBody, "utf8");

    const ctx: McpContext = { repoRoot, sessionId: "smoke-pend-decision" };
    const result = await call(tool, ctx, {
      kind: "alignment_pending",
      item_id: slug,
      choice: "a",
    });
    assert(result.ok === true, `Step 7: ok=true, got ${JSON.stringify(result)}`);
    assert(result.resolved_kind === "alignment_decision", "Step 7: resolved_kind");
    const newId = String(result.new_id ?? "");
    assert(/^DEC-[0-9a-f]{7,}$/.test(newId), `Step 7: new_id format, got ${newId}`);
    const after = readFileSync(sourceAbs, "utf8");
    assert(after.includes(`// §${newId}`), "Step 7: source carries fresh §DEC cite");
    assert(!after.includes("/**\n * The retry budget"), "Step 7: original block stripped");
    assert(!existsSync(pendingAbs), "Step 7: pending file deleted");
    console.log(`  ✓ Step 7 — alignment_pending [a] tier3 → fresh ${newId}`);
  }

  // ── Step 8 — alignment_pending tier2 [b] augments → sibling DEC ─
  {
    const repoRoot = mkRepoRoot();
    const existingId = "DEC-eeeeeee";
    const existingBody =
      "Use bcrypt with cost factor 12 because operational topology is uniform.";
    writeDec(repoRoot, existingId, existingBody, "ledger");

    // Source block (the operator's new prose).
    const source = [
      "/**",
      " * Use bcrypt with cost factor 12 because operational topology is uniform.",
      " * Rotation forbidden mid-flight to avoid lockout cascades on rolling deploys.",
      " */",
      "export function hash() {}",
    ].join("\n") + "\n";
    const sourceAbs = join(repoRoot, "src/hash.ts");
    mkdirSync(dirname(sourceAbs), { recursive: true });
    writeFileSync(sourceAbs, source, "utf8");
    const startOffset = source.indexOf("/**");
    const endOffset = source.indexOf(" */") + " */".length;
    const blockRaw = source.slice(startOffset, endOffset);
    const blockProse =
      "Use bcrypt with cost factor 12 because operational topology is uniform.\n" +
      "Rotation forbidden mid-flight to avoid lockout cascades on rolling deploys.";

    const slug = "fedcba543210";
    const pendingAbs = join(
      repoRoot,
      ".cairn",
      "ground",
      "alignment-pending",
      `${slug}.md`,
    );
    mkdirSync(dirname(pendingAbs), { recursive: true });
    const fm: Record<string, unknown> = {
      slug,
      kind: "tier2-ambiguous",
      source_file: "src/hash.ts",
      source_range: "1-4",
      start_line: 1,
      end_line: 4,
      start_offset: startOffset,
      end_offset: endOffset,
      lang: "js",
      raw: blockRaw,
      existing_id: existingId,
      detected_at: "2026-01-01T00:00:00Z",
      detector: "layer-a-pass2-ambiguous",
      severity: "soft",
    };
    const pendingBody = [
      "---",
      stringifyYaml(fm).trimEnd(),
      "---",
      "",
      "# Alignment pending",
      "",
      "## Block (just written at `src/hash.ts:1-4`)",
      "",
      "```",
      blockProse,
      "```",
      "",
      `## Existing ${existingId}`,
      "",
      "```",
      existingBody,
      "```",
      "",
    ].join("\n");
    writeFileSync(pendingAbs, pendingBody, "utf8");

    const ctx: McpContext = { repoRoot, sessionId: "smoke-pend-augments" };
    const result = await call(tool, ctx, {
      kind: "alignment_pending",
      item_id: slug,
      choice: "b",
      rationale: "Operator confirms rotation rule augments existing bcrypt choice",
    });
    assert(result.ok === true, "Step 8: ok=true");
    assert(result.resolved_kind === "alignment_augments", "Step 8: resolved_kind");
    const newId = String(result.new_id ?? "");
    assert(/^DEC-[0-9a-f]{7,}$/.test(newId), "Step 8: new_id format");
    assert(result.existing_id === existingId, "Step 8: existing preserved");
    const after = readFileSync(sourceAbs, "utf8");
    assert(after.includes(`// §${existingId}`), "Step 8: existing § token kept");
    assert(after.includes(`// §${newId}`), "Step 8: new § token added");
    assert(!existsSync(pendingAbs), "Step 8: pending file deleted");
    // Existing DEC unchanged.
    const existingFm = readDecFm(repoRoot, existingId);
    assert(existingFm !== null && existingFm.status === "accepted", "Step 8: existing still accepted");
    console.log(`  ✓ Step 8 — alignment_pending [b] tier2 augments → sibling ${newId}, double-cite`);
  }

  // ── Step 9 — alignment_pending tier3 [c] descriptive → drop file ─
  {
    const repoRoot = mkRepoRoot();
    const source = [
      "/**",
      " * Returns the merged user object. Maps the row to the API shape.",
      " * Throws when fields are missing.",
      " */",
      "export function user() {}",
    ].join("\n") + "\n";
    const sourceAbs = join(repoRoot, "src/user.ts");
    mkdirSync(dirname(sourceAbs), { recursive: true });
    writeFileSync(sourceAbs, source, "utf8");

    const slug = "111111111111";
    const pendingAbs = join(
      repoRoot,
      ".cairn",
      "ground",
      "alignment-pending",
      `${slug}.md`,
    );
    mkdirSync(dirname(pendingAbs), { recursive: true });
    const fm: Record<string, unknown> = {
      slug,
      kind: "tier3-ambiguous",
      source_file: "src/user.ts",
      source_range: "1-4",
      start_line: 1,
      end_line: 4,
      start_offset: 0,
      end_offset: 100,
      lang: "js",
      raw: source.slice(0, 100),
      detected_at: "2026-01-01T00:00:00Z",
      detector: "layer-a-pass2-ambiguous",
      severity: "soft",
    };
    writeFileSync(
      pendingAbs,
      `---\n${stringifyYaml(fm).trimEnd()}\n---\n`,
      "utf8",
    );

    const ctx: McpContext = { repoRoot, sessionId: "smoke-pend-desc" };
    const result = await call(tool, ctx, {
      kind: "alignment_pending",
      item_id: slug,
      choice: "c",
    });
    assert(result.ok === true, "Step 9: ok=true");
    assert(result.resolved_kind === "alignment_descriptive", "Step 9: resolved_kind");
    assert(!existsSync(pendingAbs), "Step 9: pending dropped");
    const after = readFileSync(sourceAbs, "utf8");
    assert(after === source, "Step 9: source untouched on descriptive");
    console.log("  ✓ Step 9 — alignment_pending [c] descriptive drops pending, source intact");
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

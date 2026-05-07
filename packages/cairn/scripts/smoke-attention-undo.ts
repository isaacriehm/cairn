#!/usr/bin/env tsx
/**
 * smoke-attention-undo — `cairn attention undo` (plan §11.7).
 *
 *   Step 1 — Tier 1 cite: alignFile auto-cites, undo restores the
 *            original prose and prunes the log.
 *   Step 2 — Idempotency: re-running undo against the same window
 *            after Step 1 is a no-op.
 *   Step 3 — Outside-window entries are preserved across undo.
 *   Step 4 — Cite already hand-removed → "already-reverted".
 *   Step 5 — Tier 3 creation entry → "not-supported", entry kept in
 *            log so the operator can hand-resolve.
 *   Step 6 — Dry-run: classification only, no source / log writes.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  alignFile,
  alignUndoLogPath,
  bindDec,
  bodyContentHash,
  emptySotBindings,
  emptySotCache,
  readSotBindings,
  readSotCache,
  runAttentionUndo,
  setSotCacheEntry,
  tokenize,
  writeSotBindings,
  writeSotCache,
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
      /* best-effort */
    }
  }
}

function mkRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-undo-"));
  cleanups.push(dir);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: dir });
  mkdirSync(join(dir, ".cairn", "ground", "decisions"), { recursive: true });
  return dir;
}

function writeFile(repoRoot: string, rel: string, body: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function commitAll(repoRoot: string): void {
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
}

function seedAcceptedDec(repoRoot: string, id: string, body: string): void {
  const fm = [
    "---",
    `id: ${id}`,
    "title: Smoke seeded",
    "type: adr",
    "status: accepted",
    "audience: dual",
    "generated: 2026-01-01T00:00:00Z",
    "verified-at: 2026-01-01T00:00:00Z",
    "decided_at: 2026-01-01T00:00:00Z",
    "decided_by: smoke",
    "sot_kind: ledger",
    "sot_path: ledger",
    `sot_content_hash: ${bodyContentHash(body)}`,
    "capture_source: smoke",
    "---",
    "",
    body,
    "",
  ].join("\n");
  writeFile(repoRoot, `.cairn/ground/decisions/${id}.md`, fm);

  const bindings = (() => {
    try {
      return readSotBindings(repoRoot);
    } catch {
      return emptySotBindings();
    }
  })();
  writeSotBindings(repoRoot, bindDec(bindings, id, "ledger"));
  const cache = (() => {
    try {
      return readSotCache(repoRoot);
    } catch {
      return emptySotCache();
    }
  })();
  writeSotCache(
    repoRoot,
    setSotCacheEntry(cache, id, {
      dec_id: id,
      sot_path: "ledger",
      body_hash: bodyContentHash(body),
      tokens: Array.from(tokenize(body, { codeAware: true })),
      shingles: [],
      mtime_ms: Date.now(),
    }),
  );
}

const seedBody = [
  "We pin Postgres at version 15 because the legacy ETL job depends on its",
  "specific replication slot semantics. The team has tried 16 twice and rolled",
  "back both times. Revisit when the ETL job is rewritten.",
].join("\n");

const verbatimSource = [
  "/**",
  " * We pin Postgres at version 15 because the legacy ETL job depends on its",
  " * specific replication slot semantics. The team has tried 16 twice and rolled",
  " * back both times. Revisit when the ETL job is rewritten.",
  " */",
  "export function db() {}",
].join("\n") + "\n";

function appendUndoFixture(repoRoot: string, line: object): void {
  const path = alignUndoLogPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
}

async function main(): Promise<void> {
  console.log("smoke-attention-undo — start");

  // ── Step 1 — Tier 1 cite undo ───────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    seedAcceptedDec(repoRoot, "DEC-aaaaaaa", seedBody);
    writeFile(repoRoot, "src/db.ts", verbatimSource);
    commitAll(repoRoot);

    const align = await alignFile({
      repoRoot,
      filePath: "src/db.ts",
      sessionId: null,
    });
    assert(align.tier1Aligned === 1, "Step 1: alignFile cited the block");
    const cited = readFileSync(join(repoRoot, "src/db.ts"), "utf8");
    assert(cited.includes("// §DEC-aaaaaaa"), "Step 1: cite landed");

    const result = await runAttentionUndo({ repoRoot });
    assert(result.windowEntries === 1, `Step 1: 1 entry in window, got ${result.windowEntries}`);
    assert(result.reverted === 1, `Step 1: reverted=1, got ${result.reverted}`);
    const after = readFileSync(join(repoRoot, "src/db.ts"), "utf8");
    assert(!after.includes("// §DEC-aaaaaaa"), "Step 1: cite removed");
    assert(after.includes("legacy ETL"), "Step 1: original prose restored");
    assert(!existsSync(alignUndoLogPath(repoRoot)) || readFileSync(alignUndoLogPath(repoRoot), "utf8").trim() === "", "Step 1: log truncated");
    console.log("  ✓ Step 1 — Tier 1 cite reverted, log pruned");
  }

  // ── Step 2 — Idempotent re-undo ─────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    seedAcceptedDec(repoRoot, "DEC-bbbbbbb", seedBody);
    writeFile(repoRoot, "src/db.ts", verbatimSource);
    commitAll(repoRoot);

    await alignFile({ repoRoot, filePath: "src/db.ts", sessionId: null });
    await runAttentionUndo({ repoRoot });
    const second = await runAttentionUndo({ repoRoot });
    assert(second.windowEntries === 0, "Step 2: second undo sees 0 entries");
    assert(second.reverted === 0, "Step 2: second undo reverts nothing");
    console.log("  ✓ Step 2 — Idempotent re-run is a no-op");
  }

  // ── Step 3 — Outside-window preservation ────────────────────────
  {
    const repoRoot = mkRepoRoot();
    seedAcceptedDec(repoRoot, "DEC-ccccccc", seedBody);

    // Stash an old entry (3 hours ago) directly into the log.
    const oldTs = new Date(Date.now() - 3 * 3_600_000).toISOString();
    appendUndoFixture(repoRoot, {
      ts: oldTs,
      session_id: null,
      kind: "tier1-cite",
      file: "src/old.ts",
      start_offset: 0,
      end_offset: 100,
      original_raw: "// older block",
      replacement: "// §DEC-ccccccc",
      primary_id: "DEC-ccccccc",
    });

    // Add a fresh entry via alignFile.
    writeFile(repoRoot, "src/db.ts", verbatimSource);
    commitAll(repoRoot);
    await alignFile({ repoRoot, filePath: "src/db.ts", sessionId: null });

    const result = await runAttentionUndo({ repoRoot, sinceMs: 60 * 60_000 }); // 1h
    assert(result.windowEntries === 1, `Step 3: 1 in window (fresh only), got ${result.windowEntries}`);
    assert(result.outsideWindow === 1, `Step 3: 1 outside (the 3h-old fixture), got ${result.outsideWindow}`);
    const log = readFileSync(alignUndoLogPath(repoRoot), "utf8");
    assert(log.includes("DEC-ccccccc"), "Step 3: outside-window entry preserved");
    assert(log.includes(oldTs), "Step 3: original 3h-old timestamp survives");
    console.log("  ✓ Step 3 — Outside-window entries preserved");
  }

  // ── Step 4 — Cite already hand-removed → already-reverted ───────
  {
    const repoRoot = mkRepoRoot();
    seedAcceptedDec(repoRoot, "DEC-ddddddd", seedBody);
    writeFile(repoRoot, "src/db.ts", verbatimSource);
    commitAll(repoRoot);
    await alignFile({ repoRoot, filePath: "src/db.ts", sessionId: null });

    // Operator hand-edits the cite away.
    writeFile(
      repoRoot,
      "src/db.ts",
      "// operator wiped the cite\nexport function db() {}\n",
    );

    const result = await runAttentionUndo({ repoRoot });
    assert(result.alreadyReverted === 1, `Step 4: alreadyReverted=1, got ${result.alreadyReverted}`);
    assert(result.reverted === 0, "Step 4: nothing to revert");
    console.log("  ✓ Step 4 — Hand-edited cite reports already-reverted");
  }

  // ── Step 5 — Tier 3 creation → not-supported ────────────────────
  {
    const repoRoot = mkRepoRoot();
    appendUndoFixture(repoRoot, {
      ts: new Date().toISOString(),
      session_id: null,
      kind: "tier3-creation",
      file: "src/novel.ts",
      start_offset: 0,
      end_offset: 100,
      original_raw: "/** novel block */",
      replacement: "// §DEC-eeeeeee",
      primary_id: "DEC-eeeeeee",
      primary_kind: "DEC",
    });
    const result = await runAttentionUndo({ repoRoot });
    assert(result.notSupported === 1, `Step 5: notSupported=1, got ${result.notSupported}`);
    assert(result.reverted === 0, "Step 5: not reverted");
    const log = readFileSync(alignUndoLogPath(repoRoot), "utf8");
    assert(log.includes("tier3-creation"), "Step 5: not-supported entry kept in log");
    console.log("  ✓ Step 5 — tier3-creation reported not-supported, kept in log");
  }

  // ── Step 6 — Dry-run preserves source + log ─────────────────────
  {
    const repoRoot = mkRepoRoot();
    seedAcceptedDec(repoRoot, "DEC-fffffff", seedBody);
    writeFile(repoRoot, "src/db.ts", verbatimSource);
    commitAll(repoRoot);
    await alignFile({ repoRoot, filePath: "src/db.ts", sessionId: null });

    const beforeSource = readFileSync(join(repoRoot, "src/db.ts"), "utf8");
    const beforeLog = readFileSync(alignUndoLogPath(repoRoot), "utf8");
    const result = await runAttentionUndo({ repoRoot, dryRun: true });
    const afterSource = readFileSync(join(repoRoot, "src/db.ts"), "utf8");
    const afterLog = readFileSync(alignUndoLogPath(repoRoot), "utf8");
    assert(afterSource === beforeSource, "Step 6: source unchanged on dry-run");
    assert(afterLog === beforeLog, "Step 6: log unchanged on dry-run");
    assert(result.outcomes.length === 1, "Step 6: classification still runs");
    assert(result.outcomes[0]!.status === "reverted", "Step 6: classification says it WOULD revert");
    console.log("  ✓ Step 6 — Dry-run leaves source and log untouched");
  }

  cleanup();
  console.log("smoke-attention-undo — OK");
}

main().catch((err) => {
  console.error("smoke-attention-undo — fail:", err);
  cleanup();
  process.exit(1);
});

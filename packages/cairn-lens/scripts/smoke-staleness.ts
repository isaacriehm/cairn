#!/usr/bin/env tsx
/**
 * smoke-staleness — Lens `⚑` staleness flag (plan §10.4).
 *
 * The decoration provider's `vscode` integration can't run outside the
 * editor, but the underlying `readPendingStalenessIds` reader is
 * vscode-free and carries the entire signal: which DEC / INV ids does
 * the workspace's `.cairn/staleness/log.jsonl` reference. The smoke
 * exercises the reader against a few common shapes.
 *
 *   Step 1 — Missing log → empty set.
 *   Step 2 — Single drift event with `dec_id` → set has one id.
 *   Step 3 — Multiple events referencing the same id → deduped to one.
 *   Step 4 — Mixed events (with + without `dec_id`) → only entries
 *            carrying an id contribute.
 *   Step 5 — Malformed JSON line → skipped, surrounding lines parsed.
 *   Step 6 — Empty / whitespace-only file → empty set, no throw.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPendingStalenessIds } from "../src/staleness.js";

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
  const dir = mkdtempSync(join(tmpdir(), "cairn-lens-stale-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn", "staleness"), { recursive: true });
  return dir;
}

function writeLog(repoRoot: string, lines: string[]): void {
  writeFileSync(
    join(repoRoot, ".cairn", "staleness", "log.jsonl"),
    `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`,
    "utf8",
  );
}

function entry(decId: string | null, kind = "doc-drift"): string {
  const obj: Record<string, unknown> = {
    ts: "2026-05-06T00:00:00Z",
    kind,
    path: "src/x.ts",
    severity: "soft",
  };
  if (decId !== null) obj.dec_id = decId;
  return JSON.stringify(obj);
}

function main(): void {
  console.log("smoke-staleness — start");

  // ── Step 1 — Missing log ────────────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    // Note: mkRepoRoot creates the dir but no log file inside.
    const ids = readPendingStalenessIds(repoRoot);
    assert(ids.size === 0, `Step 1: expected empty, got ${ids.size}`);
    console.log("  ✓ Step 1 — Missing log returns empty set");
  }

  // ── Step 2 — Single event with dec_id ───────────────────────────
  {
    const repoRoot = mkRepoRoot();
    writeLog(repoRoot, [entry("DEC-aaaaaaa")]);
    const ids = readPendingStalenessIds(repoRoot);
    assert(ids.size === 1, `Step 2: size=1, got ${ids.size}`);
    assert(ids.has("DEC-aaaaaaa"), "Step 2: id present");
    console.log("  ✓ Step 2 — Single dec_id event surfaces the id");
  }

  // ── Step 3 — Dedup repeated dec_id ──────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    writeLog(repoRoot, [
      entry("DEC-bbbbbbb"),
      entry("DEC-bbbbbbb", "orphan_path"),
      entry("DEC-bbbbbbb", "pre-commit-drift"),
    ]);
    const ids = readPendingStalenessIds(repoRoot);
    assert(ids.size === 1, `Step 3: dedup to 1, got ${ids.size}`);
    assert(ids.has("DEC-bbbbbbb"), "Step 3: id present");
    console.log("  ✓ Step 3 — Repeated dec_id deduped");
  }

  // ── Step 4 — Events with and without dec_id ─────────────────────
  {
    const repoRoot = mkRepoRoot();
    writeLog(repoRoot, [
      entry("DEC-ccccccc"),
      entry(null, "orphan_path"),
      entry("INV-1111111"),
      entry(null, "broken_link"),
    ]);
    const ids = readPendingStalenessIds(repoRoot);
    assert(ids.size === 2, `Step 4: 2 ids, got ${ids.size}`);
    assert(ids.has("DEC-ccccccc"), "Step 4: DEC present");
    assert(ids.has("INV-1111111"), "Step 4: INV present");
    console.log("  ✓ Step 4 — Mixed events: only entries with dec_id contribute");
  }

  // ── Step 5 — Malformed line skipped ─────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    writeLog(repoRoot, [
      entry("DEC-ddddddd"),
      "not valid json {{{",
      entry("DEC-eeeeeee"),
    ]);
    const ids = readPendingStalenessIds(repoRoot);
    assert(ids.size === 2, `Step 5: 2 ids around the malformed line, got ${ids.size}`);
    assert(ids.has("DEC-ddddddd") && ids.has("DEC-eeeeeee"), "Step 5: surrounding entries present");
    console.log("  ✓ Step 5 — Malformed JSON line skipped");
  }

  // ── Step 6 — Empty / whitespace file ────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    writeLog(repoRoot, []);
    const ids = readPendingStalenessIds(repoRoot);
    assert(ids.size === 0, `Step 6: empty file → 0, got ${ids.size}`);
    console.log("  ✓ Step 6 — Empty log returns empty set");
  }

  cleanup();
  console.log("smoke-staleness — OK");
}

try {
  main();
} catch (err) {
  console.error("smoke-staleness — fail:", err);
  cleanup();
  process.exit(1);
}

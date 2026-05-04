#!/usr/bin/env tsx
/**
 * smoke-query-history — runQueryHistory acceptance sensor.
 *
 * Pure-mechanical (no LLM burn): the summarizer override returns canned
 * output so the walker + post-resolution + caveat assembly are exercised
 * end-to-end without touching the claude subprocess.
 *
 *   1. No .archive/ → empty claims, caveat mentions "no .archive/".
 *   2. Empty .archive/ but no buckets → caveat mentions "0 buckets".
 *   3. Walker matches by path_hint glob; only matching files are
 *      forwarded to the summarizer.
 *   4. Date-window filter (since/until) narrows the matched set.
 *   5. summarizer_override receives the matched files; the response's
 *      claim count + canonical pointer resolution is correct:
 *      - superseded_by referencing an existing accepted DEC →
 *        currently_canonical_pointer set
 *      - superseded_by referencing a nonexistent DEC → both fields
 *        normalize to null
 *      - HISTORICAL_WARNING attached to every claim
 *   6. Walker capHit → truncated_walk = true + caveat mentions truncation.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runQueryHistory,
  type ArchiveFile,
} from "@devplusllc/harness-core";

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
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

function mkFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-smoke-query-history-"));
  cleanups.push(dir);
  return dir;
}

function seedArchive(repoRoot: string, files: { relPath: string; content: string }[]): void {
  for (const f of files) {
    const abs = join(repoRoot, f.relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, f.content, "utf8");
  }
}

function seedAcceptedDecision(repoRoot: string, id: string): void {
  const dir = join(repoRoot, ".harness", "ground", "decisions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.md`),
    `---
id: ${id}
title: Accepted decision ${id}
type: adr
status: accepted
audience: dual
generated: 2026-04-01T00:00:00Z
verified-at: 2026-05-04T00:00:00Z
decided_at: '2026-04-01'
scope_globs:
  - "core/src/**"
supersedes: null
superseded_by: null
assertions: []
---

# ${id}
`,
    "utf8",
  );
}

interface MockSummarizerInput {
  files: ArchiveFile[];
  acceptedDecisions: { id: string; title: string; scope_globs?: string[] }[];
}

function mockSummarizer(opts: { proposedSupersededBy?: string | null }): (input: MockSummarizerInput) => Promise<{
  claims: { claim: string; as_of: string; source_path: string; source_lines: string; superseded_by: string | null }[];
  summary_caveat: string;
  no_relevant_history: boolean;
  model: string;
}> {
  return async (input) => {
    const claims = input.files.map((f) => ({
      claim: `Historical content from ${f.relPath}`,
      as_of: f.archiveDate,
      source_path: f.relPath,
      source_lines: "1-10",
      superseded_by: opts.proposedSupersededBy ?? null,
    }));
    return {
      claims,
      summary_caveat: "Mock summarizer caveat.",
      no_relevant_history: false,
      model: "mock-haiku",
    };
  };
}

async function runSmoke(): Promise<void> {
  console.log("smoke-query-history — start");

  // ── Step 1 — no .archive/ at all ─────────────────────────────────
  {
    const repoRoot = mkFixture();
    const r = await runQueryHistory({
      repoRoot,
      scope: "anything",
      summarizerOverride: mockSummarizer({}),
    });
    assert(r.historical_only === true, "Step 1: historical_only !== true");
    assert(r.claims.length === 0, `Step 1: expected 0 claims, got ${r.claims.length}`);
    assert(r.walked_files === 0, "Step 1: walked_files should be 0");
    assert(r.walked_buckets.length === 0, "Step 1: walked_buckets should be empty");
    assert(
      r.summary_caveat.toLowerCase().includes("no .archive/"),
      `Step 1: caveat missing "no .archive/" wording: ${r.summary_caveat}`,
    );
    console.log("  ✓ Step 1 — no .archive/");
  }

  // ── Step 2 — .archive/ exists but empty (no buckets matched) ─────
  {
    const repoRoot = mkFixture();
    mkdirSync(join(repoRoot, ".archive", "2026-04-15-orphan"), { recursive: true });
    // Bucket dir present but no files.
    const r = await runQueryHistory({
      repoRoot,
      scope: "anything",
      summarizerOverride: mockSummarizer({}),
    });
    assert(r.claims.length === 0, "Step 2: expected 0 claims with empty buckets");
    assert(r.walked_buckets.includes("2026-04-15-orphan"), "Step 2: empty bucket should still be in walked_buckets");
    assert(
      r.summary_caveat.includes("No files matched"),
      `Step 2: caveat should mention no files matched, got: ${r.summary_caveat}`,
    );
    console.log("  ✓ Step 2 — empty buckets");
  }

  // ── Step 3 — path_hint filter narrows results ────────────────────
  {
    const repoRoot = mkFixture();
    seedArchive(repoRoot, [
      { relPath: ".archive/2026-04-15/auth.md", content: "# Old auth thinking\n\nLine 1.\nLine 2.\n" },
      { relPath: ".archive/2026-04-15/billing.md", content: "# Old billing thinking\n" },
      { relPath: ".archive/2026-04-22/auth.md", content: "# Newer auth notes\n" },
    ]);
    const r = await runQueryHistory({
      repoRoot,
      scope: "auth",
      pathHint: ".archive/**/auth.md",
      summarizerOverride: mockSummarizer({}),
    });
    assert(r.claims.length === 2, `Step 3: expected 2 auth claims, got ${r.claims.length}`);
    for (const c of r.claims) {
      assert(c.source_path.endsWith("auth.md"), `Step 3: non-auth claim slipped through: ${c.source_path}`);
      assert(c.warning.includes("HISTORICAL"), "Step 3: warning missing");
    }
    console.log("  ✓ Step 3 — path_hint filter");
  }

  // ── Step 4 — date-window filter ──────────────────────────────────
  {
    const repoRoot = mkFixture();
    seedArchive(repoRoot, [
      { relPath: ".archive/2026-03-01/old.md", content: "# Old\n" },
      { relPath: ".archive/2026-04-15/mid.md", content: "# Mid\n" },
      { relPath: ".archive/2026-05-04/new.md", content: "# New\n" },
    ]);
    const r = await runQueryHistory({
      repoRoot,
      scope: "anything",
      since: "2026-04-01",
      until: "2026-04-30",
      summarizerOverride: mockSummarizer({}),
    });
    assert(r.claims.length === 1, `Step 4: expected 1 claim in date window, got ${r.claims.length}`);
    assert(r.claims[0]?.source_path.endsWith("mid.md"), `Step 4: wrong file in window: ${r.claims[0]?.source_path}`);
    console.log("  ✓ Step 4 — date window");
  }

  // ── Step 5 — supersede pointer resolution ────────────────────────
  {
    const repoRoot = mkFixture();
    seedArchive(repoRoot, [
      { relPath: ".archive/2026-04-15/integ.md", content: "# Integ thinking\n" },
    ]);
    seedAcceptedDecision(repoRoot, "DEC-0001");
    // Mock proposes superseded_by = DEC-0001 (exists) → pointer set.
    const r1 = await runQueryHistory({
      repoRoot,
      scope: "integrations",
      summarizerOverride: mockSummarizer({ proposedSupersededBy: "DEC-0001" }),
    });
    assert(r1.claims.length === 1, "Step 5a: expected 1 claim");
    assert(r1.claims[0]?.superseded_by === "DEC-0001", `Step 5a: superseded_by should be DEC-0001, got ${r1.claims[0]?.superseded_by}`);
    assert(
      r1.claims[0]?.currently_canonical_pointer === ".harness/ground/decisions/DEC-0001.md",
      `Step 5a: pointer wrong, got ${r1.claims[0]?.currently_canonical_pointer}`,
    );

    // Mock proposes superseded_by = DEC-9999 (does NOT exist) → both null.
    const r2 = await runQueryHistory({
      repoRoot,
      scope: "integrations",
      summarizerOverride: mockSummarizer({ proposedSupersededBy: "DEC-9999" }),
    });
    assert(r2.claims[0]?.superseded_by === null, `Step 5b: nonexistent ref should resolve to null, got ${r2.claims[0]?.superseded_by}`);
    assert(r2.claims[0]?.currently_canonical_pointer === null, "Step 5b: pointer should be null");

    // Mock proposes a malformed id → null.
    const r3 = await runQueryHistory({
      repoRoot,
      scope: "integrations",
      summarizerOverride: mockSummarizer({ proposedSupersededBy: "not-a-dec-id" }),
    });
    assert(r3.claims[0]?.superseded_by === null, "Step 5c: malformed id should resolve to null");
    console.log("  ✓ Step 5 — supersede pointer resolution");
  }

  // ── Step 6 — walker cap → truncated_walk ─────────────────────────
  {
    const repoRoot = mkFixture();
    // Create > maxFiles default (40) entries to trigger the cap.
    const files: { relPath: string; content: string }[] = [];
    for (let i = 0; i < 50; i++) {
      files.push({
        relPath: `.archive/2026-04-15/file-${String(i).padStart(3, "0")}.md`,
        content: `# File ${i}\n${"x".repeat(64)}\n`,
      });
    }
    seedArchive(repoRoot, files);
    const r = await runQueryHistory({
      repoRoot,
      scope: "everything",
      summarizerOverride: mockSummarizer({}),
    });
    assert(r.truncated_walk === true, "Step 6: truncated_walk should be true at 50 files (default cap = 40)");
    assert(
      r.summary_caveat.toLowerCase().includes("walk truncated"),
      `Step 6: caveat should mention walk truncation, got: ${r.summary_caveat}`,
    );
    assert(r.walked_files <= 40, `Step 6: walked_files ${r.walked_files} exceeds default cap`);
    console.log("  ✓ Step 6 — walker cap");
  }

  console.log("smoke-query-history — pass");
}

(async () => {
  try {
    await runSmoke();
  } finally {
    cleanup();
  }
})();

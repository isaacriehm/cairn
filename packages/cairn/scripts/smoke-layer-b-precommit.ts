#!/usr/bin/env tsx
/**
 * smoke-layer-b-precommit — Layer B git pre-commit hook (plan §4.2).
 *
 * Detection-only. Never modifies the commit. The hook walks the
 * staged tree, runs the same Jaccard pre-filter + Tier 1 deterministic
 * check used by Layer A, and writes per-block records to
 * `.cairn/staleness/pre-commit-deferred.jsonl` (rich) and
 * `.cairn/staleness/log.jsonl` (lightweight `pre-commit-drift` events).
 * SessionStart Drain's SessionStart drain consumes both files.
 *
 *   Step 1 — Tier 1 verbatim duplicate: rich record + drift event
 *            written; staged source unchanged; tier=tier1.
 *   Step 2 — Tier 2/3 ambiguous (Jaccard ≥ 0.3 but Tier 1 floors not
 *            met): logged with tier=tier2-3 and full candidate list.
 *   Step 3 — Markdown staged file: skipped entirely (no log entry).
 *   Step 4 — Empty SoT cache (fresh adoption): no log entries even
 *            with verbatim-looking prose; nothing to compare against.
 *   Step 5 — Working tree differs from staged (partial `git add -p`):
 *            the staged blob is the one inspected, not the working
 *            tree (which has unstaged tweaks).
 *   Step 6 — Multiple staged files in a single hook invocation:
 *            both files contribute log entries.
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
import { execFileSync } from "node:child_process";
import {
  alignStagedTree,
  bindDec,
  bodyContentHash,
  emptySotBindings,
  emptySotCache,
  preCommitDeferredLogPath,
  readSotBindings,
  readSotCache,
  setSotCacheEntry,
  stalenessLogPath,
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
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-layerb-"));
  cleanups.push(dir);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: dir });
  mkdirSync(join(dir, ".cairn", "ground", "decisions"), { recursive: true });
  return dir;
}

function writeFile(repoRoot: string, rel: string, body: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function stage(repoRoot: string, ...paths: string[]): void {
  execFileSync("git", ["add", ...paths], { cwd: repoRoot });
}

function seedAcceptedDec(
  repoRoot: string,
  id: string,
  body: string,
  sotPath = "ledger",
): void {
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
    `sot_kind: ${sotPath === "ledger" ? "ledger" : "path"}`,
    `sot_path: ${sotPath}`,
    `sot_content_hash: ${bodyContentHash(body)}`,
    "capture_source: smoke",
    "---",
    "",
    body,
    "",
  ].join("\n");
  writeFile(repoRoot, `.cairn/ground/decisions/${id}.md`, fm);

  // Read-modify-write so seeding multiple DECs in one repo accumulates
  // entries instead of clobbering the prior write (Step 6 needs both).
  const bindingsExisting = (() => {
    try {
      return readSotBindings(repoRoot);
    } catch {
      return emptySotBindings();
    }
  })();
  writeSotBindings(repoRoot, bindDec(bindingsExisting, id, sotPath));

  const cacheExisting = (() => {
    try {
      return readSotCache(repoRoot);
    } catch {
      return emptySotCache();
    }
  })();
  writeSotCache(
    repoRoot,
    setSotCacheEntry(cacheExisting, id, {
      dec_id: id,
      sot_path: sotPath,
      body_hash: bodyContentHash(body),
      tokens: Array.from(tokenize(body, { codeAware: true })),
      shingles: [],
      mtime_ms: Date.now(),
    }),
  );
}

interface ParsedDeferred {
  ts: string;
  file: string;
  block_start_line: number;
  block_end_line: number;
  block_content_hash: string;
  block_prose: string;
  tier: "tier1" | "tier2-3";
  candidates: Array<{
    id: string;
    similarity: number;
    body_hash: string;
    sot_path: string;
  }>;
}

function readDeferredLog(repoRoot: string): ParsedDeferred[] {
  const path = preCommitDeferredLogPath(repoRoot);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) return [];
  return text.split("\n").map((line) => JSON.parse(line) as ParsedDeferred);
}

interface ParsedDrift {
  ts: string;
  kind: string;
  path: string;
  detail?: string;
  severity: string;
  dec_id?: string;
}

function readStalenessLog(repoRoot: string): ParsedDrift[] {
  const path = stalenessLogPath(repoRoot);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) return [];
  return text.split("\n").map((line) => JSON.parse(line) as ParsedDrift);
}

async function main(): Promise<void> {
  console.log("smoke-layer-b-precommit — start");

  // ── Step 1 — Tier 1 verbatim duplicate ──────────────────────────
  {
    const repoRoot = mkRepoRoot();
    const seedBody = [
      "We pin Postgres at version 15 because the legacy ETL job depends on its",
      "specific replication slot semantics. The team has tried 16 twice and rolled",
      "back both times. Revisit when the ETL job is rewritten.",
    ].join("\n");
    seedAcceptedDec(repoRoot, "DEC-aaaaaaa", seedBody);

    const source = [
      "/**",
      " * We pin Postgres at version 15 because the legacy ETL job depends on its",
      " * specific replication slot semantics. The team has tried 16 twice and rolled",
      " * back both times. Revisit when the ETL job is rewritten.",
      " */",
      "export function db() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/db.ts", source);
    stage(repoRoot, "src/db.ts");

    const before = readFileSync(join(repoRoot, "src/db.ts"), "utf8");
    const result = alignStagedTree({ repoRoot });
    const after = readFileSync(join(repoRoot, "src/db.ts"), "utf8");

    assert(after === before, "Step 1: staged source unchanged (Layer B never rewrites)");
    assert(result.tier1Matches === 1, `Step 1: tier1Matches=1, got ${result.tier1Matches}`);
    assert(result.tier23Matches === 0, `Step 1: tier23Matches=0, got ${result.tier23Matches}`);
    assert(result.filesScanned === 1, `Step 1: filesScanned=1, got ${result.filesScanned}`);

    const deferred = readDeferredLog(repoRoot);
    assert(deferred.length === 1, `Step 1: one deferred entry, got ${deferred.length}`);
    const entry = deferred[0]!;
    assert(entry.tier === "tier1", `Step 1: tier=tier1, got ${entry.tier}`);
    assert(entry.file === "src/db.ts", `Step 1: file=src/db.ts, got ${entry.file}`);
    assert(entry.candidates[0]?.id === "DEC-aaaaaaa", "Step 1: top candidate is seeded DEC");
    assert(entry.block_prose.includes("legacy ETL"), "Step 1: verbatim prose captured");
    assert(entry.block_content_hash.length === 12, "Step 1: 12-char content hash prefix");

    const drift = readStalenessLog(repoRoot);
    assert(drift.length === 1, `Step 1: one drift event, got ${drift.length}`);
    assert(drift[0]?.kind === "pre-commit-drift", "Step 1: drift kind=pre-commit-drift");
    assert(drift[0]?.dec_id === "DEC-aaaaaaa", "Step 1: drift dec_id stamped");
    console.log("  ✓ Step 1 — Tier 1 verbatim duplicate logged, source unchanged");
  }

  // ── Step 2 — Tier 2/3 ambiguous (Jaccard hit, Tier 1 floor missed) ──
  {
    const repoRoot = mkRepoRoot();
    const seedBody = [
      "Sign JWTs with HS512 not RS256 because deployment topology lacks key rotation",
      "infrastructure today. Revisit when KMS arrives.",
    ].join("\n");
    seedAcceptedDec(repoRoot, "DEC-bbbbbbb", seedBody);

    const source = [
      "/**",
      " * We sign tokens via HS512 instead of RS256 today. Topology has no key",
      " * rotation surface; KMS arrival reopens this. JWT auth path uses HS512.",
      " */",
      "export function sign() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/auth.ts", source);
    stage(repoRoot, "src/auth.ts");

    const result = alignStagedTree({ repoRoot });
    assert(result.tier1Matches === 0, `Step 2: tier1Matches=0, got ${result.tier1Matches}`);
    assert(result.tier23Matches === 1, `Step 2: tier23Matches=1, got ${result.tier23Matches}`);

    const deferred = readDeferredLog(repoRoot);
    assert(deferred.length === 1, `Step 2: one deferred entry, got ${deferred.length}`);
    assert(deferred[0]?.tier === "tier2-3", `Step 2: tier=tier2-3, got ${deferred[0]?.tier}`);
    assert(
      (deferred[0]?.candidates.length ?? 0) >= 1,
      "Step 2: candidate list populated for SessionStart Drain Haiku",
    );

    const drift = readStalenessLog(repoRoot);
    assert(drift[0]?.kind === "pre-commit-drift", "Step 2: drift kind=pre-commit-drift");
    console.log("  ✓ Step 2 — Tier 2/3 ambiguous logged with candidate list");
  }

  // ── Step 3 — Markdown staged file is skipped ────────────────────
  {
    const repoRoot = mkRepoRoot();
    const seedBody = [
      "We pin Postgres at version 15 because the legacy ETL job depends on its",
      "specific replication slot semantics. The team has tried 16 twice and rolled",
      "back both times. Revisit when the ETL job is rewritten.",
    ].join("\n");
    seedAcceptedDec(repoRoot, "DEC-ccccccc", seedBody);

    writeFile(
      repoRoot,
      "docs/db.md",
      "# Postgres pinning\n\nWe pin Postgres at version 15 because the legacy ETL job depends on its\nspecific replication slot semantics. The team has tried 16 twice and rolled\nback both times. Revisit when the ETL job is rewritten.\n",
    );
    stage(repoRoot, "docs/db.md");

    const result = alignStagedTree({ repoRoot });
    assert(result.filesScanned === 0, `Step 3: filesScanned=0 (md skipped), got ${result.filesScanned}`);
    assert(result.tier1Matches === 0, "Step 3: no tier1 hits");
    assert(readDeferredLog(repoRoot).length === 0, "Step 3: no deferred entries for markdown");
    assert(readStalenessLog(repoRoot).length === 0, "Step 3: no drift events for markdown");
    console.log("  ✓ Step 3 — Markdown staged file skipped (canonical doc, never auto-cited)");
  }

  // ── Step 4 — Empty SoT cache (fresh adoption) ───────────────────
  {
    const repoRoot = mkRepoRoot();
    // Empty cache — no DECs to compare against.
    writeSotCache(repoRoot, emptySotCache());
    writeSotBindings(repoRoot, emptySotBindings());

    const source = [
      "/**",
      " * Fresh prose that would otherwise be considered for capture, but",
      " * the SoT cache is empty so there is nothing to dedupe against.",
      " */",
      "export function fresh() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/fresh.ts", source);
    stage(repoRoot, "src/fresh.ts");

    const result = alignStagedTree({ repoRoot });
    assert(result.filesScanned === 0, "Step 4: empty cache short-circuits before scanning");
    assert(readDeferredLog(repoRoot).length === 0, "Step 4: no deferred entries");
    console.log("  ✓ Step 4 — Empty SoT cache short-circuits cleanly");
  }

  // ── Step 5 — Staged blob differs from working tree ──────────────
  {
    const repoRoot = mkRepoRoot();
    const seedBody = [
      "We pin Postgres at version 15 because the legacy ETL job depends on its",
      "specific replication slot semantics. The team has tried 16 twice and rolled",
      "back both times. Revisit when the ETL job is rewritten.",
    ].join("\n");
    seedAcceptedDec(repoRoot, "DEC-ddddddd", seedBody);

    // Stage version that DUPLICATES the seed.
    const stagedSource = [
      "/**",
      " * We pin Postgres at version 15 because the legacy ETL job depends on its",
      " * specific replication slot semantics. The team has tried 16 twice and rolled",
      " * back both times. Revisit when the ETL job is rewritten.",
      " */",
      "export function db() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/db.ts", stagedSource);
    stage(repoRoot, "src/db.ts");

    // Then mutate the working tree so it does NOT contain the duplicate prose.
    // If Layer B were reading the working tree, it would miss the drift.
    const workingSource = [
      "/**",
      " * Wholly unrelated prose that should not match the seeded DEC at all.",
      " * The operator made an unstaged tweak after `git add`-ing the duplicate.",
      " */",
      "export function db() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/db.ts", workingSource);

    const result = alignStagedTree({ repoRoot });
    assert(
      result.tier1Matches === 1,
      `Step 5: tier1Matches=1 (staged blob is what we scan), got ${result.tier1Matches}`,
    );
    const deferred = readDeferredLog(repoRoot);
    assert(deferred[0]?.candidates[0]?.id === "DEC-ddddddd", "Step 5: staged content drove the match");
    console.log("  ✓ Step 5 — Staged blob inspected even when working tree drifts");
  }

  // ── Step 6 — Multiple staged files in one invocation ────────────
  {
    const repoRoot = mkRepoRoot();
    const seedBodyA = [
      "We pin Postgres at version 15 because the legacy ETL job depends on its",
      "specific replication slot semantics. The team has tried 16 twice and rolled",
      "back both times. Revisit when the ETL job is rewritten.",
    ].join("\n");
    const seedBodyB = [
      "Background jobs run on BullMQ instead of Sidekiq because the runtime is",
      "Node-native and the Redis connection model matches existing infra. Sidekiq",
      "would have required a separate Ruby runtime which we do not operate.",
    ].join("\n");
    seedAcceptedDec(repoRoot, "DEC-eeeeeee", seedBodyA);
    seedAcceptedDec(repoRoot, "DEC-fffffff", seedBodyB);

    writeFile(
      repoRoot,
      "src/db.ts",
      [
        "/**",
        " * We pin Postgres at version 15 because the legacy ETL job depends on its",
        " * specific replication slot semantics. The team has tried 16 twice and rolled",
        " * back both times. Revisit when the ETL job is rewritten.",
        " */",
        "export function db() {}",
      ].join("\n") + "\n",
    );
    writeFile(
      repoRoot,
      "src/jobs.ts",
      [
        "/**",
        " * Background jobs run on BullMQ instead of Sidekiq because the runtime is",
        " * Node-native and the Redis connection model matches existing infra. Sidekiq",
        " * would have required a separate Ruby runtime which we do not operate.",
        " */",
        "export function jobs() {}",
      ].join("\n") + "\n",
    );
    stage(repoRoot, "src/db.ts", "src/jobs.ts");

    const result = alignStagedTree({ repoRoot });
    assert(result.filesScanned === 2, `Step 6: filesScanned=2, got ${result.filesScanned}`);
    assert(result.tier1Matches === 2, `Step 6: tier1Matches=2, got ${result.tier1Matches}`);
    const deferred = readDeferredLog(repoRoot);
    assert(deferred.length === 2, `Step 6: two deferred entries, got ${deferred.length}`);
    const ids = new Set(deferred.map((d) => d.candidates[0]?.id));
    assert(ids.has("DEC-eeeeeee"), "Step 6: db.ts entry cites DEC-eeeeeee");
    assert(ids.has("DEC-fffffff"), "Step 6: jobs.ts entry cites DEC-fffffff");
    console.log("  ✓ Step 6 — Multi-file staged invocation logs both blocks");
  }

  cleanup();
  console.log("smoke-layer-b-precommit — OK");
}

main().catch((err) => {
  console.error("smoke-layer-b-precommit — fail:", err);
  cleanup();
  process.exit(1);
});

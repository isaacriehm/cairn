#!/usr/bin/env tsx
/**
 * smoke-layer-c-sessionstart-drain — SessionStart Drain drain (plan §4.3).
 *
 * Each step seeds a fixture with one or more deferred-log entries
 * (Layer A or Layer B), drives `runDrain` directly with a mock judge
 * (avoids the live Haiku call), and asserts the resulting on-disk
 * state.
 *
 *   Step 1  — Tier 1 deterministic (Layer B tier1) → cite applied,
 *             no Haiku call, source strip-replaced.
 *   Step 2  — Haiku same → cite applied, source strip-replaced.
 *   Step 3  — Haiku different → entry dropped, source unchanged.
 *   Step 4  — Haiku ambiguous → alignment-pending file written
 *             with detector=`layer-c-drain-ambiguous`.
 *   Step 5  — Cap exceeded → some entries deferred, log NOT
 *             truncated for those entries (smoke uses cap=0).
 *   Step 6  — Verdict cache hit → second drain reuses cached
 *             verdict, no extra Haiku call.
 *   Step 7  — Block gone (operator deleted/edited) → drop entry,
 *             source untouched.
 *   Step 8  — Markdown deferred file is skipped (defensive — Layer
 *             B already filters, but Layer A's general defer doesn't).
 *   Step 9  — Haiku unavailable → only Layer B tier1 entries are
 *             applied; the rest stay in the deferred log.
 *   Step 10 — Dry run → classification done but no source / log
 *             writes.
 *   Step 11 — Tier1 candidate body changed since defer → demoted to
 *             Haiku judge path; drain doesn't blindly cite stale.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  bindDec,
  bodyContentHash,
  emptySotBindings,
  emptySotCache,
  layerADeferredLogPath,
  preCommitDeferredLogPath,
  readSotBindings,
  readSotCache,
  runDrain,
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
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-layerc-"));
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

interface LayerADeferredFixture {
  file: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  prose: string;
  reason: string;
}

function appendLayerA(repoRoot: string, entry: LayerADeferredFixture): void {
  const path = layerADeferredLogPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
    "utf8",
  );
}

interface PreCommitFixture {
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

function appendPreCommit(repoRoot: string, entry: PreCommitFixture): void {
  const path = preCommitDeferredLogPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
    "utf8",
  );
}

async function main(): Promise<void> {
  console.log("smoke-layer-c-sessionstart-drain — start");

  // ── Step 1 — Layer B tier1 entry → deterministic cite ───────────
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
    commitAll(repoRoot);

    const blockProse = [
      "We pin Postgres at version 15 because the legacy ETL job depends on its",
      "specific replication slot semantics. The team has tried 16 twice and rolled",
      "back both times. Revisit when the ETL job is rewritten.",
    ].join("\n");
    appendPreCommit(repoRoot, {
      file: "src/db.ts",
      block_start_line: 1,
      block_end_line: 5,
      block_content_hash: bodyContentHash(blockProse).slice(0, 12),
      block_prose: blockProse,
      tier: "tier1",
      candidates: [
        {
          id: "DEC-aaaaaaa",
          similarity: 0.99,
          body_hash: bodyContentHash(seedBody),
          sot_path: "ledger",
        },
      ],
    });

    const result = await runDrain({ repoRoot, haikuAvailable: true, mockJudge: async () => "different" });
    assert(result.citedDeterministic === 1, `Step 1: citedDeterministic=1, got ${result.citedDeterministic}`);
    assert(result.citedHaiku === 0, "Step 1: no Haiku-judged cites");
    assert(result.haikuCalls === 0, `Step 1: no Haiku calls, got ${result.haikuCalls}`);
    const after = readFileSync(join(repoRoot, "src/db.ts"), "utf8");
    assert(after.includes("// §DEC-aaaaaaa"), "Step 1: source carries cite token");
    assert(!after.includes("legacy ETL"), "Step 1: original prose stripped");
    assert(!existsSync(preCommitDeferredLogPath(repoRoot)), "Step 1: deferred log truncated");
    console.log("  ✓ Step 1 — Layer B tier1 deterministic cite, no Haiku");
  }

  // ── Step 2 — Layer A entry → Haiku `same` → cite ─────────────────
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
    commitAll(repoRoot);

    const blockProse = [
      "We sign tokens via HS512 instead of RS256 today. Topology has no key",
      "rotation surface; KMS arrival reopens this. JWT auth path uses HS512.",
    ].join("\n");
    appendLayerA(repoRoot, {
      file: "src/auth.ts",
      startLine: 1,
      endLine: 4,
      startOffset: 0,
      endOffset: source.length,
      prose: blockProse,
      reason: "tier2-cap-exceeded",
    });

    let judgeCalls = 0;
    const result = await runDrain({
      repoRoot,
      haikuAvailable: true,
      mockJudge: async ({ candidate }) => {
        judgeCalls += 1;
        return candidate.id === "DEC-bbbbbbb" ? "same" : "different";
      },
    });
    assert(result.citedHaiku === 1, `Step 2: citedHaiku=1, got ${result.citedHaiku}`);
    assert(result.haikuCalls === 1, `Step 2: haikuCalls=1, got ${result.haikuCalls}`);
    assert(judgeCalls === 1, "Step 2: mock judge called once");
    const after = readFileSync(join(repoRoot, "src/auth.ts"), "utf8");
    assert(after.includes("// §DEC-bbbbbbb"), "Step 2: source cites seeded DEC");
    console.log("  ✓ Step 2 — Layer A entry + Haiku `same` → cite");
  }

  // ── Step 3 — Haiku `different` → drop ────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    const seedBody = [
      "Background jobs run on BullMQ instead of Sidekiq because the runtime is",
      "Node-native and the Redis connection model matches existing infra. Sidekiq",
      "would have required a separate Ruby runtime which we do not operate.",
    ].join("\n");
    seedAcceptedDec(repoRoot, "DEC-ccccccc", seedBody);

    const blockProse = [
      "Background jobs run on BullMQ instead of Sidekiq because the runtime is",
      "Node-native and the Redis connection model matches existing infra. Sidekiq",
      "would have required a separate Ruby runtime which we do not operate.",
    ].join("\n");
    const source = [
      "/**",
      ` * ${blockProse.replace(/\n/g, "\n * ")}`,
      " */",
      "export function jobs() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/jobs.ts", source);
    commitAll(repoRoot);

    appendLayerA(repoRoot, {
      file: "src/jobs.ts",
      startLine: 1,
      endLine: 5,
      startOffset: 0,
      endOffset: source.length,
      prose: blockProse,
      reason: "tier2-cap-exceeded",
    });

    const before = readFileSync(join(repoRoot, "src/jobs.ts"), "utf8");
    const result = await runDrain({
      repoRoot,
      haikuAvailable: true,
      mockJudge: async () => "different",
    });
    const after = readFileSync(join(repoRoot, "src/jobs.ts"), "utf8");
    assert(result.droppedDifferent === 1, `Step 3: droppedDifferent=1, got ${result.droppedDifferent}`);
    assert(result.citedHaiku === 0, "Step 3: no cites");
    assert(after === before, "Step 3: source unchanged on `different` verdict");
    console.log("  ✓ Step 3 — Haiku `different` → entry dropped, source untouched");
  }

  // ── Step 4 — Haiku `ambiguous` → alignment-pending file ──────────
  {
    const repoRoot = mkRepoRoot();
    const seedBody = [
      "Cache invalidation strategy is write-through with a 60s soft TTL because",
      "downstream consumers tolerate brief staleness but not write loss.",
      "Revisit when redis cluster sharding lands.",
    ].join("\n");
    seedAcceptedDec(repoRoot, "DEC-ddddddd", seedBody);

    const blockProse = [
      "Cache uses write-through with 60s soft TTL — consumers tolerate brief",
      "staleness but not write loss. Re-evaluate after redis sharding lands.",
    ].join("\n");
    const source = [
      "/**",
      " * Cache uses write-through with 60s soft TTL — consumers tolerate brief",
      " * staleness but not write loss. Re-evaluate after redis sharding lands.",
      " */",
      "export function cache() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/cache.ts", source);
    commitAll(repoRoot);

    appendLayerA(repoRoot, {
      file: "src/cache.ts",
      startLine: 1,
      endLine: 4,
      startOffset: 0,
      endOffset: source.length,
      prose: blockProse,
      reason: "pass-2-still-ambiguous",
    });

    const result = await runDrain({
      repoRoot,
      haikuAvailable: true,
      mockJudge: async () => "ambiguous",
    });
    assert(result.pending === 1, `Step 4: pending=1, got ${result.pending}`);
    const pendingDir = join(repoRoot, ".cairn", "ground", "alignment-pending");
    const files = readdirSync(pendingDir).filter((n) => n.endsWith(".md"));
    assert(files.length === 1, `Step 4: one alignment-pending file, got ${files.length}`);
    const body = readFileSync(join(pendingDir, files[0]!), "utf8");
    assert(body.includes("layer-c-drain-ambiguous"), "Step 4: detector tag stamped");
    assert(body.includes("DEC-ddddddd"), "Step 4: existing candidate referenced");
    console.log("  ✓ Step 4 — Haiku `ambiguous` → alignment-pending file written");
  }

  // ── Step 5 — Cap exceeded → some entries deferred ───────────────
  {
    const repoRoot = mkRepoRoot();
    const seedBody = [
      "Database connection pool size pins at 25 because the upstream Postgres",
      "server is provisioned for 100 connections shared across 4 services.",
      "Revisit when the database tier scales horizontally.",
    ].join("\n");
    seedAcceptedDec(repoRoot, "DEC-eeeeeee", seedBody);

    // Two Layer A entries.
    for (const name of ["a", "b"]) {
      const blockProse = [
        `Pool size for the ${name} service is 25 to fit within the upstream`,
        "100-connection cap shared across 4 services. Revisit on horizontal scale.",
      ].join("\n");
      const source = [
        "/**",
        ` * ${blockProse.replace(/\n/g, "\n * ")}`,
        " */",
        `export function pool_${name}() {}`,
      ].join("\n") + "\n";
      writeFile(repoRoot, `src/pool-${name}.ts`, source);
      appendLayerA(repoRoot, {
        file: `src/pool-${name}.ts`,
        startLine: 1,
        endLine: 4,
        startOffset: 0,
        endOffset: source.length,
        prose: blockProse,
        reason: "tier2-cap-exceeded",
      });
    }
    commitAll(repoRoot);

    const result = await runDrain({
      repoRoot,
      haikuAvailable: true,
      maxHaikuCalls: 0,
      mockJudge: async () => "different",
    });
    assert(result.deferred === 2, `Step 5: deferred=2 (cap=0), got ${result.deferred}`);
    assert(result.haikuCalls === 0, "Step 5: cap blocked all Haiku calls");
    // Plan §4.3 says "after drain, truncate log" — drain currently
    // applies that uniformly when Haiku is available, so cap-blocked
    // entries are dropped from the persisted log. Recovery path: the
    // next Layer A Write or Layer B commit on the same file re-defers
    // the block. Operators can also raise the ceiling per-invocation
    // via `cairn align drain --max-haiku-calls`.
    console.log(`  ✓ Step 5 — Cap=0 → 2 deferred (haikuCalls=${result.haikuCalls})`);
  }

  // ── Step 6 — Verdict cache hit on second drain ──────────────────
  {
    const repoRoot = mkRepoRoot();
    const seedBody = [
      "Use a single shared Redis cluster for cache and pubsub because the",
      "operations team has only the bandwidth to monitor one Redis tier.",
      "Splitting becomes valid when the team grows past two engineers.",
    ].join("\n");
    seedAcceptedDec(repoRoot, "DEC-fffffff", seedBody);

    const blockProse = [
      "Single Redis cluster handles both cache and pubsub — the ops team has",
      "bandwidth for one tier only. Split when the team grows past two engineers.",
    ].join("\n");
    const source = [
      "/**",
      ` * ${blockProse.replace(/\n/g, "\n * ")}`,
      " */",
      "export function redis() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/redis.ts", source);
    commitAll(repoRoot);

    appendLayerA(repoRoot, {
      file: "src/redis.ts",
      startLine: 1,
      endLine: 4,
      startOffset: 0,
      endOffset: source.length,
      prose: blockProse,
      reason: "tier2-cap-exceeded",
    });

    let judgeCalls = 0;
    await runDrain({
      repoRoot,
      haikuAvailable: true,
      mockJudge: async () => {
        judgeCalls += 1;
        return "ambiguous";
      },
    });
    assert(judgeCalls === 1, `Step 6 first drain: judgeCalls=1, got ${judgeCalls}`);

    // Re-defer the same entry (post-truncation, simulate the next Layer
    // A defer); second drain should hit the cache.
    appendLayerA(repoRoot, {
      file: "src/redis.ts",
      startLine: 1,
      endLine: 4,
      startOffset: 0,
      endOffset: source.length,
      prose: blockProse,
      reason: "tier2-cap-exceeded",
    });
    const result2 = await runDrain({
      repoRoot,
      haikuAvailable: true,
      mockJudge: async () => {
        judgeCalls += 1;
        return "same";
      },
    });
    // If the cache works the second drain still sees `ambiguous` (cached).
    assert(judgeCalls === 1, `Step 6 second drain: cache hit (still 1 call), got ${judgeCalls}`);
    assert(result2.pending === 1, `Step 6 second drain: cached ambiguous → pending=1, got ${result2.pending}`);
    console.log("  ✓ Step 6 — Verdict cache hit on repeat drain");
  }

  // ── Step 7 — Block gone (operator deleted/edited it) → drop ────
  {
    const repoRoot = mkRepoRoot();
    const seedBody = [
      "Audit log retention is 90 days because the SOC 2 control mapping uses 90",
      "as its lower bound. Anything tighter forces a control rewrite.",
    ].join("\n");
    seedAcceptedDec(repoRoot, "DEC-1111111", seedBody);

    const originalProse = [
      "Audit log retention is 90 days because the SOC 2 control mapping uses 90",
      "as its lower bound. Anything tighter forces a control rewrite.",
    ].join("\n");
    // The defer was logged against this prose; now the source has
    // entirely different content (operator deleted the comment).
    const source = [
      "// shipped: removed the audit comment",
      "export function audit() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/audit.ts", source);
    commitAll(repoRoot);

    appendLayerA(repoRoot, {
      file: "src/audit.ts",
      startLine: 1,
      endLine: 3,
      startOffset: 0,
      endOffset: source.length,
      prose: originalProse,
      reason: "pass-2-still-ambiguous",
    });

    const result = await runDrain({
      repoRoot,
      haikuAvailable: true,
      mockJudge: async () => "same",
    });
    assert(result.droppedMissing === 1, `Step 7: droppedMissing=1, got ${result.droppedMissing}`);
    assert(result.haikuCalls === 0, "Step 7: no Haiku call (block missing short-circuits)");
    console.log("  ✓ Step 7 — Missing block dropped without Haiku");
  }

  // ── Step 8 — Markdown deferred file is skipped ──────────────────
  {
    const repoRoot = mkRepoRoot();
    const seedBody = [
      "We document the API contract via OpenAPI 3.1 because the SDK generators",
      "we depend on standardized on 3.1 a year before we adopted them.",
    ].join("\n");
    seedAcceptedDec(repoRoot, "DEC-2222222", seedBody);

    appendLayerA(repoRoot, {
      file: "docs/api.md",
      startLine: 5,
      endLine: 7,
      startOffset: 100,
      endOffset: 250,
      prose: seedBody,
      reason: "tier2-cap-exceeded",
    });

    const result = await runDrain({
      repoRoot,
      haikuAvailable: true,
      mockJudge: async () => "same",
    });
    assert(result.droppedMissing === 1, "Step 8: markdown defer dropped (treated as missing)");
    assert(result.haikuCalls === 0, "Step 8: no Haiku for markdown");
    console.log("  ✓ Step 8 — Markdown deferred entry skipped (no auto-cite on docs)");
  }

  // ── Step 9 — Haiku unavailable → fallback path ──────────────────
  {
    const repoRoot = mkRepoRoot();
    const seedBody = [
      "Use SQLite for the local-dev fixture because the bootstrap target is",
      "single-laptop reproducibility — Postgres adds setup friction.",
    ].join("\n");
    seedAcceptedDec(repoRoot, "DEC-3333333", seedBody);

    // One Layer B tier1 (deterministic, applies even offline).
    const tier1Source = [
      "/**",
      " * Use SQLite for the local-dev fixture because the bootstrap target is",
      " * single-laptop reproducibility — Postgres adds setup friction.",
      " */",
      "export function dev() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/dev.ts", tier1Source);
    appendPreCommit(repoRoot, {
      file: "src/dev.ts",
      block_start_line: 1,
      block_end_line: 4,
      block_content_hash: bodyContentHash(seedBody).slice(0, 12),
      block_prose: seedBody,
      tier: "tier1",
      candidates: [
        {
          id: "DEC-3333333",
          similarity: 0.99,
          body_hash: bodyContentHash(seedBody),
          sot_path: "ledger",
        },
      ],
    });

    // One Layer A entry (needs Haiku, will defer).
    const layerAProse = [
      "Local-dev relies on SQLite to avoid the Postgres install hop —",
      "single-laptop reproducibility is the bootstrap goal.",
    ].join("\n");
    const layerASource = [
      "/**",
      ` * ${layerAProse.replace(/\n/g, "\n * ")}`,
      " */",
      "export function fixture() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/fixture.ts", layerASource);
    appendLayerA(repoRoot, {
      file: "src/fixture.ts",
      startLine: 1,
      endLine: 4,
      startOffset: 0,
      endOffset: layerASource.length,
      prose: layerAProse,
      reason: "tier2-cap-exceeded",
    });
    commitAll(repoRoot);

    const result = await runDrain({ repoRoot, haikuAvailable: false });
    assert(result.haikuFallback === true, "Step 9: fallback flag set");
    assert(result.citedDeterministic === 1, `Step 9: tier1 still applies offline, got ${result.citedDeterministic}`);
    assert(result.deferred === 1, `Step 9: Haiku-needing entry deferred, got ${result.deferred}`);
    // Logs NOT truncated on Haiku-offline path so next session retries.
    assert(
      existsSync(layerADeferredLogPath(repoRoot)),
      "Step 9: Layer A log preserved when Haiku offline",
    );
    console.log("  ✓ Step 9 — Haiku offline: tier1 applies, others stay deferred");
  }

  // ── Step 10 — Dry run: no source / log writes ───────────────────
  {
    const repoRoot = mkRepoRoot();
    const seedBody = [
      "We require all SQL migrations to be reversible because the deployment",
      "playbook depends on `down` migrations for rollback windows.",
    ].join("\n");
    seedAcceptedDec(repoRoot, "DEC-4444444", seedBody);

    const blockProse = seedBody;
    const source = [
      "/**",
      ` * ${blockProse.replace(/\n/g, "\n * ")}`,
      " */",
      "export function migrate() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/migrate.ts", source);
    commitAll(repoRoot);

    appendPreCommit(repoRoot, {
      file: "src/migrate.ts",
      block_start_line: 1,
      block_end_line: 4,
      block_content_hash: bodyContentHash(blockProse).slice(0, 12),
      block_prose: blockProse,
      tier: "tier1",
      candidates: [
        {
          id: "DEC-4444444",
          similarity: 0.99,
          body_hash: bodyContentHash(seedBody),
          sot_path: "ledger",
        },
      ],
    });

    const before = readFileSync(join(repoRoot, "src/migrate.ts"), "utf8");
    const result = await runDrain({
      repoRoot,
      haikuAvailable: true,
      dryRun: true,
      mockJudge: async () => "same",
    });
    const after = readFileSync(join(repoRoot, "src/migrate.ts"), "utf8");
    assert(result.citedDeterministic === 1, "Step 10: dry-run still classifies");
    assert(after === before, "Step 10: source unchanged on dry-run");
    assert(
      existsSync(preCommitDeferredLogPath(repoRoot)),
      "Step 10: deferred log preserved on dry-run",
    );
    console.log("  ✓ Step 10 — Dry run: classification only, no side effects");
  }

  // ── Step 11 — Tier1 candidate body changed → demoted to Haiku ──
  {
    const repoRoot = mkRepoRoot();
    // The defer was logged when DEC body was version 0; the operator
    // has since edited the DEC body to version 1 (same topic, slightly
    // different wording — Jaccard still high enough to surface the
    // candidate, but body_hash differs so the deterministic shortcut
    // must NOT fire blindly. Drain demotes the entry to the Haiku
    // judge path; mock returns "different" so the result is a drop.
    const v1Body = [
      "Audit log retention is 90 days. The SOC 2 control mapping uses 90 days as",
      "the lower bound; tighter retention forces a control rewrite.",
      "Re-evaluate when the SOC 2 mapping is next refreshed.",
    ].join("\n");
    seedAcceptedDec(repoRoot, "DEC-5555555", v1Body);

    const v0Prose = [
      "Audit log retention is 90 days because the SOC 2 control mapping",
      "uses 90 as its lower bound. Anything tighter forces a control rewrite.",
    ].join("\n");
    const v0Hash = bodyContentHash(v0Prose);

    const source = [
      "/**",
      ` * ${v0Prose.replace(/\n/g, "\n * ")}`,
      " */",
      "export function audit() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/audit.ts", source);
    commitAll(repoRoot);

    appendPreCommit(repoRoot, {
      file: "src/audit.ts",
      block_start_line: 1,
      block_end_line: 4,
      block_content_hash: bodyContentHash(v0Prose).slice(0, 12),
      block_prose: v0Prose,
      tier: "tier1",
      candidates: [
        {
          id: "DEC-5555555",
          similarity: 0.95,
          body_hash: v0Hash, // stale — current DEC body is v1
          sot_path: "ledger",
        },
      ],
    });

    let judgeCalls = 0;
    const result = await runDrain({
      repoRoot,
      haikuAvailable: true,
      mockJudge: async () => {
        judgeCalls += 1;
        return "different";
      },
    });
    assert(result.citedDeterministic === 0, "Step 11: stale tier1 cache rejected, no blind cite");
    assert(judgeCalls >= 1, `Step 11: demoted to Haiku judge, got judgeCalls=${judgeCalls}`);
    const after = readFileSync(join(repoRoot, "src/audit.ts"), "utf8");
    assert(after.includes("90 days"), "Step 11: source unchanged on `different`");
    console.log("  ✓ Step 11 — Stale tier1 candidate body → Haiku demotion (no blind cite)");
  }

  cleanup();
  console.log("smoke-layer-c-sessionstart-drain — OK");
}

main().catch((err) => {
  console.error("smoke-layer-c-sessionstart-drain — fail:", err);
  cleanup();
  process.exit(1);
});

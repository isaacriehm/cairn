#!/usr/bin/env tsx
/**
 * smoke-fix-align — Layer D `cairn fix align` (plan §4.4).
 *
 *   Step 1 — Empty repo: no source files, preflight reports zero blocks.
 *   Step 2 — Tier 1 verbatim duplicate: apply auto-cites, source rewritten.
 *   Step 3 — Dry-run: preflight populated, no source / ledger writes.
 *   Step 4 — `--max-cost` exceeded → abort before Haiku spend.
 *   Step 5 — `--no-creation` → Tier 3 short-circuits as descriptive.
 *   Step 6 — `--include` filters the sweep down to a single subdir.
 *   Step 7 — `--exclude` excludes a subdir even when it matches include.
 *   Step 8 — Multi-file sweep applies cites across every matched file.
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
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  bindDec,
  bodyContentHash,
  emptySotBindings,
  emptySotCache,
  readSotBindings,
  readSotCache,
  runFixAlign,
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
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-fixalign-"));
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

async function main(): Promise<void> {
  console.log("smoke-fix-align — start");

  // ── Step 1 — Empty repo ─────────────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    writeSotCache(repoRoot, emptySotCache());
    writeSotBindings(repoRoot, emptySotBindings());
    const result = await runFixAlign({ repoRoot, dryRun: true });
    assert(result.preflight.filesScanned === 0, "Step 1: no source files");
    assert(result.preflight.blocksConsidered === 0, "Step 1: no blocks");
    assert(result.apply === null, "Step 1: dry-run skips apply");
    console.log("  ✓ Step 1 — Empty repo preflight clean");
  }

  // ── Step 2 — Tier 1 verbatim duplicate apply ────────────────────
  {
    const repoRoot = mkRepoRoot();
    seedAcceptedDec(repoRoot, "DEC-aaaaaaa", seedBody);
    writeFile(repoRoot, "src/db.ts", verbatimSource);
    commitAll(repoRoot);

    const result = await runFixAlign({ repoRoot });
    assert(result.preflight.blocksConsidered >= 1, "Step 2: preflight saw the block");
    assert(result.apply !== null, "Step 2: apply ran");
    assert(result.apply.tier1Aligned === 1, `Step 2: tier1=1, got ${result.apply.tier1Aligned}`);
    assert(result.apply.haikuCalls === 0, "Step 2: deterministic, no Haiku");
    const after = readFileSync(join(repoRoot, "src/db.ts"), "utf8");
    assert(after.includes("// §DEC-aaaaaaa"), "Step 2: source cite token");
    assert(!after.includes("legacy ETL"), "Step 2: original prose stripped");
    console.log("  ✓ Step 2 — Tier 1 verbatim duplicate applied");
  }

  // ── Step 3 — Dry-run preserves source / ledger ──────────────────
  {
    const repoRoot = mkRepoRoot();
    seedAcceptedDec(repoRoot, "DEC-bbbbbbb", seedBody);
    writeFile(repoRoot, "src/db.ts", verbatimSource);
    commitAll(repoRoot);

    const before = readFileSync(join(repoRoot, "src/db.ts"), "utf8");
    const result = await runFixAlign({ repoRoot, dryRun: true });
    const after = readFileSync(join(repoRoot, "src/db.ts"), "utf8");
    assert(after === before, "Step 3: source unchanged on dry-run");
    assert(result.preflight.blocksConsidered >= 1, "Step 3: preflight populated");
    assert(result.apply === null, "Step 3: apply did not run");
    console.log("  ✓ Step 3 — Dry-run leaves source intact");
  }

  // ── Step 4 — `--max-cost` aborts ────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    // Seed two DECs so preflight estimate is non-trivial.
    seedAcceptedDec(repoRoot, "DEC-ccccccc", seedBody);
    seedAcceptedDec(repoRoot, "DEC-ddddddd", seedBody.replace("Postgres", "MySQL"));

    // Stage a source file with prose only loosely matching DEC-c so
    // preflight estimates Pass-1 calls (Tier 2 territory). Use prose
    // that scores Jaccard ≥ 0.3 but doesn't pass the verbatim Tier 1
    // floors.
    const looseSource = [
      "/**",
      " * We pin Postgres at v15 because legacy ETL replication-slot semantics",
      " * depend on it; team rolled back v16 twice. Revisit after ETL rewrite.",
      " */",
      "export function db() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/db.ts", looseSource);
    commitAll(repoRoot);

    const result = await runFixAlign({ repoRoot, maxCost: 1 });
    assert(result.abortedOverBudget === true, "Step 4: aborted over budget");
    assert(result.apply === null, "Step 4: apply did not run after abort");
    console.log("  ✓ Step 4 — --max-cost abort skips Haiku spend");
  }

  // ── Step 5 — `--no-creation` short-circuits Tier 3 ──────────────
  {
    const repoRoot = mkRepoRoot();
    // Seed an unrelated DEC so the source block has no candidates and
    // would normally invoke Tier 3 creation.
    seedAcceptedDec(repoRoot, "DEC-eeeeeee", seedBody);

    const novelSource = [
      "/**",
      " * Use Argon2id with a memory cost of 64MB and a time cost of 3 because",
      " * the password vault threat model is offline-attack-dominant — bcrypt's",
      " * 1999 bound is no longer cost-effective on cloud GPUs.",
      " */",
      "export function hash() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/hash.ts", novelSource);
    commitAll(repoRoot);

    let creationCalls = 0;
    const result = await runFixAlign({
      repoRoot,
      skipCreation: true,
      mocks: {
        mockCreationJudgePass1: async () => {
          creationCalls += 1;
          return "decision";
        },
      },
    });
    assert(result.apply !== null, "Step 5: apply ran");
    assert(creationCalls === 0, "Step 5: skipCreation suppressed creation judge");
    assert(result.apply.decsCreated === 0, "Step 5: no fresh DECs");
    assert(result.apply.descriptive >= 1, "Step 5: novel block treated as descriptive");
    console.log("  ✓ Step 5 — --no-creation suppresses Tier 3 creation");
  }

  // ── Step 6 — `--include` scopes the sweep ───────────────────────
  {
    const repoRoot = mkRepoRoot();
    seedAcceptedDec(repoRoot, "DEC-fffffff", seedBody);
    writeFile(repoRoot, "src/db.ts", verbatimSource);
    writeFile(repoRoot, "lib/util.ts", verbatimSource);
    commitAll(repoRoot);

    const result = await runFixAlign({ repoRoot, include: ["src/**"] });
    assert(result.filesVisited.every((f) => f.startsWith("src/")), "Step 6: include scoped to src/");
    assert(result.apply !== null, "Step 6: apply ran");
    assert(result.apply.tier1Aligned === 1, `Step 6: tier1=1 (src only), got ${result.apply.tier1Aligned}`);
    const dbAfter = readFileSync(join(repoRoot, "src/db.ts"), "utf8");
    const utilAfter = readFileSync(join(repoRoot, "lib/util.ts"), "utf8");
    assert(dbAfter.includes("// §DEC-fffffff"), "Step 6: src/db.ts cited");
    assert(utilAfter.includes("legacy ETL"), "Step 6: lib/util.ts untouched");
    console.log("  ✓ Step 6 — --include scoped sweep to src/");
  }

  // ── Step 7 — `--exclude` overrides include match ────────────────
  {
    const repoRoot = mkRepoRoot();
    seedAcceptedDec(repoRoot, "DEC-1111111", seedBody);
    writeFile(repoRoot, "src/db.ts", verbatimSource);
    writeFile(repoRoot, "src/skip-me.ts", verbatimSource);
    commitAll(repoRoot);

    const result = await runFixAlign({
      repoRoot,
      include: ["src/**"],
      exclude: ["src/skip-me.ts"],
    });
    assert(
      !result.filesVisited.includes("src/skip-me.ts"),
      "Step 7: excluded path absent from sweep",
    );
    assert(result.filesVisited.includes("src/db.ts"), "Step 7: other src/ path included");
    const skipAfter = readFileSync(join(repoRoot, "src/skip-me.ts"), "utf8");
    assert(skipAfter.includes("legacy ETL"), "Step 7: excluded source untouched");
    console.log("  ✓ Step 7 — --exclude wins over --include");
  }

  // ── Step 8 — Multi-file sweep ───────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    seedAcceptedDec(repoRoot, "DEC-2222222", seedBody);
    seedAcceptedDec(
      repoRoot,
      "DEC-3333333",
      seedBody.replace("Postgres", "MySQL").replace("16", "8.0"),
    );

    writeFile(repoRoot, "src/pg.ts", verbatimSource);
    writeFile(
      repoRoot,
      "src/mysql.ts",
      verbatimSource.replace(/Postgres/g, "MySQL").replace(/16/g, "8.0"),
    );
    commitAll(repoRoot);

    const result = await runFixAlign({ repoRoot });
    assert(result.apply !== null, "Step 8: apply ran");
    assert(result.apply.filesAligned === 2, `Step 8: 2 files aligned, got ${result.apply.filesAligned}`);
    assert(result.apply.tier1Aligned === 2, `Step 8: 2 cites, got ${result.apply.tier1Aligned}`);
    assert(
      readFileSync(join(repoRoot, "src/pg.ts"), "utf8").includes("// §DEC-2222222"),
      "Step 8: pg.ts cites DEC-2222222",
    );
    assert(
      readFileSync(join(repoRoot, "src/mysql.ts"), "utf8").includes("// §DEC-3333333"),
      "Step 8: mysql.ts cites DEC-3333333",
    );
    console.log("  ✓ Step 8 — Multi-file sweep cites every matched file");
  }

  cleanup();
  console.log("smoke-fix-align — OK");
  // Defensive — ensure exit even if cleanup left handles open.
  if (existsSync("/dev/null")) process.exit(0);
}

main().catch((err) => {
  console.error("smoke-fix-align — fail:", err);
  cleanup();
  process.exit(1);
});

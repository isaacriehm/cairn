#!/usr/bin/env tsx
/**
 * smoke-invariants-prune — `cairn invariants prune` (CAIRN_ISSUES item 5, Q1=A).
 *
 * The pre-gate Layer A hook minted junk invariants from non-rule prose.
 * This sweep retires them. Contract:
 *
 *   Step 1 — surgical (default): archive ONLY sot-align invariants whose
 *            statement has no constraint shape. Real sot-align invariants
 *            (with a modal) are kept; curated invariants (other
 *            capture_source) are never touched. Junk lands in
 *            .cairn/ground/.archive/invariants/ and drops from the ledger.
 *   Step 2 — --all: archive every sot-align invariant; curated stay.
 *   Step 3 — --dry-run: report candidates, change nothing on disk.
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
import {
  bodyContentHash,
  buildInvariantsLedger,
  pruneInvariants,
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

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-inv-prune-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn", "ground", "invariants"), { recursive: true });
  return dir;
}

function seedInv(
  repoRoot: string,
  id: string,
  title: string,
  body: string,
  captureSource: string,
  sourceFile?: string,
): void {
  const fm = [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: invariant",
    "status: active",
    "audience: dual",
    "sot_kind: ledger",
    "sot_path: ledger",
    `sot_content_hash: ${bodyContentHash(body)}`,
    `capture_source: ${captureSource}`,
    ...(sourceFile !== undefined ? [`source_file: ${sourceFile}`] : []),
    "---",
    "",
    body,
    "",
  ].join("\n");
  writeFileSync(join(repoRoot, ".cairn", "ground", "invariants", `${id}.md`), fm, "utf8");
}

function writeSrc(repoRoot: string, rel: string, content: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/** The source file all seeded sot-align invariants were cited into. */
const SRC = "src/app/svc.ts";

function activeDir(repoRoot: string): string {
  return join(repoRoot, ".cairn", "ground", "invariants");
}
function archiveDir(repoRoot: string): string {
  return join(repoRoot, ".cairn", "ground", ".archive", "invariants");
}
function activeFiles(repoRoot: string): string[] {
  return readdirSync(activeDir(repoRoot)).filter((n) => n.endsWith(".md"));
}

// Stable ids (INV-<hash7+>).
const JUNK_SEP = "INV-aaaaaa1";   // title is a separator, body a banner
const JUNK_DESC = "INV-aaaaaa2";  // body is a plain description
const REAL_SOT = "INV-bbbbbb1";   // body has a modal — a genuine rule
const CURATED = "INV-cccccc1";    // non-sot-align source — out of scope

function seedAll(repoRoot: string): void {
  seedInv(repoRoot, JUNK_SEP, "Section divider", "──────────────────────────", "layer-a-sot-align", SRC);
  seedInv(repoRoot, JUNK_DESC, "Maps rows", "This adapter maps database rows onto the API user shape.", "layer-a-sot-align", SRC);
  seedInv(repoRoot, REAL_SOT, "Token expiry", "Tokens MUST expire after 15 minutes of inactivity.", "layer-a-sot-align", SRC);
  seedInv(repoRoot, CURATED, "Curated banner", "A curated entry whose body has no modal verb at all.", "init-source-comments");
  // The bare cites strip-replaced into source at mint time — one per
  // sot-align invariant. Pruning must expand the junk cites and keep REAL_SOT.
  writeSrc(
    repoRoot,
    SRC,
    [
      "export class Svc {",
      `  // §${JUNK_SEP}`,
      `  // §${JUNK_DESC}`,
      `  // §${REAL_SOT}`,
      "  run() {}",
      "}",
      "",
    ].join("\n"),
  );
}

function main(): void {
  console.log("smoke-invariants-prune — start");

  // ── Step 1 — surgical prune ──────────────────────────────────────
  {
    const repo = mkRepo();
    seedAll(repo);
    const r = pruneInvariants({ repoRoot: repo, mode: "surgical" });

    assert(r.scanned === 4, `Step 1: scanned 4, got ${r.scanned}`);
    assert(r.sotAlignTotal === 3, `Step 1: 3 sot-align eligible, got ${r.sotAlignTotal}`);
    const prunedIds = new Set(r.pruned.map((p) => p.id));
    assert(prunedIds.has(JUNK_SEP) && prunedIds.has(JUNK_DESC), "Step 1: both junk INVs pruned");
    assert(!prunedIds.has(REAL_SOT), "Step 1: real sot-align INV kept (has MUST)");
    assert(!prunedIds.has(CURATED), "Step 1: curated INV never eligible");
    assert(r.kept === 1, `Step 1: 1 eligible kept, got ${r.kept}`);

    const active = new Set(activeFiles(repo));
    assert(!active.has(`${JUNK_SEP}.md`) && !active.has(`${JUNK_DESC}.md`), "Step 1: junk removed from active dir");
    assert(active.has(`${REAL_SOT}.md`), "Step 1: real INV stays active");
    assert(active.has(`${CURATED}.md`), "Step 1: curated INV stays active");

    const archived = new Set(readdirSync(archiveDir(repo)).filter((n) => n.endsWith(".md")));
    assert(archived.has(`${JUNK_SEP}.md`) && archived.has(`${JUNK_DESC}.md`), "Step 1: junk moved to .archive/");
    const archivedBody = readFileSync(join(archiveDir(repo), `${JUNK_SEP}.md`), "utf8");
    assert(archivedBody.includes("status: archived"), "Step 1: archived copy flipped to status: archived");

    const ledger = buildInvariantsLedger({ repoRoot: repo });
    const ledgerIds = new Set(ledger.map((e) => e.id));
    assert(ledgerIds.has(REAL_SOT) && ledgerIds.has(CURATED), "Step 1: ledger keeps active INVs");
    assert(!ledgerIds.has(JUNK_SEP) && !ledgerIds.has(JUNK_DESC), "Step 1: ledger drops pruned INVs");

    // Source repair: junk cites expanded back to prose, REAL_SOT cite intact.
    assert(r.citesRepaired === 2, `Step 1: 2 cites repaired, got ${r.citesRepaired}`);
    assert(r.sourceFilesRepaired === 1, `Step 1: 1 source file repaired, got ${r.sourceFilesRepaired}`);
    const src = readFileSync(join(repo, SRC), "utf8");
    assert(!src.includes(`§${JUNK_SEP}`), "Step 1: separator cite expanded out of source");
    assert(!src.includes(`§${JUNK_DESC}`), "Step 1: description cite expanded out of source");
    assert(src.includes(`§${REAL_SOT}`), "Step 1: kept invariant's cite left in source");
    assert(src.includes("This adapter maps database rows"), "Step 1: pruned prose restored into source");
    console.log(`  ✓ Step 1 — surgical: pruned ${r.pruned.length} junk, repaired cites, kept real + curated`);
  }

  // ── Step 2 — --all prunes every sot-align INV, curated survives ──
  {
    const repo = mkRepo();
    seedAll(repo);
    const r = pruneInvariants({ repoRoot: repo, mode: "all" });
    const prunedIds = new Set(r.pruned.map((p) => p.id));
    assert(r.pruned.length === 3, `Step 2: all 3 sot-align pruned, got ${r.pruned.length}`);
    assert(prunedIds.has(REAL_SOT), "Step 2: --all archives even the real sot-align INV");
    assert(!prunedIds.has(CURATED), "Step 2: curated INV still never touched");
    const active = new Set(activeFiles(repo));
    assert(active.size === 1 && active.has(`${CURATED}.md`), "Step 2: only curated remains active");
    console.log("  ✓ Step 2 — --all archives all sot-align, curated survives");
  }

  // ── Step 3 — dry-run changes nothing ─────────────────────────────
  {
    const repo = mkRepo();
    seedAll(repo);
    const before = new Set(activeFiles(repo));
    const srcBefore = readFileSync(join(repo, SRC), "utf8");
    const r = pruneInvariants({ repoRoot: repo, mode: "surgical", dryRun: true });
    assert(r.dryRun === true, "Step 3: result marked dryRun");
    assert(r.pruned.length === 2, `Step 3: 2 candidates reported, got ${r.pruned.length}`);
    assert(r.citesRepaired === 2, `Step 3: 2 cites WOULD repair, got ${r.citesRepaired}`);
    const after = new Set(activeFiles(repo));
    assert(after.size === before.size, "Step 3: no files moved on dry-run");
    assert(!existsSync(archiveDir(repo)), "Step 3: no archive dir created on dry-run");
    assert(readFileSync(join(repo, SRC), "utf8") === srcBefore, "Step 3: source untouched on dry-run");
    console.log("  ✓ Step 3 — dry-run reports candidates + would-repair cites, mutates nothing");
  }

  cleanup();
  console.log("\nsmoke-invariants-prune — pass");
}

try {
  main();
} catch (err) {
  console.error("smoke-invariants-prune — fail");
  console.error(err);
  cleanup();
  process.exit(1);
}

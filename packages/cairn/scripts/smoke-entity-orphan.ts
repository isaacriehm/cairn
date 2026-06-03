#!/usr/bin/env tsx
/**
 * smoke-entity-orphan — entity retirement subsystem acceptance (real-FS).
 *
 * Builds an ephemeral adopted repo with five fixture entities and exercises
 * the full OUT path: detection → classification → archive → autonomous
 * retire-with-canary → manual archive.
 *
 *   1. runEntityOrphan classifies:
 *        INV-aaaaaaa  ledger, source gone, 0 cites      → SAFE
 *        INV-bbbbbbb  ledger, source present, 0 cites    → ambiguous
 *        INV-ccccccc  ledger, source present + live cite → survives
 *        DEC-ddddddd  path, doc gone                      → SAFE
 *        INV-eeeeeee  ledger, source gone, fresh (grace)  → skipped
 *   2. Surface-only retire (apply=false) mutates nothing; ambiguous surfaces.
 *   3. Apply retire (apply=true) archives the SAFE subset, commits, canary ok;
 *      cited entity survives in the active ledger.
 *   4. Manual archiveEntity retires a still-cited entity (operator override).
 */

import { execFileSync } from "node:child_process";
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
import {
  archiveEntity,
  buildDecisionsLedger,
  buildInvariantsLedger,
  parseFrontmatterRecord,
  runEntityOrphan,
  runEntityRetire,
} from "@isaacriehm/cairn-core";

const cleanups: string[] = [];
const HASH64 = "a".repeat(64);
const OLD = "2020-01-01T00:00:00.000Z";
const NOW = new Date("2026-05-01T00:00:00.000Z");
const FRESH = "2026-04-28T00:00:00.000Z"; // 3 days < 7-day grace

function header(msg: string): void {
  console.log(`\n── ${msg}`);
}
function fail(msg: string): never {
  console.error(`\n  ✗ ${msg}`);
  process.exit(1);
}
function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function invariant(
  dir: string,
  id: string,
  opts: { sotKind: string; sotPath: string; sourceFile?: string; generated: string },
): void {
  const fm = [
    `id: ${id}`,
    `title: ${id} fixture`,
    "type: invariant",
    "status: active",
    `generated: ${opts.generated}`,
    `sot_kind: ${opts.sotKind}`,
    `sot_path: ${opts.sotPath}`,
    `sot_content_hash: ${HASH64}`,
    ...(opts.sourceFile !== undefined ? [`source_file: ${opts.sourceFile}`] : []),
  ].join("\n");
  writeFileSync(join(dir, `${id}.md`), `---\n${fm}\n---\n\nBody of ${id}.\n`, "utf8");
}

function decision(
  dir: string,
  id: string,
  opts: { sotKind: string; sotPath: string; sourceFile?: string; generated: string },
): void {
  const fm = [
    `id: ${id}`,
    `title: ${id} fixture`,
    "type: adr",
    "status: accepted",
    `generated: ${opts.generated}`,
    `sot_kind: ${opts.sotKind}`,
    `sot_path: ${opts.sotPath}`,
    `sot_content_hash: ${HASH64}`,
    ...(opts.sourceFile !== undefined ? [`source_file: ${opts.sourceFile}`] : []),
  ].join("\n");
  writeFileSync(join(dir, `${id}.md`), `---\n${fm}\n---\n\nBody of ${id}.\n`, "utf8");
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cairn-smoke-orphan-"));
  cleanups.push(repo);
  const decDir = join(repo, ".cairn", "ground", "decisions");
  const invDir = join(repo, ".cairn", "ground", "invariants");
  const cfgDir = join(repo, ".cairn", "config");
  const srcDir = join(repo, "src");
  for (const d of [decDir, invDir, cfgDir, srcDir]) mkdirSync(d, { recursive: true });

  // Source files. `gone.ts` is intentionally NOT created.
  writeFileSync(join(srcDir, "present.ts"), "export const present = 1;\n", "utf8");
  writeFileSync(join(srcDir, "cited.ts"), "// §INV-ccccccc\nexport const cited = 1;\n", "utf8");

  // workflow.md — required by the GC canary.
  writeFileSync(
    join(cfgDir, "workflow.md"),
    "---\nname: smoke\n---\n\n# workflow\n",
    "utf8",
  );

  // Fixtures.
  invariant(invDir, "INV-aaaaaaa", { sotKind: "ledger", sotPath: "ledger", sourceFile: "src/gone.ts", generated: OLD });
  invariant(invDir, "INV-bbbbbbb", { sotKind: "ledger", sotPath: "ledger", sourceFile: "src/present.ts", generated: OLD });
  invariant(invDir, "INV-ccccccc", { sotKind: "ledger", sotPath: "ledger", sourceFile: "src/cited.ts", generated: OLD });
  invariant(invDir, "INV-eeeeeee", { sotKind: "ledger", sotPath: "ledger", sourceFile: "src/gone.ts", generated: FRESH });
  decision(decDir, "DEC-ddddddd", { sotKind: "path", sotPath: "docs/gone.md", generated: OLD });

  return repo;
}

function gitInit(repo: string): void {
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  };
  run(["init"]);
  run(["config", "user.email", "smoke@cairn.test"]);
  run(["config", "user.name", "cairn-smoke"]);
  run(["add", "-A"]);
  run(["commit", "-m", "fixtures"]);
}

function activeInvIds(repo: string): Set<string> {
  return new Set(buildInvariantsLedger({ repoRoot: repo }).map((e) => e.id));
}
function activeDecIds(repo: string): Set<string> {
  return new Set(buildDecisionsLedger({ repoRoot: repo }).map((e) => e.id));
}

async function main(): Promise<void> {
  console.log("smoke-entity-orphan — start");
  const repo = makeRepo();

  header("Step 1 — orphan classification");
  {
    const r = runEntityOrphan({ repoRoot: repo, now: NOW });
    const byId = new Map(r.orphans.map((o) => [o.id, o]));
    if (byId.get("INV-aaaaaaa")?.classification !== "safe") fail("aaaaaaa should be SAFE (source gone, 0 cites)");
    if (byId.get("INV-bbbbbbb")?.classification !== "ambiguous") fail("bbbbbbb should be ambiguous (source present, 0 cites)");
    if (byId.get("DEC-ddddddd")?.classification !== "safe") fail("ddddddd should be SAFE (doc gone)");
    if (byId.has("INV-ccccccc")) fail("ccccccc has a live §cite — must not be an orphan");
    if (byId.has("INV-eeeeeee")) fail("eeeeeee is within grace — must be skipped");
    if (r.orphans.length !== 3) fail(`expected 3 orphans, got ${r.orphans.length}`);
    pass("safe / ambiguous / survive / grace all classified correctly");
  }

  header("Step 2 — surface-only retire mutates nothing");
  {
    const r = await runEntityRetire({ repoRoot: repo, apply: false, now: NOW });
    if (r.retired.length !== 0) fail(`surface-only retired ${r.retired.length} (expected 0)`);
    if (r.surfaced.length !== 2) fail(`expected 2 safe surfaced, got ${r.surfaced.length}`);
    if (r.ambiguous.length !== 1) fail(`expected 1 ambiguous, got ${r.ambiguous.length}`);
    if (!existsSync(join(repo, ".cairn/ground/invariants/INV-aaaaaaa.md"))) fail("surface-only must not move aaaaaaa");
    pass("apply=false: nothing archived; safe+ambiguous surfaced");
  }

  header("Step 3 — apply retire archives the SAFE subset, canary ok, commit lands");
  {
    gitInit(repo);
    const r = await runEntityRetire({
      repoRoot: repo,
      apply: true,
      now: NOW,
      author: { name: "cairn-smoke", email: "smoke@cairn.test" },
    });
    const retiredIds = new Set(r.retired.map((x) => x.id));
    if (!retiredIds.has("INV-aaaaaaa") || !retiredIds.has("DEC-ddddddd")) fail(`expected aaaaaaa+ddddddd retired, got ${[...retiredIds].join(",")}`);
    if (r.retired.length !== 2) fail(`expected 2 retired, got ${r.retired.length}`);
    if (r.rolled_back) fail(`unexpected rollback: ${r.canary_failures.join("; ")}`);
    if (!r.canary_ok) fail(`canary failed: ${r.canary_failures.join("; ")}`);
    if (r.commit_sha === null) fail("expected a commit SHA");

    // Archived files exist with status=archived; sources dropped from active.
    const archInv = join(repo, ".cairn/ground/.archive/invariants/INV-aaaaaaa.md");
    if (!existsSync(archInv)) fail("INV-aaaaaaa not moved to archive");
    const fm = parseFrontmatterRecord(readFileSync(archInv, "utf8")).fm;
    if (fm["status"] !== "archived") fail(`archived status is ${String(fm["status"])}`);
    if (typeof fm["archived_at"] !== "string") fail("archived_at not stamped");
    if (existsSync(join(repo, ".cairn/ground/invariants/INV-aaaaaaa.md"))) fail("source INV-aaaaaaa still in active dir");
    if (!existsSync(join(repo, ".cairn/ground/.archive/decisions/DEC-ddddddd.md"))) fail("DEC-ddddddd not archived");

    const invIds = activeInvIds(repo);
    const decIds = activeDecIds(repo);
    if (invIds.has("INV-aaaaaaa")) fail("aaaaaaa still in active invariant ledger");
    if (!invIds.has("INV-ccccccc")) fail("ccccccc (cited) must survive in active ledger");
    if (decIds.has("DEC-ddddddd")) fail("ddddddd still in active decision ledger");
    pass("safe subset archived + committed; cited entity survives; canary ok");
  }

  header("Step 4 — manual archiveEntity retires a still-cited entity (override)");
  {
    const res = archiveEntity({ repoRoot: repo, id: "INV-ccccccc", reason: "manual smoke override" });
    if (!res.ok) fail(`manual archive failed: ${res.error ?? "?"}`);
    if (!existsSync(join(repo, ".cairn/ground/.archive/invariants/INV-ccccccc.md"))) fail("ccccccc not archived");
    if (activeInvIds(repo).has("INV-ccccccc")) fail("ccccccc still active after manual retire");
    pass("manual retire archives + drops from active ledger");
  }

  console.log("\nsmoke-entity-orphan — pass");
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    for (const dir of cleanups) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

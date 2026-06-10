#!/usr/bin/env tsx
/**
 * smoke-ghost-reanchor — content-hash block resolution + re-anchor (§3.5.1/§3.6).
 *
 * Ghost has no in-source `§` cite to move with the code, so a governed DEC/INV
 * is bound to the operator's *comment block*, keyed by its body hash. This
 * smoke proves the three behaviors that flip ghost liveness from coarse
 * (bound-file exists) to block-level:
 *
 *   1. resolveGhostBlock finds the block by hash → entity is LIVE → GC surfaces
 *      no orphan.
 *   2. block MOVED within the file (same hash, new lines) → still LIVE; the GC
 *      re-anchor pass refreshes the anchor-map `line_range`.
 *   3. comment DELETED while the file remains → resolveGhostBlock misses → GC
 *      surfaces an `ambiguous` orphan (the false-"live" the file-existence
 *      floor could never catch). Ghost never auto-retires it.
 *   + committed control: runGhostReanchor is a no-op (registry-absent repo).
 *
 * Isolation: `$HOME` points at a throwaway dir.
 *
 * Run: pnpm -F @isaacriehm/cairn smoke:ghost-reanchor
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failed += 1;
  }
}

const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;
const tmpHome = mkdtempSync(join(tmpdir(), "cairn-reanchor-home-"));
const repoRoot = mkdtempSync(join(tmpdir(), "cairn-reanchor-repo-"));
const plainRoot = mkdtempSync(join(tmpdir(), "cairn-reanchor-plain-"));

const REL = "src/money.ts";
const DECISION_COMMENT =
  "/**\n" +
  " * DECISION: All currency amounts are stored as integer minor units\n" +
  " * (cents), never floating point — this avoids rounding drift across the\n" +
  " * payment pipeline and keeps ledger reconciliation exact. Applies to\n" +
  " * every money field in the domain model and every DTO that crosses the\n" +
  " * API boundary. Floats accumulate error; integers stay exact + portable.\n" +
  " */\n";
const CODE_TAIL = "export const moneyIsInteger = true;\n";

function gitInit(dir: string): void {
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.email", "smoke@example.com");
  git("config", "user.name", "Smoke");
  writeFileSync(join(dir, "README.md"), `# ${dir}\n`, "utf8");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
}

async function main(): Promise<void> {
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  const {
    registerGhostRepo,
    walkSourceComments,
    bodyContentHash,
    invariantsDir,
    emptyAnchorMap,
    setAnchor,
    writeAnchorMap,
    readAnchorMap,
    writeScopeIndex,
    resolveGhostBlock,
    runGhostReanchor,
    runEntityOrphan,
  } = await import("@isaacriehm/cairn-core");

  gitInit(repoRoot);
  gitInit(plainRoot);
  registerGhostRepo(repoRoot);

  // Write the source file with the decision comment, then derive the EXACT
  // prose hash the way Layer A would, so the fixture lines up with the resolver.
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  const srcAbs = join(repoRoot, REL);
  writeFileSync(srcAbs, DECISION_COMMENT + CODE_TAIL, "utf8");

  const block0 = walkSourceComments({ repoRoot, onlyFiles: [REL] }).blocks[0];
  if (block0 === undefined) throw new Error("fixture comment did not pass the walker heuristic");
  const hash = bodyContentHash(block0.prose);
  const range0: [number, number] = [block0.startLine, block0.endLine];

  // Hand-author the ledger INV + its anchor + scope binding (what Layer A emit
  // would have written in ghost). `generated` is well outside the GC grace
  // window so the orphan pass actually evaluates it.
  const id = "INV-reanchor01";
  mkdirSync(invariantsDir(repoRoot), { recursive: true });
  const fm = [
    "---",
    `id: ${id}`,
    "title: money is integer minor units",
    "type: invariant",
    "status: active",
    "generated: 2020-01-01T00:00:00.000Z",
    "sot_kind: ledger",
    "sot_path: ledger",
    `sot_content_hash: ${hash}`,
    `source_file: ${REL}`,
    "---",
    "",
    "Money stored as integer minor units.",
    "",
  ].join("\n");
  writeFileSync(join(invariantsDir(repoRoot), `${id}.md`), fm, "utf8");

  let map = setAnchor(emptyAnchorMap(), "money-integer", {
    file: REL,
    content_hash: hash,
    line_range: range0,
    kind: "source-comment",
  });
  writeAnchorMap(repoRoot, map);
  writeScopeIndex(repoRoot, {
    generated: new Date().toISOString(),
    files: { [REL]: { decisions: [], invariants: [id] } },
  });

  /* ── 1. block intact → live → no orphan ────────────────────────────────── */
  const r0 = resolveGhostBlock(repoRoot, REL, hash);
  assert(r0.found === true, "resolveGhostBlock finds the intact block by hash");
  assert(
    runEntityOrphan({ repoRoot }).orphans.every((o) => o.id !== id),
    "GC surfaces NO orphan while the comment block resolves (live)",
  );

  /* ── 2. block moved → still live + re-anchor ───────────────────────────── */
  writeFileSync(srcAbs, "const a = 1;\nconst b = 2;\nconst c = 3;\n" + DECISION_COMMENT + CODE_TAIL, "utf8");
  const r1 = resolveGhostBlock(repoRoot, REL, hash);
  assert(r1.found === true, "block found after it moved down (content-hash, location-independent)");
  assert(
    r1.lineRange !== null && r1.lineRange[0] === range0[0] + 3,
    "resolved line range shifted by the inserted lines",
  );
  const re = runGhostReanchor(repoRoot);
  assert(re.reanchored === 1, "runGhostReanchor refreshed the moved entry");
  const movedEntry = readAnchorMap(repoRoot).anchors["money-integer"];
  assert(
    movedEntry?.line_range?.[0] === range0[0] + 3,
    "anchor-map line_range re-anchored to the new location",
  );
  assert(
    runGhostReanchor(repoRoot).reanchored === 0,
    "re-anchor is idempotent — second pass writes nothing",
  );
  assert(
    runEntityOrphan({ repoRoot }).orphans.every((o) => o.id !== id),
    "entity stays live after the block moved",
  );

  /* ── 3. comment deleted (file remains) → orphan ────────────────────────── */
  writeFileSync(srcAbs, "// unrelated\n" + CODE_TAIL, "utf8");
  assert(resolveGhostBlock(repoRoot, REL, hash).found === false, "block no longer resolves after deletion");
  const orphan = runEntityOrphan({ repoRoot }).orphans.find((o) => o.id === id);
  assert(orphan !== undefined, "GC surfaces the entity as an orphan once the comment is gone");
  assert(orphan?.classification === "ambiguous", "ghost orphan is `ambiguous` (never auto-retired)");

  /* ── 4. committed control — re-anchor is a pure no-op ──────────────────── */
  assert(runGhostReanchor(plainRoot).reanchored === 0, "runGhostReanchor no-ops on a non-ghost repo");
}

main()
  .catch((err) => {
    console.error(err);
    failed += 1;
  })
  .finally(() => {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realUserProfile;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(plainRoot, { recursive: true, force: true });
    if (failed > 0) {
      console.error(`smoke-ghost-reanchor — FAIL (${failed})`);
      process.exit(1);
    }
    console.log("smoke-ghost-reanchor — pass");
  });

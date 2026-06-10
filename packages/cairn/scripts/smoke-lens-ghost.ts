#!/usr/bin/env tsx
/**
 * smoke-lens-ghost — Cairn Lens ghost resolution (ghost-mode design, part 1).
 *
 * The lens used to find its state by walking up for an in-tree `.cairn/`. A
 * ghost repo has none — its state lives out-of-repo — so the resolver returned
 * null and the whole extension went inert. This asserts the ghost-aware
 * resolution + ghost-correct path routing (both vscode-free, so the smoke
 * exercises them directly off the built dist):
 *
 *   - `resolveRepoRoot` finds a ghost repo via the git toplevel + registry
 *     (even from a nested subdir, with NO in-tree `.cairn/`).
 *   - the resolver's ledger / scope-index / staleness paths resolve to the
 *     OUT-OF-REPO state home, never `<repoRoot>/.cairn`.
 *   - committed resolution is unchanged (walk-up wins); a non-adopted repo
 *     still resolves to null.
 *
 * Isolation: `$HOME` points at a throwaway dir (the ghost registry lives there).
 *
 * Run: pnpm -F @isaacriehm/cairn smoke:lens-ghost
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The lens resolver + staleness reader are deliberately vscode-free — import
// them straight from the built dist.
import { LensResolver } from "../../cairn-lens/dist/resolver.js";
import { readPendingStalenessIds } from "../../cairn-lens/dist/staleness.js";

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
const tmpHome = mkdtempSync(join(tmpdir(), "cairn-lens-home-"));
const ghostRepo = mkdtempSync(join(tmpdir(), "cairn-lens-ghost-"));
const committedRepo = mkdtempSync(join(tmpdir(), "cairn-lens-committed-"));
const plainRepo = mkdtempSync(join(tmpdir(), "cairn-lens-plain-"));

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
    cairnDir,
    emptyAnchorMap,
    setAnchor,
    writeAnchorMap,
    emptyTopicIndex,
    setTopic,
    writeTopicIndex,
  } = await import("@isaacriehm/cairn-core");

  const underHome = (p: string): boolean => p.startsWith(cairnDir(ghostRepo));
  const underRepo = (p: string): boolean => p.startsWith(join(ghostRepo, ".cairn"));

  /* ── Ghost repo — state out-of-repo, NO in-tree .cairn ──────────────────── */
  gitInit(ghostRepo);
  registerGhostRepo(ghostRepo);
  // Seed durable ground state out-of-repo (what a ghost session would write).
  mkdirSync(cairnDir(ghostRepo, "staleness"), { recursive: true });
  writeFileSync(
    cairnDir(ghostRepo, "staleness", "log.jsonl"),
    `${JSON.stringify({ dec_id: "DEC-abc1234", kind: "doc-drift" })}\n`,
    "utf8",
  );
  // A nested working dir the lens would activate from.
  const nested = join(ghostRepo, "src", "ui");
  mkdirSync(nested, { recursive: true });

  assert(!existsSync(join(ghostRepo, ".cairn")), "ghost repo has NO in-tree .cairn/");

  // Resolution from the repo root AND a nested subdir → the ghost repo root.
  // (git --show-toplevel canonicalizes symlinks — on macOS tmpdir that is the
  // /private-prefixed realpath — so compare against the canonical form.)
  const ghostReal = realpathSync(ghostRepo);
  assert(LensResolver.resolveRepoRoot(ghostRepo) === ghostReal, "resolveRepoRoot finds the ghost repo (git toplevel + registry)");
  assert(LensResolver.resolveRepoRoot(nested) === ghostReal, "resolveRepoRoot resolves a nested subdir to the ghost repo root");

  // Resolver paths land OUT-OF-REPO, never <repoRoot>/.cairn.
  const r = new LensResolver(ghostRepo);
  const invPath = r.invariantsLedgerFilePath();
  const decPath = r.decisionsLedgerFilePath();
  const scopePath = r.scopeIndexFilePath();
  assert(underHome(invPath) && !underRepo(invPath), "invariants ledger path resolves out-of-repo");
  assert(underHome(decPath) && !underRepo(decPath), "decisions ledger path resolves out-of-repo");
  assert(underHome(scopePath) && !underRepo(scopePath), "scope-index path resolves out-of-repo");

  // The staleness reader reads the out-of-repo log.
  const stale = readPendingStalenessIds(ghostRepo);
  assert(stale.has("DEC-abc1234"), "readPendingStalenessIds reads the out-of-repo staleness log");

  // Lens resolution never created an in-repo .cairn.
  assert(!existsSync(join(ghostRepo, ".cairn")), "ghost resolution created no in-repo .cairn/");

  /* ── Governed-blocks join (§3.7 part 2 — rendering source) ──────────────── */
  // Seed the external anchor-map (block → file + line_range) + topic-index
  // (slug → DEC/INV id). The lens derives governed ranges from these with NO
  // in-source `§` token — the join the decoration provider drives off in ghost.
  let am = emptyAnchorMap();
  am = setAnchor(am, "slug-dec", { file: "src/ui/Card.tsx", content_hash: "a".repeat(64), line_range: [10, 20], kind: "source-comment" });
  am = setAnchor(am, "slug-inv", { file: "src/ui/Card.tsx", content_hash: "b".repeat(64), line_range: [30, 35], kind: "source-comment" });
  am = setAnchor(am, "slug-other", { file: "src/ui/Other.tsx", content_hash: "c".repeat(64), line_range: [1, 2], kind: "source-comment" });
  writeAnchorMap(ghostRepo, am);

  let ti = emptyTopicIndex();
  ti = setTopic(ti, "slug-dec", { slug: "slug-dec", dec_id: "DEC-abc1234", sot_source: "src/ui/Card.tsx", candidates: [], created_at: "2026-01-01T00:00:00Z" });
  ti = setTopic(ti, "slug-inv", { slug: "slug-inv", dec_id: "INV-def5678", sot_source: "src/ui/Card.tsx", candidates: [], created_at: "2026-01-01T00:00:00Z" });
  writeTopicIndex(ghostRepo, ti);

  const blocks = new LensResolver(ghostRepo).ghostGovernedBlocks("src/ui/Card.tsx");
  assert(blocks.length === 2, "governed blocks: two blocks for the file (DEC + INV)");
  const decBlock = blocks.find((b) => b.id === "DEC-abc1234");
  const invBlock = blocks.find((b) => b.id === "INV-def5678");
  assert(decBlock?.kind === "decision" && decBlock?.startLine === 10 && decBlock?.endLine === 20, "governed blocks: DEC block range read from the anchor-map");
  assert(invBlock?.kind === "invariant" && invBlock?.startLine === 30, "governed blocks: INV block kind from the id, range from the anchor-map");
  assert(blocks[0]?.startLine === 10, "governed blocks: sorted by start line");
  assert(new LensResolver(ghostRepo).ghostGovernedBlocks("src/ui/Nope.tsx").length === 0, "governed blocks: a file with no anchors → empty");

  /* ── Committed control — walk-up still wins ─────────────────────────────── */
  gitInit(committedRepo); // NOT ghost-registered
  mkdirSync(join(committedRepo, ".cairn", "ground"), { recursive: true });
  const cNested = join(committedRepo, "src");
  mkdirSync(cNested, { recursive: true });
  assert(LensResolver.resolveRepoRoot(committedRepo) === committedRepo, "committed: resolveRepoRoot returns the in-tree .cairn dir");
  assert(LensResolver.resolveRepoRoot(cNested) === committedRepo, "committed: nested subdir walks up to the repo root");
  const rc = new LensResolver(committedRepo);
  assert(rc.invariantsLedgerFilePath().startsWith(join(committedRepo, ".cairn")), "committed: ledger path stays in-tree");

  /* ── Non-adopted repo — null ───────────────────────────────────────────── */
  gitInit(plainRepo); // no .cairn, not ghost-registered
  assert(LensResolver.resolveRepoRoot(plainRepo) === null, "non-adopted repo resolves to null");
}

main()
  .catch((err) => {
    console.error(err);
    failed += 1;
  })
  .finally(() => {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realUserProfile;
    for (const d of [tmpHome, ghostRepo, committedRepo, plainRepo]) {
      rmSync(d, { recursive: true, force: true });
    }
    if (failed > 0) {
      console.error(`smoke-lens-ghost — FAIL (${failed})`);
      process.exit(1);
    }
    console.log("smoke-lens-ghost — pass");
  });

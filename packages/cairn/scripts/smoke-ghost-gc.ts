#!/usr/bin/env tsx
/**
 * smoke-ghost-gc — the GC ghost branch (§3.6) + binding store (§3.5).
 *
 * In ghost there are NO in-source `§` cites, so the committed orphan pass —
 * which keys liveness on "grep the source tree for §DEC-<hash>" — would find
 * zero cites for every entity and archive the ENTIRE ledger on the first
 * sweep. The ghost branch instead keys liveness on the out-of-repo scope-index
 * binding (the SoT in ghost), and NEVER auto-retires (no `safe` class) because
 * there are no cites to confirm removal.
 *
 * Asserts:
 *   A. A DEC bound to a still-existing file in scope-index SURVIVES — not even
 *      a finding (ghost-mode design).
 *   B. An UNBOUND entity is surfaced but classified `ambiguous`, never `safe`
 *      (the first sweep archives nothing).
 *
 * Isolation: `$HOME` → throwaway dir (POSIX os.homedir() honors $HOME).
 *
 * Run: pnpm -F @isaacriehm/cairn smoke:ghost-gc
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
const tmpHome = mkdtempSync(join(tmpdir(), "cairn-ghost-gc-home-"));
const repoRoot = mkdtempSync(join(tmpdir(), "cairn-ghost-gc-repo-"));

const OLD = new Date(Date.now() - 30 * 86_400_000).toISOString(); // past grace

async function main(): Promise<void> {
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  const {
    registerGhostRepo,
    runEntityOrphan,
    decisionsDir,
    writeScopeIndex,
    readScopeIndex,
    rescanScopeIndex,
  } = await import("@isaacriehm/cairn-core");

  // Throwaway git repo with a committed source file the DEC will bind to.
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", repoRoot, ...a], { stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.email", "smoke@example.com");
  git("config", "user.name", "Smoke");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "Card.tsx"), "export function Card() {}\n", "utf8");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  registerGhostRepo(repoRoot);

  // Ledger-backed DEC, out-of-repo, past the grace window. NO in-source cite
  // exists (this is ghost) — its only binding is scope-index.
  const decDir = decisionsDir(repoRoot); // resolves under cairnHome (out-of-repo)
  mkdirSync(decDir, { recursive: true });
  const id = "DEC-aaaaaaa";
  const fm = [
    `id: ${id}`,
    "title: Card uses a fragment root",
    "type: adr",
    "status: accepted",
    `generated: ${OLD}`,
    "sot_kind: ledger",
    "sot_path: ledger",
    "source_file: src/Card.tsx",
  ].join("\n");
  writeFileSync(join(decDir, `${id}.md`), `---\n${fm}\n---\n\nBody.\n`, "utf8");

  // ── Case A — bound to a live file → survives ─────────────────────────
  writeScopeIndex(repoRoot, {
    generated: OLD,
    files: { "src/Card.tsx": { decisions: [id], invariants: [] } },
  });
  const a = runEntityOrphan({ repoRoot });
  assert(
    a.orphans.find((o) => o.id === id) === undefined,
    "bound DEC survives ghost GC (no zero-cite orphan)",
  );
  assert(a.orphans.length === 0, "first ghost sweep archives nothing");

  // ── Case A2 — a rescan pass (SessionStart/join) must NOT wipe the SoT ──
  // rebuildDerived calls rescanScopeIndex; in ghost it must no-op so the
  // emit-written binding survives (no cites exist to re-derive it from).
  rescanScopeIndex(repoRoot);
  const idxAfter = readScopeIndex(repoRoot);
  assert(
    idxAfter?.files["src/Card.tsx"]?.decisions.includes(id) === true,
    "rescanScopeIndex preserves the ghost SoT binding (no cite-wipe)",
  );
  assert(runEntityOrphan({ repoRoot }).orphans.length === 0, "DEC still survives after a rescan pass");

  // ── Case B — binding removed → surfaced, but never `safe` ────────────
  writeScopeIndex(repoRoot, { generated: OLD, files: {} });
  const b = runEntityOrphan({ repoRoot });
  const cand = b.orphans.find((o) => o.id === id);
  assert(cand !== undefined, "unbound entity is surfaced for review");
  assert(cand?.classification === "ambiguous", "ghost NEVER auto-retires (classification ambiguous, not safe)");
  assert(
    b.orphans.every((o) => o.classification !== "safe"),
    "no ghost orphan is ever classified `safe`",
  );
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
    if (failed > 0) {
      console.error(`smoke-ghost-gc — FAIL (${failed})`);
      process.exit(1);
    }
    console.log("smoke-ghost-gc — pass");
  });

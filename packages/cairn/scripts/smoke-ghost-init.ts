#!/usr/bin/env tsx
/**
 * smoke-ghost-init — the zero-footprint guarantee.
 *
 * Ghost adoption must leave NOTHING Cairn-shaped in the client repo: no
 * in-repo `.cairn/`, no `.claude/`/`.github/` templates, no mutated CLAUDE.md,
 * no `§DEC`/`§INV` cites in source. State lives out-of-repo under
 * `~/.cairn/state/<repo-id>/`, keyed in `~/.cairn/registry.yaml`.
 *
 * Isolation: this smoke points `$HOME` at a throwaway dir so registration +
 * out-of-repo state never touch the operator's real `~/.cairn`. (POSIX
 * `os.homedir()` honors `$HOME` — this is test isolation, not a config env var.)
 *
 * Covers ghost-mode design (reachability + the no-leak guards).
 * The §6 DEC-recall / GC-survival assertions await the binding-store + GC
 * ghost branches and are not yet exercised here.
 *
 * Run: pnpm -F @isaacriehm/cairn smoke:ghost-init
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const tmpHome = mkdtempSync(join(tmpdir(), "cairn-ghost-home-"));
const repoRoot = mkdtempSync(join(tmpdir(), "cairn-ghost-repo-"));

async function main(): Promise<void> {
  // Redirect the global Cairn home BEFORE importing the resolver-backed API.
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  const {
    registerGhostRepo,
    isGhost,
    seedCairnLayout,
    installCairnRuleAndImport,
    ensureCairnRuleImport,
    applyStripReplace,
    cairnDir,
  } = await import("@isaacriehm/cairn-core");

  // Throwaway git repo with a UI source file + initial commit (root-commit =
  // the move-stable repo id).
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", repoRoot, ...a], { stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.email", "smoke@example.com");
  git("config", "user.name", "Smoke");
  const srcRel = "src/Card.tsx";
  const srcAbs = join(repoRoot, srcRel);
  const srcBody =
    "/**\n * A card.\n * @cairn Card\n */\nexport function Card() {\n  return null;\n}\n";
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(srcAbs, srcBody, "utf8");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  // ── Register ghost + seed ────────────────────────────────────────────
  const entry = registerGhostRepo(repoRoot);
  assert(isGhost(repoRoot) === true, "repo resolves as ghost after registration");
  assert(
    entry.state_dir.startsWith(join(tmpHome, ".cairn", "state")),
    "state_dir is out-of-repo under ~/.cairn/state",
  );

  seedCairnLayout({ repoRoot, projectSlug: "ghost-smoke" });

  // ── §3.3 seam 3 — seed redirect + gating ─────────────────────────────
  assert(!existsSync(join(repoRoot, ".cairn")), "NO in-repo .cairn/ directory (headline)");
  assert(
    existsSync(join(cairnDir(repoRoot), "git-hooks", "pre-commit")),
    "seed landed out-of-repo (git-hooks/pre-commit under cairnHome)",
  );
  assert(!existsSync(join(repoRoot, ".claude")), "no .claude/ written into client tree");
  assert(!existsSync(join(repoRoot, ".github")), "no .github/ written into client tree");

  // registry carries the ghost entry
  const regRaw = existsSync(join(tmpHome, ".cairn", "registry.yaml"))
    ? readFileSync(join(tmpHome, ".cairn", "registry.yaml"), "utf8")
    : "";
  assert(/mode:\s*ghost/.test(regRaw), "registry.yaml records the ghost entry");

  // .git/info/exclude carries /.cairn/
  const excl = join(repoRoot, ".git", "info", "exclude");
  assert(
    existsSync(excl) && /\/?\.cairn\/?/.test(readFileSync(excl, "utf8")),
    ".git/info/exclude carries /.cairn/ (untracked belt-and-suspenders)",
  );

  // ── §3.3 seam 4 — rule-import guard (no client-file mutation) ─────────
  const inst = installCairnRuleAndImport(repoRoot);
  assert(inst.ruleWritten === false && inst.changed === false, "installCairnRuleAndImport no-ops in ghost");
  assert(
    !existsSync(join(repoRoot, ".claude", "rules", "cairn.md")),
    "no .claude/rules/cairn.md written",
  );
  const ens = ensureCairnRuleImport(repoRoot);
  assert(ens.changed === false, "ensureCairnRuleImport no-ops in ghost");
  assert(!existsSync(join(repoRoot, "CLAUDE.md")), "client CLAUDE.md never created");

  // ── §3.3 seam 1 — applyStripReplace no-op (no source cites) ───────────
  const before = readFileSync(srcAbs, "utf8");
  const res = applyStripReplace({
    repoRoot,
    items: [
      {
        blockId: "blk1",
        file: srcRel,
        startOffset: 0,
        endOffset: 18,
        replacement: "// §INV-deadbeef00",
      },
    ],
  });
  assert(res.itemsApplied === 0 && res.filesModified === 0, "applyStripReplace writes nothing in ghost");
  assert(readFileSync(srcAbs, "utf8") === before, "source file byte-identical (no §-cite inserted)");

  // ── Litmus part 1 — git status clean of Cairn artifacts ──────────────
  const porcelain = execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], {
    encoding: "utf8",
  });
  const dirty = porcelain
    .split("\n")
    .filter((l) => /\.cairn|\.claude|\.github|CLAUDE\.md|AGENTS\.md/.test(l));
  assert(dirty.length === 0, `no Cairn-shaped working-tree changes (got: ${JSON.stringify(dirty)})`);
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
      console.error(`smoke-ghost-init — FAIL (${failed})`);
      process.exit(1);
    }
    console.log("smoke-ghost-init — pass");
  });

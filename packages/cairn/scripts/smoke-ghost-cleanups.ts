#!/usr/bin/env tsx
/**
 * smoke-ghost-cleanups — ghost suppression of multi-dev onboarding (§3.3 seam 4)
 * + the record-decision "review rides the local diff" copy (§3.3 seam 6).
 *
 * Ghost is single-operator (§3.4): the Phase-13 multi-dev install must NOT emit
 * per-host JOIN.md hints or wire the teammate `.claude/rules/cairn.md` import —
 * even when package manifests exist — and an auto-accepted DEC has no committed
 * PR, so the tool tells the operator review rides their local diff.
 *
 * Isolation: `$HOME` points at a throwaway dir (the ghost registry lives there).
 *
 * Run: pnpm -F @isaacriehm/cairn smoke:ghost-cleanups
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const tmpHome = mkdtempSync(join(tmpdir(), "cairn-clean-home-"));
const ghostRepo = mkdtempSync(join(tmpdir(), "cairn-clean-ghost-"));
const committedRepo = mkdtempSync(join(tmpdir(), "cairn-clean-committed-"));

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
  const { registerGhostRepo, installMultiDev, allTools } = await import("@isaacriehm/cairn-core");

  const recordTool = allTools.find((t) => t.name === "cairn_record_decision");
  if (recordTool === undefined) throw new Error("cairn_record_decision missing from allTools");
  const callRecord = recordTool.handler as (
    c: { repoRoot: string; sessionId: string | null },
    i: unknown,
  ) => Promise<unknown>;

  /* ── Ghost: multi-dev onboarding suppressed even WITH manifests ─────────── */
  gitInit(ghostRepo);
  registerGhostRepo(ghostRepo);
  // Real package manifests on disk — committed mode would emit host hints for
  // these; ghost must suppress them anyway.
  writeFileSync(join(ghostRepo, "package.json"), '{"name":"client"}\n', "utf8");
  writeFileSync(join(ghostRepo, "Cargo.toml"), "[package]\nname = \"client\"\n", "utf8");

  const g = installMultiDev({ repoRoot: ghostRepo });
  assert(g.hostKinds.length === 1 && g.hostKinds[0] === "none", "ghost: hostKinds collapses to [none] despite package.json + Cargo.toml");
  assert(g.steps.some((s) => s.step === "multi-dev-suppressed-ghost" && s.status === "skipped"), "ghost: emits the multi-dev-suppressed-ghost step");
  assert(g.manualHints.length === 1 && /single-operator/.test(g.manualHints[0] ?? ""), "ghost: exactly one suppression hint");
  // The lone suppression hint legitimately *names* JOIN.md to say it's
  // suppressed; a real per-host hint instead carries "detected —" / "new
  // contributors" / "rely on .cairn". Assert none of those leak.
  assert(!g.manualHints.some((h) => /detected —|new contributors|rely on \.cairn/.test(h)), "ghost: no teammate / per-host onboarding hints leak");
  assert(g.preparePatched === false, "ghost: package.json prepare never patched");
  assert(!existsSync(join(ghostRepo, ".claude")), "ghost: no .claude/rules written (teammate rule import not wired)");

  /* ── Ghost: record-decision auto-accept note rides the local diff ───────── */
  // No config.yaml seeded under cairnHome → requireBootstrap returns null, so
  // the write proceeds without a bootstrapped clone.
  const dec = (await callRecord(
    { repoRoot: ghostRepo, sessionId: null },
    { title: "Adopt the local-first sync model", summary: "We chose local-first over server-authoritative because the client works offline." },
  )) as { ok?: boolean; auto_accepted?: boolean; note?: string };
  assert(dec.ok === true && dec.auto_accepted === true, "ghost: decision auto-accepts to local ground");
  assert(typeof dec.note === "string" && /local diff/.test(dec.note ?? ""), "ghost: note tells the operator review rides the local diff");

  /* ── Committed control — unchanged ─────────────────────────────────────── */
  gitInit(committedRepo); // NOT ghost-registered
  writeFileSync(join(committedRepo, "package.json"), '{"name":"team"}\n', "utf8");
  const c = installMultiDev({ repoRoot: committedRepo, dryRun: true });
  assert(c.hostKinds.includes("node-package-json"), "committed: still detects the node host");
  assert(c.manualHints.some((h) => /package\.json detected/.test(h)), "committed: still emits the node onboarding hint (unchanged)");
  assert(!c.steps.some((s) => s.step === "multi-dev-suppressed-ghost"), "committed: no ghost-suppression step");

  const decC = (await callRecord(
    { repoRoot: committedRepo, sessionId: null },
    { title: "Use Postgres for the primary store", summary: "We chose Postgres over MySQL for richer JSON support." },
  )) as { auto_accepted?: boolean; note?: string };
  assert(decC.note === undefined || !/local diff/.test(decC.note), "committed: no local-diff note (review rides the committed PR)");
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
    rmSync(ghostRepo, { recursive: true, force: true });
    rmSync(committedRepo, { recursive: true, force: true });
    if (failed > 0) {
      console.error(`smoke-ghost-cleanups — FAIL (${failed})`);
      process.exit(1);
    }
    console.log("smoke-ghost-cleanups — pass");
  });

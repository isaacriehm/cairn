#!/usr/bin/env tsx
/**
 * smoke-ghost-reconfirm — the deferred Haiku re-confirm tier (§3.8.1).
 *
 * The freshness gate latches `needs_reconfirm` on an identity-relevant edit
 * (deterministic, no LLM). This pass is the other half: the narrow, quota-gated
 * Haiku judge that decides whether the stored category/purpose still fits and
 * clears the flag. Exercised with a mock judge so it stays deterministic:
 *
 *   - "fits" clears the flag; "stale" leaves it flagged.
 *   - the verdict caches on the body fingerprint — a re-run over a still-flagged,
 *     unedited component is a free cache hit (judge NOT re-invoked).
 *   - a hard `cap` defers the rest (still flagged), never silently dropped.
 *   - `onlyFile` scopes the pass to one unit.
 *   - committed mode is inert; the MCP tool refuses there.
 *
 * Isolation: `$HOME` points at a throwaway dir.
 *
 * Run: pnpm -F @isaacriehm/cairn smoke:ghost-reconfirm
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const tmpHome = mkdtempSync(join(tmpdir(), "cairn-recon-home-"));
const ghostRepo = mkdtempSync(join(tmpdir(), "cairn-recon-ghost-"));
const committedRepo = mkdtempSync(join(tmpdir(), "cairn-recon-committed-"));

const CONFIG =
  "project: recon-smoke\ncomponents:\n  componentDirs:\n    - src/ui\n  extensions:\n    - .tsx\n  categories:\n    - data-display\n";
const card = (extra = "") =>
  'export function Card() {\n  return <div className="card">c</div>;\n}\n' + extra;
const modal = (extra = "") =>
  'export function Modal() {\n  return <div className="modal">m</div>;\n}\n' + extra;
const EXTRA1 = 'export function Extra1() {\n  return <span className="x">x</span>;\n}\n';
const EXTRA2 = 'export function Extra2() {\n  return <span className="y">y</span>;\n}\n';

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
    readComponentRegistry,
    runComponentFreshness,
    runComponentReconfirm,
    allTools,
  } = await import("@isaacriehm/cairn-core");

  const register = allTools.find((t) => t.name === "cairn_component_register");
  const reconfirmTool = allTools.find((t) => t.name === "cairn_component_reconfirm");
  if (register === undefined) throw new Error("cairn_component_register missing");
  if (reconfirmTool === undefined) throw new Error("cairn_component_reconfirm missing");
  const callRegister = register.handler as (c: { repoRoot: string }, i: unknown) => Promise<unknown>;
  const callReconfirm = reconfirmTool.handler as (c: { repoRoot: string }, i: unknown) => Promise<unknown>;

  const flagged = (file: string): boolean | undefined =>
    readComponentRegistry(ghostRepo).entries.find((e) => e.file === file)?.needs_reconfirm;

  // Mock judge: Card "fits", everything else "stale". Records every invocation.
  const calls: string[] = [];
  const mockJudge = async (a: { name: string }) => {
    calls.push(a.name);
    return a.name === "Card" ? ("fits" as const) : ("stale" as const);
  };

  /* ── Setup + flag both via the freshness gate ──────────────────────────── */
  gitInit(ghostRepo);
  registerGhostRepo(ghostRepo);
  mkdirSync(cairnDir(ghostRepo), { recursive: true });
  writeFileSync(cairnDir(ghostRepo, "config.yaml"), CONFIG, "utf8");
  mkdirSync(join(ghostRepo, "src", "ui"), { recursive: true });
  const cardAbs = join(ghostRepo, "src", "ui", "Card.tsx");
  const modalAbs = join(ghostRepo, "src", "ui", "Modal.tsx");
  writeFileSync(cardAbs, card(), "utf8");
  writeFileSync(modalAbs, modal(), "utf8");

  for (const [file, ex, nm] of [
    ["src/ui/Card.tsx", "Card", "Card"],
    ["src/ui/Modal.tsx", "Modal", "Modal"],
  ] as const) {
    await callRegister(
      { repoRoot: ghostRepo },
      { file, export_name: ex, name: nm, category: "data-display", purpose: `the ${nm}.`, aliases: [] },
    );
  }
  // Identity edit (adds an export) → freshness flags both.
  writeFileSync(cardAbs, card(EXTRA1), "utf8");
  writeFileSync(modalAbs, modal(EXTRA1), "utf8");
  runComponentFreshness(ghostRepo, "src/ui/Card.tsx");
  runComponentFreshness(ghostRepo, "src/ui/Modal.tsx");
  assert(flagged("src/ui/Card.tsx") === true && flagged("src/ui/Modal.tsx") === true, "both components flagged by the freshness gate");

  /* ── Pass 1 — judge each once ──────────────────────────────────────────── */
  const r1 = await runComponentReconfirm({ repoRoot: ghostRepo, mockJudge });
  assert(r1.considered === 2 && r1.cleared === 1 && r1.stillStale === 1, "pass 1: 2 considered, 1 cleared (fits), 1 stale");
  assert(r1.haikuCalls === 2 && r1.cacheHits === 0, "pass 1: 2 fresh judge calls, no cache hits");
  assert(flagged("src/ui/Card.tsx") === undefined, "Card 'fits' → flag cleared");
  assert(flagged("src/ui/Modal.tsx") === true, "Modal 'stale' → stays flagged");

  /* ── Pass 2 — unedited stale entry served from cache ───────────────────── */
  const callsAfter1 = calls.length;
  const r2 = await runComponentReconfirm({ repoRoot: ghostRepo, mockJudge });
  assert(r2.considered === 1 && r2.cacheHits === 1 && r2.haikuCalls === 0, "pass 2: only Modal left, served from fingerprint cache (0 fresh calls)");
  assert(calls.length === callsAfter1, "pass 2: mock judge NOT re-invoked (cache hit)");
  assert(flagged("src/ui/Modal.tsx") === true, "Modal still flagged after cache-hit stale");

  /* ── Cap — an uncached flagged entry defers ────────────────────────────── */
  writeFileSync(modalAbs, modal(EXTRA1) + "// edit\n", "utf8"); // new body → cache miss
  const r3 = await runComponentReconfirm({ repoRoot: ghostRepo, mockJudge, cap: 0 });
  assert(r3.considered === 1 && r3.deferred === 1 && r3.haikuCalls === 0 && r3.cleared === 0, "cap 0: the flagged entry defers (no judge, stays flagged)");
  assert(flagged("src/ui/Modal.tsx") === true, "Modal stays flagged when deferred");

  /* ── onlyFile — scope the pass to one unit ─────────────────────────────── */
  writeFileSync(cardAbs, card(EXTRA1 + EXTRA2), "utf8"); // adds Extra2 → re-flag Card
  runComponentFreshness(ghostRepo, "src/ui/Card.tsx");
  assert(flagged("src/ui/Card.tsx") === true, "Card re-flagged for the onlyFile test");
  const r4 = await runComponentReconfirm({ repoRoot: ghostRepo, mockJudge, onlyFile: "src/ui/Modal.tsx" });
  assert(r4.considered === 1, "onlyFile: only Modal considered");
  assert(flagged("src/ui/Card.tsx") === true, "onlyFile: Card untouched (still flagged)");

  /* ── Committed control ─────────────────────────────────────────────────── */
  gitInit(committedRepo); // NOT ghost-registered
  const rc = await runComponentReconfirm({ repoRoot: committedRepo, mockJudge });
  assert(rc.considered === 0, "committed mode: reconfirm is inert");
  const refusal = (await callReconfirm({ repoRoot: committedRepo }, {})) as { error?: { code?: string } };
  assert(refusal.error?.code === "NOT_ALLOWED", "cairn_component_reconfirm refuses in committed mode");

  // Source never mutated by the reconfirm pass.
  assert(/@cairn/.test(readFileSync(cardAbs, "utf8")) === false, "reconfirm never writes a header into source");
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
      console.error(`smoke-ghost-reconfirm — FAIL (${failed})`);
      process.exit(1);
    }
    console.log("smoke-ghost-reconfirm — pass");
  });

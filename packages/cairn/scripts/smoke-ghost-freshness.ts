#!/usr/bin/env tsx
/**
 * smoke-ghost-freshness — the headerless component freshness gate (§3.8.1).
 *
 * Ghost has no `@cairn` header to rot, so the out-of-repo registry must detect a
 * component body change at edit time and decide — deterministically, NO LLM —
 * whether the stored classification still holds. This exercises the L0–L3 gate:
 *
 *   L0  a non-registered file edit is a no-op (registry untouched).
 *   L1  re-running on an unchanged body returns "unchanged".
 *   L2  an internal refactor (same exports/shape) refreshes the fingerprint,
 *       does NOT flag reconfirm, and a subsequent run reads "unchanged".
 *   L3  an exports change flags `needs_reconfirm` + yields an operator hint.
 *   committed mode is inert (the in-file header is the SoT there).
 *   the flagged entry surfaces as a soft `component-reconfirm` baseline finding.
 *   the source file is never mutated by the gate.
 *
 * Isolation: `$HOME` points at a throwaway dir (the ghost registry lives there).
 *
 * Run: pnpm -F @isaacriehm/cairn smoke:ghost-freshness
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
const tmpHome = mkdtempSync(join(tmpdir(), "cairn-fresh-home-"));
const ghostRepo = mkdtempSync(join(tmpdir(), "cairn-fresh-ghost-"));
const committedRepo = mkdtempSync(join(tmpdir(), "cairn-fresh-committed-"));

const CONFIG =
  "project: fresh-smoke\ncomponents:\n  componentDirs:\n    - src/ui\n  extensions:\n    - .tsx\n  categories:\n    - data-display\n";

const CARD_V0 = 'export function Card() {\n  return <div className="card">v0</div>;\n}\n';
// Same single export `Card`, same shape — only internals differ (L2 refactor).
const CARD_INTERNAL =
  'export function Card() {\n  return <div className="card">v1 internal refactor</div>;\n}\n';
// Adds a second export → exports set changed (L3 identity change).
const CARD_NEW_EXPORT =
  CARD_INTERNAL +
  'export function CardHeader() {\n  return <h2 className="card-h">h</h2>;\n}\n';

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
    emitComponentStore,
    allTools,
  } = await import("@isaacriehm/cairn-core");

  const register = allTools.find((t) => t.name === "cairn_component_register");
  if (register === undefined) throw new Error("cairn_component_register missing from allTools");
  const callRegister = register.handler as (c: { repoRoot: string }, i: unknown) => Promise<unknown>;

  const flag = (): boolean | undefined =>
    readComponentRegistry(ghostRepo).entries.find((e) => e.file === "src/ui/Card.tsx")
      ?.needs_reconfirm;
  const storedHash = (): string | undefined =>
    readComponentRegistry(ghostRepo).entries.find((e) => e.file === "src/ui/Card.tsx")
      ?.anchor.content_hash;

  /* ── Ghost setup ───────────────────────────────────────────────────────── */
  gitInit(ghostRepo);
  registerGhostRepo(ghostRepo);
  mkdirSync(cairnDir(ghostRepo), { recursive: true });
  writeFileSync(cairnDir(ghostRepo, "config.yaml"), CONFIG, "utf8"); // out-of-repo
  mkdirSync(join(ghostRepo, "src", "ui"), { recursive: true });
  const cardAbs = join(ghostRepo, "src", "ui", "Card.tsx");
  writeFileSync(cardAbs, CARD_V0, "utf8");

  await callRegister(
    { repoRoot: ghostRepo },
    {
      file: "src/ui/Card.tsx",
      export_name: "Card",
      name: "Card",
      category: "data-display",
      purpose: "A card container.",
      aliases: ["card"],
    },
  );
  const h0 = storedHash();
  assert(h0 !== undefined && h0.length === 64, "register snapshots a whole-file fingerprint");
  const entry0 = readComponentRegistry(ghostRepo).entries[0]!;
  assert(
    entry0.exports.includes("Card") && entry0.unit_shaped === true,
    "register snapshots exports + unit_shaped for the L2 compare",
  );

  /* ── L1 — unchanged body ───────────────────────────────────────────────── */
  const fr1 = runComponentFreshness(ghostRepo, "src/ui/Card.tsx");
  assert(fr1.action === "unchanged", "L1: unedited registered file reads 'unchanged'");
  assert(fr1.hint === null, "L1: no operator hint for an unchanged body");

  /* ── L2 — internal refactor ────────────────────────────────────────────── */
  writeFileSync(cardAbs, CARD_INTERNAL, "utf8");
  const fr2 = runComponentFreshness(ghostRepo, "src/ui/Card.tsx");
  assert(fr2.action === "refreshed", "L2: internal refactor refreshes (same exports/shape)");
  assert(flag() !== true, "L2: internal refactor does NOT flag needs_reconfirm");
  assert(storedHash() !== h0, "L2: fingerprint advanced to the new body");
  const fr2b = runComponentFreshness(ghostRepo, "src/ui/Card.tsx");
  assert(fr2b.action === "unchanged", "L2: refresh persisted — re-run reads 'unchanged'");

  /* ── L3 — identity change (exports grew) ───────────────────────────────── */
  writeFileSync(cardAbs, CARD_NEW_EXPORT, "utf8");
  const fr3 = runComponentFreshness(ghostRepo, "src/ui/Card.tsx");
  assert(fr3.action === "reconfirm", "L3: an exports change flags reconfirm");
  assert(flag() === true, "L3: entry.needs_reconfirm latched true");
  assert(typeof fr3.hint === "string" && fr3.hint.includes("Card"), "L3: operator hint names the component");
  assert(readFileSync(cardAbs, "utf8") === CARD_NEW_EXPORT, "gate never mutates source (no @cairn header inserted)");

  // Latch: a subsequent internal-only edit must not CLEAR a pending reconfirm.
  writeFileSync(cardAbs, CARD_NEW_EXPORT + "\n// trailing edit\n", "utf8");
  runComponentFreshness(ghostRepo, "src/ui/Card.tsx");
  assert(flag() === true, "L3: reconfirm stays latched across a later non-identity edit");

  /* ── L0 — non-registered file ──────────────────────────────────────────── */
  const before = JSON.stringify(readComponentRegistry(ghostRepo).entries);
  const helperAbs = join(ghostRepo, "src", "ui", "helper.ts");
  writeFileSync(helperAbs, "export const x = 1;\n", "utf8");
  const fr0 = runComponentFreshness(ghostRepo, "src/ui/helper.ts");
  assert(fr0.action === "not-registered", "L0: an unregistered path is a no-op");
  assert(JSON.stringify(readComponentRegistry(ghostRepo).entries) === before, "L0: registry untouched by a non-component edit");

  /* ── Reconfirm surfaces in the emit baseline ───────────────────────────── */
  emitComponentStore(ghostRepo);
  const baselineDir = cairnDir(ghostRepo, "baseline");
  const baselineFile = existsSync(baselineDir)
    ? readdirSync(baselineDir).filter((f) => f.startsWith("components-")).sort().pop()
    : undefined;
  const baseline = baselineFile ? readFileSync(join(baselineDir, baselineFile), "utf8") : "";
  assert(/component-reconfirm/.test(baseline), "emit baseline carries a component-reconfirm sensor");
  assert(/src\/ui\/Card\.tsx/.test(baseline), "reconfirm finding names the changed component file");

  /* ── Committed control — gate is inert ─────────────────────────────────── */
  gitInit(committedRepo); // NOT ghost-registered
  mkdirSync(cairnDir(committedRepo), { recursive: true });
  writeFileSync(cairnDir(committedRepo, "config.yaml"), CONFIG, "utf8");
  mkdirSync(join(committedRepo, "src", "ui"), { recursive: true });
  writeFileSync(join(committedRepo, "src", "ui", "Card.tsx"), CARD_V0, "utf8");
  const frc = runComponentFreshness(committedRepo, "src/ui/Card.tsx");
  assert(frc.action === "inert", "committed mode: the freshness gate is inert");
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
      console.error(`smoke-ghost-freshness — FAIL (${failed})`);
      process.exit(1);
    }
    console.log("smoke-ghost-freshness — pass");
  });

#!/usr/bin/env tsx
/**
 * smoke-ghost-components — the headerless component store (§3.8.1).
 *
 * Committed mode reads the `@cairn <Name>` header in source. Ghost forbids that
 * header in client source, so the classification lives in an out-of-repo
 * registry keyed (workspace, file, export). `collectComponents` flips its tag
 * source on mode — every downstream consumer (index, validate, ledger, get)
 * sees the identical `ComponentRecord` shape.
 *
 * Asserts: an un-registered unit reads as `unregistered-unit` (soft offer), NOT
 * `missing-header`; `cairn_component_register` writes the out-of-repo store and
 * the source file stays byte-identical (no `@cairn` inserted); the registered
 * component then collects normally; the registry lives out-of-repo (no in-repo
 * `.cairn`); the tool refuses in committed mode; and committed still reads the
 * in-file header.
 *
 * Isolation: `$HOME` points at a throwaway dir.
 *
 * Run: pnpm -F @isaacriehm/cairn smoke:ghost-components
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const tmpHome = mkdtempSync(join(tmpdir(), "cairn-comp-home-"));
const ghostRepo = mkdtempSync(join(tmpdir(), "cairn-comp-ghost-"));
const committedRepo = mkdtempSync(join(tmpdir(), "cairn-comp-committed-"));

const CONFIG =
  "project: comp-smoke\ncomponents:\n  componentDirs:\n    - src/ui\n  extensions:\n    - .tsx\n  categories:\n    - data-display\n    - overlay\n";
const CARD = "export function Card() {\n  return <div className=\"card\">card</div>;\n}\n";
const MODAL = "export function Modal() {\n  return <div className=\"modal\">modal</div>;\n}\n";

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
    loadComponentsConfig,
    collectComponents,
    validateComponents,
    getComponent,
    cairnDir,
    readComponentRegistry,
    runPhase9dCompWalk,
    runPhase9eCompAnnotate,
    allTools,
  } = await import("@isaacriehm/cairn-core");

  const register = allTools.find((t) => t.name === "cairn_component_register");
  if (register === undefined) throw new Error("cairn_component_register missing from allTools");
  const callRegister = register.handler as (c: { repoRoot: string }, i: unknown) => Promise<unknown>;

  /* ── Ghost repo ────────────────────────────────────────────────────────── */
  gitInit(ghostRepo);
  registerGhostRepo(ghostRepo);
  mkdirSync(cairnDir(ghostRepo), { recursive: true });
  writeFileSync(cairnDir(ghostRepo, "config.yaml"), CONFIG, "utf8"); // out-of-repo
  mkdirSync(join(ghostRepo, "src", "ui"), { recursive: true });
  const cardAbs = join(ghostRepo, "src", "ui", "Card.tsx");
  writeFileSync(cardAbs, CARD, "utf8");
  writeFileSync(join(ghostRepo, "src", "ui", "Modal.tsx"), MODAL, "utf8");
  const cardBefore = readFileSync(cardAbs, "utf8");

  const cfg = loadComponentsConfig(ghostRepo);

  // Before registration: both are unregistered units, nothing collected.
  const c0 = collectComponents(ghostRepo, cfg);
  assert(c0.ghost === true, "collectComponents reports ghost mode");
  assert(c0.components.length === 0, "no components before any registration");
  assert(c0.missing.includes("src/ui/Card.tsx") && c0.missing.includes("src/ui/Modal.tsx"), "both unit files are 'missing' (unregistered)");

  const f0 = validateComponents(c0, cfg);
  assert(
    f0.some((f) => f.kind === "unregistered-unit" && f.file === "src/ui/Card.tsx"),
    "ghost validate emits unregistered-unit (offer)",
  );
  assert(
    !f0.some((f) => f.kind === "missing-header") && f0.every((f) => f.severity === "soft"),
    "ghost validate emits NO hard missing-header nag",
  );

  // Register Card via the MCP tool (the ghost write path).
  const res = (await callRegister(
    { repoRoot: ghostRepo },
    {
      file: "src/ui/Card.tsx",
      export_name: "Card",
      name: "Card",
      category: "data-display",
      purpose: "A card container.",
      aliases: ["card", "panel"],
    },
  )) as { registered?: boolean };
  assert(res.registered === true, "cairn_component_register writes the entry");
  assert(readFileSync(cardAbs, "utf8") === cardBefore, "Card.tsx is byte-identical (no @cairn header inserted)");

  // Registry lives out-of-repo; no in-repo .cairn at all.
  assert(
    existsSync(cairnDir(ghostRepo, "ground", "components", "registry.yaml")),
    "registry.yaml written under cairnHome (out-of-repo)",
  );
  assert(!existsSync(join(ghostRepo, ".cairn")), "no in-repo .cairn/ created");
  assert(readComponentRegistry(ghostRepo).entries.length === 1, "registry carries one entry");

  // After registration: Card collects from the registry; Modal still missing.
  const c1 = collectComponents(ghostRepo, cfg);
  const card = c1.components.find((c) => c.tags.cairn === "Card");
  assert(card !== undefined, "Card now collected from the registry");
  assert(card?.tags.category === "data-display" && card?.tags.purpose === "A card container.", "tags projected from the registry entry");
  assert(c1.missing.includes("src/ui/Modal.tsx") && !c1.missing.includes("src/ui/Card.tsx"), "Modal stays unregistered; Card no longer missing");
  assert(getComponent(ghostRepo, "Card") !== null, "getComponent resolves the registered component");

  /* ── Adoption-phase ghost flow (9d → 9e registers, never source-annotates) ─ */
  const state0 = {
    repoRoot: ghostRepo,
    currentPhase: "9d-comp-walk" as const,
    outputs: {} as Record<string, unknown>,
    startedAt: "2020-01-01T00:00:00.000Z",
    schemaVersion: 3 as const,
  };
  const walk = (await runPhase9dCompWalk(state0)) as {
    status: string;
    nextPhase?: string;
    state: typeof state0;
  };
  assert(walk.status === "complete" && walk.nextPhase === "9e-comp-annotate", "9d-comp-walk advances to 9e in ghost");
  const missingCorpus = readFileSync(cairnDir(ghostRepo, "init", "components", "missing.jsonl"), "utf8");
  assert(/src\/ui\/Modal\.tsx/.test(missingCorpus), "9d corpus lists the unregistered Modal unit");
  assert(!/src\/ui\/Card\.tsx/.test(missingCorpus), "9d corpus excludes the already-registered Card");

  // Register-during-adoption: the ghost `component-registrar` would classify +
  // register each corpus unit via the MCP tool (no header). Simulate that here
  // by registering the lone corpus unit (Modal), then assert 9e counts it.
  const modalAbs = join(ghostRepo, "src", "ui", "Modal.tsx");
  const modalBefore = readFileSync(modalAbs, "utf8");
  await callRegister(
    { repoRoot: ghostRepo },
    { file: "src/ui/Modal.tsx", export_name: "Modal", name: "Modal", category: "overlay", purpose: "A modal.", aliases: ["modal", "dialog"] },
  );

  const annotate = (await runPhase9eCompAnnotate(walk.state)) as {
    status: string;
    nextPhase?: string;
    state: { outputs: Record<string, { skipped?: string; registered?: number; still_unregistered?: number }> };
  };
  assert(annotate.status === "complete", "9e-comp-annotate completes in ghost");
  const out9e = annotate.state.outputs["9e-comp-annotate"];
  assert(out9e?.skipped === undefined, "9e no longer skips in ghost — it counts registrations");
  assert(out9e?.registered === 1 && (out9e?.still_unregistered ?? 0) === 0, "9e ghost counts the registered corpus unit (registered=1, none unregistered)");
  assert(readFileSync(modalAbs, "utf8") === modalBefore, "register-during-adoption writes NO @cairn header into source");

  /* ── Committed control ─────────────────────────────────────────────────── */
  gitInit(committedRepo); // NOT ghost-registered
  mkdirSync(cairnDir(committedRepo), { recursive: true });
  writeFileSync(cairnDir(committedRepo, "config.yaml"), CONFIG, "utf8"); // in-repo .cairn
  mkdirSync(join(committedRepo, "src", "ui"), { recursive: true });
  const cardHeader =
    "/**\n * @cairn Card\n * @category data-display\n * @purpose A card container.\n * @aliases card, panel\n */\n" + CARD;
  writeFileSync(join(committedRepo, "src", "ui", "Card.tsx"), cardHeader, "utf8");
  writeFileSync(join(committedRepo, "src", "ui", "Modal.tsx"), MODAL, "utf8");

  const ccfg = loadComponentsConfig(committedRepo);
  const cc = collectComponents(committedRepo, ccfg);
  assert(cc.ghost === false, "committed repo reports committed mode");
  assert(cc.components.some((c) => c.tags.cairn === "Card"), "committed reads the in-file @cairn header");
  const cf = validateComponents(cc, ccfg);
  assert(
    cf.some((f) => f.kind === "missing-header" && f.severity === "hard"),
    "committed still emits the hard missing-header gate for the un-annotated unit",
  );

  // The register tool refuses in committed mode.
  const refusal = (await callRegister(
    { repoRoot: committedRepo },
    { file: "src/ui/Modal.tsx", export_name: "Modal", name: "Modal", category: "overlay", purpose: "x", aliases: [] },
  )) as { error?: { code?: string } };
  assert(refusal.error?.code === "NOT_ALLOWED", "cairn_component_register refuses in committed mode");
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
      console.error(`smoke-ghost-components — FAIL (${failed})`);
      process.exit(1);
    }
    console.log("smoke-ghost-components — pass");
  });

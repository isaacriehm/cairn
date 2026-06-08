#!/usr/bin/env tsx
/**
 * smoke-components — the component store (Cairn's fourth ground store), E2E.
 *
 * Covers the docs/COMPONENT_STORE_PLAN.md §17 shapes:
 *   1. Single-app: index renders → check passes → drop a header → check
 *      hard-fails → tweak a class in a page → audit flags the inline rebuild.
 *   2. Monorepo: manifest + slices render (no honeypot); an isolated
 *      workspace's components never appear in another slice;
 *      `componentsInScope` returns only the entitled slice + shared; a
 *      duplicate `@cairn` name across workspaces is allowed, within a
 *      workspace it hard-fails.
 *   3. Pre-commit gate: a staged component file missing a header blocks
 *      (runComponentCheck({files}) reports the hard finding).
 *   4. Adoption: runPhase9dComponents detects → indexes → drafts a
 *      singleton §INV → surfaces missing-header debt + audit to baseline.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildComponentIndex,
  componentsInScope,
  emitComponentStore,
  ensureComponentsConfig,
  runComponentAudit,
  runComponentCheck,
  runPhase9dCompWalk,
  runPhase9eCompAnnotate,
  runPhase9fCompEmit,
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
      // best-effort
    }
  }
}

function step(label: string): void {
  console.log(`── ${label}`);
}

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/** Write `.cairn/config.yaml` — JSON is valid YAML, so no yaml dep needed. */
function writeConfig(root: string, components: unknown): void {
  write(root, ".cairn/config.yaml", JSON.stringify({ slug: "smoke", components }));
}

function header(name: string, category: string, extra = ""): string {
  return [
    "/**",
    ` * @cairn ${name}`,
    ` * @category ${category}`,
    ` * @purpose ${name} does a thing worth searching for.`,
    ` * @aliases ${name.toLowerCase()}, thing, widget`,
    extra,
    " */",
    `export function ${name}() { return null; }`,
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/* -------------------------------------------------------------------------- */
/* 1. Single-app                                                              */
/* -------------------------------------------------------------------------- */

function singleApp(): void {
  step("Single-app — index + check pass; drop header → hard-fail; audit flags rebuild");
  const root = mkdtempSync(join(tmpdir(), "cairn-smoke-comp-single-"));
  cleanups.push(root);

  writeConfig(root, {
    componentDirs: ["src/components"],
    extensions: [".tsx"],
  });
  // The inline-rebuild audit is Tailwind-gated (config-file presence) — a
  // realistic Tailwind project carries a config, so the fixture does too.
  write(root, "tailwind.config.js", "module.exports = { content: [] };\n");

  write(root, "src/components/AppNav.tsx", header("AppNav", "navigation", " * @singleton"));

  // A realistic corpus: every component shares the GENERIC layout utilities
  // (mx-auto/flex/gap/px/py) so those roots are non-distinctive (high df →
  // idf≈0), and each carries its own DISTINCTIVE classes. The IDF-weighted
  // audit keys inline-rebuild matches off the distinctive roots, not the
  // ubiquitous scaffolding.
  const comp = (name: string, cat: string, distinctive: string): string =>
    [
      "/**",
      ` * @cairn ${name}`,
      ` * @category ${cat}`,
      ` * @purpose ${name} section.`,
      ` * @aliases ${name.toLowerCase()}, ${name.toLowerCase()} block`,
      " */",
      `export function ${name}() {`,
      `  return <div className="mx-auto flex flex-col gap-6 px-4 py-8 ${distinctive}" />;`,
      "}",
      "",
    ].join("\n");
  write(root, "src/components/Hero.tsx", comp("Hero", "marketing", "backdrop-blur-xl ring-2 snap-x"));
  write(root, "src/components/Panel.tsx", comp("Panel", "layout", "divide-y border-dashed"));
  write(root, "src/components/Toolbar.tsx", comp("Toolbar", "navigation", "sticky top-0 z-50"));
  write(root, "src/components/Badge.tsx", comp("Badge", "data-display", "uppercase tracking-wide"));
  write(root, "src/components/Modal.tsx", comp("Modal", "overlay", "fixed inset-0 backdrop-saturate"));

  const build = buildComponentIndex(root);
  assert(build.total === 6, `index counts 6 components (got ${build.total})`);
  assert(build.missing === 0, "no missing headers yet");
  const index = readFileSync(join(root, ".cairn/ground/components/INDEX.md"), "utf8");
  assert(/AppNav \[S\]/.test(index), "INDEX marks AppNav as a [S] singleton");
  assert(index.includes("## marketing"), "INDEX groups by category");

  const clean = runComponentCheck(root);
  assert(clean.hardFailures === 0, `clean check has no hard failures (got ${clean.hardFailures})`);

  // Drop a header on a unit-shaped (PascalCase + JSX) file → missing-header.
  write(
    root,
    "src/components/Card.tsx",
    "export function Card() { return <div className=\"rounded border p-4\" />; }\n",
  );
  // A co-located lowercase ROUTE file with no header is NOT a missing unit —
  // FIX-1: the walk gates on isUnitShaped, so route/entry files in a mixed
  // component dir don't flood the gate.
  write(
    root,
    "src/components/page.tsx",
    "export default function Page() { return <main>home</main>; }\n",
  );
  const dirty = runComponentCheck(root);
  assert(dirty.hardFailures >= 1, "missing-header is a hard failure");
  assert(
    dirty.findings.some((f) => f.path === "src/components/Card.tsx"),
    "the missing-header finding names Card.tsx",
  );
  assert(
    !dirty.findings.some((f) => f.path === "src/components/page.tsx"),
    "a co-located lowercase route file (page.tsx) is NOT flagged missing-header",
  );

  // Inline rebuild — a lowercase ROUTE file (page.tsx) that copies Hero's
  // DISTINCTIVE classes is flagged as a rebuild (it is non-component code).
  write(
    root,
    "src/app/promo/page.tsx",
    [
      "export default function Page() {",
      '  return <div className="mx-auto flex flex-col gap-8 px-6 py-12 backdrop-blur-xl ring-2 snap-x" />;',
      "}",
      "",
    ].join("\n"),
  );
  // True negative — a route file using ONLY generic layout scaffolding shares
  // no distinctive roots, so the IDF-weighted audit must NOT flag it.
  write(
    root,
    "src/app/plain/page.tsx",
    [
      "export default function Page() {",
      '  return <div className="mx-auto flex flex-col gap-6 px-4 py-8" />;',
      "}",
      "",
    ].join("\n"),
  );
  // Unregistered component — a PascalCase-named component file co-located
  // OUTSIDE the component dirs. Not a rebuild: surfaced as an offer to
  // relocate/register, naming its export + file.
  write(
    root,
    "src/app/featured/FeaturedShell.tsx",
    [
      "export const FEATURED_TABS = ['summary'];",
      "export function FeaturedShell() {",
      '  return <div className="mx-auto flex flex-col gap-6 px-4 py-8 backdrop-blur-xl ring-2" />;',
      "}",
      "",
    ].join("\n"),
  );
  const audit = runComponentAudit(root);
  assert(
    audit.findings.some(
      (f) => f.kind === "inline-rebuild" && f.file === "src/app/promo/page.tsx" && f.component === "Hero",
    ),
    "audit flags the distinctive-class rebuild in a route file against Hero",
  );
  assert(
    !audit.findings.some((f) => f.file === "src/app/plain/page.tsx"),
    "audit does NOT flag a route file that shares only generic layout utilities",
  );
  const unreg = audit.findings.find(
    (f) => f.kind === "unregistered-component" && f.file === "src/app/featured/FeaturedShell.tsx",
  );
  assert(unreg !== undefined, "co-located PascalCase component is flagged as unregistered-component");
  assert(unreg!.component === "FeaturedShell", "the offer names the actual export (FeaturedShell)");
  assert(
    /FeaturedShell/.test(unreg!.message) && /FeaturedShell\.tsx/.test(unreg!.message),
    "the offer cites the export name and the actual file",
  );
  assert(
    !audit.findings.some(
      (f) => f.kind === "inline-rebuild" && f.file === "src/app/featured/FeaturedShell.tsx",
    ),
    "a misplaced component is NOT also mislabeled an inline-rebuild",
  );
  console.log("  ✓ single-app: index, gate, IDF audit, unregistered-component offer behave");
}

/* -------------------------------------------------------------------------- */
/* 1b. Export detection — multi-export files must not false-positive          */
/* -------------------------------------------------------------------------- */

function exportDetection(): void {
  step("Export detection — header matching any export is valid; a true non-export flags");
  const root = mkdtempSync(join(tmpdir(), "cairn-smoke-comp-export-"));
  cleanups.push(root);
  writeConfig(root, { componentDirs: ["src/components"], extensions: [".tsx"] });

  // Component file that ALSO exports a hook + a constant table, both declared
  // BEFORE the component. The header names the component — that is valid; the
  // old detector grabbed the first export (the hook/const) and false-flagged.
  write(
    root,
    "src/components/Foo.tsx",
    [
      "/**",
      " * @cairn Foo",
      " * @category forms",
      " * @purpose Foo form fields.",
      " * @aliases foo, foo form fields",
      " */",
      "export const FOO_TABLE = { a: 1 };",
      "export function useFoo() { return null; }",
      "export function Foo() { return null; }",
      "",
    ].join("\n"),
  );
  // True lie: header names something the file does not export at all.
  write(
    root,
    "src/components/Ghost.tsx",
    [
      "/**",
      " * @cairn Ghost",
      " * @category forms",
      " * @purpose Ghostly.",
      " * @aliases ghost, phantom",
      " */",
      "export function Real() { return null; }",
      "",
    ].join("\n"),
  );

  const r = runComponentCheck(root);
  assert(
    !r.findings.some(
      (f) => f.path === "src/components/Foo.tsx" && /is not an exported name/.test(f.message),
    ),
    "multi-export component (header matches a later export) does NOT false-positive",
  );
  assert(
    r.findings.some(
      (f) => f.path === "src/components/Ghost.tsx" && /is not an exported name/.test(f.message),
    ),
    "header naming a non-exported symbol IS flagged as export-mismatch",
  );
  assert(r.hardFailures === 0, `no hard failures expected (got ${r.hardFailures})`);
  console.log("  ✓ export detection: any-export match valid, genuine non-export flagged");
}

/* -------------------------------------------------------------------------- */
/* 2. Monorepo                                                                */
/* -------------------------------------------------------------------------- */

function monorepo(): void {
  step("Monorepo — manifest+slices, isolation, in-scope entitlement, dup-name scoping");
  const root = mkdtempSync(join(tmpdir(), "cairn-smoke-comp-mono-"));
  cleanups.push(root);

  writeConfig(root, {
    extensions: [".tsx"],
    workspaces: {
      platform: { componentDirs: ["platform/src/components"] },
      site: { componentDirs: ["site/src/components"] },
      ui: { componentDirs: ["packages/ui/src"], shared: true },
    },
  });

  // Same @cairn name in two ISOLATED workspaces — allowed (scoped per ws).
  write(root, "platform/src/components/Button.tsx", header("Button", "forms"));
  write(root, "site/src/components/Button.tsx", header("Button", "forms"));
  write(root, "packages/ui/src/Token.tsx", header("Token", "utility"));

  const build = buildComponentIndex(root);
  assert(build.workspaces === 3, "three workspaces");
  const manifest = readFileSync(join(root, ".cairn/ground/components/INDEX.md"), "utf8");
  assert(/Manifest/i.test(manifest), "monorepo INDEX is a manifest, not an inventory");
  assert(!manifest.includes("@purpose"), "manifest carries no inventory rows (no honeypot)");

  const platformSlice = readFileSync(
    join(root, ".cairn/ground/components/index/platform.md"),
    "utf8",
  );
  assert(platformSlice.includes("Button"), "platform slice lists its own Button");
  assert(platformSlice.includes("Token"), "platform slice includes the shared ui Token");
  assert(/OFF-LIMITS/.test(platformSlice), "platform slice names OFF-LIMITS isolated workspaces");
  assert(/\bsite\b/.test(platformSlice), "site is listed OFF-LIMITS from platform");

  // Dup name across isolated workspaces is allowed; check stays clean.
  const monoCheck = runComponentCheck(root);
  assert(monoCheck.hardFailures === 0, "duplicate name ACROSS workspaces is not a failure");

  // Within a single workspace, a duplicate @cairn name hard-fails.
  write(root, "platform/src/components/Button2.tsx", header("Button", "forms"));
  const dupCheck = runComponentCheck(root);
  assert(
    dupCheck.findings.some((f) => /duplicate @cairn name/.test(f.message)),
    "duplicate name WITHIN a workspace is a hard failure",
  );
  rmSync(join(root, "platform/src/components/Button2.tsx"));

  // in-scope entitlement: editing platform → platform + shared ui; site OFF-LIMITS.
  const scope = componentsInScope(root, ["platform/src/components/Button.tsx"]);
  assert(scope.workspaces.includes("platform"), "in-scope resolves the platform workspace");
  assert(scope.workspaces.includes("ui"), "in-scope includes the shared ui workspace");
  assert(scope.offLimits.includes("site"), "in-scope names site as OFF-LIMITS");
  assert(
    scope.components.every((c) => c.workspace === "platform" || c.workspace === "ui"),
    "in-scope inventory carries only entitled (own + shared) components",
  );
  assert(
    !scope.components.some((c) => c.workspace === "site"),
    "isolated site components never leak into the platform scope",
  );
  console.log("  ✓ monorepo: manifest/slices, isolation, entitlement, dup-name scoping hold");
}

/* -------------------------------------------------------------------------- */
/* 3. Pre-commit gate (staged narrowing)                                      */
/* -------------------------------------------------------------------------- */

function preCommit(): void {
  step("Pre-commit — staged component file missing a header blocks");
  const root = mkdtempSync(join(tmpdir(), "cairn-smoke-comp-precommit-"));
  cleanups.push(root);
  writeConfig(root, { componentDirs: ["src/components"], extensions: [".tsx"] });
  write(root, "src/components/Ok.tsx", header("Ok", "utility"));
  write(
    root,
    "src/components/Bad.tsx",
    "export function Bad() { return <div className=\"p-2\">bad</div>; }\n",
  );

  // Only the bad file is staged.
  const staged = runComponentCheck(root, { files: ["src/components/Bad.tsx"] });
  assert(staged.hardFailures >= 1, "staged missing-header blocks the commit");
  assert(
    staged.findings.every((f) => f.path === undefined || f.path === "src/components/Bad.tsx"),
    "only the staged file's findings surface",
  );
  console.log("  ✓ pre-commit: staged narrowing reports the blocking finding");
}

/* -------------------------------------------------------------------------- */
/* 4. Adoption trio (9d-comp-walk → 9e-comp-annotate → 9f-comp-emit)           */
/* -------------------------------------------------------------------------- */

async function adoption(): Promise<void> {
  step("Adoption — detect → walk → annotate → emit (index + singleton §INV + baseline)");
  const root = mkdtempSync(join(tmpdir(), "cairn-smoke-comp-adopt-"));
  cleanups.push(root);

  write(root, "src/components/AppShell.tsx", header("AppShell", "layout", " * @singleton"));
  write(
    root,
    "src/components/Card.tsx",
    "export function Card() { return <div className=\"grid gap-2\">card</div>; }\n",
  );

  const detection = {
    repo_root: root,
    project_slug: "smoke",
    origin_url: null,
    stack_signatures: [{ kind: "typescript" as const, marker: "tsconfig.json" }],
    start_command: null,
    hook_capability: "cli-only" as const,
    environment: { claude_auth: false },
  };
  // Component-layout detection is LLM-driven (convention-agnostic), so the
  // discovery quality is exercised by the opt-in real-LLM smoke
  // (`smoke:llm-detect-components`), not this deterministic gate. Here we
  // inject the config directly and assert the mechanical adoption pipeline
  // (walk → annotate → emit → baseline) end-to-end.
  writeConfig(root, { componentDirs: ["src/components"], extensions: [".tsx"] });

  const base = {
    repoRoot: root,
    outputs: { "1-detect": detection },
    startedAt: new Date().toISOString(),
    schemaVersion: 3 as const,
  };

  // Leg 1 — walk: lists the un-headered Card.tsx into the corpus.
  const walk = await runPhase9dCompWalk({
    ...base,
    currentPhase: "9d-comp-walk",
  } as never);
  assert(walk.status === "complete", `walk completes (got ${walk.status})`);
  assert(
    walk.status === "complete" && walk.nextPhase === "9e-comp-annotate",
    "walk advances to 9e-comp-annotate",
  );
  const walkOut = (walk as { state: { outputs: Record<string, Record<string, unknown>> } }).state
    .outputs["9d-comp-walk"]!;
  assert(walkOut.missing_count === 1, `walk lists the 1 missing header (got ${walkOut.missing_count as number})`);
  const corpus = readFileSync(join(root, ".cairn/init/components/missing.jsonl"), "utf8");
  assert(/Card\.tsx/.test(corpus), "corpus names Card.tsx");
  assert(/"export_name":"Card"/.test(corpus), "corpus carries the detected export name");

  // Leg 2 — annotate: no skill ran here, so Card stays un-headered.
  // The runner is tolerant: it counts and advances (still_missing=1).
  const annotate = await runPhase9eCompAnnotate({
    ...base,
    currentPhase: "9e-comp-annotate",
  } as never);
  assert(annotate.status === "complete", `annotate completes (got ${annotate.status})`);
  assert(
    annotate.status === "complete" && annotate.nextPhase === "9f-comp-emit",
    "annotate advances to 9f-comp-emit",
  );
  const annOut = (annotate as { state: { outputs: Record<string, Record<string, unknown>> } }).state
    .outputs["9e-comp-annotate"]!;
  assert(annOut.still_missing === 1, "annotate reports Card.tsx still missing (no subagent ran)");

  // Leg 3 — emit: index + singleton §INV + audit/missing baseline.
  const emit = await runPhase9fCompEmit({
    ...base,
    currentPhase: "9f-comp-emit",
  } as never);
  assert(emit.status === "complete", `emit completes (got ${emit.status})`);
  assert(
    emit.status === "complete" && emit.nextPhase === "10-rules-merge",
    "emit advances to 10-rules-merge",
  );
  const out = (emit as { state: { outputs: Record<string, Record<string, unknown>> } }).state
    .outputs["9f-comp-emit"]!;
  assert(out.indexed === 1, `indexed the 1 headered component (got ${out.indexed as number})`);
  assert(out.missing === 1, "missing-header debt counted (Card.tsx)");
  assert(out.singletons_drafted === 1, "AppShell singleton drafted to §INV");
  assert(typeof out.baseline_path === "string", "a baseline file was written for triage");

  // The singleton became a real invariant in the ledger.
  const invDir = join(root, ".cairn/ground/invariants");
  const ledger = readFileSync(join(invDir, "invariants.ledger.yaml"), "utf8");
  assert(/AppShell exists exactly once/.test(ledger), "singleton §INV titled + in the ledger");

  // The baseline carries both sensor rows.
  const baseline = readFileSync(join(root, out.baseline_path as string), "utf8");
  assert(/component-missing-header/.test(baseline), "baseline has the missing-header sensor row");
  assert(/Card\.tsx/.test(baseline), "baseline names the un-headered Card.tsx");
  console.log("  ✓ adoption trio: walk lists debt, annotate is tolerant, emit indexes + drafts singleton");
}

async function backfill(): Promise<void> {
  step("Backfill — ensureComponentsConfig guards + emitComponentStore on an already-adopted repo");

  // not-adopted: a bare dir with no .cairn/ refuses (early return, no LLM).
  const bare = mkdtempSync(join(tmpdir(), "cairn-smoke-comp-bare-"));
  cleanups.push(bare);
  assert(
    (await ensureComponentsConfig(bare)).status === "not-adopted",
    "no .cairn/config.yaml → not-adopted",
  );

  // exists: a repo that already carries a components: block is the
  // idempotent no-op path (early return, no LLM). Detection quality
  // (none for non-UI repos, written for UI repos, the monorepo flag) is
  // LLM-driven and lives in `smoke:llm-detect-components`, not this gate.
  const root = mkdtempSync(join(tmpdir(), "cairn-smoke-comp-backfill-"));
  cleanups.push(root);
  mkdirSync(join(root, ".cairn"), { recursive: true });
  writeFileSync(
    join(root, ".cairn", "config.yaml"),
    "project:\n  slug: demo\ncomponents:\n  componentDirs:\n    - src/components\n  extensions:\n    - .tsx\n",
    "utf8",
  );
  write(root, "src/components/AppShell.tsx", header("AppShell", "layout", " * @singleton"));
  write(
    root,
    "src/components/Card.tsx",
    "export function Card() { return <div className=\"grid gap-2\">card</div>; }\n",
  );

  const exists = await ensureComponentsConfig(root);
  assert(exists.status === "exists", `existing block → exists no-op (got ${exists.status})`);
  const cfgText = readFileSync(join(root, ".cairn", "config.yaml"), "utf8");
  assert(/^project:/m.test(cfgText), "the pre-existing project: key is preserved");
  assert(/^components:/m.test(cfgText), "the components: block is left intact");

  // emitComponentStore: same end state as adoption Phase 9f.
  const emit = emitComponentStore(root);
  assert(!emit.skipped, "emit runs (config present)");
  assert(emit.indexed === 1, `indexed the headered AppShell (got ${emit.indexed})`);
  assert(emit.missing === 1, "Card.tsx counted as missing-header debt");
  assert(emit.singletonsDrafted === 1, "AppShell singleton drafted to §INV");
  assert(emit.baselinePath !== null, "a baseline file was written for triage");

  const ledger = readFileSync(
    join(root, ".cairn/ground/invariants/invariants.ledger.yaml"),
    "utf8",
  );
  assert(/AppShell exists exactly once/.test(ledger), "singleton §INV landed in the ledger");
  const index = readFileSync(join(root, ".cairn/ground/components/INDEX.md"), "utf8");
  assert(/AppShell/.test(index), "INDEX lists the indexed component");
  console.log("  ✓ backfill: guards (not-adopted / exists no-op), emit reaches the 9f end state");
}

async function main(): Promise<void> {
  singleApp();
  exportDetection();
  monorepo();
  preCommit();
  await adoption();
  await backfill();
  cleanup();
  console.log("\nsmoke-components — pass");
}

main().catch((err) => {
  console.error("smoke-components — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});

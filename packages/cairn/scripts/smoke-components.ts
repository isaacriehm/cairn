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
  detectComponentsConfig,
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

  write(root, "src/components/AppNav.tsx", header("AppNav", "navigation", " * @singleton"));
  write(
    root,
    "src/components/Hero.tsx",
    [
      "/**",
      " * @cairn Hero",
      " * @category marketing",
      " * @purpose Landing hero section.",
      " * @aliases hero, banner, splash",
      " */",
      "export function Hero() {",
      '  return <div className="max-w-2xl mx-auto px-4 py-8 flex flex-col gap-6" />;',
      "}",
      "",
    ].join("\n"),
  );

  const build = buildComponentIndex(root);
  assert(build.total === 2, `index counts 2 components (got ${build.total})`);
  assert(build.missing === 0, "no missing headers yet");
  const index = readFileSync(join(root, ".cairn/ground/components/INDEX.md"), "utf8");
  assert(/AppNav \[S\]/.test(index), "INDEX marks AppNav as a [S] singleton");
  assert(index.includes("## marketing"), "INDEX groups by category");

  const clean = runComponentCheck(root);
  assert(clean.hardFailures === 0, `clean check has no hard failures (got ${clean.hardFailures})`);

  // Drop a header → missing-header hard finding.
  write(root, "src/components/Card.tsx", "export function Card() { return null; }\n");
  const dirty = runComponentCheck(root);
  assert(dirty.hardFailures >= 1, "missing-header is a hard failure");
  assert(
    dirty.findings.some((f) => f.path === "src/components/Card.tsx"),
    "the missing-header finding names Card.tsx",
  );

  // Inline rebuild in a non-component page → audit advisory (exit-0 surface).
  write(
    root,
    "src/pages/Landing.tsx",
    [
      "export function Landing() {",
      '  return <div className="max-w-4xl mx-auto px-6 py-12 flex flex-col gap-8" />;',
      "}",
      "",
    ].join("\n"),
  );
  // Landing lives outside componentDirs, so it must be scanned for rebuilds —
  // the audit walks the whole tree. Hero's class roots match Landing's.
  const audit = runComponentAudit(root);
  assert(
    audit.findings.some(
      (f) => f.kind === "inline-rebuild" && f.file === "src/pages/Landing.tsx",
    ),
    "audit flags the inline rebuild in Landing.tsx against Hero",
  );
  console.log("  ✓ single-app: index, gate, advisory audit all behave");
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
  write(root, "src/components/Bad.tsx", "export function Bad() { return null; }\n");

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
  write(root, "src/components/Card.tsx", "export function Card() { return null; }\n");

  const detection = {
    repo_root: root,
    project_slug: "smoke",
    origin_url: null,
    stack_signatures: [{ kind: "typescript" as const, marker: "tsconfig.json" }],
    proposed_sensors: [],
    start_command: null,
    hook_capability: "cli-only" as const,
    environment: { claude_auth: false },
  };
  const detected = detectComponentsConfig(root, detection);
  assert(detected !== null, "detection finds the single-app component dir");
  assert(
    (detected as { componentDirs?: string[] }).componentDirs?.includes("src/components") === true,
    "detection proposes src/components",
  );
  writeConfig(root, detected);

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

async function main(): Promise<void> {
  singleApp();
  monorepo();
  preCommit();
  await adoption();
  cleanup();
  console.log("\nsmoke-components — pass");
}

main().catch((err) => {
  console.error("smoke-components — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});

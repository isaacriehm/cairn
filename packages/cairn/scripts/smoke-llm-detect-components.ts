#!/usr/bin/env tsx
/**
 * smoke-llm-detect-components — opt-in real-LLM regression for the
 * convention-AGNOSTIC component-layout detector.
 *
 * Burns operator quota (real Sonnet via `runClaude`) — NOT part of
 * `pnpm smokes`. Run when touching `detect-components.ts`'s prompt/schema
 * or the Sonnet model alias. Mirrors `smoke:llm-prompt-eval`'s contract:
 * if a case flips, surface the failure — do not weaken the assertions.
 *
 * The whole point of the detector is that it owns NO convention list, so
 * every fixture deliberately AVOIDS the obvious names (no `src/components`,
 * no `packages/`): a component dir called `ui/widgets`, workspaces sitting
 * at the repo root, a backend that must be excluded. If the model can only
 * find components when they live in `src/components`, these fail.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectComponentsConfig } from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function cleanup(): void {
  for (const d of cleanups) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    cleanup();
    process.exit(1);
  }
}

function w(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

const COMPONENT = (name: string): string =>
  `export function ${name}() {\n  return <div className="${name.toLowerCase()}" />;\n}\n`;
const SERVICE = (name: string): string =>
  `export class ${name} {\n  run() { return ${JSON.stringify(name)}; }\n}\n`;

/** Flatten a config's component dirs across flat + workspace forms. */
function allDirs(cfg: {
  componentDirs?: string[];
  workspaces?: Record<string, { componentDirs?: string[] }>;
}): string[] {
  const out: string[] = [...(cfg.componentDirs ?? [])];
  for (const ws of Object.values(cfg.workspaces ?? {})) {
    out.push(...(ws.componentDirs ?? []));
  }
  return out;
}

function step(s: string): void {
  console.log(`\n▸ ${s}`);
}

/* -------------------------------------------------------------------------- */
/* Case 1 — top-level workspaces, NON-conventional component dir names.        */
/*          This is the layout that regressed: workspaces at the repo root     */
/*          (no packages/ wrapper) + a backend workspace that must be excluded.*/
/* -------------------------------------------------------------------------- */

async function topLevelWorkspaces(): Promise<void> {
  step("Top-level workspaces (root-level packages, ui/widgets dir, backend excluded)");
  const root = mkdtempSync(join(tmpdir(), "cairn-llm-detect-mono-"));
  cleanups.push(root);

  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    "packages:\n  - web\n  - admin\n  - api\n",
    "utf8",
  );

  // web — a marketing-ish frontend, components under ui/widgets (NOT "components").
  w(root, "web/package.json", '{ "name": "web" }\n');
  for (const c of ["Hero", "PricingCard", "NavBar"]) {
    w(root, `web/ui/widgets/${c}.tsx`, COMPONENT(c));
  }
  w(root, "web/ui/pages/Home.tsx", COMPONENT("Home"));

  // admin — an app shell, components under app/elements.
  w(root, "admin/package.json", '{ "name": "admin" }\n');
  for (const c of ["Sidebar", "DataGrid", "Modal"]) {
    w(root, `admin/app/elements/${c}.tsx`, COMPONENT(c));
  }

  // api — a backend workspace, NO components. Must be excluded entirely.
  w(root, "api/package.json", '{ "name": "api" }\n');
  for (const s of ["UserService", "AuthService", "BillingService"]) {
    w(root, `api/src/services/${s}.ts`, SERVICE(s));
  }

  const cfg = await detectComponentsConfig(root);
  assert(cfg !== null, "monorepo with UI workspaces detected (not null)");
  const dirs = allDirs(cfg!);
  assert(dirs.length > 0, "at least one component dir found");
  assert(
    dirs.some((d) => d.startsWith("web/")),
    `web workspace's component dir found (got ${JSON.stringify(dirs)})`,
  );
  assert(
    dirs.some((d) => d.startsWith("admin/")),
    `admin workspace's component dir found (got ${JSON.stringify(dirs)})`,
  );
  assert(
    !dirs.some((d) => d.startsWith("api/")),
    `backend (api/) is NOT registered as a component dir (got ${JSON.stringify(dirs)})`,
  );
  console.log(`  ✓ detected dirs: ${JSON.stringify(dirs)}`);
}

/* -------------------------------------------------------------------------- */
/* Case 2 — single app, non-conventional dir name.                             */
/* -------------------------------------------------------------------------- */

async function singleApp(): Promise<void> {
  step("Single app (components under source/elements, not src/components)");
  const root = mkdtempSync(join(tmpdir(), "cairn-llm-detect-single-"));
  cleanups.push(root);
  w(root, "package.json", '{ "name": "app" }\n');
  for (const c of ["Button", "Card", "Avatar", "Tooltip"]) {
    w(root, `source/elements/${c}.tsx`, COMPONENT(c));
  }

  const cfg = await detectComponentsConfig(root);
  assert(cfg !== null, "single-app UI repo detected (not null)");
  const dirs = allDirs(cfg!);
  assert(
    dirs.some((d) => d.includes("source/elements")),
    `the non-conventional component dir is found (got ${JSON.stringify(dirs)})`,
  );
  console.log(`  ✓ detected dirs: ${JSON.stringify(dirs)}`);
}

/* -------------------------------------------------------------------------- */
/* Case 3 — non-UI repo → null.                                                */
/* -------------------------------------------------------------------------- */

async function nonUi(): Promise<void> {
  step("Non-UI backend (only .ts services + db) → null");
  const root = mkdtempSync(join(tmpdir(), "cairn-llm-detect-nonui-"));
  cleanups.push(root);
  w(root, "package.json", '{ "name": "backend" }\n');
  for (const s of ["UserService", "OrderService", "PaymentService", "MailService"]) {
    w(root, `src/${s}.ts`, SERVICE(s));
  }
  w(root, "src/db/schema.ts", "export const users = {};\n");

  const cfg = await detectComponentsConfig(root);
  assert(cfg === null, `backend-only repo returns null (got ${JSON.stringify(cfg)})`);
  console.log("  ✓ non-UI repo correctly returns null");
}

async function main(): Promise<void> {
  console.log("== smoke-llm-detect-components (real Sonnet — burns quota) ==");
  await topLevelWorkspaces();
  await singleApp();
  await nonUi();
  cleanup();
  console.log("\n✓ smoke-llm-detect-components passed");
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});

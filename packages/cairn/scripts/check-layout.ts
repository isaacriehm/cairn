#!/usr/bin/env tsx
/**
 * check-layout — Phase 1 sensor (post-split layout).
 *
 * Validates the four-package skeleton + the umbrella + the templates that
 * ship with the published cairn-core package. See docs/ARCHITECTURE.md
 * §3 for the layered model.
 *
 * Run: pnpm -F @isaacriehm/cairn check:layout
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

type Severity = "hard" | "soft";
type Finding = { severity: Severity; path: string; reason: string };

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const findings: Finding[] = [];

function fail(severity: Severity, path: string, reason: string): void {
  findings.push({ severity, path, reason });
}

function checkDir(relPath: string, severity: Severity = "hard"): void {
  const abs = resolve(repoRoot, relPath);
  if (!existsSync(abs)) {
    fail(severity, relPath, "directory missing");
    return;
  }
  if (!statSync(abs).isDirectory()) {
    fail(severity, relPath, "exists but is not a directory");
  }
}

function checkFile(
  relPath: string,
  opts: { requireFrontmatter?: boolean; requireYaml?: boolean; severity?: Severity } = {},
): void {
  const severity = opts.severity ?? "hard";
  const abs = resolve(repoRoot, relPath);
  if (!existsSync(abs)) {
    fail(severity, relPath, "file missing");
    return;
  }
  if (!statSync(abs).isFile()) {
    fail(severity, relPath, "exists but is not a file");
    return;
  }
  const body = readFileSync(abs, "utf8");
  if (body.trim().length === 0) {
    fail(severity, relPath, "file is empty");
    return;
  }
  if (opts.requireFrontmatter) {
    if (!/^---\s*\n[\s\S]*?\n---\s*\n/.test(body)) {
      fail(severity, relPath, "missing YAML frontmatter (--- ... ---)");
    }
  }
  if (opts.requireYaml) {
    if (!/^[a-zA-Z_][\w-]*\s*:/m.test(body)) {
      fail(severity, relPath, "does not look like a YAML document (no top-level key:)");
    }
  }
}

// ── Templates that ship inside cairn-core ───────────────────────────────
const templateRoot = "packages/cairn-core/templates";

const requiredTemplateDirs: string[] = [
  templateRoot,
  `${templateRoot}/.cairn`,
  `${templateRoot}/.cairn/config`,
  `${templateRoot}/.cairn/ground`,
];
for (const d of requiredTemplateDirs) checkDir(d);

checkFile(`${templateRoot}/README.md`);
checkFile(`${templateRoot}/.cairn/config/workflow.md`, {
  requireFrontmatter: true,
});
checkFile(`${templateRoot}/.cairn/config/sensors.yaml`, { requireYaml: true });
checkFile(`${templateRoot}/.cairn/config/stub-patterns.yaml`, { requireYaml: true });
checkFile(`${templateRoot}/.cairn/config/trust-policy.yaml`, { requireYaml: true });
checkFile(`${templateRoot}/.cairn/ground/manifest.yaml`, { requireYaml: true });

// ── Required project root files ────────────────────────────────────────────
checkFile("package.json");
checkFile("pnpm-workspace.yaml");
checkFile("tsconfig.base.json");
checkFile("tsconfig.json");
checkFile(".gitignore");
checkFile(".nvmrc");
checkFile("CLAUDE.md");
checkFile("README.md");

// ── Umbrella packages/cairn/ ─────────────────────────────────────────────
checkFile("packages/cairn/package.json");
checkFile("packages/cairn/tsconfig.json");
checkFile("packages/cairn/README.md");
checkFile("packages/cairn/src/index.ts");
checkFile("packages/cairn/src/cli/index.ts");
checkFile("packages/cairn/src/cli/init.ts");
checkFile("packages/cairn/src/cli/mcp.ts");
checkFile("packages/cairn/src/cli/gc.ts");

// ── cairn-core (state + context) ─────────────────────────────────────────
const corePkg = "packages/cairn-core";
checkFile(`${corePkg}/package.json`);
checkFile(`${corePkg}/tsconfig.json`);
checkFile(`${corePkg}/src/index.ts`);
checkFile(`${corePkg}/src/logger.ts`);
checkFile(`${corePkg}/src/prompt.ts`);

// paths (slug + project state path utilities; mirror/ moved to _dormant)
checkFile(`${corePkg}/src/paths/index.ts`);

// ground
checkFile(`${corePkg}/src/ground/index.ts`);
checkFile(`${corePkg}/src/ground/schemas.ts`);
checkFile(`${corePkg}/src/ground/paths.ts`);
checkFile(`${corePkg}/src/ground/glob.ts`);
checkFile(`${corePkg}/src/ground/walk.ts`);
checkFile(`${corePkg}/src/ground/frontmatter.ts`);
checkFile(`${corePkg}/src/ground/manifest.ts`);
checkFile(`${corePkg}/src/ground/ledgers.ts`);
checkFile(`${corePkg}/src/ground/drift.ts`);
checkFile(`${corePkg}/src/ground/quality-grades.ts`);

// profiles
checkFile(`${corePkg}/src/profiles/index.ts`);
checkFile(`${corePkg}/src/profiles/types.ts`);
checkFile(`${corePkg}/src/profiles/registry.ts`);
checkFile(`${corePkg}/src/profiles/unknown.ts`);

// mcp
checkFile(`${corePkg}/src/mcp/index.ts`);
checkFile(`${corePkg}/src/mcp/server.ts`);
checkFile(`${corePkg}/src/mcp/context.ts`);
checkFile(`${corePkg}/src/mcp/errors.ts`);
checkFile(`${corePkg}/src/mcp/result.ts`);
checkFile(`${corePkg}/src/mcp/path-allowlist.ts`);
checkFile(`${corePkg}/src/mcp/telemetry.ts`);
checkFile(`${corePkg}/src/mcp/schemas.ts`);
checkFile(`${corePkg}/src/mcp/tools/index.ts`);
checkFile(`${corePkg}/src/mcp/tools/types.ts`);
for (const tool of [
  "decision-get",
  "decisions-in-scope",
  "decisions-for-symbol",
  "supersedes-chain",
  "invariant-get",
  "invariants-in-scope",
  "canonical-for-topic",
  "ground-get",
  "get-full",
  "search",
  "record-decision",
  "resolve-attention",
  "init-phases",
]) {
  checkFile(`${corePkg}/src/mcp/tools/${tool}.ts`);
}
checkFile(`${corePkg}/templates/.cairn/ground/canonical-map/topics.yaml`, {
  requireYaml: true,
});

// claude / decision-capture / gc / init / sensors
for (const sub of [
  "claude",
  "decision-capture",
  "gc",
  "init",
  "sensors",
]) {
  checkFile(`${corePkg}/src/${sub}/index.ts`);
}

// ── cairn-runtime + cairn-frontend-discord ────────────────────────────
// Both moved to _dormant/ per docs/PLUGIN_ARCHITECTURE.md §16. Not part of
// the active build. No layout check.

// ── cairn-core's `files` field must include templates so they ship ──────
const corePkgJson = JSON.parse(
  readFileSync(resolve(repoRoot, `${corePkg}/package.json`), "utf8"),
) as { files?: string[] };
if (!corePkgJson.files?.includes("templates")) {
  fail(
    "hard",
    `${corePkg}/package.json`,
    'missing "templates" in `files` field — templates would not ship on npm publish',
  );
}

// ── Report ─────────────────────────────────────────────────────────────────
const hardFails = findings.filter((f) => f.severity === "hard");
const softFails = findings.filter((f) => f.severity === "soft");

if (findings.length === 0) {
  console.log("check-layout: OK — pkg source + templates are well-formed");
  process.exit(0);
}

console.error(`check-layout: ${hardFails.length} hard, ${softFails.length} soft`);
for (const f of findings) {
  console.error(`  [${f.severity}] ${f.path} — ${f.reason}`);
}
process.exit(hardFails.length > 0 ? 1 : 0);

#!/usr/bin/env tsx
/**
 * check-layout — Phase 1 sensor (post-split layout).
 *
 * Validates the four-package skeleton + the umbrella + the templates that
 * ship with the published harness-core package. See docs/ARCHITECTURE.md
 * §3 for the layered model.
 *
 * Run: pnpm -F @isaacriehm/harness check:layout
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

type Severity = "hard" | "soft";
type Finding = { severity: Severity; path: string; reason: string };

const repoRoot = resolve(import.meta.dirname, "..", "..");
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

// ── Templates that ship inside harness-core ───────────────────────────────
const templateRoot = "packages/harness-core/templates";

const requiredTemplateDirs: string[] = [
  templateRoot,
  `${templateRoot}/.harness`,
  `${templateRoot}/.harness/config`,
  `${templateRoot}/.harness/ground`,
  `${templateRoot}/.archive`,
];
for (const d of requiredTemplateDirs) checkDir(d);

checkFile(`${templateRoot}/README.md`);
checkFile(`${templateRoot}/.harness/config/workflow.md`, {
  requireFrontmatter: true,
});
checkFile(`${templateRoot}/.harness/config/sensors.yaml`, { requireYaml: true });
checkFile(`${templateRoot}/.harness/config/stub-patterns.yaml`, { requireYaml: true });
checkFile(`${templateRoot}/.harness/config/trust-policy.yaml`, { requireYaml: true });
checkFile(`${templateRoot}/.harness/ground/manifest.yaml`, { requireYaml: true });
checkFile(`${templateRoot}/.archive/README.md`, { requireFrontmatter: true });

// ── Project-agnostic check: no hardcoded "sample-project" string in pkg / template ─
const banned = ["sample-project", "Sample project", "SAMPLE-PROJECT"];
const pkgScanGlobs = [
  "packages/harness-core/src",
  "packages/harness-core/templates",
  "packages/harness-runtime/src",
  "packages/harness-frontend-discord/src",
  "packages/harness-frontend-stub/src",
  "harness/src",
  "harness/scripts",
];
function walk(absDir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = resolve(absDir, entry.name);
    if (entry.isDirectory()) walk(abs, files);
    else files.push(abs);
  }
  return files;
}
const selfPath = resolve(repoRoot, "harness/scripts/check-layout.ts");
for (const g of pkgScanGlobs) {
  const abs = resolve(repoRoot, g);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs)) {
    if (file === selfPath) continue;
    const body = readFileSync(file, "utf8");
    for (const term of banned) {
      const idx = body.indexOf(term);
      if (idx !== -1) {
        const line = body.slice(0, idx).split("\n").length;
        fail(
          "hard",
          file.replace(`${repoRoot}/`, ""),
          `contains banned project-name "${term}" at line ${line} (per L50 — pkg code must be project-agnostic)`,
        );
      }
    }
  }
}

// ── Required project root files ────────────────────────────────────────────
checkFile("package.json");
checkFile("pnpm-workspace.yaml");
checkFile("tsconfig.base.json");
checkFile("tsconfig.json");
checkFile(".gitignore");
checkFile(".nvmrc");
checkFile("AGENTS.md");
checkFile("README.md");

// ── Umbrella harness/ ──────────────────────────────────────────────────────
checkFile("harness/package.json");
checkFile("harness/tsconfig.json");
checkFile("harness/README.md");
checkFile("harness/src/index.ts");
checkFile("harness/src/cli/index.ts");
checkFile("harness/src/cli/init.ts");
checkFile("harness/src/cli/run.ts");
checkFile("harness/src/cli/watch.ts");
checkFile("harness/src/cli/mirror.ts");
checkFile("harness/src/cli/mcp.ts");
checkFile("harness/src/cli/gc.ts");
checkFile("harness/src/cli/task.ts");
checkFile("harness/src/cli/daemon.ts");
checkFile("harness/src/cli/install.ts");

// ── harness-core (state + context) ─────────────────────────────────────────
const corePkg = "packages/harness-core";
checkFile(`${corePkg}/package.json`);
checkFile(`${corePkg}/tsconfig.json`);
checkFile(`${corePkg}/src/index.ts`);
checkFile(`${corePkg}/src/logger.ts`);
checkFile(`${corePkg}/src/prompt.ts`);
checkFile(`${corePkg}/src/inbox.ts`);
checkFile(`${corePkg}/src/frontend-types.ts`);

// mirror
checkFile(`${corePkg}/src/mirror/index.ts`);
checkFile(`${corePkg}/src/mirror/types.ts`);
checkFile(`${corePkg}/src/mirror/paths.ts`);
checkFile(`${corePkg}/src/mirror/state.ts`);
checkFile(`${corePkg}/src/mirror/clone.ts`);
checkFile(`${corePkg}/src/mirror/sync.ts`);
checkFile(`${corePkg}/src/mirror/push.ts`);
checkFile(`${corePkg}/src/mirror/dirty-overlap.ts`);

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
  "timeline",
  "query-history",
  "append",
  "record-run-event",
  "drop-task",
  "archive",
  "record-decision",
]) {
  checkFile(`${corePkg}/src/mcp/tools/${tool}.ts`);
}
checkFile(`${corePkg}/templates/.harness/ground/canonical-map/topics.yaml`, {
  requireYaml: true,
});

// claude / tier0 / tightener / decision-capture / gc / init / sensors / voice
for (const sub of [
  "claude",
  "decision-capture",
  "gc",
  "init",
  "sensors",
  "tier0",
  "tightener",
  "voice",
]) {
  checkFile(`${corePkg}/src/${sub}/index.ts`);
}

// ── harness-runtime (orchestration) ────────────────────────────────────────
const runtimePkg = "packages/harness-runtime";
checkFile(`${runtimePkg}/package.json`);
checkFile(`${runtimePkg}/tsconfig.json`);
checkFile(`${runtimePkg}/src/index.ts`);
for (const sub of ["backprop", "orchestrator", "reviewer", "uat", "watch"]) {
  checkFile(`${runtimePkg}/src/${sub}/index.ts`);
}

// ── harness-frontend-discord ───────────────────────────────────────────────
const discordPkg = "packages/harness-frontend-discord";
checkFile(`${discordPkg}/package.json`);
checkFile(`${discordPkg}/tsconfig.json`);
checkFile(`${discordPkg}/src/index.ts`);
checkFile(`${discordPkg}/src/discord/index.ts`);
checkFile(`${discordPkg}/src/discord/acl.ts`);
checkFile(`${discordPkg}/src/discord/channels.ts`);
checkFile(`${discordPkg}/src/discord/classifier.ts`);
checkFile(`${discordPkg}/src/discord/slash.ts`);

// ── harness-frontend-stub ──────────────────────────────────────────────────
const stubPkg = "packages/harness-frontend-stub";
checkFile(`${stubPkg}/package.json`);
checkFile(`${stubPkg}/tsconfig.json`);
checkFile(`${stubPkg}/src/index.ts`);
checkFile(`${stubPkg}/src/stub/index.ts`);

// ── harness-core's `files` field must include templates so they ship ──────
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

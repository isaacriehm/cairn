#!/usr/bin/env tsx
/**
 * check-layout — Phase 1 sensor.
 *
 * The Harness package source repo is NOT self-hosted. It only ships:
 *   1. The runtime code under harness/src/
 *   2. The init-time templates under harness/templates/, which the init script
 *      copies into adopting projects' .harness/ and .archive/ directories.
 *
 * This sensor validates that:
 *   • the templates tree is present and well-formed
 *   • the workspace package's source files exist
 *   • the repo root config (tsconfig, package.json, etc.) is in place
 *
 * Run: pnpm -F @devplusllc/harness check:layout
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

// ── Templates that ship with the published npm package ────────────────────
const templateRoot = "harness/templates";

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

// ── Project-agnostic check: no hardcoded "mypal" string in any pkg / template
// (per L50, operator answer S1).
const banned = ["mypal", "Mypal", "MYPAL"];
const pkgScanGlobs = ["harness/src", "harness/scripts", "harness/templates"];
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

// ── Required harness/ workspace files ──────────────────────────────────────
checkFile("harness/package.json");
checkFile("harness/tsconfig.json");
checkFile("harness/.env.example");
checkFile("harness/README.md");
checkFile("harness/src/index.ts");
checkFile("harness/src/cli/index.ts");

// ── Pkg's `files` field must include templates so they ship on npm publish ─
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "harness/package.json"), "utf8")) as {
  files?: string[];
};
if (!pkg.files?.includes("templates")) {
  fail(
    "hard",
    "harness/package.json",
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

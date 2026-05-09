#!/usr/bin/env node
/**
 * sync-version — single source of truth for the Cairn version across the
 * monorepo.
 *
 * The truth lives in `packages/cairn/package.json`'s `version` field.
 * Every other version field in the repo is synced from there:
 *
 *   - packages/cairn-core/package.json
 *   - packages/cairn-frontend-claudecode/package.json
 *   - packages/cairn-lens/package.json
 *   - packages/cairn-frontend-claudecode/.claude-plugin/plugin.json
 *   - .claude-plugin/marketplace.json   (metadata.version + plugins[].version)
 *
 * Usage:
 *
 *   node scripts/sync-version.mjs              # write mode — sync all targets
 *   node scripts/sync-version.mjs --check      # CI mode — exit 1 on drift
 *   node scripts/sync-version.mjs --set 0.2.0  # set source version + sync
 *   node scripts/sync-version.mjs --bump patch # patch-bump source + sync
 *   node scripts/sync-version.mjs --bump minor
 *   node scripts/sync-version.mjs --bump major
 *
 * Run via `pnpm version:sync`, `pnpm version:check`, `pnpm release:patch` etc.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_OF_TRUTH = "packages/cairn/package.json";

/**
 * Each target = a path + a `set(json, version)` mutator + a `get(json)` reader.
 * The reader is what we compare against in --check mode.
 */
const TARGETS = [
  pkgJsonTarget("packages/cairn/package.json"),
  pkgJsonTarget("packages/cairn-core/package.json"),
  pkgJsonTarget("packages/cairn-state/package.json"),
  pkgJsonTarget("packages/cairn-frontend-claudecode/package.json"),
  pkgJsonTarget("packages/cairn-lens/package.json"),
  pkgJsonTarget("packages/cairn-frontend-claudecode/.claude-plugin/plugin.json"),
  {
    path: ".claude-plugin/marketplace.json",
    get: (json) => [
      ["metadata.version", json.metadata?.version],
      ...((json.plugins ?? []).map((p, i) => [`plugins[${i}=${p.name}].version`, p.version])),
    ],
    set: (json, version) => {
      if (json.metadata !== undefined && json.metadata !== null) {
        json.metadata.version = version;
      }
      if (Array.isArray(json.plugins)) {
        for (const p of json.plugins) {
          if (p && typeof p === "object" && p.name === "cairn") {
            p.version = version;
          }
        }
      }
    },
  },
];

function pkgJsonTarget(path) {
  return {
    path,
    get: (json) => [["version", json.version]],
    set: (json, version) => {
      json.version = version;
    },
  };
}

function readJson(rel) {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"));
}

function writeJson(rel, json) {
  const out = JSON.stringify(json, null, 2) + "\n";
  writeFileSync(join(REPO_ROOT, rel), out, "utf8");
}

function bump(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version);
  if (!m) throw new Error(`source version not semver: ${version}`);
  let [, major, minor, patch] = m;
  major = Number(major); minor = Number(minor); patch = Number(patch);
  switch (kind) {
    case "major": return `${major + 1}.0.0`;
    case "minor": return `${major}.${minor + 1}.0`;
    case "patch": return `${major}.${minor}.${patch + 1}`;
    default: throw new Error(`unknown bump kind: ${kind}`);
  }
}

function parseArgs(argv) {
  const args = { mode: "write", setVersion: null, bumpKind: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.mode = "check";
    else if (a === "--set") { args.mode = "set"; args.setVersion = argv[++i]; }
    else if (a === "--bump") { args.mode = "bump"; args.bumpKind = argv[++i]; }
    else if (a === "--help" || a === "-h") {
      console.error("Usage: sync-version.mjs [--check|--set X.Y.Z|--bump patch|minor|major]");
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // Read current source of truth.
  const sourceJson = readJson(SOURCE_OF_TRUTH);
  let target = sourceJson.version;

  // Decide what version we're aiming for.
  if (args.mode === "set") {
    if (!/^\d+\.\d+\.\d+/.test(args.setVersion ?? "")) {
      console.error(`--set requires X.Y.Z, got ${args.setVersion}`);
      process.exit(2);
    }
    target = args.setVersion;
  } else if (args.mode === "bump") {
    target = bump(sourceJson.version, args.bumpKind);
  }

  // Walk every target. In --check mode we report drift; otherwise we write.
  let drift = 0;
  let touched = 0;
  for (const t of TARGETS) {
    const json = readJson(t.path);
    const before = t.get(json);
    const mismatches = before.filter(([, v]) => v !== target);
    if (args.mode === "check") {
      if (mismatches.length > 0) {
        console.error(`✗ ${t.path}`);
        for (const [field, v] of mismatches) {
          console.error(`    ${field}: ${JSON.stringify(v)} (expected ${JSON.stringify(target)})`);
        }
        drift += mismatches.length;
      }
      continue;
    }
    if (mismatches.length === 0) continue;
    t.set(json, target);
    writeJson(t.path, json);
    touched += 1;
    console.log(`✓ ${t.path} → ${target}`);
  }

  if (args.mode === "check") {
    if (drift > 0) {
      console.error(`\nversion drift: ${drift} field(s) out of sync with ${SOURCE_OF_TRUTH} (${sourceJson.version}).`);
      console.error(`fix: pnpm version:sync`);
      process.exit(1);
    }
    console.log(`✓ versions in sync at ${sourceJson.version}`);
    return;
  }

  if (args.mode === "write" && touched === 0) {
    console.log(`✓ already synced at ${target}`);
    return;
  }
  console.log(`\nsynced ${touched + 1} file(s) to ${target}`);
}

main();

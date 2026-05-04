#!/usr/bin/env node
/**
 * check-layout — validates the harness-frontend-claudecode plugin layout.
 *
 * Confirms manifest + mcp + hooks files parse as JSON with expected
 * shape, and that referenced bin scripts exist under harness-core/dist.
 * Runs as the package's `build` step so `pnpm -r build` flags layout
 * regressions.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const HARNESS_CORE_DIST = resolve(PKG_ROOT, "..", "harness-core", "dist");

const errors = [];

function fail(message) {
  errors.push(message);
}

function readJson(path) {
  if (!existsSync(path)) {
    fail(`missing: ${path}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`invalid JSON: ${path} — ${err.message}`);
    return null;
  }
}

// ── plugin.json ─────────────────────────────────────────────────────
const manifest = readJson(join(PKG_ROOT, ".claude-plugin", "plugin.json"));
if (manifest) {
  for (const key of ["name", "version", "description"]) {
    if (typeof manifest[key] !== "string" || manifest[key].length === 0) {
      fail(`plugin.json: ${key} is required and must be a non-empty string`);
    }
  }
  if (manifest.name !== "harness") {
    fail(`plugin.json: name must be "harness", got ${manifest.name}`);
  }
}

// ── .mcp.json ───────────────────────────────────────────────────────
const mcp = readJson(join(PKG_ROOT, ".mcp.json"));
if (mcp) {
  const server = mcp?.mcpServers?.harness;
  if (!server || typeof server !== "object") {
    fail(".mcp.json: mcpServers.harness must be an object");
  } else {
    if (server.command !== "node") fail(".mcp.json: harness.command must be 'node'");
    if (!Array.isArray(server.args) || server.args.length !== 1) {
      fail(".mcp.json: harness.args must be a single-arg array");
    } else {
      const arg = server.args[0];
      if (!arg.includes("${CLAUDE_PLUGIN_ROOT}/../harness-core/dist/mcp/")) {
        fail(`.mcp.json: harness.args[0] must reference harness-core/dist/mcp, got ${arg}`);
      }
      const localBin = arg.replace("${CLAUDE_PLUGIN_ROOT}/../harness-core/dist/", "");
      if (!existsSync(join(HARNESS_CORE_DIST, localBin))) {
        fail(`.mcp.json: bin not found at ${join(HARNESS_CORE_DIST, localBin)}`);
      }
    }
  }
}

// ── hooks/hooks.json ────────────────────────────────────────────────
const hooks = readJson(join(PKG_ROOT, "hooks", "hooks.json"));
if (hooks) {
  for (const event of ["SessionStart", "SessionEnd", "Stop", "PostToolUse"]) {
    if (!Array.isArray(hooks[event]) || hooks[event].length === 0) {
      fail(`hooks.json: ${event} must be a non-empty array`);
    }
  }
  // Walk every command and verify it points at an existing dist/hooks/<x>.js.
  const visit = (event, entries) => {
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        if (hook.type !== "command" || typeof hook.command !== "string") {
          fail(`hooks.json: ${event}: each hook must have type=command + string command`);
          continue;
        }
        const m = hook.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/\.\.\/harness-core\/dist\/(hooks\/[a-z-]+\.js)/);
        if (!m) {
          fail(`hooks.json: ${event}: command must reference harness-core/dist/hooks/<x>.js, got ${hook.command}`);
          continue;
        }
        const localBin = m[1];
        if (!existsSync(join(HARNESS_CORE_DIST, localBin))) {
          fail(`hooks.json: ${event}: bin missing at ${join(HARNESS_CORE_DIST, localBin)}`);
        }
      }
    }
  };
  for (const event of ["SessionStart", "SessionEnd", "Stop", "PostToolUse"]) {
    if (Array.isArray(hooks[event])) visit(event, hooks[event]);
  }
}

// ── component dirs (skills/agents/commands) ─────────────────────────
for (const dir of ["skills", "agents", "commands"]) {
  if (!existsSync(join(PKG_ROOT, dir))) fail(`missing component dir: ${dir}/`);
}

if (errors.length > 0) {
  console.error("check-layout: FAIL");
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log("check-layout: OK — plugin layout valid");

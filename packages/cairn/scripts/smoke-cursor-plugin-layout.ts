#!/usr/bin/env tsx
/** smoke-cursor-plugin-layout — cursor frontend manifest/hooks/MCP/dist gate */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PLUGIN_ROOT = join(REPO_ROOT, "packages", "cairn-plugin");

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    process.exit(1);
  }
}

function readJson<T>(path: string): T {
  assert(existsSync(path), `expected file at ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

console.log("smoke-cursor-plugin-layout — start");

const manifest = readJson<{ name: string; version: string; logo?: string; hooks?: string }>(
  join(PLUGIN_ROOT, ".cursor-plugin", "plugin.json"),
);
assert(manifest.name === "cairn", "plugin name must be cairn");
assert(manifest.logo === undefined, "plugin must not reference missing logo asset");
assert(manifest.hooks === "hooks/hooks.cursor.json", "cursor manifest must point at hooks.cursor.json");

const mcp = readJson<{ mcpServers: { cairn: { env: Record<string, string> } } }>(
  join(PLUGIN_ROOT, "mcp.json"),
);
assert(mcp.mcpServers.cairn.env.CAIRN_REPO_ROOT === "${CURSOR_PROJECT_DIR}", "MCP must inject CAIRN_REPO_ROOT");

const hooks = readJson<{ hooks: Record<string, unknown[]> }>(
  join(PLUGIN_ROOT, "hooks", "hooks.cursor.json"),
);
for (const event of ["sessionStart", "sessionEnd", "stop", "postToolUse"]) {
  assert(Array.isArray(hooks.hooks[event]) && hooks.hooks[event]!.length > 0, `${event} required`);
}

assert(existsSync(join(PLUGIN_ROOT, "dist", "cli.mjs")), "dist/cli.mjs must be committed");
assert(existsSync(join(PLUGIN_ROOT, "rules", "cairn-ground-state.mdc")), "ground-state rule required");
assert(existsSync(join(PLUGIN_ROOT, "hooks", "hooks.cursor.json")), "hooks.cursor.json required");

console.log("smoke-cursor-plugin-layout — pass");

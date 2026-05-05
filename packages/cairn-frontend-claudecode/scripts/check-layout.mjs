#!/usr/bin/env node
/**
 * check-layout — validates the cairn-frontend-claudecode plugin layout.
 *
 * Confirms manifest + mcp + hooks files parse as JSON with expected
 * shape, and that hook commands reference the published `cairn` CLI.
 * Runs as the package's `build` step so `pnpm -r build` flags layout
 * regressions.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");

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
  if (manifest.name !== "cairn") {
    fail(`plugin.json: name must be "cairn", got ${manifest.name}`);
  }
}

// ── .mcp.json ───────────────────────────────────────────────────────
// Plugin shells out to the published `cairn` CLI on PATH (installed via
// `npm install -g @isaacriehm/cairn`). This avoids the pre-v0.1.2 problem
// where the plugin manifest pointed at `${CLAUDE_PLUGIN_ROOT}/../cairn-core`
// — Claude Code's plugin cache only stores the plugin dir, not sibling
// workspace packages, so the path didn't resolve in production installs.
const mcp = readJson(join(PKG_ROOT, ".mcp.json"));
if (mcp) {
  const server = mcp?.mcpServers?.cairn;
  if (!server || typeof server !== "object") {
    fail(".mcp.json: mcpServers.cairn must be an object");
  } else {
    if (server.command !== "cairn") {
      fail(`.mcp.json: cairn.command must be 'cairn' (the npm-installed CLI), got ${server.command}`);
    }
    if (!Array.isArray(server.args) || server.args.length !== 2) {
      fail(".mcp.json: cairn.args must be ['mcp', 'serve']");
    } else if (server.args[0] !== "mcp" || server.args[1] !== "serve") {
      fail(`.mcp.json: cairn.args must be ['mcp', 'serve'], got ${JSON.stringify(server.args)}`);
    }
  }
}

// ── hooks/hooks.json ────────────────────────────────────────────────
const hooksFile = readJson(join(PKG_ROOT, "hooks", "hooks.json"));
if (hooksFile) {
  // Claude Code's plugin loader expects a top-level `hooks` record.
  if (typeof hooksFile.hooks !== "object" || hooksFile.hooks === null) {
    fail(`hooks.json: top-level "hooks" record required (zod loader rejects without it)`);
  } else {
    const hooks = hooksFile.hooks;
    for (const event of ["SessionStart", "SessionEnd", "Stop", "PostToolUse"]) {
      if (!Array.isArray(hooks[event]) || hooks[event].length === 0) {
        fail(`hooks.json: hooks.${event} must be a non-empty array`);
      }
    }
    // Walk every command. Each must invoke `cairn hook <event>` so the
    // hook resolves against the npm-installed `cairn` binary on PATH.
    const ALLOWED = new Set([
      "cairn hook session-start",
      "cairn hook session-end",
      "cairn hook stop",
      "cairn hook read-enrich",
      "cairn hook write-guard",
    ]);
    const visit = (event, entries) => {
      for (const entry of entries) {
        for (const hook of entry.hooks ?? []) {
          if (hook.type !== "command" || typeof hook.command !== "string") {
            fail(`hooks.json: ${event}: each hook must have type=command + string command`);
            continue;
          }
          if (!ALLOWED.has(hook.command)) {
            fail(`hooks.json: ${event}: command must be one of ${[...ALLOWED].join(", ")} — got ${hook.command}`);
          }
        }
      }
    };
    for (const event of ["SessionStart", "SessionEnd", "Stop", "PostToolUse"]) {
      if (Array.isArray(hooks[event])) visit(event, hooks[event]);
    }
  }
}

// ── component dirs (skills/agents/commands) ─────────────────────────
for (const dir of ["skills", "agents", "commands"]) {
  if (!existsSync(join(PKG_ROOT, dir))) fail(`missing component dir: ${dir}/`);
}

// ── skills: each subdir must contain SKILL.md with valid frontmatter ─
const skillsDir = join(PKG_ROOT, "skills");
if (existsSync(skillsDir)) {
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) {
      fail(`skill ${entry.name}: missing SKILL.md`);
      continue;
    }
    validateMarkdownFrontmatter(skillFile, ["name", "description"], `skill ${entry.name}`);
  }
}

// ── commands: each .md must have a description in frontmatter ───────
const commandsDir = join(PKG_ROOT, "commands");
if (existsSync(commandsDir)) {
  for (const entry of readdirSync(commandsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    validateMarkdownFrontmatter(
      join(commandsDir, entry.name),
      ["description"],
      `command ${entry.name}`,
    );
  }
}

// ── agents: each .md must have name + description in frontmatter ────
const agentsDir = join(PKG_ROOT, "agents");
if (existsSync(agentsDir)) {
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    validateMarkdownFrontmatter(
      join(agentsDir, entry.name),
      ["name", "description"],
      `agent ${entry.name}`,
    );
  }
}

function validateMarkdownFrontmatter(path, requiredKeys, label) {
  const text = readFileSync(path, "utf8");
  if (!text.startsWith("---\n")) {
    fail(`${label}: must start with --- frontmatter`);
    return;
  }
  const end = text.indexOf("\n---", 4);
  if (end === -1) {
    fail(`${label}: frontmatter not terminated`);
    return;
  }
  const fmBlock = text.slice(4, end);
  const body = text.slice(end + 4).trim();
  for (const key of requiredKeys) {
    // Match `key:` followed by either inline value or a `|` block.
    const re = new RegExp(`^${key}:\\s*\\S`, "m");
    if (!re.test(fmBlock)) {
      fail(`${label}: frontmatter missing or empty key "${key}"`);
    }
  }
  if (body.length === 0) fail(`${label}: body is empty`);
}

if (errors.length > 0) {
  console.error("check-layout: FAIL");
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log("check-layout: OK — plugin layout valid");

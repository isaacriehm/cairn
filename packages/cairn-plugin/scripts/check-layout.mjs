#!/usr/bin/env node
/**
 * check-layout — validates the cairn-plugin plugin layout.
 *
 * Confirms manifest + mcp + hooks files parse as JSON with expected
 * shape, and that hook commands reference the published `cairn` CLI.
 * Runs as the package's `build` step so `pnpm -r build` flags layout
 * regressions.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");

// Operator-set heuristic for the bare `description` field — keeps
// the one-liner readable in /skills + chat.
const DESCRIPTION_CAP = 180;

// Claude Code's hard per-entry cap on the skill listing sent to the
// model (settings: skillListingMaxDescChars, default 1536). The
// listing concatenates `description` + `when_to_use`; over-cap
// entries are silently dropped (operator sees "1 description exceeds
// the per-entry cap" in /doctor). Cap at 1400 to leave headroom.
const SKILL_LISTING_CAP = 1400;

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
// Plugin invokes a self-contained bundle at dist/cli.mjs via plain `node`.
// ${CLAUDE_PLUGIN_ROOT} resolves to the plugin's cache dir at runtime,
// so the bundle ships alongside the plugin — no `npm install -g`,
// no npx latency, no PATH dependency, no sibling-workspace lookups.
const mcp = readJson(join(PKG_ROOT, ".mcp.json"));
if (mcp) {
  const server = mcp?.mcpServers?.cairn;
  if (!server || typeof server !== "object") {
    fail(".mcp.json: mcpServers.cairn must be an object");
  } else {
    if (server.command !== "node") {
      fail(`.mcp.json: cairn.command must be 'node', got ${server.command}`);
    }
    const expected = [
      "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs",
      "mcp",
      "serve",
      "--model-provider",
      "claude",
    ];
    if (!Array.isArray(server.args) || server.args.length !== expected.length || server.args.some((a, i) => a !== expected[i])) {
      fail(`.mcp.json: cairn.args must be ${JSON.stringify(expected)}, got ${JSON.stringify(server.args)}`);
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
    for (const event of ["SessionStart", "SessionEnd", "Stop", "UserPromptSubmit", "PostToolUse"]) {
      if (!Array.isArray(hooks[event]) || hooks[event].length === 0) {
        fail(`hooks.json: hooks.${event} must be a non-empty array`);
      }
    }
    // Walk every command. Each invokes the bundled CLI at the plugin's
    // own cache dir — no npx, no PATH dependency.
    // Quoted form is required — `${CLAUDE_PLUGIN_ROOT}` may resolve
    // to a path containing spaces (local-marketplace dev installs or
    // any operator with spaces in their home). Without the surrounding
    // `"…"` the shell splits on whitespace and `node` fails to
    // resolve the module path.
    const ALLOWED = new Set([
      'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook session-start --host claude-code --model-provider claude',
      'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook session-end --host claude-code --model-provider claude',
      'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook stop --host claude-code --model-provider claude',
      'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook user-prompt-submit --host claude-code --model-provider claude',
      'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook read-enrich --host claude-code --model-provider claude',
      'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook write-guard --host claude-code --model-provider claude',
      'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook sot-align --host claude-code --model-provider claude',
      'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook post-write --host claude-code --model-provider claude',
      'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook ask-user-blocked --host claude-code --model-provider claude',
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
    for (const event of ["SessionStart", "SessionEnd", "Stop", "UserPromptSubmit", "PostToolUse"]) {
      if (Array.isArray(hooks[event])) visit(event, hooks[event]);
    }
  }
}

// ── component dirs (skills/agents/commands) ─────────────────────────
for (const dir of ["skills", "agents", "commands"]) {
  if (!existsSync(join(PKG_ROOT, dir))) fail(`missing component dir: ${dir}/`);
}

// ── bin/ executables ────────────────────────────────────────────────
// Claude Code adds bin/ to the Bash tool's PATH while the plugin is
// enabled, so `cairn …` works in any Bash call with no global install.
// Ship both the POSIX shim (Git-Bash) and the .cmd (native-Windows
// PowerShell/cmd fallback); each self-locates ../dist/cli.mjs because
// CLAUDE_PLUGIN_ROOT is not exported to Bash-tool processes.
const binPosix = join(PKG_ROOT, "bin", "cairn");
const binWin = join(PKG_ROOT, "bin", "cairn.cmd");
if (!existsSync(binPosix)) {
  fail("bin/cairn missing — POSIX CLI shim required for Git-Bash PATH");
} else {
  const text = readFileSync(binPosix, "utf8");
  if (!text.startsWith("#!")) fail("bin/cairn: missing shebang");
  if (!text.includes("../dist/cli.mjs")) {
    fail("bin/cairn: must invoke ../dist/cli.mjs (self-located bundle)");
  }
  // Exec bit only carries meaning on POSIX; Windows file modes don't
  // represent it (a Windows dev build would false-fail otherwise).
  if (process.platform !== "win32") {
    try {
      if ((statSync(binPosix).mode & 0o111) === 0) {
        fail("bin/cairn: not executable (chmod +x required for PATH invocation)");
      }
    } catch {
      fail("bin/cairn: cannot stat");
    }
  }
}
if (!existsSync(binWin)) {
  fail("bin/cairn.cmd missing — native-Windows CLI shim required");
} else if (!readFileSync(binWin, "utf8").includes("..\\dist\\cli.mjs")) {
  fail("bin/cairn.cmd: must invoke ..\\dist\\cli.mjs (self-located bundle)");
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
    checkSkillListingCap(skillFile, `skill ${entry.name}`);
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

  // Description-length cap. Handles both inline ("description: text")
  // and `|` / `>` block forms (multi-line indented blocks).
  const descLength = measureDescriptionLength(fmBlock);
  if (descLength !== null && descLength > DESCRIPTION_CAP) {
    fail(
      `${label}: description is ${descLength} chars — cap is ${DESCRIPTION_CAP} ` +
        `(over-cap descriptions get silently dropped from Claude Code's skill listing). ` +
        `Trim the description to a tight one-liner; push detail into when_to_use.`,
    );
  }
}

function measureDescriptionLength(fmBlock) {
  return measureFieldLength(fmBlock, "description");
}

function measureFieldLength(fmBlock, key) {
  const lines = fmBlock.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(new RegExp(`^${key}:\\s*(.*)$`));
    if (m === null) continue;
    const inline = m[1].trim();
    if (inline === "|" || inline === ">") {
      // Block scalar — collect indented lines until the next top-level key.
      const blockLines = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (/^\S/.test(next)) break; // top-level key — block ended
        blockLines.push(next.trimStart());
      }
      return blockLines.join(" ").trim().length;
    }
    // Inline form — strip surrounding quotes if present.
    return inline.replace(/^["']|["']$/g, "").length;
  }
  return null;
}

function checkSkillListingCap(path, label) {
  const text = readFileSync(path, "utf8");
  if (!text.startsWith("---\n")) return;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return;
  const fmBlock = text.slice(4, end);
  const descLen = measureFieldLength(fmBlock, "description") ?? 0;
  const whenToUseLen = measureFieldLength(fmBlock, "when_to_use") ?? 0;
  const combined = descLen + whenToUseLen;
  if (combined > SKILL_LISTING_CAP) {
    fail(
      `${label}: description+when_to_use is ${combined} chars — Claude Code skill-listing cap is ${SKILL_LISTING_CAP} ` +
        `(over-cap → /doctor flags "exceeds the per-entry cap" and the skill is silently dropped from the listing). ` +
        `Trim when_to_use.`,
    );
  }
}

// ── Cursor plugin (shared package — no duplicated skills/dist) ───────
const cursorManifest = readJson(join(PKG_ROOT, ".cursor-plugin", "plugin.json"));
if (cursorManifest) {
  if (cursorManifest.hooks !== "./hooks/hooks.cursor.json") {
    fail('.cursor-plugin/plugin.json: hooks must be "./hooks/hooks.cursor.json"');
  }
}

const cursorMcp = readJson(join(PKG_ROOT, "mcp.json"));
if (cursorMcp) {
  const server = cursorMcp?.mcpServers?.cairn;
  if (!server || typeof server !== "object") {
    fail("mcp.json: mcpServers.cairn must be an object");
  } else {
    const expected = [
      "${CURSOR_PLUGIN_ROOT}/dist/cli.mjs",
      "mcp",
      "serve",
      "--model-provider",
      "cursor",
    ];
    if (server.command !== "node" || JSON.stringify(server.args) !== JSON.stringify(expected)) {
      fail(`mcp.json: cairn must invoke ${JSON.stringify(expected)} with node`);
    }
    if (server.env?.CAIRN_REPO_ROOT !== "${CURSOR_PROJECT_DIR}") {
      fail("mcp.json: env.CAIRN_REPO_ROOT must be ${CURSOR_PROJECT_DIR}");
    }
  }
}

const cursorHooks = readJson(join(PKG_ROOT, "hooks", "hooks.cursor.json"));
if (cursorHooks) {
  if (cursorHooks.version !== 1) {
    fail("hooks.cursor.json: version must be 1");
  }
  const CURSOR_ALLOWED = new Set([
    'node "${CURSOR_PLUGIN_ROOT}/dist/cli.mjs" hook session-start --host cursor --model-provider cursor',
    'node "${CURSOR_PLUGIN_ROOT}/dist/cli.mjs" hook session-end --host cursor --model-provider cursor',
    'node "${CURSOR_PLUGIN_ROOT}/dist/cli.mjs" hook stop --host cursor --model-provider cursor',
    'node "${CURSOR_PLUGIN_ROOT}/dist/cli.mjs" hook read-enrich --host cursor --model-provider cursor',
    'node "${CURSOR_PLUGIN_ROOT}/dist/cli.mjs" hook post-write --host cursor --model-provider cursor',
  ]);
  for (const event of ["sessionStart", "sessionEnd", "stop", "postToolUse"]) {
    for (const entry of cursorHooks.hooks?.[event] ?? []) {
      if (entry.hooks !== undefined) {
        fail(`hooks.cursor.json: ${event}: Cursor v1 entries must not use nested hooks`);
      }
      if (!CURSOR_ALLOWED.has(entry.command)) {
        fail(`hooks.cursor.json: ${event}: unexpected command ${entry.command}`);
      }
    }
  }
}

if (!existsSync(join(PKG_ROOT, "rules", "cairn-ground-state.mdc"))) {
  fail("rules/cairn-ground-state.mdc required for Cursor");
}

// ── Codex plugin (same skills/runtime, native package metadata) ─────
const codexManifest = readJson(join(PKG_ROOT, ".codex-plugin", "plugin.json"));
if (codexManifest) {
  if (codexManifest.skills !== "./skills/") {
    fail('.codex-plugin/plugin.json: skills must be "./skills/"');
  }
  if (codexManifest.mcpServers !== "./.mcp.codex.json") {
    fail('.codex-plugin/plugin.json: mcpServers must be "./.mcp.codex.json"');
  }
  if (codexManifest.hooks !== "./hooks/hooks.codex.json") {
    fail('.codex-plugin/plugin.json: hooks must be "./hooks/hooks.codex.json"');
  }
}

const codexMcp = readJson(join(PKG_ROOT, ".mcp.codex.json"));
if (codexMcp) {
  const server = codexMcp.cairn;
  const expected = [
    "${PLUGIN_ROOT}/dist/cli.mjs",
    "mcp",
    "serve",
    "--model-provider",
    "codex",
  ];
  if (server?.command !== "node" || JSON.stringify(server?.args) !== JSON.stringify(expected)) {
    fail(`.mcp.codex.json: cairn must invoke ${JSON.stringify(expected)} with node`);
  }
}

const codexHooks = readJson(join(PKG_ROOT, "hooks", "hooks.codex.json"));
if (codexHooks) {
  for (const event of ["SessionStart", "Stop", "UserPromptSubmit", "PostToolUse"]) {
    const groups = codexHooks.hooks?.[event];
    if (!Array.isArray(groups) || groups.length === 0) {
      fail(`hooks.codex.json: hooks.${event} must be a non-empty array`);
      continue;
    }
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        if (
          typeof hook.command !== "string" ||
          !hook.command.includes("${PLUGIN_ROOT}/dist/cli.mjs") ||
          !hook.command.endsWith("--host codex --model-provider codex")
        ) {
          fail(`hooks.codex.json: ${event}: invalid command ${hook.command}`);
        }
      }
    }
  }
}

if (errors.length > 0) {
  console.error("check-layout: FAIL");
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log("check-layout: OK — plugin layout valid");

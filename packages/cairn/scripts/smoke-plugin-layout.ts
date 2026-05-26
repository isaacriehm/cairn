#!/usr/bin/env tsx
/**
 * smoke-plugin-layout — verifies cairn-frontend-claudecode shape
 * and that all hook/MCP bin paths resolve to existing dist files.
 *
 * Spec: PLUGIN_ARCHITECTURE §4 (manifest), §9 (MCP), §10 (hooks).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@isaacriehm/cairn-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const PLUGIN_ROOT = join(REPO_ROOT, "packages", "cairn-frontend-claudecode");

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    process.exit(1);
  }
}

interface ManifestShape {
  name: string;
  version: string;
  description: string;
  repository?: string;
  license?: string;
}

interface McpShape {
  mcpServers: {
    cairn: {
      command: string;
      args: string[];
    };
  };
}

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string }[];
}

interface HooksJsonShape {
  hooks: {
    SessionStart: HookEntry[];
    SessionEnd: HookEntry[];
    Stop: HookEntry[];
    PostToolUse: HookEntry[];
  };
}

function readJson<T>(path: string): T {
  assert(existsSync(path), `expected file at ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function runSmoke(): void {
  console.log("smoke-plugin-layout — start");

  // ── Step 1 — plugin.json shape ───────────────────────────────────
  {
    const manifest = readJson<ManifestShape>(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"));
    assert(manifest.name === "cairn", `Step 1: name must be "cairn", got ${manifest.name}`);
    assert(/^\d+\.\d+\.\d+/.test(manifest.version), `Step 1: version must be semver, got ${manifest.version}`);
    assert(manifest.description.length > 0, "Step 1: description required");
    console.log("  ✓ Step 1 — plugin.json shape");
  }

  // ── Step 2 — .mcp.json wires cairn MCP via bundled cli.cjs ───────
  {
    const mcp = readJson<McpShape>(join(PLUGIN_ROOT, ".mcp.json"));
    assert(mcp.mcpServers?.cairn !== undefined, "Step 2: mcpServers.cairn required");
    const server = mcp.mcpServers.cairn;
    assert(server.command === "node", `Step 2: cairn.command must be 'node', got ${server.command}`);
    const expected = ["${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs", "mcp", "serve"];
    assert(
      Array.isArray(server.args) && server.args.length === expected.length && server.args.every((a, i) => a === expected[i]),
      `Step 2: cairn.args must be ${JSON.stringify(expected)}, got ${JSON.stringify(server.args)}`,
    );
    console.log("  ✓ Step 2 — .mcp.json invokes bundled cli.cjs mcp serve");
  }

  // ── Step 3 — hooks.json wires SessionStart, SessionEnd, Stop, PostToolUse ──
  {
    const hooksFile = readJson<HooksJsonShape>(join(PLUGIN_ROOT, "hooks", "hooks.json"));
    assert(typeof hooksFile.hooks === "object" && hooksFile.hooks !== null, "Step 3: top-level 'hooks' record required");
    const hooks = hooksFile.hooks;
    for (const event of ["SessionStart", "SessionEnd", "Stop", "PostToolUse"] as const) {
      assert(Array.isArray(hooks[event]) && hooks[event].length > 0, `Step 3: ${event} must be non-empty array`);
    }
    // Quoted form is required — `${CLAUDE_PLUGIN_ROOT}` may resolve to
    // a path containing spaces (e.g. local-marketplace dev installs
    // or any operator with spaces in their home). Without the
    // surrounding `"…"` the shell splits on whitespace and `node`
    // fails to resolve the module path.
    const ALLOWED = new Set([
      'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook session-start',
      'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook session-end',
      'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook stop',
      'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook user-prompt-submit',
      'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook read-enrich',
      'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook write-guard',
      'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook sot-align',
      'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook post-write',
      'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" hook ask-user-blocked',
    ]);
    for (const event of ["SessionStart", "SessionEnd", "Stop", "PostToolUse"] as const) {
      for (const entry of hooks[event]) {
        for (const hook of entry.hooks) {
          assert(hook.type === "command", `Step 3: ${event} hook.type must be 'command'`);
          assert(
            ALLOWED.has(hook.command),
            `Step 3: ${event} command must be one of ${[...ALLOWED].join(", ")} — got ${hook.command}`,
          );
        }
      }
    }
    // PostToolUse must include both Read|Grep|Glob and Write|Edit matchers.
    const matchers = hooks.PostToolUse.flatMap((e) => (e.matcher !== undefined ? [e.matcher] : []));
    const hasReadMatcher = matchers.some((m) => /Read|Grep|Glob/.test(m));
    const hasWriteMatcher = matchers.some((m) => /Write|Edit/.test(m));
    assert(hasReadMatcher, "Step 3: PostToolUse must match Read|Grep|Glob");
    assert(hasWriteMatcher, "Step 3: PostToolUse must match Write|Edit");
    console.log("  ✓ Step 3 — hooks.json invokes bundled cli.cjs hook <event>");
  }

  // ── Step 4 — component dirs exist ────────────────────────────────
  {
    for (const dir of ["skills", "agents", "commands"]) {
      assert(existsSync(join(PLUGIN_ROOT, dir)), `Step 4: missing component dir ${dir}/`);
    }
    console.log("  ✓ Step 4 — skills/agents/commands dirs scaffolded");
  }

  // ── Step 4b — required skills present with frontmatter ──────────
  {
    const expected = [
      "cairn-adopt",
      "cairn-direction",
      "cairn-attention",
    ];
    for (const slug of expected) {
      const path = join(PLUGIN_ROOT, "skills", slug, "SKILL.md");
      assert(existsSync(path), `Step 4b: missing skill ${slug}/SKILL.md`);
      const text = readFileSync(path, "utf8");
      assert(text.startsWith("---\n"), `Step 4b: ${slug} must start with frontmatter`);
      const end = text.indexOf("\n---", 4);
      assert(end !== -1, `Step 4b: ${slug} frontmatter not terminated`);
      const fm = text.slice(4, end);
      assert(/^name:\s*\S/m.test(fm), `Step 4b: ${slug} frontmatter missing name`);
      assert(/^description:\s*\S/m.test(fm), `Step 4b: ${slug} frontmatter missing description`);
      const body = text.slice(end + 4).trim();
      assert(body.length > 200, `Step 4b: ${slug} body looks empty (${body.length} chars)`);
    }
    console.log(`  ✓ Step 4b — ${expected.length} skills present with valid frontmatter`);
  }

  // ── Step 4c — required slash commands present ───────────────────
  {
    const expected = ["cairn-init.md", "cairn-direction.md", "cairn-statusline-setup.md"];
    for (const filename of expected) {
      const path = join(PLUGIN_ROOT, "commands", filename);
      assert(existsSync(path), `Step 4c: missing command ${filename}`);
      const text = readFileSync(path, "utf8");
      assert(text.startsWith("---\n"), `Step 4c: ${filename} must start with frontmatter`);
      const end = text.indexOf("\n---", 4);
      assert(end !== -1, `Step 4c: ${filename} frontmatter not terminated`);
      const fm = text.slice(4, end);
      assert(/^description:/m.test(fm), `Step 4c: ${filename} missing description`);
    }
    console.log(`  ✓ Step 4c — ${expected.length} slash commands present`);
  }

  // ── Step 4d — agents/reviewer.md present + valid frontmatter ───
  {
    const reviewerPath = join(PLUGIN_ROOT, "agents", "reviewer.md");
    assert(existsSync(reviewerPath), "Step 4d: missing agents/reviewer.md");
    const text = readFileSync(reviewerPath, "utf8");
    assert(text.startsWith("---\n"), "Step 4d: reviewer.md must start with frontmatter");
    const end = text.indexOf("\n---", 4);
    assert(end !== -1, "Step 4d: reviewer.md frontmatter not terminated");
    const fm = text.slice(4, end);
    assert(/^name:\s*\S/m.test(fm), "Step 4d: reviewer.md frontmatter missing name");
    assert(/^description:\s*\S/m.test(fm), "Step 4d: reviewer.md frontmatter missing description");
    const body = text.slice(end + 4).trim();
    assert(body.length > 200, `Step 4d: reviewer.md body looks empty (${body.length} chars)`);
    console.log("  ✓ Step 4d — agents/reviewer.md present + valid");
  }

  // ── Step 5 — every hook bin export accepts payload via stdin ─────
  // Sanity-check that the runners barrel exports the expected symbols.
  {
    const ns = core as Record<string, unknown>;
    for (const symbol of [
      "runSessionStartHook",
      "runSessionEndHook",
      "runStopHook",
      "runReadEnricher",
      "runWriteGuardian",
      "runPostWriteHook",
    ]) {
      assert(typeof ns[symbol] === "function", `Step 5: cairn-core must export ${symbol}`);
    }
    console.log("  ✓ Step 5 — runner exports present");
  }

  console.log("smoke-plugin-layout — pass");
}

runSmoke();

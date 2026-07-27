#!/usr/bin/env tsx
/** smoke-cursor-hook-format — Cursor hook stdout + repo-root resolution */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizePostToolUse,
  pickToolResponseContent,
  resolveHookCwd,
  resolveMcpRepoRoot,
} from "@isaacriehm/cairn-core";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    process.exit(1);
  }
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

console.log("smoke-cursor-hook-format — start");

{
  const hooksPath = join(
    REPO_ROOT,
    "packages",
    "cairn-plugin",
    "hooks",
    "hooks.cursor.json",
  );
  const config = JSON.parse(readFileSync(hooksPath, "utf8")) as {
    version?: number;
    hooks?: Record<string, Array<Record<string, unknown>>>;
  };
  assert(config.version === 1, "Cursor hooks config must declare version: 1");
  for (const event of ["sessionStart", "sessionEnd", "stop", "postToolUse"]) {
    const entries = config.hooks?.[event];
    assert(Array.isArray(entries) && entries.length > 0, `Cursor ${event} hooks required`);
    for (const entry of entries) {
      assert(typeof entry.command === "string", `Cursor ${event} command must be flat`);
      assert(!("hooks" in entry), `Cursor ${event} must not use Claude nested hook groups`);
      assert(
        entry.command.includes("--host cursor"),
        `Cursor ${event} command must select the Cursor adapter`,
      );
      assert(
        entry.command.includes("--model-provider cursor"),
        `Cursor ${event} command must select the Cursor model provider`,
      );
    }
  }
  console.log("  ✓ hooks config uses Cursor's native v1 schema");
}

{
  const cwd = resolveHookCwd({ workspace_roots: ["/tmp/ws-root"] });
  assert(cwd === "/tmp/ws-root", "workspace_roots[0] must win when cwd absent");
  console.log("  ✓ resolveHookCwd uses workspace_roots");
}

{
  const dir = mkdtempSync(join(tmpdir(), "cairn-cursor-mcp-"));
  mkdirSync(join(dir, ".cairn"), { recursive: true });
  writeFileSync(join(dir, ".cairn", "config.yaml"), "cairn_version: 0.0.0\n");
  const prevProject = process.env.CURSOR_PROJECT_DIR;
  const prevPlugin = process.env.CURSOR_PLUGIN_ROOT;
  process.env.CURSOR_PROJECT_DIR = dir;
  process.env.CURSOR_PLUGIN_ROOT = "/fake/cursor/plugin";
  delete process.env.CAIRN_REPO_ROOT;
  const root = resolveMcpRepoRoot();
  if (prevProject === undefined) delete process.env.CURSOR_PROJECT_DIR;
  else process.env.CURSOR_PROJECT_DIR = prevProject;
  if (prevPlugin === undefined) delete process.env.CURSOR_PLUGIN_ROOT;
  else process.env.CURSOR_PLUGIN_ROOT = prevPlugin;
  assert(root === dir, "resolveMcpRepoRoot must honor CURSOR_PROJECT_DIR");
  console.log("  ✓ resolveMcpRepoRoot honors CURSOR_PROJECT_DIR");
}

{
  const bundle = join(REPO_ROOT, "packages", "cairn-plugin", "dist", "cli.mjs");
  const dir = mkdtempSync(join(tmpdir(), "cairn-cursor-ss-"));
  const payload = JSON.stringify({
    session_id: "smoke-cursor",
    workspace_roots: [dir],
    hook_event_name: "sessionStart",
  });
  const result = spawnSync("node", [bundle, "hook", "session-start", "--host", "cursor"], {
    input: payload,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      CURSOR_PLUGIN_ROOT: join(REPO_ROOT, "packages", "cairn-plugin"),
      CURSOR_PROJECT_DIR: dir,
    },
  });
  assert(result.status === 0, `session-start failed: ${result.stderr}`);
  const out = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  assert("additional_context" in out || Object.keys(out).length === 0, "Cursor sessionStart JSON shape");
  console.log("  ✓ session-start --host cursor emits Cursor JSON");
}

{
  const payload = normalizePostToolUse({
    tool_name: "Read",
    tool_input: { path: "/tmp/example.ts" },
    tool_output: JSON.stringify({
      path: "/tmp/example.ts",
      contents: "// sample\n",
    }),
  });
  assert(payload.tool_input?.file_path === "/tmp/example.ts", "path→file_path on tool_input");
  assert(
    pickToolResponseContent(payload.tool_response) === "// sample\n",
    "tool_output contents→content",
  );
  console.log("  ✓ normalizePostToolUse maps Cursor Read payload");
}

{
  const payload = normalizePostToolUse({
    tool_name: "StrReplace",
    tool_input: { path: "src/foo.ts", new_string: "hello" },
  });
  assert(payload.tool_name === "Edit", "StrReplace→Edit alias");
  console.log("  ✓ normalizePostToolUse aliases StrReplace→Edit");
}

{
  const bundle = join(REPO_ROOT, "packages", "cairn-plugin", "dist", "cli.mjs");
  const dir = mkdtempSync(join(tmpdir(), "cairn-cursor-stop-"));
  const payload = JSON.stringify({
    status: "completed",
    loop_count: 0,
    workspace_roots: [dir],
    hook_event_name: "stop",
  });
  const result = spawnSync("node", [bundle, "hook", "stop", "--host", "cursor"], {
    input: payload,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      CURSOR_PLUGIN_ROOT: join(REPO_ROOT, "packages", "cairn-plugin"),
      CURSOR_PROJECT_DIR: dir,
    },
  });
  assert(result.status === 0, `stop failed: ${result.stderr}`);
  const out = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  assert(
    !("decision" in out) && !("hookSpecificOutput" in out),
    "stop --host cursor must not emit Claude Code envelope",
  );
  console.log("  ✓ stop --host cursor emits Cursor JSON");
}

{
  const bundle = join(REPO_ROOT, "packages", "cairn-plugin", "dist", "cli.mjs");
  const dir = mkdtempSync(join(tmpdir(), "cairn-cursor-read-"));
  const payload = JSON.stringify({
    tool_name: "Read",
    tool_input: { path: "noop.txt" },
    tool_output: JSON.stringify({ path: "noop.txt", contents: "" }),
    workspace_roots: [dir],
    hook_event_name: "postToolUse",
  });
  const result = spawnSync("node", [bundle, "hook", "read-enrich", "--host", "cursor"], {
    input: payload,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      CURSOR_PLUGIN_ROOT: join(REPO_ROOT, "packages", "cairn-plugin"),
      CURSOR_PROJECT_DIR: dir,
    },
  });
  assert(result.status === 0, `read-enrich failed: ${result.stderr}`);
  const out = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  assert(!("hookSpecificOutput" in out), "read-enrich --host cursor must not emit Shape-B");
  console.log("  ✓ read-enrich --host cursor accepts tool_output payload");
}

console.log("smoke-cursor-hook-format — pass");

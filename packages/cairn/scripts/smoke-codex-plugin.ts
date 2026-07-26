#!/usr/bin/env tsx
/** smoke-codex-plugin — Codex manifest, hooks, and isolated CLI install */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`✗ ${message}`);
    process.exit(1);
  }
}

function readJson(path: string): Record<string, unknown> {
  assert(existsSync(path), `missing ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PLUGIN_ROOT = join(REPO_ROOT, "packages", "cairn-plugin");

console.log("smoke-codex-plugin — start");

{
  const manifest = readJson(join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"));
  assert(manifest.name === "cairn", "Codex manifest name");
  assert(manifest.skills === "./skills/", "Codex manifest must reuse shared skills");
  assert(manifest.mcpServers === "./.mcp.codex.json", "Codex MCP manifest path");
  assert(manifest.hooks === "./hooks/hooks.codex.json", "Codex hooks manifest path");
  console.log("  ✓ manifest reuses shared plugin components");
}

{
  for (const skill of [
    "cairn-adopt",
    "cairn-adopt-components",
    "cairn-attention",
    "cairn-direction",
    "cairn-resync",
  ]) {
    const text = readFileSync(join(PLUGIN_ROOT, "skills", skill, "SKILL.md"), "utf8");
    assert(
      text.includes("## Host portability"),
      `${skill} must define host-native tool and interaction fallbacks`,
    );
  }
  console.log("  ✓ shared skills define host-portable interactions");
}

{
  const hooks = readJson(join(PLUGIN_ROOT, "hooks", "hooks.codex.json")) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  };
  for (const event of ["SessionStart", "Stop", "PostToolUse"]) {
    const groups = hooks.hooks?.[event];
    assert(Array.isArray(groups) && groups.length > 0, `Codex ${event} hooks required`);
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        assert(
          hook.command?.includes("${PLUGIN_ROOT}/dist/cli.mjs") === true,
          `Codex ${event} must use PLUGIN_ROOT`,
        );
        assert(
          hook.command?.includes("--host codex") === true,
          `Codex ${event} must select the Codex adapter`,
        );
      }
    }
  }
  console.log("  ✓ hooks use Codex plugin environment and adapter");
}

{
  const codexHome = mkdtempSync(join(tmpdir(), "cairn-codex-home-"));
  const env = { ...process.env, CODEX_HOME: codexHome };
  const addMarketplace = spawnSync(
    "codex",
    ["plugin", "marketplace", "add", REPO_ROOT],
    { encoding: "utf8", env, timeout: 30_000 },
  );
  assert(
    addMarketplace.status === 0,
    `Codex marketplace add failed: ${addMarketplace.stderr}`,
  );

  const available = spawnSync(
    "codex",
    ["plugin", "list", "--available", "--json"],
    { encoding: "utf8", env, timeout: 30_000 },
  );
  assert(available.status === 0, `Codex plugin list failed: ${available.stderr}`);
  const availablePayload = JSON.parse(available.stdout) as {
    available?: Array<{ name?: string; marketplaceName?: string }>;
  };
  assert(
    availablePayload.available?.some((plugin) => plugin.name === "cairn"),
    "Cairn must be discoverable from the repo marketplace",
  );

  const install = spawnSync(
    "codex",
    ["plugin", "add", "cairn", "--marketplace", "cairn"],
    { encoding: "utf8", env, timeout: 30_000 },
  );
  assert(install.status === 0, `Codex plugin install failed: ${install.stderr}`);

  const installed = spawnSync("codex", ["plugin", "list", "--json"], {
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  assert(installed.status === 0, `Codex installed list failed: ${installed.stderr}`);
  const installedPayload = JSON.parse(installed.stdout) as {
    installed?: Array<{ name?: string }>;
  };
  assert(
    installedPayload.installed?.some((plugin) => plugin.name === "cairn"),
    "Cairn must be installed in the isolated Codex home",
  );
  console.log("  ✓ Codex CLI discovers and installs the repo plugin");
}

console.log("smoke-codex-plugin — pass");

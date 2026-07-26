/**
 * Shared MCP repo-root resolution for Claude Code, Cursor, and Codex.
 *
 * Cursor launches MCP with cwd = ~; hooks inject CURSOR_PROJECT_DIR (always)
 * and mcp.json sets CAIRN_REPO_ROOT from it. Codex and Claude Code launch
 * local stdio servers in the active project cwd. When CURSOR_PLUGIN_ROOT is
 * set, prefer CURSOR_PROJECT_DIR over a stale shell CAIRN_REPO_ROOT.
 */

import { resolve } from "node:path";
import { resolveAnchorRoot } from "../session-start/index.js";

function cursorPluginLaunch(): boolean {
  const root = process.env["CURSOR_PLUGIN_ROOT"];
  return typeof root === "string" && root.length > 0;
}

function envProjectDir(): string | undefined {
  const cursor = process.env["CURSOR_PROJECT_DIR"];
  if (typeof cursor === "string" && cursor.length > 0) return cursor;
  const claude = process.env["CLAUDE_PROJECT_DIR"];
  if (typeof claude === "string" && claude.length > 0) return claude;
  return undefined;
}

function envRepoRootOverride(): string | undefined {
  const explicit = process.env["CAIRN_REPO_ROOT"];
  if (typeof explicit !== "string" || explicit.length === 0) return undefined;
  if (cursorPluginLaunch()) {
    const projectDir = envProjectDir();
    if (projectDir !== undefined) return projectDir;
  }
  return explicit;
}

/**
 * Resolve adopted-project repo root for MCP serve.
 * @param explicitFlag --repo-root CLI flag value, if any
 */
export function resolveMcpRepoRoot(explicitFlag?: string): string {
  if (explicitFlag !== undefined && explicitFlag.length > 0) {
    return resolveAnchorRoot(resolve(explicitFlag));
  }
  const fromEnv = envRepoRootOverride() ?? envProjectDir();
  const base = fromEnv !== undefined ? resolve(fromEnv) : process.cwd();
  return resolveAnchorRoot(base);
}

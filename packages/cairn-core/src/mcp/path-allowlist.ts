import { isAbsolute, normalize, relative, resolve } from "node:path";
import { matchAnyGlob } from "@isaacriehm/cairn-state";
import { mcpError, type McpErrorPayload } from "./errors.js";

/**
 * Append-write allowlist. Server-side, NOT agent-controllable.
 *
 * Per CONTEXT_CONTINUITY_SPEC §2.3:
 *   - .cairn/tasks/active/<task-id>/notes.md  — agent-authored run notes
 *     (consumed by handoff builder; persists across sessions)
 */
export const APPEND_ALLOWLIST: readonly string[] = [
  ".cairn/tasks/active/*/notes.md",
];

/**
 * Paths agents may NOT archive. AGENTS.md, CLAUDE.md, brand guidelines, and
 * decisions/ are all sacred ground.
 */
export const ARCHIVE_DENY: readonly string[] = [
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/**",
  "docs/decisions/**",
  ".cairn/ground/decisions/**",
  ".cairn/ground/invariants/**",
  ".cairn/config/**",
  "docs/design/brand/**",
];

/** Historical-zone globs — read tools refuse these. */
export const HISTORICAL_ZONE: readonly string[] = [
  ".cairn/runs/terminal/**",
  ".cairn/tasks/done/**",
  ".cairn/tasks/archived/**",
  ".cairn/ground/decisions/_inbox/**",
];

/** Resolves a relative path against repoRoot and rejects escapes. */
export function safeJoin(repoRoot: string, rel: string): string | McpErrorPayload {
  if (isAbsolute(rel)) {
    return mcpError("PATH_OUTSIDE_REPO", `Absolute paths not accepted: ${rel}`);
  }
  const abs = resolve(repoRoot, rel);
  const back = relative(repoRoot, abs);
  if (back.startsWith("..") || isAbsolute(back)) {
    return mcpError("PATH_OUTSIDE_REPO", `Path resolves outside repo: ${rel}`);
  }
  return abs;
}

/** Returns repo-relative POSIX-style path for a path already inside repoRoot. */
export function relPosix(repoRoot: string, abs: string): string {
  return normalize(relative(repoRoot, abs)).replace(/\\/g, "/");
}

export function isAppendAllowed(repoRelPath: string): boolean {
  return matchAnyGlob(repoRelPath, APPEND_ALLOWLIST);
}

export function isArchiveDenied(repoRelPath: string): boolean {
  return matchAnyGlob(repoRelPath, ARCHIVE_DENY);
}

export function isHistorical(repoRelPath: string): boolean {
  return matchAnyGlob(repoRelPath, HISTORICAL_ZONE);
}

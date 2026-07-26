import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { mcpError, type McpErrorPayload } from "../mcp/errors.js";
import { safeJoin } from "../mcp/path-allowlist.js";

export type SpecIoErrorCode = "PATH_OUTSIDE_REPO" | "FILE_NOT_FOUND" | "READ_FAILED";

export class SpecIoError extends Error {
  readonly code: SpecIoErrorCode;

  constructor(code: SpecIoErrorCode, message: string) {
    super(message);
    this.name = "SpecIoError";
    this.code = code;
  }
}

/**
 * First H1 in the spec, or the spec's filename without extension.
 * Capped at 60 chars so the slug fits within the statusline budget.
 */
export function deriveTitleFromSpec(source: string, fallback: string): string {
  const m = source.match(/^#\s+(.+?)\s*$/m);
  const raw = m?.[1] ?? fallback.replace(/^.*\//, "").replace(/\.[a-z]+$/i, "");
  return raw.slice(0, 60);
}

function pathInsideRepo(repoRoot: string, abs: string): boolean {
  const back = relative(repoRoot, abs);
  return !back.startsWith("..") && !isAbsolute(back);
}

/** Resolves a mission spec path; relative paths go through safeJoin. */
export function resolveMissionSpecPath(
  repoRoot: string,
  specPath: string,
): string | McpErrorPayload {
  if (isAbsolute(specPath)) {
    const abs = resolve(specPath);
    if (!pathInsideRepo(repoRoot, abs)) {
      return mcpError("PATH_OUTSIDE_REPO", `Path resolves outside repo: ${specPath}`);
    }
    return abs;
  }
  return safeJoin(repoRoot, specPath);
}

export function resolveSpecAbsPath(repoRoot: string, specPath: string): string {
  const resolved = resolveMissionSpecPath(repoRoot, specPath);
  if (typeof resolved !== "string") {
    throw new SpecIoError("PATH_OUTSIDE_REPO", resolved.error.message);
  }
  return resolved;
}

export function readSpecSource(repoRoot: string, specPath: string): string {
  const abs = resolveSpecAbsPath(repoRoot, specPath);
  if (!existsSync(abs)) {
    throw new SpecIoError("FILE_NOT_FOUND", `Spec doc not found: ${specPath}`);
  }
  try {
    return readFileSync(abs, "utf8");
  } catch (err) {
    throw new SpecIoError(
      "READ_FAILED",
      `Failed to read spec doc: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

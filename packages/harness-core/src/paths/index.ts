import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HARNESS_HOME_ROOT = ".local/harness";

export type ProjectName = string;

export function harnessHome(): string {
  return resolve(homedir(), HARNESS_HOME_ROOT);
}

export function modelsRoot(): string {
  return join(harnessHome(), "models");
}

/** `.harness/sessions/` — per-session state root inside an adopted project. */
export function sessionsDir(repoRoot: string): string {
  return join(repoRoot, ".harness", "sessions");
}

/** `.harness/sessions/<id>/` — directory owned by one session for the duration of that session. */
export function sessionStateDir(repoRoot: string, sessionId: string): string {
  return join(sessionsDir(repoRoot), sanitizeSessionId(sessionId));
}

/**
 * Sanitize a session id to a filesystem-safe slug. Claude Code ids are
 * already uuid-shaped, but defensively reject path separators / dots and
 * collapse any other non-alphanumeric run to `_`.
 */
export function sanitizeSessionId(raw: string): string {
  const slug = raw.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "");
  if (slug.length === 0) {
    throw new Error(`Cannot sanitize session id from "${raw}" — result is empty`);
  }
  return slug;
}

/**
 * Normalize a free-form name (package.json `name`, directory name) into the
 * filesystem slug used as a directory key.
 *
 * - Lowercased
 * - Scoped names (`@org/pkg`) use the path-after-slash
 * - Non-alphanumerics collapse to a single underscore
 * - Leading/trailing underscores stripped
 */
export function normalizeProjectName(raw: string): ProjectName {
  const afterScope = raw.includes("/") ? (raw.split("/").pop() ?? raw) : raw;
  const slug = afterScope
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (slug.length === 0) {
    throw new Error(`Cannot normalize project name from "${raw}" — result is empty`);
  }
  return slug;
}

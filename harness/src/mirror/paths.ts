import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProjectName } from "./types.js";

const HARNESS_HOME_ROOT = ".local/harness";

export function harnessHome(): string {
  return resolve(homedir(), HARNESS_HOME_ROOT);
}

export function reposRoot(): string {
  return join(harnessHome(), "repos");
}

export function stateRoot(): string {
  return join(harnessHome(), "state");
}

export function modelsRoot(): string {
  return join(harnessHome(), "models");
}

export function mirrorPath(projectName: ProjectName): string {
  return join(reposRoot(), projectName);
}

export function projectStatePath(projectName: ProjectName): string {
  return join(stateRoot(), projectName);
}

export function mirrorRecordPath(projectName: ProjectName): string {
  return join(projectStatePath(projectName), "mirror.json");
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

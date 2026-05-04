import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { normalizeProjectName, projectStatePath } from "../mirror/index.js";
import type { StatusJson } from "./index.js";

/**
 * Resolve the absolute path to `status.json` for the given repo root.
 * Slug is derived from `basename(repoRoot)` via `normalizeProjectName`.
 */
export function statusJsonPath(repoRoot: string): string {
  const slug = normalizeProjectName(basename(repoRoot));
  return join(projectStatePath(slug), "status.json");
}

/**
 * Patch `status.json` for the project at `repoRoot`. Reads the existing file
 * (if present and valid JSON), shallow-merges `patch` over it, and writes the
 * pretty-printed result back. Creates the state directory if missing.
 *
 * v1: best-effort write; no atomic-rename ceremony. The status file is
 * cosmetic — torn writes self-heal on the next daemon tick.
 */
export function writeStatusJson(
  repoRoot: string,
  patch: Partial<StatusJson>,
): void {
  const slug = normalizeProjectName(basename(repoRoot));
  const stateDir = projectStatePath(slug);
  const filePath = join(stateDir, "status.json");

  let existing: Partial<StatusJson> = {};
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        existing = parsed as Partial<StatusJson>;
      }
    } catch {
      // Corrupt file — start fresh.
      existing = {};
    }
  }

  const merged: Partial<StatusJson> = { ...existing, ...patch };

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

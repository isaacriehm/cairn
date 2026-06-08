/**
 * Top-level `.cairn/config.yaml` reader for the non-component sections.
 *
 * (The `components:` block has its own typed loader in components.ts.)
 * Kept deliberately small + tolerant: a missing or malformed config is
 * never fatal — callers get the documented defaults.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** Parse `.cairn/config.yaml` into a plain object ({} when absent/broken). */
export function loadCairnConfig(repoRoot: string): Record<string, unknown> {
  const p = join(repoRoot, ".cairn", "config.yaml");
  if (!existsSync(p)) return {};
  try {
    const doc = parseYaml(readFileSync(p, "utf8"));
    return typeof doc === "object" && doc !== null
      ? (doc as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}


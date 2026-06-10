/**
 * Top-level `.cairn/config.yaml` reader for the non-component sections.
 *
 * (The `components:` block has its own typed loader in components.ts.)
 * Kept deliberately small + tolerant: a missing or malformed config is
 * never fatal — callers get the documented defaults.
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { cairnDir } from "./home.js";

/** Parse `.cairn/config.yaml` into a plain object ({} when absent/broken). */
export function loadCairnConfig(repoRoot: string): Record<string, unknown> {
  const p = cairnDir(repoRoot, "config.yaml");
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


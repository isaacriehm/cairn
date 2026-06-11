/**
 * 0004 — drop the glob-driven sensor settings.
 *
 * The Layer C structural sensors (route-handler / DTO) and the high-stakes GC
 * tier were removed: stack-specific regex fed by LLM-guessed globs that were
 * never validated against the tree or refreshed after adoption, so they failed
 * silent and never fired. Their config surface — the whole `project_globs`
 * block and the legacy top-level `high_stakes_globs` key — now has no runtime
 * reader. Stripping it is value-preserving (`off_limits` and everything else
 * stay), so this is a `safe` migration. New adoptions stop emitting these keys
 * at the source (init/overlay.ts).
 */

import type { ConfigDoc, Migration, MigrationResult } from "../types.js";
import { configHasKeys, deleteConfigKeys } from "../config-io.js";

/** Defunct top-level config keys with no runtime consumer. */
export const DEAD_GLOB_KEYS = ["project_globs", "high_stakes_globs"] as const;

export const dropGlobSettings: Migration = {
  id: "0004-drop-glob-settings",
  introducedIn: "0.22.6",
  describe:
    "Remove the defunct glob-driven sensor settings (project_globs, high_stakes_globs) — the Layer C structural sensors + high-stakes GC tier were removed",
  class: "safe",
  detect(repoRoot: string, doc?: ConfigDoc | null): boolean {
    return configHasKeys(repoRoot, DEAD_GLOB_KEYS, doc).length > 0;
  },
  apply(repoRoot: string): MigrationResult {
    const removed = deleteConfigKeys(repoRoot, DEAD_GLOB_KEYS);
    return {
      changed: removed.length > 0,
      detail:
        removed.length > 0
          ? `removed ${removed.length} defunct glob key(s): ${removed.join(", ")}`
          : "no glob settings present",
    };
  },
};

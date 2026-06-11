/**
 * 0004 — collapse the duplicate `high_stakes_globs`.
 *
 * Early adopters carry `high_stakes_globs` in TWO places: a top-level key and
 * `project_globs.high_stakes_globs`, written from one shared array so the
 * serializer emitted a YAML anchor/alias pair. The runtime reads only
 * `project_globs.high_stakes_globs`, falling back to the top-level key solely
 * when the nested one is absent (sensors/runner loadProjectGlobs). So when both
 * exist the top-level copy is dead weight — and its anchor makes a naive delete
 * dangle the alias.
 *
 * This migration is value-preserving: it materializes the canonical list into
 * `project_globs.high_stakes_globs` as a fresh inline node (clearing any alias),
 * then drops the top-level key. The data ends in the single location the runtime
 * prefers, so it is `safe`. New adoptions stop emitting the top-level key at the
 * source (init/overlay.ts).
 */

import type { ConfigDoc, Migration, MigrationResult } from "../types.js";
import { configHasKeys, mutateConfig } from "../config-io.js";

const NESTED_PATH = ["project_globs", "high_stakes_globs"] as const;

function asStringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

export const collapseHighStakesDupe: Migration = {
  id: "0004-collapse-high-stakes-dupe",
  introducedIn: "0.22.6",
  describe:
    "Collapse the duplicate top-level high_stakes_globs into project_globs.high_stakes_globs (the only key the runtime reads)",
  class: "safe",
  detect(repoRoot: string, doc?: ConfigDoc | null): boolean {
    // The top-level key is the dead copy; its presence is the whole signal.
    return configHasKeys(repoRoot, ["high_stakes_globs"], doc).length > 0;
  },
  apply(repoRoot: string): MigrationResult {
    let detail = "no top-level high_stakes_globs present";
    const changed = mutateConfig(repoRoot, (d) => {
      if (!d.has("high_stakes_globs")) return false;
      const json = (d.toJSON() ?? {}) as Record<string, unknown>;
      const top = asStringArray(json["high_stakes_globs"]) ?? [];
      const pg = json["project_globs"];
      const nested =
        typeof pg === "object" && pg !== null
          ? asStringArray((pg as Record<string, unknown>)["high_stakes_globs"])
          : null;
      // Canonical = whatever the runtime would already use: the nested list when
      // it carries entries, else the top-level copy we are about to remove.
      const canonical = nested !== null && nested.length > 0 ? nested : top;
      d.setIn([...NESTED_PATH], d.createNode(canonical));
      d.delete("high_stakes_globs");
      detail = `moved ${canonical.length} high_stakes glob(s) into project_globs.high_stakes_globs; dropped dead top-level key`;
      return true;
    });
    return { changed, detail };
  },
};

/**
 * 0001 — drop dead `config.yaml` fields.
 *
 * These keys were written at adoption but have no runtime reader (audit
 * Tier 2 + the proposed-sensors GUT). Removing them from existing adopters
 * is value-preserving (nothing consumes them), so this is a `safe` migration.
 * New adoptions stop emitting them at the source (init/overlay.ts).
 */

import type { Migration, MigrationResult } from "../types.js";
import { configHasKeys, deleteConfigKeys } from "../config-io.js";

/** Top-level config keys with no runtime consumer. */
export const DEAD_CONFIG_KEYS = [
  "detected_sensor_commands",
  "mapper_proposed_sensors",
  "mapper_notes",
  "key_modules",
  "stack_signatures",
  "hook_capability",
  "start_command",
  "origin_url",
] as const;

export const dropDeadConfigFields: Migration = {
  id: "0001-drop-dead-config-fields",
  introducedIn: "0.21.0",
  describe: "Remove unconsumed config.yaml keys (detected_sensor_commands, mapper_proposed_sensors, mapper_notes, key_modules, stack_signatures, hook_capability, start_command, origin_url)",
  class: "safe",
  detect(repoRoot: string): boolean {
    return configHasKeys(repoRoot, DEAD_CONFIG_KEYS).length > 0;
  },
  apply(repoRoot: string): MigrationResult {
    const removed = deleteConfigKeys(repoRoot, DEAD_CONFIG_KEYS);
    return {
      changed: removed.length > 0,
      detail:
        removed.length > 0
          ? `removed ${removed.length} dead config key(s): ${removed.join(", ")}`
          : "no dead config keys present",
    };
  },
};

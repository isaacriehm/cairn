import type { Profile } from "./types.js";

/**
 * Fallback profile — applies when no other profile detects.
 *
 * Carries no extractors and no stack-specific sensors. The cairn still
 * runs the generic sensors (Layer A stub catalog + decision-assertions)
 * defined in templates/.cairn/config/sensors.yaml.
 */
export const unknownProfile: Profile = {
  id: "unknown",
  name: "Unknown / generic",
  detect: () => true,
  sensors: [],
  extractors: [],
  offLimitsDefaults: [".git/**", ".archive/**", "node_modules/**", ".env", ".env.local"],
};

import type { Profile } from "./types.js";

/**
 * Fallback profile — applies when no other profile detects.
 *
 * Carries no extractors and no stack-specific sensors. The harness still
 * runs every generic sensor (Layer A/B/C/D/E/U + decision-assertions +
 * invariant-suite) defined in templates/.harness/config/sensors.yaml.
 */
export const unknownProfile: Profile = {
  id: "unknown",
  name: "Unknown / generic",
  detect: () => true,
  sensors: [],
  extractors: [],
  offLimitsDefaults: [".git/**", ".archive/**", "node_modules/**", ".env", ".env.local"],
  highStakesDefaults: [],
};

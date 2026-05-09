/**
 * Reads `copy_safety` configuration from
 * `.cairn/config/sensors.yaml`. Consumed by the PostToolUse Write
 * guardian and (later) by the Layer D copy-safety sensor.
 *
 * Falls back to hardcoded defaults if the file is missing or
 * unparseable — the guardian must never block due to a missing
 * optional config file.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export interface CopySafetyConfig {
  enabled: boolean;
  globs: string[];
  allowlist: string[];
}

const CopySafetySchema = z.object({
  enabled: z.boolean().optional(),
  globs: z.array(z.string()).optional(),
  allowlist: z.array(z.string()).optional(),
}).passthrough();

const SensorsConfigSchema = z.object({
  copy_safety: CopySafetySchema.optional(),
}).passthrough();

const DEFAULT: CopySafetyConfig = {
  enabled: true,
  globs: [
    "src/**/*.tsx",
    "src/**/*.jsx",
    "src/**/*.ts",
    "src/**/*.js",
    "src/**/*.mjs",
    "src/**/*.cjs",
    "src/**/*.py",
    "src/**/*.rb",
    "src/**/*.go",
    "src/**/*.rs",
    "src/**/*.java",
    "src/**/*.c",
    "src/**/*.cc",
    "src/**/*.cpp",
    "src/**/*.h",
    "src/**/*.hpp",
    "src/**/*.swift",
    "src/**/*.kt",
    "src/**/*.sh",
    "src/**/*.bash",
    "src/**/*.zsh",
    "src/**/*.sql",
    "src/**/*.html",
    "src/**/*.vue",
    "src/**/*.svelte",
    "src/**/*.css",
    "src/**/*.scss",
    "src/**/*.sass",
    "src/**/*.less",
  ],
  allowlist: [],
};

export function readCopySafetyConfig(repoRoot: string): CopySafetyConfig {
  const path = join(repoRoot, ".cairn", "config", "sensors.yaml");
  if (!existsSync(path)) return defaultsCopy();

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return defaultsCopy();
  }
  const result = SensorsConfigSchema.safeParse(parsed);
  if (!result.success || result.data.copy_safety === undefined) return defaultsCopy();
  
  const block = result.data.copy_safety;
  const enabled = block.enabled ?? DEFAULT.enabled;
  const globs = (block.globs !== undefined && block.globs.length > 0) ? block.globs : [...DEFAULT.globs];
  const allowlist = block.allowlist ?? [];

  return { enabled, globs, allowlist };
}

function defaultsCopy(): CopySafetyConfig {
  return {
    enabled: DEFAULT.enabled,
    globs: [...DEFAULT.globs],
    allowlist: [...DEFAULT.allowlist],
  };
}

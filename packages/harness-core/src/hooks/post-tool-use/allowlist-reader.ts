/**
 * Reads `copy_safety` configuration from
 * `.harness/config/sensors.yaml`. Consumed by the PostToolUse Write
 * guardian and (later) by the Layer D copy-safety sensor.
 *
 * Falls back to hardcoded defaults if the file is missing or
 * unparseable — the guardian must never block on configuration.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface CopySafetyConfig {
  enabled: boolean;
  globs: string[];
  allowlist: string[];
}

const DEFAULT: CopySafetyConfig = {
  enabled: true,
  globs: [
    "src/**/*.tsx",
    "src/**/*.jsx",
    "src/**/*.vue",
    "src/**/*.svelte",
    "**/*.html",
    "src/**/i18n/**/*.json",
    "src/**/locales/**/*.json",
  ],
  allowlist: [],
};

function defaultsCopy(): CopySafetyConfig {
  return {
    enabled: DEFAULT.enabled,
    globs: [...DEFAULT.globs],
    allowlist: [...DEFAULT.allowlist],
  };
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === "string") out.push(v);
  }
  return out;
}

export function readCopySafetyConfig(repoRoot: string): CopySafetyConfig {
  const path = join(repoRoot, ".harness", "config", "sensors.yaml");
  if (!existsSync(path)) return defaultsCopy();

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return defaultsCopy();
  }

  if (typeof parsed !== "object" || parsed === null) return defaultsCopy();

  const raw = (parsed as { copy_safety?: unknown }).copy_safety;
  if (typeof raw !== "object" || raw === null) return defaultsCopy();

  const block = raw as Record<string, unknown>;

  const enabledRaw = block["enabled"];
  const enabled =
    typeof enabledRaw === "boolean" ? enabledRaw : DEFAULT.enabled;

  const globsParsed = asStringArray(block["globs"]);
  const globs =
    globsParsed !== null && globsParsed.length > 0
      ? globsParsed
      : [...DEFAULT.globs];

  const allowlistParsed = asStringArray(block["allowlist"]);
  const allowlist = allowlistParsed !== null ? allowlistParsed : [];

  return { enabled, globs, allowlist };
}

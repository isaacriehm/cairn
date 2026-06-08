/**
 * Loaders for the on-disk sensor configuration files.
 *
 * `.cairn/config/stub-patterns.yaml` — Layer A regex catalog
 * `.cairn/config/sensors.yaml`       — sensor registry (which sensors run,
 *                                       and project-specific glob keys)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { isSensorLang } from "@isaacriehm/cairn-state";
import type { StubCatalog, StubPattern, SensorLanguage } from "./types.js";
import { z } from "zod";

const StubPatternSchema = z.object({
  id: z.string(),
  languages: z.array(z.string()),
  description: z.string(),
  regex: z.string(),
  severity: z.enum(["hard", "soft"]),
  skip_globs: z.array(z.string()).optional(),
  must_contain: z.string().optional(),
}).passthrough();

const StubCatalogSchema = z.object({
  version: z.number().optional(),
  patterns: z.array(StubPatternSchema),
}).passthrough();

const SensorRegistryEntrySchema = z.object({
  id: z.string(),
  layer: z.string(),
  kind: z.string(),
  description: z.string(),
  triggers: z.array(z.string()),
  glob_keys: z.array(z.string()).optional(),
  catalog: z.string().optional(),
  fail_severity: z.enum(["hard", "soft"]).optional(),
}).passthrough();

const SensorRegistrySchema = z.object({
  version: z.number().optional(),
  sensors: z.array(SensorRegistryEntrySchema),
  required_glob_keys: z.array(z.string()).optional(),
  disabled_per_project: z.array(z.string()).optional(),
}).passthrough();

export type SensorRegistryEntry = z.infer<typeof SensorRegistryEntrySchema>;
export type SensorRegistry = {
  version: number;
  sensors: SensorRegistryEntry[];
  required_glob_keys: string[];
  disabled_per_project: string[];
};

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Path to the catalog file shipped inside the cairn package itself. Used
 * as the fallback when the adopted project hasn't customized the catalog.
 *
 * Dev / npm build: `dist/sensors/catalog.js` → `templates/.cairn/config/`.
 * Claude Code plugin bundle: `dist/cli.mjs` co-located with `dist/templates/`.
 */
const PKG_TEMPLATE_STUB_CATALOG =
  typeof __CAIRN_BUNDLED__ !== "undefined" && __CAIRN_BUNDLED__
    ? join(HERE, "templates", ".cairn", "config", "stub-patterns.yaml")
    : join(HERE, "..", "..", "templates", ".cairn", "config", "stub-patterns.yaml");

const PKG_TEMPLATE_SENSORS =
  typeof __CAIRN_BUNDLED__ !== "undefined" && __CAIRN_BUNDLED__
    ? join(HERE, "templates", ".cairn", "config", "sensors.yaml")
    : join(HERE, "..", "..", "templates", ".cairn", "config", "sensors.yaml");

/** Load the stub-pattern catalog. Order:
 *   1. `<repoRoot>/.cairn/config/stub-patterns.yaml` (project override)
 *   2. `templates/` inside the cairn package (shipped default)
 */
export function loadStubCatalog(repoRoot?: string): StubCatalog {
  const candidates: string[] = [];
  if (repoRoot !== undefined) {
    candidates.push(join(repoRoot, ".cairn", "config", "stub-patterns.yaml"));
  }
  candidates.push(PKG_TEMPLATE_STUB_CATALOG);

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    return parseStubCatalog(readFileSync(p, "utf8"));
  }
  throw new Error(
    `stub-patterns.yaml not found; checked: ${candidates.join(", ")}`,
  );
}

/** Parse a stub-patterns.yaml document into the typed catalog shape. */
export function parseStubCatalog(yamlText: string): StubCatalog {
  const parsed: unknown = parseYaml(yamlText);
  const result = StubCatalogSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`stub-patterns.yaml parse failed: ${result.error.message}`);
  }
  const data = result.data;
  const patterns: StubPattern[] = data.patterns
    .filter((p) => p.languages.some(isKnownLanguageOrAll))
    .map((p) => ({
      id: p.id,
      languages: p.languages.filter((l): l is SensorLanguage | "all" => isKnownLanguageOrAll(l)),
      description: p.description,
      regex: p.regex,
      severity: p.severity,
      ...(p.skip_globs !== undefined ? { skip_globs: p.skip_globs } : {}),
      ...(p.must_contain !== undefined ? { must_contain: p.must_contain } : {}),
    }));
  return { version: data.version ?? 1, patterns };
}

function isKnownLanguageOrAll(s: unknown): s is SensorLanguage | "all" {
  // Open registry: `"all"` plus any language profile id. A typo'd tag is
  // still rejected (not in the table), but any table language is accepted.
  return s === "all" || isSensorLang(s);
}

/** Load + parse the sensor registry. */
export function loadSensorRegistry(repoRoot?: string): SensorRegistry {
  const candidates: string[] = [];
  if (repoRoot !== undefined) {
    candidates.push(join(repoRoot, ".cairn", "config", "sensors.yaml"));
  }
  candidates.push(PKG_TEMPLATE_SENSORS);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    const parsed: unknown = parseYaml(raw);
    const result = SensorRegistrySchema.safeParse(parsed);
    if (!result.success) continue;
    
    const data = result.data;
    return {
      version: data.version ?? 1,
      sensors: data.sensors,
      required_glob_keys: data.required_glob_keys ?? [],
      disabled_per_project: data.disabled_per_project ?? [],
    };
  }
  throw new Error(
    `sensors.yaml not found; checked: ${candidates.join(", ")}`,
  );
}

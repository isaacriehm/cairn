/**
 * Loaders for the on-disk sensor configuration files.
 *
 * `.cairn/config/stub-patterns.yaml` — Layer A regex catalog
 * `.cairn/config/sensors.yaml`       — sensor registry (which sensors run,
 *                                        their layer, fail_severity, glob keys)
 *
 * Both files ship as templates in `cairn/templates/.cairn/config/` and
 * are copied into the adopted project's `.cairn/config/` at init.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { StubCatalog, StubPattern, SensorLanguage } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Path to the catalog file shipped inside the cairn package itself. Used
 * as the fallback when the adopted project hasn't customized the catalog.
 *
 * Dev / npm build: `dist/sensors/catalog.js` → `templates/.cairn/config/`.
 * Plugin bundle: `dist/cli.cjs` → `dist/templates/.cairn/config/` (esbuild
 * --define flips the prefix; build-bundle.mjs co-locates templates).
 */
const TEMPLATES_PREFIX =
  typeof __CAIRN_BUNDLED__ !== "undefined" && __CAIRN_BUNDLED__
    ? join(HERE, "templates")
    : join(HERE, "..", "..", "templates");
const PKG_TEMPLATE_STUB = join(
  TEMPLATES_PREFIX,
  ".cairn",
  "config",
  "stub-patterns.yaml",
);
const PKG_TEMPLATE_SENSORS = join(
  TEMPLATES_PREFIX,
  ".cairn",
  "config",
  "sensors.yaml",
);

const KNOWN_LANGUAGES: SensorLanguage[] = [
  "typescript",
  "javascript",
  "python",
  "ruby",
  "go",
  "rust",
  "sql",
];

function isKnownLanguage(s: unknown): s is SensorLanguage {
  return typeof s === "string" && (KNOWN_LANGUAGES as string[]).includes(s);
}

/** Parse a stub-patterns.yaml document into the typed catalog shape. */
export function parseStubCatalog(yamlText: string): StubCatalog {
  const doc = parseYaml(yamlText) as Record<string, unknown>;
  const version = typeof doc["version"] === "number" ? doc["version"] : 1;
  const rawPatterns = Array.isArray(doc["patterns"]) ? doc["patterns"] : [];
  const patterns: StubPattern[] = [];
  for (const raw of rawPatterns) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r["id"] === "string" ? r["id"] : "";
    const langs = Array.isArray(r["languages"])
      ? (r["languages"] as unknown[]).filter(isKnownLanguage)
      : [];
    const description = typeof r["description"] === "string" ? r["description"] : "";
    const regex = typeof r["regex"] === "string" ? r["regex"] : "";
    const severity = r["severity"] === "soft" ? "soft" : "hard";
    if (id === "" || regex === "" || langs.length === 0) continue;
    patterns.push({ id, languages: langs, description, regex, severity });
  }
  return { version, patterns };
}

/**
 * Load the stub-pattern catalog. Order:
 *   1. `<repoRoot>/.cairn/config/stub-patterns.yaml` (project override)
 *   2. The package's bundled template file (always present in cairn/dist).
 *
 * Returns the parsed catalog. Throws only if both candidates are missing or
 * unparseable — that would indicate a broken cairn install.
 */
export function loadStubCatalog(repoRoot?: string): StubCatalog {
  const candidates: string[] = [];
  if (repoRoot !== undefined) {
    candidates.push(join(repoRoot, ".cairn", "config", "stub-patterns.yaml"));
  }
  candidates.push(PKG_TEMPLATE_STUB);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    return parseStubCatalog(readFileSync(p, "utf8"));
  }
  throw new Error(
    `stub-patterns.yaml not found; checked: ${candidates.join(", ")}`,
  );
}

/** Sensor registry entry from sensors.yaml. */
export interface SensorRegistryEntry {
  id: string;
  layer: string;
  kind: string;
  description: string;
  triggers: string[];
  glob_keys?: string[];
  catalog?: string;
  fail_severity?: "hard" | "soft";
}

export interface SensorRegistry {
  version: number;
  sensors: SensorRegistryEntry[];
  required_glob_keys: string[];
  disabled_per_project: string[];
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
    const doc = parseYaml(readFileSync(p, "utf8")) as Record<string, unknown>;
    const version = typeof doc["version"] === "number" ? doc["version"] : 1;
    const sensors: SensorRegistryEntry[] = [];
    for (const raw of (doc["sensors"] as unknown[]) ?? []) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      sensors.push({
        id: String(r["id"] ?? ""),
        layer: String(r["layer"] ?? ""),
        kind: String(r["kind"] ?? ""),
        description: String(r["description"] ?? ""),
        triggers: Array.isArray(r["triggers"]) ? (r["triggers"] as string[]) : [],
        ...(Array.isArray(r["glob_keys"]) ? { glob_keys: r["glob_keys"] as string[] } : {}),
        ...(typeof r["catalog"] === "string" ? { catalog: r["catalog"] } : {}),
        ...(r["fail_severity"] === "hard" || r["fail_severity"] === "soft"
          ? { fail_severity: r["fail_severity"] }
          : {}),
      });
    }
    return {
      version,
      sensors,
      required_glob_keys: Array.isArray(doc["required_glob_keys"])
        ? (doc["required_glob_keys"] as string[])
        : [],
      disabled_per_project: Array.isArray(doc["disabled_per_project"])
        ? (doc["disabled_per_project"] as string[])
        : [],
    };
  }
  throw new Error(
    `sensors.yaml not found; checked: ${candidates.join(", ")}`,
  );
}

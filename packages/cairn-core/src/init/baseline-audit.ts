/**
 * Phase 11 — baseline sensor sweep.
 *
 * Runs every sensor that can operate without an LLM call or an external
 * command against a synthetic "every file added at SHA-zero" diff. Each
 * finding is pre-Cairn debt, not a hard failure. Findings land in
 * `.cairn/baseline/sensor-audit-<ISO>.yaml`.
 *
 * Spec: docs/CONTEXT_CONTINUITY_SPEC.md §8.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { cairnDir, writeFileSafe } from "@isaacriehm/cairn-state";
import {
  runStubCatalog,
  runRouteHandlerNonEmpty,
  runDtoNoFakeFields,
  loadStubCatalog,
  loadSensorRegistry,
  type SensorLanguage,
  type SensorResult,
} from "../sensors/index.js";
import { logger } from "../logger.js";
import { walkSourceTree } from "../gc/walk-source.js";
import type { DiffEntry } from "../sensors/types.js";
import { z } from "zod";

const log = logger("init.baseline-audit");

const AuditFileSchema = z.object({
  run_at: z.string().optional(),
}).passthrough();

const MAX_FILE_BYTES = 1_000_000; // skip lock files / minified bundles

/**
 * Hard cap on baseline-audit file count. The per-sensor finding-collection
 * pass is O(files × sensors), and `buildSyntheticDiff` holds every file's
 * content in memory. 1000 files is a safe ceiling for typical project src/
 * without blowing heap or taking > 10s.
 */
const BASELINE_FILE_CAP = 1000;

export interface BaselineAuditFinding {
  path: string;
  line: number;
  severity: "hard" | "soft";
  message: string;
}

export interface BaselineAuditSensorRow {
  sensor_id: string;
  findings: BaselineAuditFinding[];
}

export interface RunBaselineAuditArgs {
  repoRoot: string;
  languages: SensorLanguage[];
}

export interface BaselineAuditResult {
  auditPath: string;
  findingsCount: number;
  filesScanned: number;
  durationMs: number;
}

/** Run the baseline sensor sweep. */
export async function runBaselineAudit(
  args: RunBaselineAuditArgs,
): Promise<BaselineAuditResult> {
  const startedAt = Date.now();
  const dir = cairnDir(args.repoRoot, "baseline");
  mkdirSync(dir, { recursive: true });

  // 1. Build synthetic "add all" diff.
  const files = walkSourceTree(args.repoRoot);
  const syntheticDiff: DiffEntry[] = [];
  let filesScanned = 0;

  for (const rel of files) {
    if (filesScanned >= BASELINE_FILE_CAP) break;
    const abs = join(args.repoRoot, rel);
    try {
      const st = statSync(abs);
      if (st.size > MAX_FILE_BYTES) continue;
      const content = readFileSync(abs, "utf8");
      syntheticDiff.push({
        path: rel,
        status: "added",
        afterContent: content,
      });
      filesScanned += 1;
    } catch {
      continue;
    }
  }

  // 2. Load catalogs and registry.
  const stubCatalog = loadStubCatalog(args.repoRoot);
  const registry = loadSensorRegistry(args.repoRoot);
  const results: SensorResult[] = [];

  // 3. Run sensors.
  // Layer A: Stub catalog
  results.push(
    runStubCatalog({
      diff: syntheticDiff,
      catalog: stubCatalog,
      languages: args.languages,
    }),
  );

  // Layer C: Structural
  const routeGlobs = registry.sensors.find((s) => s.id === "route-handler-non-empty")?.glob_keys;
  results.push(
    runRouteHandlerNonEmpty({
      diff: syntheticDiff,
      globs: routeGlobs ?? [],
    }),
  );
  const dtoGlobs = registry.sensors.find((s) => s.id === "dto-no-fake-fields")?.glob_keys;
  results.push(
    runDtoNoFakeFields({
      diff: syntheticDiff,
      globs: dtoGlobs ?? [],
    }),
  );

  // 4. Summarize and write.
  const findingsCount = results.reduce((n, r) => n + r.findings.length, 0);
  const nowIso = new Date().toISOString();
  const filename = `sensor-audit-${nowIso.replace(/[:.]/g, "-")}.yaml`;
  const auditPath = join(dir, filename);

  const payload = {
    run_at: nowIso,
    languages: args.languages,
    files_scanned: filesScanned,
    total_findings: findingsCount,
    sensors: results.map((r) => ({
      sensor_id: r.sensor_id,
      findings: r.findings.map((f) => ({
        path: f.path,
        line: f.line,
        severity: f.severity,
        message: f.message,
      })),
    })),
  };

  writeFileSafe(auditPath, stringifyYaml(payload));

  return {
    auditPath,
    findingsCount,
    filesScanned,
    durationMs: Date.now() - startedAt,
  };
}

export function findLatestBaselineAudit(repoRoot: string): {
  path: string;
  runAt: string | null;
} | null {
  const dir = cairnDir(repoRoot, "baseline");
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir, { encoding: "utf8" });
  } catch {
    return null;
  }
  const matching = entries
    .filter((name) => /^sensor-audit-.*\.yaml$/.test(name))
    .sort();
  const latest = matching.at(-1);
  if (latest === undefined) return null;
  const abs = join(dir, latest);
  let runAt: string | null = null;
  try {
    const raw = readFileSync(abs, "utf8");
    const parsed: unknown = parseYaml(raw);
    const result = AuditFileSchema.safeParse(parsed);
    if (result.success) {
      runAt = result.data.run_at ?? null;
    }
  } catch {
    runAt = null;
  }
  return { path: abs, runAt };
}

/** Internal helper exposed for smoke cairn — language list from project. */
export function defaultBaselineLanguages(
  stackKinds: string[] | undefined,
): SensorLanguage[] {
  if (stackKinds === undefined || stackKinds.length === 0) {
    return ["typescript", "javascript", "python", "go", "ruby", "rust", "sql"];
  }
  const out: Set<SensorLanguage> = new Set();
  for (const kind of stackKinds) {
    if (kind === "typescript") {
      out.add("typescript");
      out.add("javascript");
    } else if (kind === "python") {
      out.add("python");
    } else if (kind === "ruby") {
      out.add("ruby");
    } else if (kind === "go") {
      out.add("go");
    } else if (kind === "rust") {
      out.add("rust");
    }
  }
  if (out.size === 0) {
    return ["typescript", "javascript", "python", "go", "ruby", "rust", "sql"];
  }
  out.add("sql");
  return Array.from(out);
}

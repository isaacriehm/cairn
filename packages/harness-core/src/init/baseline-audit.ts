/**
 * Phase 6.4 — baseline sensor sweep.
 *
 * Runs every sensor that can operate without an LLM call or an external
 * command against a synthetic "every file added at SHA-zero" diff. Each
 * finding is pre-Harness debt, not a hard failure: the audit yaml is
 * surfaced through `harness attention` later.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { simpleGit } from "simple-git";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import {
  loadSensorRegistry,
  loadStubCatalog,
  runDtoNoFakeFields,
  runRouteHandlerNonEmpty,
  runStubCatalog,
  type DiffEntry,
  type ProjectGlobs,
  type SensorFinding,
  type SensorLanguage,
  type SensorResult,
} from "../sensors/index.js";
import { logger } from "../logger.js";

const log = logger("init.baseline-audit");

const MAX_FILE_BYTES = 1_000_000; // skip lock files / minified bundles
const SOURCE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".cts",
  ".mts",
  ".js",
  ".jsx",
  ".cjs",
  ".mjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".sql",
]);

const SKIP_DIR_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".harness",
  ".archive",
  ".git",
]);

/** Sensors we never run during baseline — they need inputs init can't supply. */
const BASELINE_SKIP_IDS = new Set([
  "attestation-cross-check",
  "generator-drift",
  "decision-assertions",
  "invariant-suite",
  "reviewer-subagent",
  "e2e-real-db",
  "uat-headless-chrome",
  "frontmatter-freshness",
  "local-dirty-overlap",
]);

export interface BaselineAuditFinding {
  sensor_id: string;
  path: string;
  line: number;
  message: string;
  severity: "hard" | "soft";
}

export interface BaselineAuditSensorRow {
  sensor_id: string;
  finding_count: number;
  findings: BaselineAuditFinding[];
  /** Set when the sensor's runnable implementation is missing — captured for transparency. */
  unsupported?: boolean;
}

export interface BaselineAuditResult {
  /** Absolute path to the audit yaml. */
  auditPath: string;
  /** Repo-relative path used in completion summary. */
  auditRelPath: string;
  /** ISO timestamp captured at write time. */
  runAt: string;
  /** One row per sensor that was attempted. */
  sensors: BaselineAuditSensorRow[];
  /** Sum of finding counts (severity:soft + hard). */
  totalFindings: number;
  /** Number of source files synthesized into the audit diff. */
  filesScanned: number;
  /** Sensor IDs that ran clean. */
  cleanSensorIds: string[];
  /** Sensor IDs that produced at least one finding. */
  dirtySensorIds: string[];
  /** Sensor IDs skipped (LLM/external/etc). */
  skippedSensorIds: string[];
}

export interface RunBaselineAuditArgs {
  repoRoot: string;
  /** Globs the route-handler / dto sensors scope to — usually mapper output. */
  projectGlobs: ProjectGlobs;
  /** Languages active for this profile. Defaults derived from stack signatures. */
  languages: SensorLanguage[];
  /** Per-sensor progress callback. */
  onSensorProgress?: (row: {
    sensor_id: string;
    finding_count: number;
    skipped: boolean;
    error: string | null;
  }) => void;
  /** Skip filesystem write — smokes only. */
  dryRun?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Synthetic diff                                                             */
/* -------------------------------------------------------------------------- */

async function listRepoSourceFiles(repoRoot: string): Promise<string[]> {
  // git ls-files honors .gitignore. --cached + untracked + recurse into submodules.
  try {
    const git = simpleGit({ baseDir: repoRoot });
    const cached = await git.raw([
      "ls-files",
      "--cached",
      "--recurse-submodules",
    ]);
    const others = await git.raw([
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);
    const combined = `${cached}\n${others}`;
    return uniqueFilter(combined);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "git ls-files failed; baseline audit will scan an empty fileset",
    );
    return [];
  }
}

function uniqueFilter(blob: string): string[] {
  const out = new Set<string>();
  for (const raw of blob.split("\n")) {
    const path = raw.trim();
    if (path.length === 0) continue;
    if (path.includes("..")) continue;
    if (path.split("/").some((seg) => SKIP_DIR_SEGMENTS.has(seg))) continue;
    if (!hasSourceExt(path)) continue;
    out.add(path);
  }
  return Array.from(out);
}

function hasSourceExt(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return SOURCE_EXTS.has(path.slice(dot).toLowerCase());
}

function buildSyntheticDiff(repoRoot: string, paths: string[]): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const path of paths) {
    const abs = join(repoRoot, path);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE_BYTES) continue;
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    out.push({ path, status: "added", afterContent: text });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Sensor dispatcher                                                          */
/* -------------------------------------------------------------------------- */

interface SensorDispatchOutcome {
  result: SensorResult | null;
  unsupported: boolean;
  errorMessage: string | null;
}

function runOneBaselineSensor(args: {
  id: string;
  diff: DiffEntry[];
  repoRoot: string;
  languages: SensorLanguage[];
  projectGlobs: ProjectGlobs;
}): SensorDispatchOutcome {
  try {
    if (args.id === "stub-pattern-catalog") {
      const catalog = loadStubCatalog(args.repoRoot);
      return {
        result: runStubCatalog({
          diff: args.diff,
          catalog,
          languages: args.languages,
        }),
        unsupported: false,
        errorMessage: null,
      };
    }
    if (args.id === "route-handler-non-empty") {
      return {
        result: runRouteHandlerNonEmpty({
          diff: args.diff,
          globs: args.projectGlobs.route_handler_globs,
        }),
        unsupported: false,
        errorMessage: null,
      };
    }
    if (args.id === "dto-no-fake-fields") {
      return {
        result: runDtoNoFakeFields({
          diff: args.diff,
          globs: args.projectGlobs.dto_globs,
        }),
        unsupported: false,
        errorMessage: null,
      };
    }
    return { result: null, unsupported: true, errorMessage: null };
  } catch (err) {
    return {
      result: null,
      unsupported: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Orchestrator                                                               */
/* -------------------------------------------------------------------------- */

export async function runBaselineAudit(
  args: RunBaselineAuditArgs,
): Promise<BaselineAuditResult> {
  const registry = safeLoadRegistry(args.repoRoot);
  const disabled = new Set(registry?.disabled_per_project ?? []);
  const sensorIds: string[] = (registry?.sensors ?? [])
    .map((s) => s.id)
    .filter((id) => id.length > 0)
    .filter((id) => !disabled.has(id));

  // Stable sort: registry order preserved.
  const filePaths = await listRepoSourceFiles(args.repoRoot);
  const diff = buildSyntheticDiff(args.repoRoot, filePaths);

  const sensors: BaselineAuditSensorRow[] = [];
  const skippedSensorIds: string[] = [];
  const cleanSensorIds: string[] = [];
  const dirtySensorIds: string[] = [];
  let total = 0;

  for (const id of sensorIds) {
    if (BASELINE_SKIP_IDS.has(id)) {
      skippedSensorIds.push(id);
      sensors.push({
        sensor_id: id,
        finding_count: 0,
        findings: [],
        unsupported: true,
      });
      args.onSensorProgress?.({
        sensor_id: id,
        finding_count: 0,
        skipped: true,
        error: null,
      });
      continue;
    }
    const outcome = runOneBaselineSensor({
      id,
      diff,
      repoRoot: args.repoRoot,
      languages: args.languages,
      projectGlobs: args.projectGlobs,
    });
    if (outcome.unsupported || outcome.result === null) {
      skippedSensorIds.push(id);
      sensors.push({
        sensor_id: id,
        finding_count: 0,
        findings: [],
        unsupported: true,
      });
      args.onSensorProgress?.({
        sensor_id: id,
        finding_count: 0,
        skipped: true,
        error: outcome.errorMessage,
      });
      continue;
    }
    const row: BaselineAuditSensorRow = {
      sensor_id: id,
      finding_count: outcome.result.findings.length,
      findings: outcome.result.findings.map(toBaselineFinding),
    };
    sensors.push(row);
    total += row.finding_count;
    if (row.finding_count === 0) cleanSensorIds.push(id);
    else dirtySensorIds.push(id);
    args.onSensorProgress?.({
      sensor_id: id,
      finding_count: row.finding_count,
      skipped: false,
      error: null,
    });
  }

  // Allow inferred languages to widen detection if caller passed an empty list
  // (some adoption paths may fail to detect any). Detection per file kicks
  // back in on the next baseline run, which is cheap.
  if (args.languages.length === 0 && diff.length > 0) {
    log.warn(
      { sample: diff[0]?.path },
      "baseline audit ran with empty languages list; stub-pattern catalog matched nothing",
    );
  }

  const runAt = new Date().toISOString();
  const auditRelPath = `.harness/baseline/sensor-audit-${runAt
    .replace(/[:.]/g, "-")
    .slice(0, 19)}.yaml`;
  const auditPath = join(args.repoRoot, auditRelPath);

  if (args.dryRun !== true) {
    writeAudit(auditPath, {
      run_at: runAt,
      sensors: sensors.map((s) => ({
        sensor_id: s.sensor_id,
        finding_count: s.finding_count,
        findings: s.findings,
        ...(s.unsupported === true ? { unsupported: true } : {}),
      })),
      total_findings: total,
      files_scanned: diff.length,
    });
  }

  return {
    auditPath,
    auditRelPath,
    runAt,
    sensors,
    totalFindings: total,
    filesScanned: diff.length,
    cleanSensorIds,
    dirtySensorIds,
    skippedSensorIds,
  };
}

function safeLoadRegistry(
  repoRoot: string,
): ReturnType<typeof loadSensorRegistry> | null {
  try {
    return loadSensorRegistry(repoRoot);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "loadSensorRegistry failed; baseline audit returns empty",
    );
    return null;
  }
}

function toBaselineFinding(f: SensorFinding): BaselineAuditFinding {
  return {
    sensor_id: f.sensor_id,
    path: f.path ?? "",
    line: f.line ?? 0,
    message: f.message,
    severity: f.severity,
  };
}

function writeAudit(absPath: string, payload: Record<string, unknown>): void {
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, stringifyYaml(payload), "utf8");
}

/* -------------------------------------------------------------------------- */
/* Helpers exported for first-session detection                               */
/* -------------------------------------------------------------------------- */

/**
 * Returns the path of the most recent baseline audit yaml, or null when the
 * baseline directory is empty/missing. Used by the SessionStart onboarding
 * injection to decide whether to fire.
 */
export function findLatestBaselineAudit(repoRoot: string): {
  path: string;
  runAt: string | null;
} | null {
  const dir = join(repoRoot, ".harness", "baseline");
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
    const parsed = parseYaml(readFileSync(abs, "utf8")) as Record<string, unknown>;
    if (typeof parsed["run_at"] === "string") runAt = parsed["run_at"] as string;
  } catch {
    runAt = null;
  }
  return { path: abs, runAt };
}

/** Internal helper exposed for smoke harness — language list from project. */
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


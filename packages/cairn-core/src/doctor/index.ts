/**
 * `cairn doctor` — verify the adoption is healthy.
 *
 * Pure filesystem reads + a status.json check. No LLM. No subprocess fan-out.
 * Returns a structured `DoctorReport` the CLI renders. Exit-code mapping:
 *   0 — all checks OK
 *   1 — at least one error
 *   2 — at least one warning (but no errors)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { which } from "../sensors/shell.js";
import { parse as parseYaml } from "yaml";
import {
  buildDecisionsLedger,
  buildInvariantsLedger,
  hasComponentConfig,
  loadCairnConfig,
  loadComponentsConfig,
  matchAnyGlob,
  matchGlob,
  walkFs,
} from "@isaacriehm/cairn-state";
import { runComponentCheck } from "../components/check.js";
import { semverCmp } from "../migrate/semver.js";
import { VERSION } from "../index.js";
import { normalizeProjectName } from "../paths/index.js";
import { z } from "zod";

const ScopeIndexSchema = z.object({
  files: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const SensorSchema = z.object({
  id: z.string().optional(),
  fail_severity: z.string().optional(),
  command: z.string().optional(),
}).passthrough();

const SensorsConfigSchema = z.object({
  sensors: z.array(SensorSchema).optional(),
  disabled_per_project: z.array(z.string()).optional(),
}).passthrough();

export type DoctorStatus = "ok" | "warn" | "error" | "info";

export interface DoctorCheck {
  group: "core" | "ground" | "sensors";
  /** Short label rendered in the report. */
  label: string;
  status: DoctorStatus;
  /** Detailed reason / remediation instruction. */
  detail: string;
  /** Command to fix the issue (if any). */
  fixCommand?: string;
}

export interface DoctorReport {
  projectName: string;
  checks: DoctorCheck[];
  errors: number;
  warnings: number;
}

export function runDoctor(opts: { repoRoot: string }): DoctorReport {
  const checks: DoctorCheck[] = [];

  // 1. Core checks (adoption state)
  checks.push(checkCairnDir(opts.repoRoot));
  checks.push(checkWorkflowMd(opts.repoRoot));
  checks.push(checkCairnVersion(opts.repoRoot));

  // 2. Ground state
  checks.push(checkScopeIndex(opts.repoRoot));
  checks.push(...checkConfigGlobs(opts.repoRoot));
  checks.push(checkLedger(opts.repoRoot, "decisions"));
  checks.push(checkLedger(opts.repoRoot, "invariants"));

  // 3. Sensors
  checks.push(...checkSensorAvailability(opts.repoRoot));

  // 4. Component registry (only when the project declares component dirs)
  checks.push(...checkComponents(opts.repoRoot));

  const errors = checks.filter((c) => c.status === "error").length;
  const warnings = checks.filter((c) => c.status === "warn").length;

  return {
    projectName: detectProjectName(opts.repoRoot),
    checks,
    errors,
    warnings,
  };
}

// ── Checks ───────────────────────────────────────────────────────────

function checkCairnDir(repoRoot: string): DoctorCheck {
  const path = join(repoRoot, ".cairn");
  if (!existsSync(path)) {
    return {
      group: "core",
      label: ".cairn/",
      status: "error",
      detail: "not found — this is not a cairn-adopted repo",
      fixCommand: "cairn init",
    };
  }
  return {
    group: "core",
    label: ".cairn/",
    status: "ok",
    detail: "present",
  };
}

function checkCairnVersion(repoRoot: string): DoctorCheck {
  const path = join(repoRoot, ".cairn", "config.yaml");
  if (!existsSync(path)) {
    return {
      group: "core",
      label: "cairn version",
      status: "warn",
      detail: ".cairn/config.yaml missing — cannot verify version pin",
      fixCommand: "cairn init --force",
    };
  }
  let projectVersion: string | null = null;
  try {
    const parsed: unknown = parseYaml(readFileSync(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "cairn_version" in parsed
    ) {
      const v = (parsed as Record<string, unknown>)["cairn_version"];
      if (typeof v === "string" && v.length > 0) projectVersion = v;
    }
  } catch {
    return {
      group: "core",
      label: "cairn version",
      status: "warn",
      detail: ".cairn/config.yaml unreadable — cannot verify version pin",
    };
  }
  if (projectVersion === null) {
    return {
      group: "core",
      label: "cairn version",
      status: "warn",
      detail: ".cairn/config.yaml missing cairn_version key — re-run init",
      fixCommand: "cairn init --force",
    };
  }
  if (projectVersion !== VERSION) {
    // Pin behind the CLI → the migration runner brings `.cairn/` forward and
    // stamps the pin. Pin ahead → this CLI is the stale one; upgrade it.
    // (Never advise downgrading the CLI to a frozen pin — that was backwards.)
    const pinBehind = semverCmp(projectVersion, VERSION) < 0;
    return {
      group: "core",
      label: "cairn version",
      status: "warn",
      detail: pinBehind
        ? `project pinned to ${projectVersion}; running cairn ${VERSION} — run \`cairn migrate\` to bring .cairn/ to current`
        : `project pinned to ${projectVersion}; this CLI is older (${VERSION}) — upgrade the CLI`,
      fixCommand: pinBehind ? "cairn migrate" : "npm install -g @isaacriehm/cairn@latest",
    };
  }
  return {
    group: "core",
    label: "cairn version",
    status: "ok",
    detail: `${VERSION} matches project pin`,
  };
}

function checkWorkflowMd(repoRoot: string): DoctorCheck {
  const path = join(repoRoot, ".cairn", "config", "workflow.md");
  if (!existsSync(path)) {
    return {
      group: "core",
      label: "workflow.md",
      status: "error",
      detail: "missing — re-run cairn init",
      fixCommand: "cairn init --force",
    };
  }
  return {
    group: "core",
    label: "workflow.md",
    status: "ok",
    detail: "present",
  };
}

function checkScopeIndex(repoRoot: string): DoctorCheck {
  const path = join(repoRoot, ".cairn", "ground", "scope-index.yaml");
  if (!existsSync(path)) {
    return {
      group: "ground",
      label: "scope-index",
      status: "warn",
      detail: "missing — run cairn scope rebuild",
      fixCommand: "cairn scope rebuild",
    };
  }
  let count = 0;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = parseYaml(raw);
    const result = ScopeIndexSchema.safeParse(parsed);
    if (result.success) {
      const files = result.data.files;
      if (files !== undefined) {
        count = Object.keys(files).length;
      }
    }
  } catch {
    return {
      group: "ground",
      label: "scope-index",
      status: "warn",
      detail: "unreadable — re-run cairn scope rebuild",
      fixCommand: "cairn scope rebuild",
    };
  }
  if (count === 0) {
    return {
      group: "ground",
      label: "scope-index",
      status: "warn",
      detail: "empty — run cairn scope rebuild",
      fixCommand: "cairn scope rebuild",
    };
  }
  return {
    group: "ground",
    label: "scope-index",
    status: "ok",
    detail: `${count} file${count === 1 ? "" : "s"} classified`,
  };
}

/** Dirs the config-glob walk never descends into. */
const GLOB_WALK_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".archive",
  "coverage",
  ".cairn",
]);

/**
 * Config-glob staleness — warn when a `config.yaml` scope glob matches zero
 * files in the working tree. These globs (`high_stakes_globs`,
 * `project_globs.{route_handler,dto,generator_source,high_stakes}_globs`) are
 * written once at adoption and never reconciled to the tree, so a later
 * directory refactor silently neuters high-stakes weighting + the
 * route/DTO sensors (they resolve to zero matches with no signal).
 *
 * Returns [] when the project declares no scope globs (nothing to validate)
 * or the tree walk yields nothing. Stale globs collapse into a single warn
 * check so the report stays readable; the detail lists a sample.
 */
function checkConfigGlobs(repoRoot: string): DoctorCheck[] {
  const cfg = loadCairnConfig(repoRoot);

  const pairs: { source: string; glob: string }[] = [];
  const collect = (source: string, raw: unknown): void => {
    if (!Array.isArray(raw)) return;
    for (const g of raw) {
      if (typeof g === "string" && g.length > 0) pairs.push({ source, glob: g });
    }
  };

  collect("high_stakes_globs", cfg["high_stakes_globs"]);
  const projectGlobs = cfg["project_globs"];
  if (typeof projectGlobs === "object" && projectGlobs !== null) {
    const pg = projectGlobs as Record<string, unknown>;
    collect("project_globs.route_handler_globs", pg["route_handler_globs"]);
    collect("project_globs.dto_globs", pg["dto_globs"]);
    collect("project_globs.generator_source_globs", pg["generator_source_globs"]);
    collect("project_globs.high_stakes_globs", pg["high_stakes_globs"]);
  }

  if (pairs.length === 0) return [];

  const files: string[] = [];
  walkFs({
    dir: repoRoot,
    skipDirs: GLOB_WALK_SKIP_DIRS,
    onFile: (rel) => {
      files.push(rel);
    },
  });
  if (files.length === 0) return [];

  const stale = pairs.filter((p) => !files.some((f) => matchGlob(f, p.glob)));
  if (stale.length === 0) {
    return [
      {
        group: "ground",
        label: "config globs",
        status: "ok",
        detail: `${pairs.length} scope glob${pairs.length === 1 ? "" : "s"} all match tree files`,
      },
    ];
  }

  const sample = stale
    .slice(0, 3)
    .map((p) => `${p.glob} (${p.source})`)
    .join("; ");
  const more = stale.length > 3 ? ` (+${stale.length - 3} more)` : "";
  return [
    {
      group: "ground",
      label: "config globs",
      status: "warn",
      detail:
        `${stale.length} of ${pairs.length} scope glob(s) match zero tree files — ` +
        `stale after a directory refactor? high-stakes weighting + route/DTO sensors silently skip these: ${sample}${more}`,
      fixCommand: "cairn init --force",
    },
  ];
}

function checkLedger(
  repoRoot: string,
  kind: "decisions" | "invariants",
): DoctorCheck {
  const path = join(repoRoot, ".cairn", "ground", kind, `${kind}.ledger.yaml`);
  if (!existsSync(path)) {
    return {
      group: "ground",
      label: `${kind}.ledger`,
      status: "warn",
      detail: "missing — rebuilding...",
      fixCommand: "cairn fix",
    };
  }
  let count = 0;
  try {
    if (kind === "decisions") {
      count = buildDecisionsLedger({ repoRoot }).length;
    } else {
      count = buildInvariantsLedger({ repoRoot }).length;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      group: "ground",
      label: `${kind}.ledger`,
      status: "error",
      detail: `unreadable: ${message}`,
      fixCommand: "cairn fix",
    };
  }
  return {
    group: "ground",
    label: `${kind}.ledger`,
    status: "ok",
    detail: `${count} active entry/ies`,
  };
}

function checkSensorAvailability(repoRoot: string): DoctorCheck[] {
  const path = join(repoRoot, ".cairn", "config", "sensors.yaml");
  if (!existsSync(path)) {
    return [
      {
        group: "sensors",
        label: "sensors.yaml",
        status: "warn",
        detail: "missing — re-run cairn init",
        fixCommand: "cairn init --force",
      },
    ];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return [
      {
        group: "sensors",
        label: "sensors.yaml",
        status: "warn",
        detail: "unreadable",
      },
    ];
  }
  const result = SensorsConfigSchema.safeParse(parsed);
  if (!result.success) return [];
  
  const sensorsRaw = result.data.sensors ?? [];
  const disabled = result.data.disabled_per_project ?? [];
  const disabledSet = new Set<string>(disabled);

  const checks: DoctorCheck[] = [];
  for (const r of sensorsRaw) {
    const id = r.id ?? null;
    if (id === null) continue;
    if (disabledSet.has(id)) {
      checks.push({
        group: "sensors",
        label: id,
        status: "info",
        detail: "disabled per project",
      });
      continue;
    }
    const failSeverity = r.fail_severity ?? "soft";
    const command = r.command ?? null;
    if (command !== null && command.length > 0) {
      const found = which(command);
      if (!found) {
        checks.push({
          group: "sensors",
          label: id,
          status: failSeverity === "hard" ? "error" : "warn",
          detail: `${command} not on PATH — install or disable in sensors.yaml`,
        });
        continue;
      }
    }
    checks.push({
      group: "sensors",
      label: id,
      status: "ok",
      detail: failSeverity === "hard" ? "registered" : "registered (warn-only)",
    });
  }
  return checks;
}

/**
 * Component-registry health. No-op (returns []) when the project declares no
 * component dirs, so non-UI repos see no extra check. Rebuilds the index in
 * memory and validates `@cairn` headers; hard findings fail CI (the workflow
 * runs `cairn doctor`).
 */
function checkComponents(repoRoot: string): DoctorCheck[] {
  const config = loadComponentsConfig(repoRoot);
  if (!hasComponentConfig(config)) return [];
  const result = runComponentCheck(repoRoot);
  if (result.hardFailures > 0) {
    const sample = result.findings
      .filter((f) => f.severity === "hard")
      .slice(0, 3)
      .map((f) => f.message)
      .join("; ");
    const more = result.hardFailures > 3 ? ` (+${result.hardFailures - 3} more)` : "";
    return [
      {
        group: "ground",
        label: "components",
        status: "error",
        detail: `${result.hardFailures} hard finding(s): ${sample}${more}`,
        fixCommand: "cairn components check",
      },
    ];
  }
  if (result.softFindings > 0) {
    return [
      {
        group: "ground",
        label: "components",
        status: "warn",
        detail: `${result.total} component(s); ${result.softFindings} warning(s)`,
        fixCommand: "cairn components check",
      },
    ];
  }
  return [
    {
      group: "ground",
      label: "components",
      status: "ok",
      detail: `${result.total} component(s) across ${result.workspaces} workspace(s)`,
    },
  ];
}

// ── Helpers ──────────────────────────────────────────────────────────

function detectProjectName(repoRoot: string): string {
  const path = join(repoRoot, "package.json");
  if (existsSync(path)) {
    try {
      const pkg = JSON.parse(readFileSync(path, "utf8")) as { name?: string };
      if (pkg.name) return normalizeProjectName(pkg.name);
    } catch {
      /* ignore */
    }
  }
  return normalizeProjectName(repoRoot.split("/").pop() || "this-project");
}

/** Lightweight frontmatter peek without full parser dependency. */
export function peekStatus(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8");
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m || m[1] === undefined) return null;
    const fm = m[1];
    const sm = fm.match(/^status:\s*(\S+)\s*$/m);
    return sm && sm[1] ? sm[1] : null;
  } catch {
    return null;
  }
}

// ── Auto-fix runner ──────────────────────────────────────────────────

export interface RunFixOptions {
  repoRoot: string;
  /** Inject a non-default scope-rebuild handler — used by smokes. */
  rebuildScopeIndexFn?: (repoRoot: string) => Promise<{
    filesClassified: number;
  }>;
}

export interface FixReport {
  appliedFixes: string[];
  manualFixes: { check: string; command: string | null }[];
}

export async function runFix(opts: RunFixOptions): Promise<FixReport> {
  const report = runDoctor({ repoRoot: opts.repoRoot });
  const applied: string[] = [];
  const manual: { check: string; command: string | null }[] = [];

  for (const c of report.checks) {
    if (c.status !== "warn" && c.status !== "error") continue;

    if (c.label === "scope-index" && opts.rebuildScopeIndexFn !== undefined) {
      try {
        const r = await opts.rebuildScopeIndexFn(opts.repoRoot);
        applied.push(
          `scope-index → ${r.filesClassified} file${r.filesClassified === 1 ? "" : "s"} classified`,
        );
      } catch (err) {
        manual.push({
          check: c.label,
          command: c.fixCommand ?? null,
        });
        void err;
      }
      continue;
    }

    manual.push({
      check: c.label,
      command: c.fixCommand ?? null,
    });
  }

  return { appliedFixes: applied, manualFixes: manual };
}

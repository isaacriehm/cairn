/**
 * `cairn doctor` — verify the adoption is healthy.
 *
 * Pure filesystem reads + a status.json check. No LLM. No subprocess fan-out.
 * Returns a structured `DoctorReport` the CLI renders. Exit-code mapping:
 *   0 — all checks pass
 *   1 — at least one error (missing core file, broken layout)
 *   2 — at least one warning (drafty brand, empty scope, GC overdue, …)
 *
 * Spec: docs/PLUGIN_ARCHITECTURE.md §6 (adoption output).
 */

import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, delimiter, join, resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildDecisionsLedger,
  buildInvariantsLedger,
} from "@isaacriehm/cairn-state";
import { normalizeProjectName } from "../paths/index.js";

export type DoctorStatus = "ok" | "warn" | "error" | "info";

export interface DoctorCheck {
  group: "core" | "ground" | "sensors";
  /** Short label rendered in the report. */
  label: string;
  status: DoctorStatus;
  /** One-line detail rendered next to the icon. */
  detail: string;
  /** When non-null, the exact command the operator can run to fix this. */
  fixCommand?: string;
}

export interface DoctorReport {
  projectName: string;
  repoRoot: string;
  checks: DoctorCheck[];
  errors: number;
  warnings: number;
}

export interface RunDoctorOptions {
  repoRoot: string;
}

export function runDoctor(opts: RunDoctorOptions): DoctorReport {
  const repoRoot = opts.repoRoot;
  const projectName = normalizeProjectName(basename(repoRoot));
  const checks: DoctorCheck[] = [];

  // ── Core checks ────────────────────────────────────────────────────
  // .claude/settings.json hooks are no longer written into adopted
  // projects — the Claude Code plugin owns hooks via its own
  // hooks/hooks.json, so a check here would always fire false negatives.
  checks.push(checkCairnLayout(repoRoot));
  // Project-level `.mcp.json` is forbidden in plugin-mode (the plugin's
  // bundled `.mcp.json` is the single registration source). Skipping
  // the check here avoids false errors in CI on plugin-adopted
  // projects. CLI-only adopters still get registration via `cairn init`
  // writing the bundle's manifest fields.

  // ── Ground state checks ────────────────────────────────────────────
  checks.push(checkDecisions(repoRoot));
  checks.push(checkBrandOverview(repoRoot));
  checks.push(checkScopeIndex(repoRoot));

  // ── Sensor presence ────────────────────────────────────────────────
  for (const c of checkSensorAvailability(repoRoot)) checks.push(c);

  let errors = 0;
  let warnings = 0;
  for (const c of checks) {
    if (c.status === "error") errors++;
    else if (c.status === "warn") warnings++;
  }

  return { projectName, repoRoot, checks, errors, warnings };
}

// ── Core checks ──────────────────────────────────────────────────────

function checkCairnLayout(repoRoot: string): DoctorCheck {
  const groundDir = join(repoRoot, ".cairn", "ground");
  if (!existsSync(groundDir)) {
    return {
      group: "core",
      label: ".cairn/",
      status: "error",
      detail: "missing — run cairn init",
      fixCommand: "cairn init",
    };
  }
  let count = 0;
  const stack: string[] = [groundDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "_inbox") continue;
        stack.push(abs);
      } else if (e.isFile()) {
        count++;
      }
    }
  }
  return {
    group: "core",
    label: ".cairn/",
    status: "ok",
    detail: `layout complete (${count} ground files)`,
  };
}

// ── Ground state checks ──────────────────────────────────────────────

function checkDecisions(repoRoot: string): DoctorCheck {
  let accepted = 0;
  let drafts = 0;
  try {
    accepted = buildDecisionsLedger({ repoRoot }).length;
  } catch {
    return {
      group: "ground",
      label: "decisions",
      status: "warn",
      detail: "ledger build failed",
    };
  }
  const inboxDir = join(repoRoot, ".cairn", "ground", "decisions", "_inbox");
  if (existsSync(inboxDir)) {
    try {
      const entries: Dirent[] = readdirSync(inboxDir, {
        withFileTypes: true,
        encoding: "utf8",
      });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".draft.md")) drafts++;
      }
    } catch {
      // ignore
    }
  }
  // Count active invariants for the same line.
  let invariants = 0;
  try {
    invariants = buildInvariantsLedger({ repoRoot }).length;
  } catch {
    // ignore
  }
  if (drafts > 0) {
    return {
      group: "ground",
      label: "decisions",
      status: "warn",
      detail: `${accepted} accepted, ${invariants} invariants, ${drafts} drafts pending`,
      fixCommand: "cairn attention",
    };
  }
  return {
    group: "ground",
    label: "decisions",
    status: "ok",
    detail: `${accepted} accepted, ${invariants} invariants, no drafts pending`,
  };
}

function checkBrandOverview(repoRoot: string): DoctorCheck {
  const path = join(repoRoot, ".cairn", "ground", "brand", "overview.md");
  if (!existsSync(path)) {
    return {
      group: "ground",
      label: "brand/overview",
      status: "warn",
      detail: "missing — re-run cairn init",
      fixCommand: "cairn init --force",
    };
  }
  // Brand overview is operator-paced — `status: draft` is the
  // expected post-adoption state until the operator fills in voice
  // + tone. Doctor reports it informationally (status: ok) so CI
  // workflows pass while the operator still has work to do.
  const status = readFrontmatterStatus(path) ?? "(none)";
  return {
    group: "ground",
    label: "brand/overview",
    status: "ok",
    detail:
      status === "current" || status === "accepted"
        ? `status:${status}`
        : `status:${status} — fill in when ready (operator-paced)`,
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
    const parsed = parseYaml(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const filesRaw = (parsed as Record<string, unknown>)["files"];
      if (typeof filesRaw === "object" && filesRaw !== null) {
        count = Object.keys(filesRaw as Record<string, unknown>).length;
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

// ── Sensors ──────────────────────────────────────────────────────────

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
  if (typeof parsed !== "object" || parsed === null) return [];
  const sensorsRaw = (parsed as Record<string, unknown>)["sensors"];
  if (!Array.isArray(sensorsRaw)) return [];
  const disabled = (parsed as Record<string, unknown>)["disabled_per_project"];
  const disabledSet = new Set<string>(
    Array.isArray(disabled)
      ? (disabled as unknown[]).filter(
          (x): x is string => typeof x === "string",
        )
      : [],
  );

  const checks: DoctorCheck[] = [];
  for (const raw of sensorsRaw) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r["id"] === "string" ? (r["id"] as string) : null;
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
    const failSeverity =
      typeof r["fail_severity"] === "string" ? (r["fail_severity"] as string) : "soft";
    const command =
      typeof r["command"] === "string" ? (r["command"] as string) : null;
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

function which(binary: string): boolean {
  const pathEnv = process.env["PATH"];
  if (typeof pathEnv !== "string" || pathEnv.length === 0) return false;
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = resolvePath(dir, binary);
    try {
      if (statSync(candidate).isFile()) return true;
    } catch {
      // continue
    }
  }
  return false;
}

// ── Shared helpers ───────────────────────────────────────────────────

function readFrontmatterStatus(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8");
    const m = text.match(/^---\n([\s\S]*?\n)---/);
    if (!m) return null;
    const fm = m[1] ?? "";
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

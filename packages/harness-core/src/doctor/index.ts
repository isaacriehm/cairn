/**
 * `harness doctor` — verify the adoption is healthy.
 *
 * Pure filesystem reads + a status.json check. No LLM. No subprocess fan-out.
 * Returns a structured `DoctorReport` the CLI renders. Exit-code mapping:
 *   0 — all checks pass
 *   1 — at least one error (missing core file, broken layout)
 *   2 — at least one warning (drafty brand, empty scope, daemon not running, …)
 *
 * Spec: BUILD_REPORT.md "Task D — harness doctor command".
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
} from "../ground/index.js";
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
  checks.push(checkHarnessLayout(repoRoot));
  checks.push(checkMcpRegistration(repoRoot));
  checks.push(checkClaudeHooks(repoRoot));

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

function checkHarnessLayout(repoRoot: string): DoctorCheck {
  const groundDir = join(repoRoot, ".harness", "ground");
  if (!existsSync(groundDir)) {
    return {
      group: "core",
      label: ".harness/",
      status: "error",
      detail: "missing — run harness init",
      fixCommand: "harness init",
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
    label: ".harness/",
    status: "ok",
    detail: `layout complete (${count} ground files)`,
  };
}

function checkMcpRegistration(repoRoot: string): DoctorCheck {
  const path = join(repoRoot, ".mcp.json");
  if (!existsSync(path)) {
    return {
      group: "core",
      label: ".mcp.json",
      status: "error",
      detail: "missing — run harness init",
      fixCommand: "harness init",
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {
      group: "core",
      label: ".mcp.json",
      status: "error",
      detail: "unreadable — re-run harness init",
      fixCommand: "harness init --force",
    };
  }
  const servers = parsed["mcpServers"];
  if (typeof servers !== "object" || servers === null) {
    return {
      group: "core",
      label: ".mcp.json",
      status: "error",
      detail: "missing mcpServers — re-run harness init",
      fixCommand: "harness init --force",
    };
  }
  if ((servers as Record<string, unknown>)["harness"] === undefined) {
    return {
      group: "core",
      label: ".mcp.json",
      status: "error",
      detail: "no harness entry — re-run harness init",
      fixCommand: "harness init --force",
    };
  }
  return {
    group: "core",
    label: ".mcp.json",
    status: "ok",
    detail: "harness MCP server registered",
  };
}

function checkClaudeHooks(repoRoot: string): DoctorCheck {
  const path = join(repoRoot, ".claude", "settings.json");
  if (!existsSync(path)) {
    return {
      group: "core",
      label: ".claude/",
      status: "error",
      detail: "missing settings.json — re-run harness init",
      fixCommand: "harness init --force",
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {
      group: "core",
      label: ".claude/",
      status: "error",
      detail: "settings.json unreadable",
      fixCommand: "harness init --force",
    };
  }
  const hooks = parsed["hooks"];
  if (typeof hooks !== "object" || hooks === null) {
    return {
      group: "core",
      label: ".claude/",
      status: "warn",
      detail: "no hooks block — re-run harness init",
      fixCommand: "harness init --force",
    };
  }
  const labels: string[] = [];
  if (Array.isArray((hooks as Record<string, unknown>)["SessionStart"])) {
    labels.push("SessionStart");
  }
  if (Array.isArray((hooks as Record<string, unknown>)["PostToolUse"])) {
    labels.push("PostToolUse");
  }
  if (labels.length === 0) {
    return {
      group: "core",
      label: ".claude/",
      status: "warn",
      detail: "no SessionStart / PostToolUse entries",
      fixCommand: "harness init --force",
    };
  }
  return {
    group: "core",
    label: ".claude/",
    status: "ok",
    detail: `${labels.join(" + ")} registered`,
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
  const inboxDir = join(repoRoot, ".harness", "ground", "decisions", "_inbox");
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
      fixCommand: "harness attention",
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
  const path = join(repoRoot, ".harness", "ground", "brand", "overview.md");
  if (!existsSync(path)) {
    return {
      group: "ground",
      label: "brand/overview",
      status: "warn",
      detail: "missing — re-run harness init",
      fixCommand: "harness init --force",
    };
  }
  const status = readFrontmatterStatus(path) ?? "(none)";
  if (status === "current" || status === "accepted") {
    return {
      group: "ground",
      label: "brand/overview",
      status: "ok",
      detail: `status:${status}`,
    };
  }
  return {
    group: "ground",
    label: "brand/overview",
    status: "warn",
    detail: `status:${status}`,
    fixCommand: "harness configure brand",
  };
}

function checkScopeIndex(repoRoot: string): DoctorCheck {
  const path = join(repoRoot, ".harness", "ground", "scope-index.yaml");
  if (!existsSync(path)) {
    return {
      group: "ground",
      label: "scope-index",
      status: "warn",
      detail: "missing — run harness scope rebuild",
      fixCommand: "harness scope rebuild",
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
      detail: "unreadable — re-run harness scope rebuild",
      fixCommand: "harness scope rebuild",
    };
  }
  if (count === 0) {
    return {
      group: "ground",
      label: "scope-index",
      status: "warn",
      detail: "empty — run harness scope rebuild",
      fixCommand: "harness scope rebuild",
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
  const path = join(repoRoot, ".harness", "config", "sensors.yaml");
  if (!existsSync(path)) {
    return [
      {
        group: "sensors",
        label: "sensors.yaml",
        status: "warn",
        detail: "missing — re-run harness init",
        fixCommand: "harness init --force",
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

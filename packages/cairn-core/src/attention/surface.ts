/**
 * Shared attention-surface readers — pending drafts + baseline audit files.
 *
 * Consumed by SessionStart (`session-start/build.ts`) and the
 * `cairn attention` CLI so both surfaces scan the same sources.
 */

import { type Dirent, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { cairnDir, parseFrontmatter } from "@isaacriehm/cairn-state";

export interface AttentionDraftEntry {
  id: string;
  title: string;
  capture_source: string | null;
  decided_at: string | null;
  source_file: string | null;
  proposed_rationale: string | null;
}

export interface BaselineAuditSummary {
  runAt: string | null;
  totalFindings: number;
  hardFindings: number;
  softFindings: number;
  filesScanned: number;
}

export interface BaselineFindingRow {
  sensor_id: string;
  path: string;
  line: number;
  message: string;
  severity: "hard" | "soft";
}

export interface BaselineAuditDetail extends BaselineAuditSummary {
  /** Repo-relative path when under repoRoot, else absolute. */
  auditPath: string;
  bySensor: Map<string, BaselineFindingRow[]>;
}

export interface ReadBaselineOptions {
  /** Baseline filename prefix. Default `sensor-audit-`. */
  prefix?: string;
  /** Optional warning sink for non-fatal read errors. */
  warnings?: string[];
}

const DEFAULT_BASELINE_PREFIX = "sensor-audit-";

const INBOX_DIRS = (repoRoot: string): string[] => [
  cairnDir(repoRoot, "ground", "decisions", "_inbox"),
  cairnDir(repoRoot, "ground", "invariants", "_inbox"),
];

function fmString(fm: Record<string, unknown>, key: string): string | null {
  const v = fm[key];
  return typeof v === "string" ? v : null;
}

/** List pending DEC + INV drafts from both `_inbox/` directories. */
export function listPendingDrafts(
  repoRoot: string,
  warnings: string[] = [],
): AttentionDraftEntry[] {
  const out: AttentionDraftEntry[] = [];
  for (const dir of INBOX_DIRS(repoRoot)) {
    if (!existsSync(dir)) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".draft.md")) continue;
      const abs = join(dir, e.name);
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch (err) {
        warnings.push(
          `draft ${e.name} unreadable: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const parsed = parseFrontmatter(text);
      const fm = (parsed.frontmatter ?? {}) as Record<string, unknown>;
      const id = fmString(fm, "id") ?? e.name.replace(/\.draft\.md$/, "");
      const title = fmString(fm, "title") ?? "(untitled draft)";
      out.push({
        id,
        title,
        capture_source: fmString(fm, "capture_source"),
        decided_at: fmString(fm, "decided_at"),
        source_file: fmString(fm, "sourceFile"),
        proposed_rationale: fmString(fm, "proposedRationale"),
      });
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function findLatestBaselineFile(
  repoRoot: string,
  prefix: string,
  warnings: string[],
): string | null {
  const dir = cairnDir(repoRoot, "baseline");
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir, { encoding: "utf8" });
  } catch (err) {
    warnings.push(
      `baseline dir read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}.*\\.yaml$`);
  const latest = entries.filter((name) => re.test(name)).sort().at(-1);
  return latest === undefined ? null : join(dir, latest);
}

function parseBaselinePayload(raw: unknown): {
  runAt: string | null;
  totalFindings: number;
  filesScanned: number;
  sensors: unknown;
} {
  if (typeof raw !== "object" || raw === null) {
    return { runAt: null, totalFindings: 0, filesScanned: 0, sensors: undefined };
  }
  const parsed = raw as Record<string, unknown>;
  return {
    runAt: typeof parsed["run_at"] === "string" ? parsed["run_at"] : null,
    totalFindings:
      typeof parsed["total_findings"] === "number" ? parsed["total_findings"] : 0,
    filesScanned:
      typeof parsed["files_scanned"] === "number" ? parsed["files_scanned"] : 0,
    sensors: parsed["sensors"],
  };
}

/** Tally findings by severity from `sensors[].findings[]`. */
export function countFindingsBySeverity(sensorsRaw: unknown): { hard: number; soft: number } {
  let hard = 0;
  let soft = 0;
  if (!Array.isArray(sensorsRaw)) return { hard, soft };
  for (const sensor of sensorsRaw) {
    if (typeof sensor !== "object" || sensor === null) continue;
    const findings = (sensor as Record<string, unknown>)["findings"];
    if (!Array.isArray(findings)) continue;
    for (const f of findings) {
      if (typeof f !== "object" || f === null) continue;
      const sev = (f as Record<string, unknown>)["severity"];
      if (sev === "hard") hard += 1;
      else if (sev === "soft") soft += 1;
    }
  }
  return { hard, soft };
}

function buildFindingsBySensor(sensorsRaw: unknown): Map<string, BaselineFindingRow[]> {
  const bySensor = new Map<string, BaselineFindingRow[]>();
  if (!Array.isArray(sensorsRaw)) return bySensor;
  for (const sensor of sensorsRaw) {
    if (typeof sensor !== "object" || sensor === null) continue;
    const rec = sensor as Record<string, unknown>;
    const sensorId = typeof rec["sensor_id"] === "string" ? rec["sensor_id"] : "";
    if (sensorId.length === 0) continue;
    const findingsRaw = rec["findings"];
    if (!Array.isArray(findingsRaw)) continue;
    const rows: BaselineFindingRow[] = [];
    for (const fr of findingsRaw) {
      if (typeof fr !== "object" || fr === null) continue;
      const f = fr as Record<string, unknown>;
      rows.push({
        sensor_id: sensorId,
        path: typeof f["path"] === "string" ? f["path"] : "",
        line: typeof f["line"] === "number" ? f["line"] : 0,
        message: typeof f["message"] === "string" ? f["message"] : "",
        severity: f["severity"] === "hard" ? "hard" : "soft",
      });
    }
    if (rows.length > 0) bySensor.set(sensorId, rows);
  }
  return bySensor;
}

/** Read the latest baseline audit summary (hard/soft tallies). */
export function readLatestBaselineAudit(
  repoRoot: string,
  options: ReadBaselineOptions = {},
): BaselineAuditSummary | null {
  const warnings = options.warnings ?? [];
  const prefix = options.prefix ?? DEFAULT_BASELINE_PREFIX;
  const abs = findLatestBaselineFile(repoRoot, prefix, warnings);
  if (abs === null) return null;
  try {
    const payload = parseBaselinePayload(parseYaml(readFileSync(abs, "utf8")));
    const { hard, soft } = countFindingsBySeverity(payload.sensors);
    return {
      runAt: payload.runAt,
      totalFindings: payload.totalFindings,
      hardFindings: hard,
      softFindings: soft,
      filesScanned: payload.filesScanned,
    };
  } catch (err) {
    warnings.push(
      `baseline audit unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Read the latest baseline audit with per-sensor findings (CLI display). */
export function readLatestBaselineDetail(
  repoRoot: string,
  options: ReadBaselineOptions = {},
): BaselineAuditDetail | null {
  const warnings = options.warnings ?? [];
  const prefix = options.prefix ?? DEFAULT_BASELINE_PREFIX;
  const abs = findLatestBaselineFile(repoRoot, prefix, warnings);
  if (abs === null) return null;
  try {
    const payload = parseBaselinePayload(parseYaml(readFileSync(abs, "utf8")));
    const { hard, soft } = countFindingsBySeverity(payload.sensors);
    const auditPath = abs.startsWith(repoRoot) ? abs.slice(repoRoot.length + 1) : abs;
    return {
      runAt: payload.runAt,
      totalFindings: payload.totalFindings,
      hardFindings: hard,
      softFindings: soft,
      filesScanned: payload.filesScanned,
      auditPath,
      bySensor: buildFindingsBySensor(payload.sensors),
    };
  } catch (err) {
    warnings.push(
      `baseline audit unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

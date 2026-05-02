/**
 * Persistent UAT.md per task — survives context resets.
 *
 * Per UAT_PIPELINE.md §8 + GSD pattern. One file per task at
 * `.harness/tasks/<task_id>/uat.md`. Carries:
 *   - status: pending | passing | passed | failed | blocked | abandoned
 *   - acceptance criteria checklist (per AC, status icon)
 *   - cold-start smoke status
 *   - blocked_by (env issues) — NEVER folded into Gaps
 *   - Gaps from prior rejections
 *   - related run ids
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { logger } from "../logger.js";
import type { UatSummary } from "./types.js";

const log = logger("uat.persistent");

export type UatTaskStatus =
  | "pending"
  | "passing"
  | "passed"
  | "failed"
  | "blocked"
  | "abandoned";

export interface UatTaskRecord {
  status: UatTaskStatus;
  generated: string;
  last_updated: string;
  attempt: number;
  related_run_ids: string[];
  acceptance: { id: string; text: string; status: "pass" | "fail" | "pending" | "skipped" }[];
  cold_start_smoke?: { status: "pass" | "fail" | "skipped" };
  /** Environmental blockers (server down, third-party rate-limited). NEVER code bugs. */
  blocked_by: string[];
  /** Resolved gaps from prior rejections. */
  gaps_resolved: { run_id: string; description: string }[];
  /** Open gaps not yet resolved. */
  gaps_open: { run_id: string; description: string }[];
  notes?: string;
}

function uatTaskFile(repoRoot: string, taskId: string): string {
  return join(repoRoot, ".harness", "tasks", taskId, "uat.md");
}

const FENCE_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;

export function readUatTaskFile(repoRoot: string, taskId: string): UatTaskRecord | null {
  const path = uatTaskFile(repoRoot, taskId);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const m = raw.match(FENCE_RE);
  if (!m) return null;
  try {
    const fm = parseYaml(m[1] ?? "") as Record<string, unknown>;
    return normalizeRecord(fm);
  } catch (err) {
    log.warn({ err: String(err), path }, "uat.md frontmatter parse failed");
    return null;
  }
}

function normalizeRecord(fm: Record<string, unknown>): UatTaskRecord {
  return {
    status: ((): UatTaskStatus => {
      const v = fm["status"];
      return typeof v === "string" && isStatus(v) ? v : "pending";
    })(),
    generated: typeof fm["generated"] === "string" ? fm["generated"] : new Date().toISOString(),
    last_updated:
      typeof fm["last_updated"] === "string" ? fm["last_updated"] : new Date().toISOString(),
    attempt: typeof fm["attempt"] === "number" ? fm["attempt"] : 1,
    related_run_ids: Array.isArray(fm["related_run_ids"])
      ? (fm["related_run_ids"] as unknown[]).map(String)
      : [],
    acceptance: Array.isArray(fm["acceptance"])
      ? (fm["acceptance"] as Record<string, unknown>[]).map((row) => ({
          id: String(row["id"] ?? ""),
          text: String(row["text"] ?? ""),
          status: ((): "pass" | "fail" | "pending" | "skipped" => {
            const v = row["status"];
            return v === "pass" || v === "fail" || v === "skipped" ? v : "pending";
          })(),
        }))
      : [],
    ...(fm["cold_start_smoke"] !== undefined
      ? {
          cold_start_smoke: {
            status: ((): "pass" | "fail" | "skipped" => {
              const v = (fm["cold_start_smoke"] as Record<string, unknown>)["status"];
              return v === "pass" || v === "fail" ? v : "skipped";
            })(),
          },
        }
      : {}),
    blocked_by: Array.isArray(fm["blocked_by"]) ? (fm["blocked_by"] as unknown[]).map(String) : [],
    gaps_resolved: Array.isArray(fm["gaps_resolved"])
      ? (fm["gaps_resolved"] as Record<string, unknown>[]).map((row) => ({
          run_id: String(row["run_id"] ?? ""),
          description: String(row["description"] ?? ""),
        }))
      : [],
    gaps_open: Array.isArray(fm["gaps_open"])
      ? (fm["gaps_open"] as Record<string, unknown>[]).map((row) => ({
          run_id: String(row["run_id"] ?? ""),
          description: String(row["description"] ?? ""),
        }))
      : [],
    ...(typeof fm["notes"] === "string" ? { notes: fm["notes"] } : {}),
  };
}

function isStatus(s: string): s is UatTaskStatus {
  return ["pending", "passing", "passed", "failed", "blocked", "abandoned"].includes(s);
}

export interface UpsertUatTaskArgs {
  repoRoot: string;
  taskId: string;
  runId: string;
  summary: UatSummary;
  /** Final status to record on this attempt. */
  status: UatTaskStatus;
  /** New gap to record (from a rejection). */
  newGap?: { run_id: string; description: string };
  /** Gap descriptions to mark resolved. */
  resolveGaps?: string[];
  /** Optional blocked_by reason to add. */
  blockedBy?: string;
  /** Free-text notes appended to the body. */
  notes?: string;
}

/** Create or update the per-task UAT.md. Idempotent. */
export async function upsertUatTask(args: UpsertUatTaskArgs): Promise<string> {
  const path = uatTaskFile(args.repoRoot, args.taskId);
  const existing = readUatTaskFile(args.repoRoot, args.taskId);
  const now = new Date().toISOString();
  const next: UatTaskRecord = existing
    ? {
        ...existing,
        status: args.status,
        last_updated: now,
        attempt: existing.attempt + (existing.related_run_ids.includes(args.runId) ? 0 : 1),
        related_run_ids: existing.related_run_ids.includes(args.runId)
          ? existing.related_run_ids
          : [...existing.related_run_ids, args.runId],
      }
    : {
        status: args.status,
        generated: now,
        last_updated: now,
        attempt: 1,
        related_run_ids: [args.runId],
        acceptance: [],
        blocked_by: [],
        gaps_resolved: [],
        gaps_open: [],
      };

  // Acceptance status from summary.
  next.acceptance = args.summary.acceptance_results.map((r) => ({
    id: r.id,
    text: r.text,
    status: r.status,
  }));
  if (args.summary.cold_start_smoke) {
    next.cold_start_smoke = { status: args.summary.cold_start_smoke.status };
  }

  if (args.blockedBy && !next.blocked_by.includes(args.blockedBy)) {
    next.blocked_by.push(args.blockedBy);
  }
  if (args.newGap) {
    next.gaps_open.push(args.newGap);
  }
  if (args.resolveGaps && args.resolveGaps.length > 0) {
    const toResolve = new Set(args.resolveGaps);
    const stillOpen: typeof next.gaps_open = [];
    for (const g of next.gaps_open) {
      if (toResolve.has(g.description)) {
        next.gaps_resolved.push({ run_id: args.runId, description: g.description });
      } else {
        stillOpen.push(g);
      }
    }
    next.gaps_open = stillOpen;
  }
  if (args.notes !== undefined) next.notes = args.notes;

  const body = renderBody(next);
  const content = `---\n${stringifyYaml(stripBodyFromRecord(next)).trim()}\n---\n\n${body}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  log.info({ task_id: args.taskId, status: args.status, path }, "uat.md upserted");
  return path;
}

/** Frontmatter doesn't include the rendered body's prose; strip it for serialization. */
function stripBodyFromRecord(r: UatTaskRecord): Record<string, unknown> {
  return {
    type: "uat",
    status: r.status,
    generated: r.generated,
    last_updated: r.last_updated,
    attempt: r.attempt,
    related_run_ids: r.related_run_ids,
    acceptance: r.acceptance,
    ...(r.cold_start_smoke !== undefined ? { cold_start_smoke: r.cold_start_smoke } : {}),
    blocked_by: r.blocked_by,
    gaps_resolved: r.gaps_resolved,
    gaps_open: r.gaps_open,
  };
}

function renderBody(r: UatTaskRecord): string {
  const lines: string[] = [];
  lines.push(`# UAT — status: ${r.status} (attempt ${r.attempt})`);
  lines.push("");
  lines.push("## Acceptance criteria");
  if (r.acceptance.length === 0) lines.push("(none)");
  for (const a of r.acceptance) {
    const icon =
      a.status === "pass" ? "✓" : a.status === "fail" ? "✗" : a.status === "skipped" ? "⊘" : "·";
    lines.push(`- [${icon}] ${a.id} — ${a.text}`);
  }
  if (r.cold_start_smoke) {
    lines.push("");
    lines.push(`## Cold-start smoke: ${r.cold_start_smoke.status}`);
  }
  lines.push("");
  lines.push("## Blocked-by (env issues, NEVER folded into Gaps)");
  if (r.blocked_by.length === 0) lines.push("(none)");
  for (const b of r.blocked_by) lines.push(`- ${b}`);
  lines.push("");
  lines.push("## Gaps from prior rejections");
  if (r.gaps_resolved.length === 0 && r.gaps_open.length === 0) lines.push("(none)");
  for (const g of r.gaps_resolved) lines.push(`- [resolved in ${g.run_id}] ${g.description}`);
  for (const g of r.gaps_open) lines.push(`- [open · ${g.run_id}] ${g.description}`);
  if (r.notes) {
    lines.push("");
    lines.push("## Notes");
    lines.push(r.notes);
  }
  return lines.join("\n");
}

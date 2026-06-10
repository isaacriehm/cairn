/**
 * Run-handoff block — builds the Section-0 SessionStart payload from git
 * history when an active run is in flight (`tasks/active/<id>/status.yaml`
 * with `phase: running` or `phase: sensor_check`).
 *
 * Spec: docs/CONTEXT_CONTINUITY_SPEC.md §7.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { cairnDir, parseFrontmatter } from "@isaacriehm/cairn-state";

/** Hard cap on rendered handoff size (chars). ~600 tokens. */
const MAX_CHARS = 2_400;
/** Cap on commits emitted before truncation kicks in. */
const COMMIT_CAP = 20;

const StatusFileSchema = z.object({
  phase: z.string().optional(),
  related_run_ids: z.array(z.string()).optional(),
}).passthrough();

const MetaFileSchema = z.object({
  sha_pin: z.string().optional(),
}).passthrough();

const CheckpointSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
});

const SpecFrontmatterSchema = z.object({
  checkpoints: z.array(CheckpointSchema).optional(),
}).passthrough();

interface CheckpointEntry {
  id: string;
  label?: string;
}

export interface HandoffPayload {
  taskId: string;
  runId: string;
  taskTitle: string;
  shaPin: string;
  checkpoints: CheckpointEntry[];
  diffFiles: { file: string; insertions: number; deletions: number }[];
  commitsSincePin: { hash: string; msg: string }[];
  notes?: string;
}

/**
 * Scan for an active task run and build the handoff payload by diffing
 * current working tree against the run's sha_pin. Returns null when no
 * task is in flight.
 */
export async function buildHandoffBlock(repoRoot: string): Promise<string | null> {
  const activeDir = cairnDir(repoRoot, "tasks", "active");
  if (!existsSync(activeDir)) return null;

  let matched: { taskId: string; runId: string } | null = null;
  const entries = readdirSync(activeDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const statusPath = join(activeDir, e.name, "status.yaml");
    if (!existsSync(statusPath)) continue;
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(statusPath, "utf8"));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const statusResult = StatusFileSchema.safeParse(parsed);
    if (!statusResult.success) continue;
    
    const status = statusResult.data;
    const phase = status.phase ?? "";
    if (phase !== "running" && phase !== "sensor_check") continue;
    const runIds = status.related_run_ids ?? [];
    const first = runIds[0];
    if (typeof first !== "string" || first.length === 0) continue;
    matched = { taskId: e.name, runId: first };
    break;
  }
  if (matched === null) return null;

  // Read meta.json for the run's sha_pin.
  const metaPath = cairnDir(repoRoot, "runs", "active", matched.runId, "meta.json");
  if (!existsSync(metaPath)) return null;
  let shaPin: string | null = null;
  try {
    const raw = JSON.parse(readFileSync(metaPath, "utf8"));
    const metaResult = MetaFileSchema.safeParse(raw);
    if (metaResult.success) {
      shaPin = metaResult.data.sha_pin ?? null;
    }
  } catch {
    return null;
  }
  if (shaPin === null || shaPin.length === 0) return null;

  // Resolve task title from spec.tightened.md heading.
  const taskDir = join(activeDir, matched.taskId);
  const specPath = join(taskDir, "spec.tightened.md");
  let taskTitle = matched.taskId;
  let checkpoints: CheckpointEntry[] = [];
  if (existsSync(specPath)) {
    let specText = "";
    try {
      specText = readFileSync(specPath, "utf8");
    } catch {
      specText = "";
    }
    if (specText.length > 0) {
      const parsed = parseFrontmatter(specText);
      const titleMatch = parsed.body.match(/^#\s+(.+)$/m);
      if (titleMatch && titleMatch[1]) taskTitle = titleMatch[1].trim();
      
      const fmResult = SpecFrontmatterSchema.safeParse(parsed.frontmatter ?? {});
      if (fmResult.success) {
        checkpoints = (fmResult.data.checkpoints ?? []).map(c => ({
          id: c.id,
          ...(c.label !== undefined ? { label: c.label } : {})
        }));
      }
    }
  }

  // Read git log + diff summary.
  const git = simpleGit(repoRoot);
  const diffSummary = await git.diffSummary([shaPin]);
  const log = await git.log({ from: shaPin, to: "HEAD" });

  // Read agent notes if present.
  let notes: string | undefined;
  const notesPath = join(taskDir, "notes.md");
  if (existsSync(notesPath)) {
    try {
      notes = readFileSync(notesPath, "utf8");
    } catch {
      /* ignore */
    }
  }

  const payload: HandoffPayload = {
    taskId: matched.taskId,
    runId: matched.runId,
    taskTitle,
    shaPin,
    checkpoints,
    diffFiles: diffSummary.files.map((f) => {
      const insertions = "insertions" in f ? (f as { insertions: number }).insertions : 0;
      const deletions = "deletions" in f ? (f as { deletions: number }).deletions : 0;
      return {
        file: f.file,
        insertions,
        deletions,
      };
    }),
    commitsSincePin: log.all.map((c) => ({
      hash: c.hash,
      msg: c.message,
    })),
    ...(notes !== undefined ? { notes } : {}),
  };

  const block = renderHandoff(payload);
  return block.length > MAX_CHARS ? block.slice(0, MAX_CHARS) + "\n...[truncated]" : block;
}

function renderHandoff(parts: HandoffPayload): string {
  const lines: string[] = [];
  lines.push(`Active task: ${parts.taskTitle} (${parts.taskId})`);
  lines.push(`Implementation in flight — resumed from sha_pin ${parts.shaPin.slice(0, 7)}.`);
  lines.push("");

  const phasesComplete = parts.checkpoints.filter((c) => c.label?.includes("[x]")).map((c) => c.id);
  const phasesRemaining = parts.checkpoints.filter((c) => !c.label?.includes("[x]")).map((c) => c.id);
  const notesBody = parts.notes?.trim() ?? "";

  if (parts.checkpoints.length > 0) {
    lines.push(`Phases complete: ${phasesComplete.length === 0 ? "(none)" : phasesComplete.join(", ")}`);
    lines.push(
      `Phases remaining: ${phasesRemaining.length === 0 ? "(none)" : phasesRemaining.join(", ")}`,
    );
    lines.push("");
  }

  lines.push("Files touched so far:");
  if (parts.diffFiles.length === 0) {
    lines.push("  (none reported)");
  } else {
    for (const f of parts.diffFiles) {
      lines.push(`  ${f.file}  [+${f.insertions} -${f.deletions}]`);
    }
  }

  if (notesBody.length > 0) {
    lines.push("");
    lines.push("Agent notes from previous phases:");
    lines.push(notesBody);
  }

  return lines.join("\n");
}

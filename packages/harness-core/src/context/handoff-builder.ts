/**
 * Run-handoff block — builds the Section-0 SessionStart payload from git
 * history when an active run is in flight (`tasks/active/<id>/status.yaml`
 * with `phase: running` or `phase: sensor_check`).
 *
 * Spec: docs/CONTEXT_CONTINUITY_SPEC.md §2.2.
 *
 * Read-only; returns null when no in-flight run is detected, when meta is
 * unparseable, or when there are no commits since the run's `sha_pin`.
 */

import { type Dirent, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { parse as parseYaml } from "yaml";
import { parseFrontmatter } from "../ground/index.js";

/** Hard cap on rendered handoff size (chars). ~600 tokens. */
const MAX_CHARS = 2_400;
/** Cap on commits emitted before truncation kicks in. */
const COMMIT_CAP = 20;

interface StatusFile {
  phase?: string;
  related_run_ids?: string[];
}

interface MetaFile {
  sha_pin?: string;
}

interface CheckpointEntry {
  id: string;
  label?: string;
}

export async function buildHandoffBlock(repoRoot: string): Promise<string | null> {
  const activeDir = join(repoRoot, ".harness", "tasks", "active");
  if (!existsSync(activeDir)) return null;

  let dirents: Dirent[];
  try {
    dirents = readdirSync(activeDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return null;
  }

  // Find the first task whose status indicates an in-flight run with a runId.
  let matched: { taskId: string; runId: string } | null = null;
  for (const e of dirents) {
    if (!e.isDirectory()) continue;
    const taskDir = join(activeDir, e.name);
    const statusPath = join(taskDir, "status.yaml");
    if (!existsSync(statusPath)) continue;
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(statusPath, "utf8"));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const status = parsed as StatusFile;
    const phase = typeof status.phase === "string" ? status.phase : "";
    if (phase !== "running" && phase !== "sensor_check") continue;
    const runIds = Array.isArray(status.related_run_ids) ? status.related_run_ids : [];
    const first = runIds[0];
    if (typeof first !== "string" || first.length === 0) continue;
    matched = { taskId: e.name, runId: first };
    break;
  }
  if (matched === null) return null;

  // Read meta.json for the run's sha_pin.
  const metaPath = join(repoRoot, ".harness", "runs", "active", matched.runId, "meta.json");
  if (!existsSync(metaPath)) return null;
  let meta: MetaFile;
  try {
    const raw = JSON.parse(readFileSync(metaPath, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    meta = raw as MetaFile;
  } catch {
    return null;
  }
  const shaPin = typeof meta.sha_pin === "string" ? meta.sha_pin : null;
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
      const fm = (parsed.frontmatter ?? {}) as Record<string, unknown>;
      const rawCheckpoints = fm["checkpoints"];
      if (Array.isArray(rawCheckpoints)) {
        for (const c of rawCheckpoints) {
          if (typeof c !== "object" || c === null) continue;
          const cc = c as Record<string, unknown>;
          if (typeof cc["id"] !== "string") continue;
          const entry: CheckpointEntry = { id: cc["id"] };
          if (typeof cc["label"] === "string") entry.label = cc["label"];
          checkpoints.push(entry);
        }
      }
    }
  }

  // Read git log + diff summary.
  const git = simpleGit({ baseDir: repoRoot });

  let logCommits: { hash: string; subject: string }[] = [];
  try {
    const logResult = await git.log({ from: shaPin, to: "HEAD" });
    for (const c of logResult.all) {
      const subject = (c.message ?? "").split("\n")[0] ?? "";
      logCommits.push({ hash: c.hash, subject });
    }
  } catch {
    return null;
  }
  if (logCommits.length === 0) return null;

  let diffFiles: { file: string; insertions: number; deletions: number }[] = [];
  try {
    const summary = await git.diffSummary([shaPin, "HEAD"]);
    for (const f of summary.files) {
      if (f.binary) {
        diffFiles.push({ file: f.file, insertions: 0, deletions: 0 });
      } else {
        diffFiles.push({
          file: f.file,
          insertions: f.insertions,
          deletions: f.deletions,
        });
      }
    }
  } catch {
    diffFiles = [];
  }

  // Read notes.md if present.
  let notes = "";
  const notesPath = join(taskDir, "notes.md");
  if (existsSync(notesPath)) {
    try {
      notes = readFileSync(notesPath, "utf8").trim();
    } catch {
      notes = "";
    }
  }

  return renderHandoff({
    taskId: matched.taskId,
    taskTitle,
    commits: logCommits,
    diffFiles,
    checkpoints,
    notes,
  });
}

interface HandoffParts {
  taskId: string;
  taskTitle: string;
  commits: { hash: string; subject: string }[];
  diffFiles: { file: string; insertions: number; deletions: number }[];
  checkpoints: CheckpointEntry[];
  notes: string;
}

function renderHandoff(parts: HandoffParts): string {
  const truncatedCommits = parts.commits.slice(0, COMMIT_CAP);

  const phasesComplete: string[] = [];
  const phasesRemaining: string[] = [];
  for (const cp of parts.checkpoints) {
    const isComplete = parts.commits.some((c) => c.subject.includes(cp.id));
    const label = cp.label !== undefined ? `${cp.id} (${cp.label})` : cp.id;
    if (isComplete) phasesComplete.push(label);
    else phasesRemaining.push(label);
  }

  const lines: string[] = [];
  lines.push(`## ⟳ Resuming run ${parts.taskId} — ${parts.taskTitle}`);
  lines.push("");
  lines.push("Commits since run start:");
  for (const c of truncatedCommits) {
    const sha7 = c.hash.slice(0, 7);
    lines.push(`  ${sha7}  ${c.subject}`);
  }
  if (parts.commits.length > truncatedCommits.length) {
    lines.push(`  …${parts.commits.length - truncatedCommits.length} older commits truncated`);
  }
  lines.push("");

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

  let notesBody = parts.notes;
  if (notesBody.length > 0) {
    lines.push("");
    lines.push("Agent notes from previous phases:");
    lines.push(notesBody);
  }

  let out = lines.join("\n");
  if (out.length <= MAX_CHARS) return out;

  // Over budget — first try truncating notes oldest-first (front of body).
  while (notesBody.length > 0 && out.length > MAX_CHARS) {
    const newlineIdx = notesBody.indexOf("\n");
    if (newlineIdx === -1) {
      notesBody = "";
    } else {
      notesBody = notesBody.slice(newlineIdx + 1);
    }
    out = renderWithCustomNotes(parts, truncatedCommits, phasesComplete, phasesRemaining, notesBody);
  }
  if (out.length <= MAX_CHARS) return out;

  // Still over — drop notes section entirely.
  out = renderWithCustomNotes(parts, truncatedCommits, phasesComplete, phasesRemaining, "");
  if (out.length <= MAX_CHARS) return out;

  // Hard cap.
  return out.slice(0, MAX_CHARS);
}

function renderWithCustomNotes(
  parts: HandoffParts,
  truncatedCommits: { hash: string; subject: string }[],
  phasesComplete: string[],
  phasesRemaining: string[],
  notesBody: string,
): string {
  const lines: string[] = [];
  lines.push(`## ⟳ Resuming run ${parts.taskId} — ${parts.taskTitle}`);
  lines.push("");
  lines.push("Commits since run start:");
  for (const c of truncatedCommits) {
    lines.push(`  ${c.hash.slice(0, 7)}  ${c.subject}`);
  }
  if (parts.commits.length > truncatedCommits.length) {
    lines.push(`  …${parts.commits.length - truncatedCommits.length} older commits truncated`);
  }
  lines.push("");

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

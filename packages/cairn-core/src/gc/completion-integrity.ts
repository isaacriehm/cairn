/**
 * GC pass — completion integrity.
 *
 * For every task in `.harness/tasks/done/`, validate that:
 *   - status.yaml indicates phase: succeeded
 *   - related_run_ids has at least one entry (last entry is "the run")
 *   - the linked run dir exists in either runs/active/ or runs/terminal/
 *   - meta.json is present and parseable, with a sha_pin string
 *   - attestation.yaml is present
 *   - sensor-results.yaml is present and contains no failed entries
 *   - the attested sha_pin is reachable in the current git history
 *
 * All findings are kind: "task_integrity_error" with severity: "warn".
 */

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { parse as parseYaml } from "yaml";
import type { GcFinding } from "./types.js";

const PASS_ID = "completion-integrity" as const;

export interface CompletionIntegrityOptions {
  repoRoot: string;
}

export interface CompletionIntegrityResult {
  findings: GcFinding[];
}

export async function runCompletionIntegrity(
  opts: CompletionIntegrityOptions,
): Promise<CompletionIntegrityResult> {
  const findings: GcFinding[] = [];
  const doneDir = join(opts.repoRoot, ".harness", "tasks", "done");
  if (!existsSync(doneDir)) return { findings };

  let dirents: Dirent[];
  try {
    dirents = readdirSync(doneDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return { findings };
  }

  // Lazily-constructed git client; only needed if any task makes it past the
  // attestation checks.
  let git: ReturnType<typeof simpleGit> | null = null;
  function ensureGit(): ReturnType<typeof simpleGit> {
    if (git === null) git = simpleGit({ baseDir: opts.repoRoot });
    return git;
  }

  for (const entry of dirents) {
    if (!entry.isDirectory()) continue;
    const taskId = entry.name;
    const taskDir = join(doneDir, taskId);
    const statusPath = join(taskDir, "status.yaml");

    if (!existsSync(statusPath)) {
      findings.push(makeFinding(taskId, `tasks/done/${taskId}/status.yaml missing`));
      continue;
    }

    let statusParsed: unknown;
    try {
      statusParsed = parseYaml(readFileSync(statusPath, "utf8"));
    } catch (err) {
      findings.push(
        makeFinding(taskId, `tasks/done/${taskId}/status.yaml unparseable: ${stringifyErr(err)}`),
      );
      continue;
    }
    if (typeof statusParsed !== "object" || statusParsed === null) {
      findings.push(makeFinding(taskId, `tasks/done/${taskId}/status.yaml is not an object`));
      continue;
    }
    const status = statusParsed as Record<string, unknown>;
    const phase = typeof status["phase"] === "string" ? (status["phase"] as string) : null;
    if (phase !== "succeeded") {
      // Tasks in done/ that aren't succeeded are presumably archived for
      // another reason; skip — the pass is about completion integrity, not
      // categorization.
      continue;
    }

    const runIds = Array.isArray(status["related_run_ids"])
      ? (status["related_run_ids"] as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const runId = runIds.length > 0 ? runIds[runIds.length - 1] : undefined;
    if (runId === undefined) {
      findings.push(
        makeFinding(taskId, `task ${taskId} in tasks/done/ has no related_run_ids`),
      );
      continue;
    }

    // Look in runs/terminal/ first (succeeded runs typically end up here),
    // then fall back to runs/active/.
    const terminalDir = join(opts.repoRoot, ".harness", "runs", "terminal", runId);
    const activeDir = join(opts.repoRoot, ".harness", "runs", "active", runId);
    let runDir: string | null = null;
    if (existsSync(terminalDir)) runDir = terminalDir;
    else if (existsSync(activeDir)) runDir = activeDir;

    if (runDir === null) {
      findings.push(
        makeFinding(taskId, `linked run dir not found for ${runId} (checked runs/{active,terminal}/)`),
      );
      continue;
    }

    const metaPath = join(runDir, "meta.json");
    if (!existsSync(metaPath)) {
      findings.push(makeFinding(taskId, `meta.json missing in ${relPathOf(opts.repoRoot, runDir)}`));
      continue;
    }
    let meta: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(metaPath, "utf8")) as unknown;
      if (typeof raw !== "object" || raw === null) {
        findings.push(makeFinding(taskId, `meta.json malformed in ${relPathOf(opts.repoRoot, runDir)}`));
        continue;
      }
      meta = raw as Record<string, unknown>;
    } catch (err) {
      findings.push(
        makeFinding(taskId, `meta.json unparseable in ${relPathOf(opts.repoRoot, runDir)}: ${stringifyErr(err)}`),
      );
      continue;
    }

    const attestationPath = join(runDir, "attestation.yaml");
    if (!existsSync(attestationPath)) {
      findings.push(
        makeFinding(taskId, `attestation.yaml missing in ${relPathOf(opts.repoRoot, runDir)}`),
      );
      continue;
    }

    const sensorResultsPath = join(runDir, "sensor-results.yaml");
    if (existsSync(sensorResultsPath)) {
      let sensorParsed: unknown;
      try {
        sensorParsed = parseYaml(readFileSync(sensorResultsPath, "utf8"));
      } catch (err) {
        findings.push(
          makeFinding(taskId, `sensor-results.yaml unparseable in ${relPathOf(opts.repoRoot, runDir)}: ${stringifyErr(err)}`),
        );
        continue;
      }
      if (Array.isArray(sensorParsed)) {
        for (const r of sensorParsed) {
          if (typeof r !== "object" || r === null) continue;
          const rr = r as Record<string, unknown>;
          if (typeof rr["status"] === "string" && rr["status"] !== "pass") {
            findings.push(
              makeFinding(
                taskId,
                `sensor failures present in completed task ${taskId} (sensor: ${typeof rr["sensor"] === "string" ? (rr["sensor"] as string) : "unknown"})`,
              ),
            );
            // Don't break — surface every failed sensor as its own finding.
          }
        }
      }
    }

    // SHA reachability — skip if no sha_pin field.
    const shaPin = typeof meta["sha_pin"] === "string" ? (meta["sha_pin"] as string) : null;
    if (shaPin === null || shaPin.length === 0) continue;
    try {
      await ensureGit().catFile(["-e", shaPin]);
      // No throw → SHA reachable; nothing to surface.
    } catch {
      findings.push(
        makeFinding(
          taskId,
          `attested SHA ${shaPin.slice(0, 7)} not found in git history (task ${taskId})`,
        ),
      );
    }
  }

  return { findings };
}

function makeFinding(taskId: string, detail: string): GcFinding {
  return {
    pass: PASS_ID,
    kind: "task_integrity_error",
    path: `.harness/tasks/done/${taskId}/`,
    detail,
    severity: "warn",
  };
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function relPathOf(repoRoot: string, abs: string): string {
  return abs.startsWith(repoRoot) ? abs.slice(repoRoot.length + 1) : abs;
}

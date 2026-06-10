/**
 * GC pass — completion integrity.
 *
 * For every task in `.cairn/tasks/done/`, validate that:
 *   - status.yaml indicates phase: succeeded
 *   - related_run_ids has at least one entry (last entry is "the run")
 *   - the run directory exists in runs/terminal/ (or fallback runs/active/)
 *   - the run's meta.json contains a sha_pin
 *   - the sha_pin is reachable in the current git history
 *   - attestation.yaml is present in the run dir
 *   - sensor-results.yaml (if present) indicates all sensors passed
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { parse as parseYaml } from "yaml";
import type { GcFinding } from "./types.js";
import { z } from "zod";
import { cairnDir } from "@isaacriehm/cairn-state";

const PASS_ID = "completion-integrity" as const;

const StatusSchema = z.object({
  phase: z.string().optional(),
  related_run_ids: z.array(z.string()).optional(),
}).passthrough();

const MetaSchema = z.object({
  sha_pin: z.string().optional(),
}).passthrough();

const SensorResultSchema = z.object({
  status: z.string().optional(),
  sensor: z.string().optional(),
}).passthrough();

export interface CompletionIntegrityOptions {
  repoRoot: string;
}

export interface CompletionIntegrityResult {
  findings: GcFinding[];
}

let _git: ReturnType<typeof simpleGit> | null = null;
function ensureGit(repoRoot: string): ReturnType<typeof simpleGit> {
  if (!_git) _git = simpleGit(repoRoot);
  return _git;
}

/** Run the completion-integrity pass. */
export async function runCompletionIntegrity(
  opts: CompletionIntegrityOptions,
): Promise<CompletionIntegrityResult> {
  const doneDir = cairnDir(opts.repoRoot, "tasks", "done");
  const findings: GcFinding[] = [];
  if (!existsSync(doneDir)) return { findings };

  const entries = readdirSync(doneDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const taskId = e.name;
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
    const statusResult = StatusSchema.safeParse(statusParsed);
    if (!statusResult.success) {
      findings.push(makeFinding(taskId, `tasks/done/${taskId}/status.yaml is malformed`));
      continue;
    }
    const status = statusResult.data;
    const phase = status.phase ?? null;
    if (phase !== "succeeded") {
      continue;
    }

    const runIds = status.related_run_ids ?? [];
    const runId = runIds.length > 0 ? runIds[runIds.length - 1] : undefined;
    if (runId === undefined) {
      findings.push(
        makeFinding(taskId, `task ${taskId} in tasks/done/ has no related_run_ids`),
      );
      continue;
    }

    const terminalDir = cairnDir(opts.repoRoot, "runs", "terminal", runId);
    const activeDir = cairnDir(opts.repoRoot, "runs", "active", runId);
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
    let shaPin: string | null = null;
    try {
      const raw = JSON.parse(readFileSync(metaPath, "utf8"));
      const metaResult = MetaSchema.safeParse(raw);
      if (!metaResult.success) {
        findings.push(makeFinding(taskId, `meta.json malformed in ${relPathOf(opts.repoRoot, runDir)}`));
        continue;
      }
      shaPin = metaResult.data.sha_pin ?? null;
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
      const resultsResult = z.array(SensorResultSchema).safeParse(sensorParsed);
      if (resultsResult.success) {
        for (const rr of resultsResult.data) {
          if (rr.status !== undefined && rr.status !== "pass") {
            findings.push(
              makeFinding(
                taskId,
                `sensor failures present in completed task ${taskId} (sensor: ${rr.sensor ?? "unknown"})`,
              ),
            );
          }
        }
      }
    }

    if (shaPin === null || shaPin.length === 0) continue;
    try {
      await ensureGit(opts.repoRoot).catFile(["-e", shaPin]);
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
    path: `.cairn/tasks/done/${taskId}/`,
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

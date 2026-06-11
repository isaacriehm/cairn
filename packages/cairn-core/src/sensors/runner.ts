/**
 * Sensor sweep — the live enforcement entry point.
 *
 * Composes the sensors that actually have teeth into one diff-scoped sweep:
 *   - Layer A — stub-pattern catalog (mechanical debt regex)
 *   - decision-assertions — "was the in-scope DEC honored?"
 *
 * Runs at the real gates: pre-commit (staged diff), CI (`--diff` range), and
 * advisory at the Stop hook (working-tree diff). The diff + repoRoot are the
 * only inputs — there is no mirror checkout or orchestrator runtime.
 *
 * Two theatre layers have been removed. (1) Layer-B attestation cross-check:
 * depended on an agent-emitted attestation block no production path produced.
 * (2) The Layer C structural sensors (route-handler / DTO) + their
 * `project_globs` targeting: stack-specific regex fed by LLM-guessed globs that
 * were never validated or refreshed, so they failed silent and never fired.
 * Both are gone; the spine (Layer A + decision-assertions) is glob-independent.
 */

import { logger } from "../logger.js";
import {
  decisionsInScope,
  loadAcceptedDecisions,
  runDecisionAssertions,
} from "./decisions.js";
import { loadStubCatalog } from "./catalog.js";
import { formatRemediation } from "./remediation.js";
import { runStubCatalog } from "./stub-catalog.js";
import type {
  DiffEntry,
  SensorLanguage,
  SensorResult,
  SensorSweepResult,
} from "./types.js";

const log = logger("sensors.runner");

export interface RunSensorsOnDiffArgs {
  /** Repo root — decisions, stub catalog, and config are read from here. */
  repoRoot: string;
  /** Files changed in this diff, content already loaded. */
  diff: DiffEntry[];
  /** Languages to filter Layer A patterns. Omit = scan all known languages. */
  languages?: SensorLanguage[];
  /** Label for log lines (e.g. the gate name). */
  runId?: string;
  /** Retry context for the remediation prompt. Defaults to a single 1/1 pass. */
  attempt?: number;
  maxAttempts?: number;
}

/**
 * Run the live sensor sweep over a diff. Returns per-sensor results, the
 * aggregate `ok` (false on any hard failure), and a remediation prompt body
 * the caller can surface to the agent.
 */
export async function runSensorsOnDiff(
  args: RunSensorsOnDiffArgs,
): Promise<SensorSweepResult> {
  const startedAt = Date.now();
  const { repoRoot, diff } = args;
  const stubCatalog = loadStubCatalog(repoRoot);
  const acceptedDecisions = loadAcceptedDecisions(repoRoot);
  const inScope = decisionsInScope(acceptedDecisions, diff);

  const results: SensorResult[] = [
    // Layer A — stub-pattern catalog.
    runStubCatalog({ diff, catalog: stubCatalog, languages: args.languages }),
    // Decision-assertions — the core value prop.
    runDecisionAssertions({ mirrorPath: repoRoot, diff, decisions: inScope }),
  ];

  const hard_failures = results.filter((r) => !r.ok).length;
  const soft_findings = results.reduce(
    (n, r) => n + r.findings.filter((f) => f.severity === "soft").length,
    0,
  );
  const ok = hard_failures === 0;
  const remediation_prompt = ok
    ? ""
    : formatRemediation(results, {
        attempt: args.attempt ?? 1,
        maxAttempts: args.maxAttempts ?? 1,
      });

  log.info(
    {
      run_id: args.runId ?? "sensor-sweep",
      ok,
      hard_failures,
      soft_findings,
      sensors: results.map((r) => ({
        id: r.sensor_id,
        ok: r.ok,
        findings: r.findings.length,
        skipped: r.skipped?.reason,
      })),
    },
    "sensor sweep complete",
  );

  return {
    ok,
    hard_failures,
    soft_findings,
    results,
    remediation_prompt,
    duration_ms: Date.now() - startedAt,
  };
}

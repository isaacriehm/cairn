/**
 * Sensor runner — orchestrator-facing entry point.
 *
 * Composes Layer A + Layer B + Layer D + decision-assertions into a single
 * sweep. Returns the aggregated result + the remediation prompt body the
 * orchestrator feeds back to the agent on retry.
 *
 * Phase 9 wires the implementer-side stack only. Layer C (reviewer subagent)
 * is Phase 10; Layer E (high-stakes E2E) and U (UAT) are Phases 11+. Soft
 * findings emitted here are intentionally surfaced for those later layers
 * to consume.
 */

import { logger } from "../logger.js";
import { decisionsInScope, loadAcceptedDecisions, runDecisionAssertions } from "./decisions.js";
import { extractAttestation, runAttestationCrossCheck } from "./attestation.js";
import { getDiff } from "./diff.js";
import { loadStubCatalog } from "./catalog.js";
import { formatRemediation } from "./remediation.js";
import { runStubCatalog } from "./stub-catalog.js";
import { runDtoNoFakeFields, runRouteHandlerNonEmpty } from "./structural.js";
import type {
  Attestation,
  ProjectGlobs,
  SensorLanguage,
  SensorResult,
  SensorSweepResult,
} from "./types.js";

const log = logger("sensors.runner");

export interface RunSensorsArgs {
  /** Mirror checkout where the agent worked. */
  mirrorPath: string;
  /** SHA pin captured at workspace prep. */
  shaPin: string;
  /** Final assistant text, used to extract the attestation block. */
  finalAssistantText?: string;
  /** Languages active for this profile (filters Layer A patterns). */
  languages: SensorLanguage[];
  /** Project-block globs from workflow.md. */
  projectGlobs: ProjectGlobs;
  /** Run id used in log lines. */
  runId: string;
  /** Number of this attempt (1 = first run, 2 = first retry). */
  attempt: number;
  /** Max attempts the orchestrator will allow. */
  maxAttempts: number;
  /**
   * Optional pre-extracted attestation. Useful for tests / smokes that
   * inject the attestation directly without going through the assistant
   * stream. When supplied, finalAssistantText is ignored for extraction.
   */
  attestation?: Attestation;
}

/**
 * Run all sensors for a finished implementer run. Returns:
 *   - per-sensor results (with `ok` + findings)
 *   - aggregate `ok` (false if any hard failure)
 *   - remediation prompt body for the next retry (empty string on success)
 */
export async function runSensors(args: RunSensorsArgs): Promise<SensorSweepResult> {
  const startedAt = Date.now();
  const diff = await getDiff({ mirrorPath: args.mirrorPath, shaPin: args.shaPin });

  const stubCatalog = loadStubCatalog(args.mirrorPath);
  const acceptedDecisions = loadAcceptedDecisions(args.mirrorPath);
  const inScope = decisionsInScope(acceptedDecisions, diff);

  const attestation =
    args.attestation ?? extractAttestation(args.finalAssistantText ?? "");

  const results: SensorResult[] = [];

  // Layer A — stub-pattern catalog.
  results.push(
    runStubCatalog({
      diff,
      catalog: stubCatalog,
      languages: args.languages,
    }),
  );

  // Layer B — attestation cross-check.
  results.push(
    runAttestationCrossCheck({
      attestation,
      diff,
      stubCatalog,
      ignoreGlobs: [".harness/runs/active/**", ".harness/inbox/processed/**"],
    }),
  );

  // Layer D — generic structural sensors.
  results.push(
    runRouteHandlerNonEmpty({
      diff,
      globs: args.projectGlobs.route_handler_globs,
    }),
  );
  results.push(
    runDtoNoFakeFields({
      diff,
      globs: args.projectGlobs.dto_globs,
    }),
  );

  // Decision-assertions.
  results.push(
    runDecisionAssertions({
      mirrorPath: args.mirrorPath,
      diff,
      decisions: inScope,
    }),
  );

  const hard_failures = results.filter((r) => !r.ok).length;
  const soft_findings = results.reduce(
    (n, r) => n + r.findings.filter((f) => f.severity === "soft").length,
    0,
  );
  const ok = hard_failures === 0;
  const remediation_prompt = ok
    ? ""
    : formatRemediation(results, {
        attempt: args.attempt,
        maxAttempts: args.maxAttempts,
      });

  log.info(
    {
      run_id: args.runId,
      attempt: args.attempt,
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

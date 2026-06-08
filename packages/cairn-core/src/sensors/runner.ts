/**
 * Sensor sweep — the live enforcement entry point.
 *
 * Composes the sensors that actually have teeth into one diff-scoped sweep:
 *   - Layer A — stub-pattern catalog (mechanical debt regex)
 *   - Layer C — generic structural sensors (route handlers, DTOs)
 *   - decision-assertions — "was the in-scope DEC honored?"
 *
 * Runs at the real gates: pre-commit (staged diff), CI (`--diff` range), and
 * advisory at the Stop hook (working-tree diff). The diff + repoRoot are the
 * only inputs — there is no mirror checkout or orchestrator runtime.
 *
 * Layer-B attestation cross-check was removed: it depended on an
 * agent-emitted attestation block that no production path produced, so it
 * never ran. Project-specific "proposed sensors" were likewise never wired
 * to an executor and have been dropped.
 */

import { logger } from "../logger.js";
import { loadCairnConfig } from "@isaacriehm/cairn-state";
import {
  decisionsInScope,
  loadAcceptedDecisions,
  runDecisionAssertions,
} from "./decisions.js";
import { loadStubCatalog } from "./catalog.js";
import { formatRemediation } from "./remediation.js";
import { runStubCatalog } from "./stub-catalog.js";
import { runDtoNoFakeFields, runRouteHandlerNonEmpty } from "./structural.js";
import type {
  DiffEntry,
  ProjectGlobs,
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
  /** Route/DTO globs. Omit = loaded from `.cairn/config.yaml`. */
  projectGlobs?: ProjectGlobs;
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
  const projectGlobs = args.projectGlobs ?? loadProjectGlobs(repoRoot);
  const stubCatalog = loadStubCatalog(repoRoot);
  const acceptedDecisions = loadAcceptedDecisions(repoRoot);
  const inScope = decisionsInScope(acceptedDecisions, diff);

  const results: SensorResult[] = [
    // Layer A — stub-pattern catalog.
    runStubCatalog({ diff, catalog: stubCatalog, languages: args.languages }),
    // Layer C — generic structural sensors.
    runRouteHandlerNonEmpty({ diff, globs: projectGlobs.route_handler_globs }),
    runDtoNoFakeFields({ diff, globs: projectGlobs.dto_globs }),
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

/** Read route/DTO/high-stakes globs from `.cairn/config.yaml`. */
export function loadProjectGlobs(repoRoot: string): ProjectGlobs {
  const cfg = loadCairnConfig(repoRoot);
  const out: ProjectGlobs = {};
  const asStrings = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

  const pg = cfg["project_globs"];
  if (typeof pg === "object" && pg !== null) {
    const p = pg as Record<string, unknown>;
    const rh = asStrings(p["route_handler_globs"]);
    if (rh) out.route_handler_globs = rh;
    const dto = asStrings(p["dto_globs"]);
    if (dto) out.dto_globs = dto;
    const gen = asStrings(p["generator_source_globs"]);
    if (gen) out.generator_source_globs = gen;
    const hs = asStrings(p["high_stakes_globs"]);
    if (hs) out.high_stakes_globs = hs;
  }
  if (out.high_stakes_globs === undefined) {
    const topHs = asStrings(cfg["high_stakes_globs"]);
    if (topHs) out.high_stakes_globs = topHs;
  }
  return out;
}

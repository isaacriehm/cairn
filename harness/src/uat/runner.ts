/**
 * UAT-runner — Tier-2 (Sonnet) call that picks one probe per acceptance
 * criterion. Auto-escalates to Opus on second failure (caller's policy).
 */

import { runClaude } from "../claude/index.js";
import { logger } from "../logger.js";
import { buildUatRunnerUserPrompt, UAT_RUNNER_SYSTEM_PROMPT } from "./prompt.js";
import { UAT_RUNNER_OUTPUT_SCHEMA } from "./schema.js";
import type {
  UatAcceptanceCheck,
  UatProbe,
  UatRunnerInput,
  UatRunnerOutput,
} from "./types.js";

const log = logger("uat.runner");

function isProbe(value: unknown): value is UatProbe {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["kind"] === "http" ||
    v["kind"] === "cli" ||
    v["kind"] === "ui" ||
    v["kind"] === "sql" ||
    v["kind"] === "integration"
  );
}

function isAcceptanceCheck(value: unknown): value is UatAcceptanceCheck {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["text"] === "string" &&
    isProbe(v["probe"])
  );
}

function isOutput(value: unknown): value is UatRunnerOutput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v["acceptance_checks"])) return false;
  for (const c of v["acceptance_checks"]) {
    if (!isAcceptanceCheck(c)) return false;
  }
  if (typeof v["cold_start_smoke"] !== "boolean") return false;
  if (typeof v["backend_only"] !== "boolean") return false;
  return true;
}

export async function generateUatChecks(input: UatRunnerInput): Promise<UatRunnerOutput> {
  log.info(
    {
      tier: input.tier,
      ac_count: input.acceptance_criteria.length,
      diff_files: input.changed_files.length,
      is_high_stakes: input.is_high_stakes,
      hints: input.hints,
    },
    "uat-runner dispatch",
  );

  const result = await runClaude({
    tier: input.tier,
    prompt: buildUatRunnerUserPrompt(input),
    system: UAT_RUNNER_SYSTEM_PROMPT,
    jsonSchema: UAT_RUNNER_OUTPUT_SCHEMA as object,
    timeoutMs: input.timeout_ms ?? 300_000,
  });

  if (!isOutput(result.parsed)) {
    throw new Error(
      `uat-runner returned malformed output. preview: ${result.text.slice(0, 200)}`,
    );
  }

  // Reject probes for unavailable surfaces — defense-in-depth in case the
  // model emitted them despite the prompt.
  const filtered: UatAcceptanceCheck[] = [];
  for (const check of result.parsed.acceptance_checks) {
    if (check.probe.kind === "ui" && input.hints.ui_available !== true) {
      log.warn({ check_id: check.id }, "dropping ui probe — surface not available");
      continue;
    }
    if (check.probe.kind === "sql" && input.hints.sql_available !== true) {
      log.warn({ check_id: check.id }, "dropping sql probe — surface not available");
      continue;
    }
    if (check.probe.kind === "integration" && input.hints.integration_available !== true) {
      log.warn({ check_id: check.id }, "dropping integration probe — surface not available");
      continue;
    }
    filtered.push(check);
  }

  log.info(
    {
      checks_emitted: result.parsed.acceptance_checks.length,
      checks_after_filter: filtered.length,
      cold_start_smoke: result.parsed.cold_start_smoke,
      backend_only: result.parsed.backend_only,
      ungenerable_reason: result.parsed.ungenerable_reason,
    },
    "uat-runner complete",
  );

  return {
    acceptance_checks: filtered,
    cold_start_smoke: result.parsed.cold_start_smoke,
    backend_only: result.parsed.backend_only,
    ...(result.parsed.ungenerable_reason !== undefined
      ? { ungenerable_reason: result.parsed.ungenerable_reason }
      : {}),
  };
}

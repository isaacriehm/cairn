/**
 * Build a remediation prompt from sensor findings.
 *
 * Per OpenAI's pattern: failure messages are remediation prompts the agent
 * consumes on retry. The orchestrator appends this body to the original
 * prompt and re-dispatches the agent. The agent sees concrete failures with
 * paths, lines, matched text, and remediation guidance.
 */

import type { SensorFinding, SensorResult } from "./types.js";

export interface RemediationOptions {
  /** Number of the upcoming retry (1 = first retry). */
  attempt: number;
  /** Max attempts the orchestrator will allow. */
  maxAttempts: number;
}

/**
 * Format a remediation prompt body to be appended to the original task
 * prompt. Empty string when there are no hard failures.
 */
export function formatRemediation(
  results: SensorResult[],
  opts: RemediationOptions,
): string {
  const hardFails = results.filter((r) => !r.ok);
  if (hardFails.length === 0) return "";

  const lines: string[] = [];
  lines.push(
    "## Sensor failures (from previous attempt)",
    "",
    `Your previous turn was rejected by ${hardFails.length} sensor(s). Read each finding below; the path/line/match are concrete. Fix every hard finding before your next turn — this is retry attempt ${opts.attempt} of ${opts.maxAttempts}.`,
    "",
    "Do NOT re-run the parts that already passed. Edit only what the failures point to.",
    "",
  );

  for (const result of hardFails) {
    const hard = result.findings.filter((f) => f.severity === "hard");
    if (hard.length === 0) continue;
    lines.push(`### Sensor \`${result.sensor_id}\` — ${hard.length} failure(s)`);
    lines.push("");
    for (const finding of hard) {
      lines.push(formatFinding(finding));
    }
    lines.push("");
  }

  // Append soft findings as advisory context (not gating).
  const softFindings = results.flatMap((r) => r.findings).filter((f) => f.severity === "soft");
  if (softFindings.length > 0) {
    lines.push("### Advisory (soft) findings");
    lines.push("");
    lines.push("These do not block your run but represent debt or surfaces a reviewer will inspect:");
    lines.push("");
    for (const f of softFindings) lines.push(formatFinding(f));
    lines.push("");
  }

  lines.push(
    "## What to do",
    "",
    "1. Re-emit your `attestation:` YAML block at the END of your reply, with corrected `delivered`, `files_touched`, `todos_introduced`, and `stubs_introduced` values.",
    "2. Edit the files listed above to remove the stub patterns / fix the assertions / fill the empty handlers.",
    "3. Do NOT re-introduce TODO/FIXME/XXX/HACK markers, `throw new Error('not implemented')`, `as any` casts, or any pattern flagged in `.harness/config/stub-patterns.yaml`.",
    "4. If any failure is genuinely impossible to satisfy (e.g. an assertion contradicts a current decision), emit a `blocked_by:` block in your final response instead of a partial diff.",
    "",
  );
  return lines.join("\n");
}

function formatFinding(f: SensorFinding): string {
  const where: string[] = [];
  if (f.path !== undefined && f.line !== undefined) where.push(`${f.path}:${f.line}`);
  else if (f.path !== undefined) where.push(f.path);
  if (f.pattern_id) where.push(`pattern=${f.pattern_id}`);
  if (f.decision_id) where.push(`decision=${f.decision_id}`);
  if (f.assertion_id) where.push(`assertion=${f.assertion_id}`);
  const head = where.length > 0 ? `[${where.join(" • ")}] ` : "";
  let body = f.message;
  if (f.matched_text) body += `\n  matched: \`${truncate(f.matched_text, 160)}\``;
  return `- ${head}${body}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

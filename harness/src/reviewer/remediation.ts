/**
 * Format reviewer findings as an agent-prompt-shaped retry context.
 *
 * Reviewer remediation is structurally similar to sensor remediation
 * (Phase 9) — we surface concrete gaps with path/symbol/category and the
 * implementer turns that into a fix on the next attempt. Different file
 * because the framing is different: sensors point at mechanical patterns,
 * the reviewer points at semantic gaps.
 */

import type { ReviewerOutput } from "./types.js";

export interface ReviewerRemediationOptions {
  attempt: number;
  maxAttempts: number;
}

export function formatReviewerRemediation(
  output: ReviewerOutput,
  opts: ReviewerRemediationOptions,
): string {
  if (output.verdict === "pass" && output.gaps.every((g) => g.severity !== "hard")) {
    return "";
  }

  const lines: string[] = [];
  const hard = output.gaps.filter((g) => g.severity === "hard");
  const soft = output.gaps.filter((g) => g.severity === "soft");

  lines.push("## Reviewer subagent rejected the diff");
  lines.push("");
  lines.push(
    `A fresh reviewer reviewed your diff against the tightened spec and decisions in scope, with no visibility into your reasoning. It returned **verdict: ${output.verdict}** with ${hard.length} hard gap(s) and ${soft.length} soft gap(s). This is retry attempt ${opts.attempt} of ${opts.maxAttempts}.`,
  );
  lines.push("");
  lines.push(`> Reviewer summary: ${output.summary}`);
  lines.push("");

  if (hard.length > 0) {
    lines.push("### Hard gaps (must fix)");
    lines.push("");
    for (const g of hard) {
      const where: string[] = [];
      if (g.path) where.push(g.path);
      if (g.symbol) where.push(`symbol=${g.symbol}`);
      const head = where.length > 0 ? `[${where.join(" • ")}] ` : "";
      lines.push(`- **${g.category}** ${head}— ${g.description}`);
    }
    lines.push("");
  }

  if (soft.length > 0) {
    lines.push("### Soft gaps (advisory)");
    lines.push("");
    lines.push(
      "These do not gate the commit but the reviewer flagged them for your awareness:",
    );
    lines.push("");
    for (const g of soft) {
      const where: string[] = [];
      if (g.path) where.push(g.path);
      if (g.symbol) where.push(`symbol=${g.symbol}`);
      const head = where.length > 0 ? `[${where.join(" • ")}] ` : "";
      lines.push(`- ${g.category} ${head}— ${g.description}`);
    }
    lines.push("");
  }

  lines.push("## What to do");
  lines.push("");
  lines.push("1. Address each hard gap concretely. Do not paper over them with comments — fix the underlying issue.");
  lines.push("2. Re-emit your `attestation:` YAML block at the END of your reply with corrected counts.");
  lines.push("3. If a gap is genuinely impossible to satisfy (e.g. it would contradict an accepted decision), emit a `blocked_by:` block instead of a partial diff.");
  lines.push("");
  return lines.join("\n");
}

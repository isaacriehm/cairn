/**
 * Reviewer prompts (Layer C).
 *
 * Anti-completionist framing — the implementer is biased toward shipping;
 * the reviewer is biased toward catching omission. Same model on both
 * sides; what protects against blindspots is the absence of shared context,
 * not the presence of a different weight set (L15).
 */

import type { ReviewerInput } from "./types.js";

export const REVIEWER_SYSTEM_PROMPT = [
  "You are the REVIEWER subagent in a developer harness.",
  "",
  "Your default verdict is **fail**. The implementer was rewarded for finishing; you are rewarded for catching omission. Behave accordingly: prove the implementer wrong before you let the diff ship.",
  "",
  "You see ONLY:",
  "  • the tightened spec the implementer was given",
  "  • the acceptance criteria",
  "  • the diff (full post-change content of each changed file)",
  "  • accepted decisions whose scope overlaps the diff",
  "  • soft sensor findings from earlier mechanical checks",
  "",
  "You do NOT see:",
  "  • the implementer's reasoning, tool-use trace, prior turns",
  "  • test fixtures, console output, runtime logs",
  "",
  "**Categories of gap to look for** (set `category` to the matching slug):",
  "  - `deferred_but_claimed_done` — function/method body looks complete but a critical branch is missing, returns hard-coded data, or hands off to a non-existent helper.",
  "  - `missing_acceptance_criterion` — an acceptance bullet is not satisfied by the diff.",
  "  - `scope_leak` — diff touches paths the spec didn't ask for.",
  "  - `query_scope_omission` — a query/filter/route/auth predicate is missing a scoping field the spec or decisions demand (e.g. user_id, organization_id, deleted_at IS NULL).",
  "  - `decision_contradiction` — diff violates an accepted decision in scope, beyond what the assertion sensor already caught.",
  "  - `unhandled_error` — error path silently swallowed, returns wrong type, or rethrows generic.",
  "  - `fake_thoroughness` — code looks load-bearing but does nothing meaningful (empty interfaces, decorators with no effect, redundant guards).",
  "  - `documentation_drift` — code change requires a doc/contract update that didn't happen.",
  "  - `security_concern` — input not validated, secret in code, auth omitted, etc.",
  "  - `other` — use sparingly; prefer naming a more specific category.",
  "",
  "For each gap, set `severity`:",
  "  - `hard` — must be fixed before this diff can ship. Choose hard for any acceptance miss, scope leak, decision contradiction, or query-scope omission.",
  "  - `soft` — should be flagged for the operator at UAT but does not gate the commit. Choose soft for stylistic concerns, naming inconsistencies, or doc-drift that isn't load-bearing.",
  "",
  "**Verdict rules** — set `verdict = pass` ONLY when ALL three are true:",
  "  1. zero `hard` gaps",
  "  2. you would yourself ship this commit to production",
  "  3. every acceptance criterion is observably satisfied by the diff",
  "Otherwise set `verdict = fail`.",
  "",
  "**Confidence signal** —",
  "  - `high` — you've inspected every changed file and every acceptance criterion is mechanically verifiable from the diff content.",
  "  - `medium` — diff is large or mostly comprehensible, but some acceptance criteria need runtime verification (UAT) you can't perform from text alone.",
  "  - `low` — diff is sparse, ambiguous, or appears to elide structural changes you can't see from the changed files.",
  "",
  "Return ONLY the JSON object. No preamble, no apology, no markdown wrapper.",
].join("\n");

export function buildReviewerUserPrompt(input: ReviewerInput): string {
  const parts: string[] = [];

  parts.push("# Tightened spec");
  parts.push("");
  parts.push(input.tightened_spec.trim());

  if (input.acceptance_criteria.length > 0) {
    parts.push("");
    parts.push("# Acceptance criteria");
    parts.push("");
    for (const a of input.acceptance_criteria) parts.push(`- ${a}`);
  }

  if (input.decisions_in_scope.length > 0) {
    parts.push("");
    parts.push("# Decisions in scope");
    parts.push("");
    parts.push(
      "Each accepted decision binds the implementer. Treat any contradiction as a hard `decision_contradiction` gap.",
    );
    parts.push("");
    for (const d of input.decisions_in_scope) {
      parts.push(`## ${d.id} — ${d.title}`);
      const scope = (d.scope_globs ?? []).join(", ");
      if (scope.length > 0) parts.push(`Scope: ${scope}`);
      const assertions = d.assertions ?? [];
      if (assertions.length > 0) {
        parts.push("Assertions:");
        for (const a of assertions) {
          parts.push(`  - ${a.id} (${a.kind})`);
        }
      }
      parts.push("");
    }
  }

  if (input.soft_findings.length > 0) {
    parts.push("# Soft sensor findings");
    parts.push("");
    parts.push(
      "These were flagged by mechanical sensors but did not gate the run. Treat them as hints; don't double-count them as gaps unless you find independent evidence.",
    );
    parts.push("");
    for (const f of input.soft_findings.slice(0, 50)) {
      const where = f.path ? ` [${f.path}${f.line ? `:${f.line}` : ""}]` : "";
      parts.push(`- ${f.sensor_id}${where} — ${f.message}`);
    }
    parts.push("");
  }

  parts.push("# Diff");
  parts.push("");
  parts.push(
    "Each section below is one changed file. Read every byte. Trace the spec's acceptance criteria through the code. If you see something that doesn't add up — empty body, hard-coded value, missing branch — name it.",
  );
  parts.push("");
  for (const entry of input.diff) {
    if (entry.status === "deleted") {
      parts.push(`## ${entry.path} — DELETED`);
      parts.push("");
      continue;
    }
    parts.push(`## ${entry.path} — ${entry.status}`);
    if (entry.fromPath !== undefined) parts.push(`(renamed from ${entry.fromPath})`);
    parts.push("");
    parts.push("```");
    parts.push((entry.afterContent ?? "").slice(0, 32_000));
    parts.push("```");
    parts.push("");
  }

  if (input.is_high_stakes) {
    parts.push("# High-stakes augmentation (per Codex audit Q1)");
    parts.push("");
    parts.push(
      "This diff touches paths classified as high-stakes. Beyond the standard review, perform an EXPLICIT query-scope completeness check:",
    );
    parts.push("");
    parts.push(
      "  • For every `WHERE`, ORM filter, route handler, and authorization predicate in the diff, list the scoping fields the spec or decisions demand (e.g. `organizationId AND userId AND deleted_at IS NULL`).",
    );
    parts.push(
      "  • Match each call site against that demand. Any call site that omits a required scoping field is a hard `query_scope_omission` gap.",
    );
    parts.push(
      "  • A request from user/org B against a resource owned by user/org A must return the spec's denial response — verify the filter chain enforces this.",
    );
    parts.push("");
  }

  parts.push("---");
  parts.push("");
  parts.push("Now return the JSON object per the schema. Default verdict = fail. Pass only if the diff is something you would ship yourself.");
  return parts.join("\n");
}

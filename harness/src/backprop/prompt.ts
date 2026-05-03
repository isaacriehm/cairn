/**
 * Backprop subagent prompts.
 *
 * The agent reads the tightened spec, the failure that motivated this fix,
 * and the diff that resolved it. It produces a single typed object —
 * `BackpropOutput` — that the harness uses to write the invariant file +
 * generate the sensor.
 *
 * The agent does NOT touch the filesystem; the schema and prompt
 * deliberately do not surface tools. Per L13.1: "Naming convention:
 * sensor scripts and E2E cases cite the invariant ID — the harness
 * mints the id, so the agent only supplies the slug."
 */

import type { DiffEntry } from "../sensors/index.js";
import type { BackpropInput } from "./types.js";

/**
 * Maximum characters per file emitted in the prompt. Larger files
 * are truncated with an explicit elision marker.
 */
const PER_FILE_CHAR_CAP = 16_000;

export const BACKPROP_SYSTEM_PROMPT = `You are the **backprop subagent** for an agent harness. A fix has just landed; your job is to capture the underlying invariant so the same class of bug becomes mechanically detectable forever.

You read three things and you emit one structured object.

You read:
1. The tightened spec the implementer worked from.
2. The failure that motivated this fix (a sensor finding, reviewer gap, UAT rejection note, or operator bug report).
3. The diff that resolved it.

You emit a single JSON object matching the supplied schema. Required fields:
- \`slug\`: short kebab-case identifier (≤30 chars). Use the invariant's *what*, not the bug. \`no-jsonb-userid-filter\` is good; \`fix-bug-from-yesterday\` is bad.
- \`title\`: imperative one-liner describing the invariant. Example: "All user-scoped queries MUST filter by \`user_id\` in addition to provider keys".
- \`body_markdown\`: 2–6 paragraphs explaining (a) the rule, (b) why it exists / what bug it prevents, (c) how to satisfy it on future code, (d) known exceptions if any.
- \`introduced_for_bug\`: the original failure summary, distilled to one paragraph.
- \`enforcement\`: ONE mechanism that catches a regression of this invariant.

Two enforcement kinds:

**\`regex_sensor\`** — for invariants that are mechanically detectable by a single regex pattern over source files. Most invariants are this kind. Required sub-fields:
- \`regex\`: a JS-flavored regex pattern (string, no leading/trailing slashes). It MUST match the BAD pattern (i.e., a hit means the invariant is violated). Use \`(?!...)\` or \`(?=...)\` lookarounds when needed.
- \`target_globs\`: list of repo-relative globs the sensor scans. Example: \`["src/**/*.ts", "core/src/**/*.ts"]\`. Default to the directory the fix touched if uncertain.
- \`language\`: one of typescript, javascript, python, ruby, go, rust, sql. Filters which files the regex runs against.
- \`failure_message\`: imperative one-liner the sensor prints when it hits. Should tell the next agent what to do.

**\`named_e2e\`** — for invariants that only show up at runtime (e.g., cross-tenant scoping, multi-step user flows). Required sub-fields:
- \`e2e_path\`: relative path the harness will create. Use the form \`e2e/V<N>_<slug>.spec.ts\`. The harness substitutes V<N>; you supply the rest.

DO NOT:
- Suggest a \`regex_sensor\` whose pattern would have false positives. A noisy sensor is worse than no sensor.
- Capture an invariant that's a tautology ("don't write bugs"). The invariant must be a *specific structural rule* that, if obeyed, makes a class of bug impossible.
- Output any free text outside the JSON envelope.

If the diff is genuinely too small or generic to extract a useful invariant — for example, a typo fix or a trivial copy update — emit a regex_sensor with a wildly-permissive pattern that will never hit AND a body_markdown that says "no enforceable invariant; fix was cosmetic". The id allocator still mints a V-id; it's better to record "no invariant here" than to fabricate one.`;

export function buildBackpropUserPrompt(input: BackpropInput): string {
  const sections: string[] = [];

  sections.push("## Run");
  sections.push(`run_id: ${input.run_id}`);
  if (input.in_scope_decision_ids.length > 0) {
    sections.push(`decisions in scope: ${input.in_scope_decision_ids.join(", ")}`);
  }

  sections.push("\n## Tightened spec");
  sections.push(input.tightened_spec.trim());

  if (input.acceptance_criteria.length > 0) {
    sections.push("\n## Acceptance criteria");
    for (const ac of input.acceptance_criteria) {
      sections.push(`- ${ac}`);
    }
  }

  sections.push("\n## Failure that motivated this fix");
  sections.push(input.failure_summary.trim());

  sections.push("\n## Diff that landed");
  sections.push(formatDiff(input.diff));

  sections.push("\n## Your task");
  sections.push(
    "Extract the invariant. Emit the structured object per the schema. " +
      "The harness will mint the invariant id, write the file, and generate the sensor.",
  );

  return sections.join("\n");
}

function formatDiff(diff: readonly DiffEntry[]): string {
  if (diff.length === 0) return "(empty diff)";
  const out: string[] = [];
  for (const entry of diff) {
    out.push(`### ${entry.path}  [${entry.status}]`);
    if (entry.status === "deleted") {
      out.push("(file deleted)");
      continue;
    }
    const after = entry.afterContent ?? "";
    if (after.length === 0) {
      out.push("(empty after content)");
      continue;
    }
    if (after.length > PER_FILE_CHAR_CAP) {
      out.push(after.slice(0, PER_FILE_CHAR_CAP));
      out.push(`\n…[truncated; ${after.length - PER_FILE_CHAR_CAP} chars elided]`);
    } else {
      out.push(after);
    }
  }
  return out.join("\n\n");
}

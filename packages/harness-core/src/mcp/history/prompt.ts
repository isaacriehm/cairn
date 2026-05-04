/**
 * Tier-1 (Haiku) summarizer prompts for harness_query_history.
 *
 * Constraint: the LLM emits ONLY structured claims; raw historical
 * content never reaches the agent's context. Each claim cites a
 * concrete source_path + source_lines so the operator (and any future
 * audit) can verify the summary against the original.
 *
 * The prompt id + version are committed in source so a behavior change
 * here is a versioned change in the source tree, not a silent runtime
 * update.
 */

import type { ArchiveFile } from "./walker.js";

export const HARNESS_HISTORY_SUMMARIZE_PROMPT_ID = "harness.history_summarize.v1";
export const HARNESS_HISTORY_SUMMARIZE_VERSION = "v1";

export const HISTORY_SUMMARIZER_SYSTEM_PROMPT = `You are the **history summarizer** for an agent harness's two-zone read separation. The agent calling you cannot read .archive/ files directly — by design. You read those files on its behalf and emit a structured response with cited claims. Only your structured response reaches the agent's context.

Your job: read N historical files and the operator's scope question. Produce per-claim records that capture what the historical files said, with full citation, dates, and supersedes-tags pointing at currently-canonical decisions when they exist.

## Hard contract

Every claim you emit MUST include:

- \`claim\` — one-sentence factual statement of what the historical content said. Past-tense. Imperative voice avoided. Example: "The project considered using a JSONB expression index on commandPayload->>'userId' for dashboard queries." NOT "The project should use a JSONB index" — that is current-tense and reads as canon.
- \`as_of\` — ISO date when the source content was authored / valid. Use the file's frontmatter \`generated\` or \`verified-at\`, the bucket date in the path (\`.archive/2026-05-pre-harness/\`), or the most explicit date you can find in the body. If genuinely unknown, set the bucket date.
- \`source_path\` — the repo-relative path EXACTLY as given in the file headers. Do not invent a path or a hash.
- \`source_lines\` — line range like "320-410" or a single line "47". Required so the operator can audit your summary by opening the original file.
- \`superseded_by\` — when an accepted decision in the supplied "Currently-accepted decisions" list directly relates to the historical claim, set the DEC-NNNN id. Otherwise set null. Do NOT invent decision ids.

## When you should set \`no_relevant_history: true\`

The supplied files don't contain anything relevant to the operator's scope question. Better to short-circuit than to fabricate a summary. The harness returns an empty claims array with a one-line caveat.

## When you should set \`summary_caveat\`

Anything important about the input that affects how the agent should treat your output:
- "Summary covers 8 files; 3 additional matches were truncated."
- "All claims are from a single bucket dated 2026-04-23; nothing more recent in scope."

## What you must NOT do

- Do NOT issue a recommendation. Your output is descriptive (what was said), not prescriptive (what to do).
- Do NOT phrase claims as if they are current truth. Always past-tense + cited.
- Do NOT invent paths, line ranges, decision ids, or dates. If you can't find a value, set what's required by schema and skip the claim.
- Do NOT emit a free-form preamble before the JSON.
- Do NOT emit fields not in the schema.

Output ONLY the JSON object.`;

export interface BuildHistoryUserPromptArgs {
  /** Operator's free-text scope description. */
  scope: string;
  /** Repo-relative pathHint glob, when provided. */
  pathHint?: string;
  since?: string;
  until?: string;
  files: ArchiveFile[];
  /** Optional ledger of currently-accepted decisions for supersedes inference. */
  acceptedDecisions: { id: string; title: string; scope_globs?: string[] }[];
}

const PER_FILE_HEADER_PREVIEW_LINES = 800;

export function buildHistorySummarizerUserPrompt(
  args: BuildHistoryUserPromptArgs,
): string {
  const sections: string[] = [];

  sections.push("## Operator scope question");
  sections.push(args.scope.trim());

  sections.push("");
  sections.push("## Filters applied to the .archive/ walk");
  sections.push(`path_hint: ${args.pathHint ?? "(none — full archive)"}`);
  sections.push(`since: ${args.since ?? "(none — beginning of time)"}`);
  sections.push(`until: ${args.until ?? "(none — present)"}`);
  sections.push(`matched_files: ${args.files.length}`);

  if (args.acceptedDecisions.length > 0) {
    sections.push("");
    sections.push("## Currently-accepted decisions (for supersedes inference)");
    sections.push("Each line: `<DEC-id> — <title>  (scope: <globs>)`. If a historical claim directly contradicts or has been replaced by one of these, cite the id in `superseded_by`. Otherwise set null. Do NOT invent ids.");
    sections.push("");
    for (const d of args.acceptedDecisions.slice(0, 30)) {
      const scope = d.scope_globs && d.scope_globs.length > 0 ? d.scope_globs.join(", ") : "(no scope)";
      sections.push(`- **${d.id}** — ${d.title}  (scope: ${scope})`);
    }
    if (args.acceptedDecisions.length > 30) {
      sections.push(`…(${args.acceptedDecisions.length - 30} additional accepted decisions omitted)`);
    }
  }

  sections.push("");
  sections.push("## Historical files (line-numbered)");
  if (args.files.length === 0) {
    sections.push("(none — return `no_relevant_history: true`)");
  }
  for (const f of args.files) {
    sections.push("");
    sections.push(`### ${f.relPath}  (bucket: ${f.bucket}, archive_date: ${f.archiveDate}${f.truncated ? ", TRUNCATED" : ""})`);
    sections.push("```");
    sections.push(numberLines(f.content, PER_FILE_HEADER_PREVIEW_LINES));
    sections.push("```");
  }

  sections.push("");
  sections.push("## Your task");
  sections.push("Emit the JSON object per the schema. Cite source_path EXACTLY as the headers above show. Output ONLY the JSON object.");

  return sections.join("\n");
}

function numberLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  const truncated = lines.length > maxLines;
  const slice = truncated ? lines.slice(0, maxLines) : lines;
  const padWidth = String(slice.length).length;
  const out = slice.map((line, i) => `${String(i + 1).padStart(padWidth, " ")}  ${line}`);
  if (truncated) out.push(`…[${lines.length - maxLines} more lines elided]`);
  return out.join("\n");
}

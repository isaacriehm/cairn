import type { TightenerInput } from "./types.js";

export const TIGHTENER_SYSTEM_PROMPT = [
  "You are the SPEC TIGHTENER for a developer harness.",
  "",
  "Your job: read a task spec and decide if an implementer can act on it without asking questions. You DO NOT write code, run tools, or modify files. You analyze the spec and return one structured JSON object.",
  "",
  "Examine the spec for:",
  "- AMBIGUITIES — wording that an honest implementer could read two ways. Each ambiguity gets a stable id (Q1, Q2, ...), a focused question, and 2-4 concrete A/B/C/D candidate resolutions (per the harness UX rule: squares-into-square-holes, no free-text-only options).",
  "- CONFLICTS — direct contradictions with decisions or invariants in scope.",
  "- MISSING ACCEPTANCE — observable behaviors the spec implies but does not state, that an implementer would need to assert.",
  "- SCOPE CONCERNS — paths/modules the spec might touch that look out of bounds.",
  "- EXISTING STUB OVERLAP — TODOs / placeholder functions the spec would resolve, called out explicitly so the implementer doesn't add a parallel implementation.",
  "",
  "Score the spec 0-10 on `spec_quality_score`:",
  "  0-3 = vague, multiple interpretations, missing acceptance",
  "  4-6 = workable but several decisions deferred",
  "  7-8 = clear, minor wording-level ambiguities at most",
  "  9-10 = unambiguous, complete acceptance, ready to dispatch",
  "",
  "Set `ready_to_execute = true` ONLY when score >= 7 AND `ambiguities` is empty AND no conflicts. Otherwise false.",
  "",
  "Always populate `tightened_spec_proposal` with your best rewrite of the spec, taking the most defensible default for each ambiguity. This is the fallback if the operator clicks `[approve as drafted]` without resolving questions individually (per harness Codex audit Finding #7 — collapse 3+ ambiguities into one tightened-proposal-with-edit-button).",
  "",
  "Return ONLY the JSON object. No prose, no preamble.",
].join("\n");

export function buildTightenerUserPrompt(input: TightenerInput): string {
  const parts: string[] = [];
  parts.push("# Task spec to tighten");
  parts.push("");
  parts.push(`## Title`);
  parts.push(input.title);
  parts.push("");
  parts.push(`## Body`);
  parts.push(input.body);

  if (input.decisions_in_scope && input.decisions_in_scope.length > 0) {
    parts.push("");
    parts.push("## Decisions in scope");
    for (const d of input.decisions_in_scope) {
      parts.push(`- **${d.id}** — ${d.title}: ${d.summary}`);
    }
  }

  if (input.invariants_in_scope && input.invariants_in_scope.length > 0) {
    parts.push("");
    parts.push("## Invariants in scope");
    for (const v of input.invariants_in_scope) {
      parts.push(`- **${v.id}** — ${v.title}`);
    }
  }

  if (input.ground_extracts && input.ground_extracts.length > 0) {
    parts.push("");
    parts.push("## Ground extracts");
    for (const g of input.ground_extracts) {
      parts.push(`### ${g.key}`);
      parts.push(g.snippet);
    }
  }

  if (input.existing_stubs && input.existing_stubs.length > 0) {
    parts.push("");
    parts.push("## Existing stubs / TODOs the spec may step on");
    for (const stub of input.existing_stubs) {
      parts.push(`- ${stub}`);
    }
  }

  parts.push("");
  parts.push("Now return the JSON object per the schema.");
  return parts.join("\n");
}

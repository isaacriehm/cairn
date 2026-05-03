/**
 * Draft writer + confirm-side persistence.
 *
 * `writeDecisionDraft` materializes the extractor output into
 * `.harness/ground/decisions/_inbox/<DEC-id>.draft.md`. Frontmatter
 * conforms to `DecisionFrontmatter` (status: "draft").
 *
 * `acceptDraft` moves the draft to its canonical path with status flipped
 * to "accepted" and triggers a ledger regenerate.
 *
 * `rejectDraft` removes the draft file entirely. The id remains burned —
 * `allocateDecisionId` always returns mark+1, so a rejected DEC-NNNN never
 * gets reissued (per L13.2 monotonic principle, applied to decisions).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { decisionsDir, decisionsLedgerPath } from "../ground/paths.js";
import { writeDecisionsLedger } from "../ground/ledgers.js";
import { parseFrontmatter } from "../ground/frontmatter.js";
import type {
  DecisionDraft,
  DecisionExtractorOutput,
} from "./types.js";

export interface WriteDecisionDraftArgs {
  repoRoot: string;
  id: string;
  output: DecisionExtractorOutput;
  rawText: string;
  authorId: string;
  receivedAt: string;
  source: string;
}

export function writeDecisionDraft(args: WriteDecisionDraftArgs): DecisionDraft {
  const dir = decisionsDir(args.repoRoot);
  const inboxDir = join(dir, "_inbox");
  mkdirSync(inboxDir, { recursive: true });

  const draftFilename = `${args.id}.draft.md`;
  const canonicalFilename = `${args.id}.md`;
  const draftAbs = join(inboxDir, draftFilename);
  const canonicalAbs = join(dir, canonicalFilename);
  const draftRel = `.harness/ground/decisions/_inbox/${draftFilename}`;
  const canonicalRel = `.harness/ground/decisions/${canonicalFilename}`;

  const now = new Date().toISOString();
  // candidate_assertions are PROPOSALS — schema-loose. They live under
  // `candidate_assertions:` in the frontmatter (passthrough), NOT under
  // `assertions:` which DecisionFrontmatter validates strictly. A future
  // refinement step (Phase 14.x) lifts candidates into the strict
  // `assertions:` form once parameters are filled in. Until then the
  // ledger ignores them and Layer-D sensors don't enforce them.
  const candidateAssertions = args.output.candidate_assertions.map((a, idx) => {
    const id = a.id ?? `${args.id}-A${(idx + 1).toString().padStart(2, "0")}`;
    return {
      id,
      kind: a.kind,
      description: a.description,
      ...(a.parameters !== undefined ? { parameters: a.parameters } : {}),
    };
  });

  const frontmatter: Record<string, unknown> = {
    id: args.id,
    title: args.output.subject,
    type: "adr",
    status: "draft",
    audience: "dual",
    generated: now,
    "verified-at": now,
    decided_at: args.receivedAt,
    decided_by: args.authorId,
    ...(args.output.scope_globs.length > 0 ? { scope_globs: args.output.scope_globs } : {}),
    ...(args.output.supersedes ? { supersedes: args.output.supersedes } : {}),
    ...(candidateAssertions.length > 0
      ? { candidate_assertions: candidateAssertions }
      : {}),
    capture_source: args.source,
    capture_confidence: args.output.confidence_signal,
  };

  const yaml = stringifyYaml(frontmatter);
  const body = composeDraftBody(args);
  const fileContent = `---\n${yaml}---\n\n${body}\n`;
  writeFileSync(draftAbs, fileContent, "utf8");

  return {
    id: args.id,
    draft_path: draftRel,
    canonical_path: canonicalRel,
    output: args.output,
    raw_text: args.rawText,
  };
}

function composeDraftBody(args: WriteDecisionDraftArgs): string {
  const lines: string[] = [];
  lines.push(`# ${args.id} — ${args.output.subject}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(args.output.summary.trim());
  lines.push("");
  lines.push("## Original direction");
  lines.push("```");
  lines.push(args.rawText.trim());
  lines.push("```");
  lines.push("");
  if (args.output.scope_globs.length > 0) {
    lines.push("## Scope");
    for (const g of args.output.scope_globs) lines.push(`- \`${g}\``);
    lines.push("");
  }
  if (args.output.candidate_assertions.length > 0) {
    lines.push("## Candidate assertions");
    for (const a of args.output.candidate_assertions) {
      lines.push(`- **${a.kind}** — ${a.description}`);
    }
    lines.push("");
  }
  if (args.output.supersedes) {
    lines.push(`## Supersedes`);
    lines.push(`- ${args.output.supersedes}`);
    lines.push("");
  }
  lines.push(
    `_Confidence: ${args.output.confidence_signal}. This is a DRAFT — pending operator confirmation via Discord._`,
  );
  return lines.join("\n");
}

export interface AcceptDraftResult {
  acceptedPath: string;
  ledgerSize: number;
  ledgerPath: string;
}

/**
 * Move a draft to the canonical decisions/ dir, flip status:draft → accepted,
 * then regenerate the decisions ledger so accepted assertions become live.
 *
 * If a `supersedes` link exists, this also stamps `superseded_by` on the
 * referenced decision (when the file is present). Best-effort — a missing
 * referent doesn't block acceptance.
 */
export function acceptDraft(args: {
  repoRoot: string;
  draft: DecisionDraft;
}): AcceptDraftResult {
  const draftAbs = join(args.repoRoot, args.draft.draft_path);
  const canonicalAbs = join(args.repoRoot, args.draft.canonical_path);

  const original = readFileSync(draftAbs, "utf8");
  const flipped = original.replace(/^status:\s*draft\s*$/m, "status: accepted");
  mkdirSync(dirname(canonicalAbs), { recursive: true });
  writeFileSync(canonicalAbs, flipped, "utf8");
  rmSync(draftAbs, { force: true });

  if (args.draft.output.supersedes) {
    stampSupersededBy({
      repoRoot: args.repoRoot,
      supersededId: args.draft.output.supersedes,
      supersedingId: args.draft.id,
    });
  }

  const ledger = writeDecisionsLedger({ repoRoot: args.repoRoot });
  return {
    acceptedPath: args.draft.canonical_path,
    ledgerSize: ledger.entries.length,
    ledgerPath: decisionsLedgerPath(args.repoRoot).replace(args.repoRoot + "/", ""),
  };
}

/**
 * Discard a draft. The DEC-id is NOT recycled — the allocator advances
 * past every existing DEC-NNNN.* file. Per L13.2 (monotonic ids), even
 * rejected drafts burn their id, so we leave a tombstone at
 * `_inbox/<DEC-id>.rejected.md` rather than deleting outright. The
 * tombstone has `status: rejected` and is excluded from the ledger by
 * the existing `status === "accepted"` filter.
 */
export function rejectDraft(args: {
  repoRoot: string;
  draft: DecisionDraft;
}): void {
  const draftAbs = join(args.repoRoot, args.draft.draft_path);
  if (!existsSync(draftAbs)) return;
  const original = readFileSync(draftAbs, "utf8");
  const tombstone = original.replace(/^status:\s*draft\s*$/m, "status: rejected");
  const tombstoneRel = args.draft.draft_path.replace(
    /\.draft\.md$/,
    ".rejected.md",
  );
  const tombstoneAbs = join(args.repoRoot, tombstoneRel);
  writeFileSync(tombstoneAbs, tombstone, "utf8");
  rmSync(draftAbs, { force: true });
}

function stampSupersededBy(args: {
  repoRoot: string;
  supersededId: string;
  supersedingId: string;
}): void {
  const target = join(decisionsDir(args.repoRoot), `${args.supersededId}.md`);
  if (!existsSync(target)) return;
  const original = readFileSync(target, "utf8");
  // Inject `superseded_by:` into the frontmatter block if not already present.
  if (/^superseded_by:/m.test(original)) return;
  const fenceEnd = original.indexOf("\n---", 3);
  if (fenceEnd === -1) return;
  const fenceText = original.slice(0, fenceEnd);
  const restText = original.slice(fenceEnd);
  const updated = `${fenceText}\nsuperseded_by: ${args.supersedingId}${restText}`;
  writeFileSync(target, updated, "utf8");
}

/* -------------------------------------------------------------------------- */
/* Phase 14.x — refinement lift writer.                                        */
/* -------------------------------------------------------------------------- */

export interface LiftVerdict {
  candidate_id: string;
  status: "lift" | "demote" | "skip";
  /** Strict assertion params (without id/kind — writer injects them). */
  strict_assertion?: Record<string, unknown>;
  /** Original candidate kind (carried onto lifted assertion). */
  candidate_kind:
    | "schema_must_contain"
    | "text_must_match"
    | "text_must_not_match"
    | "index_must_exist"
    | "ast_pattern"
    | "file_must_not_be_modified"
    | "query_must_filter_by"
    | "route_must_have_guard"
    | "event_must_emit"
    | "service_method_must_call"
    | "human_review_hint";
  /** Original candidate description (used when demoted to human_review_hint). */
  candidate_description: string;
}

export interface LiftResult {
  decision_id: string;
  decision_path: string;
  lifted_count: number;
  demoted_count: number;
  skipped_count: number;
  ledger_size: number;
}

/**
 * Apply per-candidate verdicts to an accepted decision file.
 *
 * For each verdict:
 *   - status="lift"   → strict_assertion (with id/kind injected) lands in
 *                       frontmatter `assertions:`
 *   - status="demote" → a `{kind: human_review_hint, description}` assertion
 *                       lands in `assertions:` (always soft, always zod-valid)
 *   - status="skip"   → original candidate stays under `candidate_assertions:`
 *
 * Then regenerates the decisions ledger so the new strict assertions are
 * visible to Layer-D sensors on the next run.
 */
export function liftCandidatesToAssertions(args: {
  repoRoot: string;
  decisionId: string;
  verdicts: LiftVerdict[];
}): LiftResult {
  const decisionRel = `.harness/ground/decisions/${args.decisionId}.md`;
  const decisionAbs = join(args.repoRoot, decisionRel);
  if (!existsSync(decisionAbs)) {
    throw new Error(
      `liftCandidatesToAssertions: decision file missing at ${decisionRel}`,
    );
  }
  const original = readFileSync(decisionAbs, "utf8");
  const parsed = parseFrontmatter(original);
  const fmRaw =
    parsed.raw.length > 0 ? (parseYaml(parsed.raw) as Record<string, unknown>) : {};

  const existingAssertions = Array.isArray(fmRaw["assertions"])
    ? (fmRaw["assertions"] as Array<Record<string, unknown>>).slice()
    : [];
  const existingCandidates = Array.isArray(fmRaw["candidate_assertions"])
    ? (fmRaw["candidate_assertions"] as Array<Record<string, unknown>>).slice()
    : [];

  let liftedCount = 0;
  let demotedCount = 0;
  let skippedCount = 0;

  const newAssertions = [...existingAssertions];
  const liftedIds = new Set<string>();
  const demotedIds = new Set<string>();
  const skippedIds = new Set<string>();

  for (const v of args.verdicts) {
    if (v.status === "lift" && v.strict_assertion !== undefined) {
      newAssertions.push({
        id: v.candidate_id,
        kind: v.candidate_kind,
        ...v.strict_assertion,
      });
      liftedIds.add(v.candidate_id);
      liftedCount++;
      continue;
    }
    if (v.status === "demote") {
      newAssertions.push({
        id: v.candidate_id,
        kind: "human_review_hint",
        description: v.candidate_description,
      });
      demotedIds.add(v.candidate_id);
      demotedCount++;
      continue;
    }
    skippedIds.add(v.candidate_id);
    skippedCount++;
  }

  const remainingCandidates = existingCandidates.filter((c) => {
    const id = typeof c["id"] === "string" ? (c["id"] as string) : "";
    return !liftedIds.has(id) && !demotedIds.has(id);
  });

  // Build the new frontmatter object preserving every existing field, just
  // updating assertions: + candidate_assertions: + verified-at.
  const newFm: Record<string, unknown> = { ...fmRaw };
  if (newAssertions.length > 0) {
    newFm["assertions"] = newAssertions;
  } else {
    delete newFm["assertions"];
  }
  if (remainingCandidates.length > 0) {
    newFm["candidate_assertions"] = remainingCandidates;
  } else {
    delete newFm["candidate_assertions"];
  }
  newFm["verified-at"] = new Date().toISOString();

  const newYaml = stringifyYaml(newFm);
  const newContent = `---\n${newYaml}---\n${parsed.body.startsWith("\n") ? "" : "\n"}${parsed.body}`;
  writeFileSync(decisionAbs, newContent, "utf8");

  const ledger = writeDecisionsLedger({ repoRoot: args.repoRoot });

  return {
    decision_id: args.decisionId,
    decision_path: decisionRel,
    lifted_count: liftedCount,
    demoted_count: demotedCount,
    skipped_count: skippedCount,
    ledger_size: ledger.entries.length,
  };
}

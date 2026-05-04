/**
 * Phase 14.x — assertion refinement.
 *
 * Lifts the loose `candidate_assertions:` set on an accepted decision into
 * the strict `assertions:` shape that Layer-D sensors enforce.
 *
 * Flow:
 *   read accepted decision file
 *   → proposeStrictAssertions  (Tier-1 LLM)
 *   → re-validate each lift via DecisionAssertion zod (auto-demote on fail)
 *   → adapter.requestDialog: a) approve_all  b) approve_high_only
 *                            c) demote_all   d) skip
 *   → liftCandidatesToAssertions writes the file
 *   → ledger regenerates so the new strict assertions become live
 *
 * The proposer runs READ-ONLY. The writer + dialog drive everything that
 * touches the filesystem. A proposer failure (timeout, malformed JSON,
 * subprocess crash) does NOT roll back the prior accept — it returns
 * `proposer_failed: true` and leaves candidates under their loose
 * `candidate_assertions:` field for the next refine pass.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";
import { runClaude } from "../claude/index.js";
import type { FrontendAdapter, DialogSpec } from "../frontend-types.js";
import type { ClaudeTier } from "../claude/index.js";
import { DecisionAssertion } from "../ground/schemas.js";
import { parseFrontmatter } from "../ground/frontmatter.js";
import {
  REFINEMENT_PROPOSER_SYSTEM_PROMPT,
  buildRefinementProposerUserPrompt,
} from "./refinement-prompt.js";
import { REFINEMENT_PROPOSER_OUTPUT_SCHEMA } from "./refinement-schema.js";
import { liftCandidatesToAssertions, type LiftVerdict } from "./writer.js";
import type {
  CandidateAssertion,
  RefinementProposal,
  RefinementResult,
  RefinerInput,
  RefinerOutput,
} from "./types.js";

const log = logger("decision-capture.refinement");

const RATIONALE_DISPLAY_CAP = 240;
/** Max chars in the refinement dialog prompt body. Discord caps at 2000. */
const DIALOG_PROMPT_CHAR_CAP = 1_700;

const CHOICE_APPROVE_ALL = "a";
const CHOICE_APPROVE_HIGH_ONLY = "b";
const CHOICE_DEMOTE_ALL = "c";
const CHOICE_SKIP = "d";

export interface ProposerResult {
  output: RefinerOutput;
  duration_ms: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Single Tier-1 (Haiku default) LLM call producing one proposal per
 * input candidate. The output is gated by the JSON Schema on the CLI
 * side and re-validated structurally here.
 */
export async function proposeStrictAssertions(
  input: RefinerInput,
): Promise<ProposerResult> {
  if (input.candidates.length === 0) {
    return { output: { proposals: [] }, duration_ms: 0 };
  }
  const userPrompt = buildRefinementProposerUserPrompt(input);
  log.info(
    {
      decision_id: input.decision_id,
      candidates: input.candidates.length,
      tier: input.tier,
    },
    "refinement-proposer dispatch",
  );

  const result = await runClaude({
    tier: input.tier,
    prompt: userPrompt,
    system: REFINEMENT_PROPOSER_SYSTEM_PROMPT,
    jsonSchema: REFINEMENT_PROPOSER_OUTPUT_SCHEMA as object,
    timeoutMs: input.timeout_ms ?? 120_000,
  });

  if (!isRefinerOutput(result.parsed)) {
    throw new Error(
      `refinement-proposer returned malformed output. preview: ${result.text.slice(0, 200)}`,
    );
  }

  log.info(
    {
      decision_id: input.decision_id,
      proposals: result.parsed.proposals.length,
      duration_ms: result.durationMs,
    },
    "refinement-proposer complete",
  );

  return {
    output: result.parsed,
    duration_ms: result.durationMs,
    ...(result.usage !== undefined
      ? {
          usage: {
            ...(result.usage["input_tokens"] !== undefined
              ? { input_tokens: result.usage["input_tokens"] }
              : {}),
            ...(result.usage["output_tokens"] !== undefined
              ? { output_tokens: result.usage["output_tokens"] }
              : {}),
          },
        }
      : {}),
  };
}

export interface RunDecisionRefinementArgs {
  /** Repo root for the mirror checkout. */
  repoRoot: string;
  /** DEC-id of the accepted decision whose candidates we're refining. */
  decisionId: string;
  /** Adapter that owns the confirm dialog. */
  adapter: FrontendAdapter;
  /** Channel for the dialog (Discord thread / DM). */
  channelId?: string;
  /** Tier for the proposer call. Default = haiku. */
  tier?: ClaudeTier;
  /** Per-call timeout for the proposer. */
  proposerTimeoutMs?: number;
  /** Dialog timeout. Default 60_000 ms. */
  dialogTimeoutMs?: number;
  /**
   * Smokes inject a stub here so they can verify dialog branching without
   * burning claude quota. Defaults to `proposeStrictAssertions`.
   */
  proposerOverride?: typeof proposeStrictAssertions;
}

export async function runDecisionRefinement(
  args: RunDecisionRefinementArgs,
): Promise<RefinementResult> {
  const tier = args.tier ?? "haiku";
  const propose = args.proposerOverride ?? proposeStrictAssertions;

  const decision = readAcceptedDecision({
    repoRoot: args.repoRoot,
    decisionId: args.decisionId,
  });
  if (decision.candidates.length === 0) {
    log.info(
      { decision_id: args.decisionId },
      "no candidates to refine — skipping",
    );
    return emptyResult(args.decisionId, "skip");
  }

  let proposerResult: ProposerResult | null = null;
  try {
    proposerResult = await propose({
      decision_id: args.decisionId,
      subject: decision.subject,
      summary: decision.summary,
      scope_globs: decision.scope_globs,
      candidates: decision.candidates,
      tier,
      ...(args.proposerTimeoutMs !== undefined
        ? { timeout_ms: args.proposerTimeoutMs }
        : {}),
    });
  } catch (err) {
    log.error(
      { err: String(err), decision_id: args.decisionId },
      "refinement-proposer threw — leaving candidates loose",
    );
    return { ...emptyResult(args.decisionId, "skip"), proposer_failed: true };
  }

  // Align proposals to candidates by id; fill gaps with auto-demote so a
  // partial proposer response never silently drops a candidate.
  const aligned = alignProposalsToCandidates({
    decisionId: args.decisionId,
    candidates: decision.candidates,
    proposals: proposerResult.output.proposals,
  });

  // Re-validate each lift via the production zod. Anything that doesn't
  // pass becomes a demote with the validation error in the rationale.
  const validated = aligned.map((p) => validateLift(p));

  const dialogPrompt = renderDialogPrompt({
    decisionId: args.decisionId,
    subject: decision.subject,
    proposals: validated,
  });
  const dialogSpec: DialogSpec = {
    bundleId: `refine:${args.decisionId}`,
    prompt: dialogPrompt,
    choices: [
      { id: CHOICE_APPROVE_ALL, label: "🟢 approve all (lift + demote per recs)" },
      { id: CHOICE_APPROVE_HIGH_ONLY, label: "🟡 lift HIGH-confidence only" },
      { id: CHOICE_DEMOTE_ALL, label: "🟠 demote all to human_review_hint" },
      { id: CHOICE_SKIP, label: "🔴 skip refinement" },
      { id: "e_other", label: "E) Other" },
    ],
    timeoutMs: args.dialogTimeoutMs ?? 60_000,
  };
  if (args.channelId !== undefined) dialogSpec.channelId = args.channelId;

  const response = await args.adapter.requestDialog(dialogSpec);
  const choice = mapDialogChoice(response);

  // Compose the final per-candidate verdict map from the operator's choice.
  const finalVerdicts = applyOperatorChoice({
    proposals: validated,
    candidates: decision.candidates,
    choice,
  });

  if (choice === "skip") {
    log.info({ decision_id: args.decisionId }, "operator skipped refinement");
    return {
      decision_id: args.decisionId,
      proposals: validated,
      operator_choice: "skip",
      lifted_count: 0,
      demoted_count: 0,
      skipped_count: validated.length,
    };
  }

  const liftResult = liftCandidatesToAssertions({
    repoRoot: args.repoRoot,
    decisionId: args.decisionId,
    verdicts: finalVerdicts,
  });

  log.info(
    {
      decision_id: args.decisionId,
      operator_choice: choice,
      lifted: liftResult.lifted_count,
      demoted: liftResult.demoted_count,
      kept_candidate: liftResult.skipped_count,
    },
    "refinement applied",
  );

  return {
    decision_id: args.decisionId,
    proposals: validated,
    operator_choice: choice,
    lifted_count: liftResult.lifted_count,
    demoted_count: liftResult.demoted_count,
    skipped_count: liftResult.skipped_count,
  };
}

/* ───────────────────────────── helpers ───────────────────────────── */

interface AcceptedDecisionRead {
  subject: string;
  summary: string;
  scope_globs: string[];
  candidates: CandidateAssertion[];
}

function readAcceptedDecision(args: {
  repoRoot: string;
  decisionId: string;
}): AcceptedDecisionRead {
  const relPath = `.harness/ground/decisions/${args.decisionId}.md`;
  const abs = join(args.repoRoot, relPath);
  const raw = readFileSync(abs, "utf8");
  // parseFrontmatter validates with ProvenanceFrontmatter zod which is a
  // passthrough — extra keys (candidate_assertions, scope_globs, title)
  // survive in the returned object.
  const parsed = parseFrontmatter(raw);
  const fm = (parsed.frontmatter ?? {}) as Record<string, unknown>;
  const candidatesRaw = fm["candidate_assertions"];
  const candidates: CandidateAssertion[] = Array.isArray(candidatesRaw)
    ? (candidatesRaw as Array<Record<string, unknown>>).flatMap((c, idx) => {
        const kind = c["kind"];
        const description = c["description"];
        if (typeof kind !== "string" || typeof description !== "string") {
          log.warn(
            { decision_id: args.decisionId, idx },
            "dropping malformed candidate row from frontmatter",
          );
          return [];
        }
        const id =
          typeof c["id"] === "string"
            ? (c["id"] as string)
            : `${args.decisionId}-A${(idx + 1).toString().padStart(2, "0")}`;
        const params = c["parameters"];
        const out: CandidateAssertion = {
          id,
          kind: kind as CandidateAssertion["kind"],
          description,
          ...(params !== undefined && typeof params === "object" && params !== null
            ? { parameters: params as Record<string, unknown> }
            : {}),
        };
        return [out];
      })
    : [];

  return {
    subject: typeof fm["title"] === "string" ? (fm["title"] as string) : args.decisionId,
    summary: extractSummaryFromBody(parsed.body),
    scope_globs: Array.isArray(fm["scope_globs"])
      ? (fm["scope_globs"] as unknown[]).filter((g): g is string => typeof g === "string")
      : [],
    candidates,
  };
}

function extractSummaryFromBody(body: string): string {
  // Body starts with `# DEC-NNNN — title\n\n## Summary\n<text>\n\n## ...`
  const summaryHeader = body.indexOf("## Summary");
  if (summaryHeader === -1) return "";
  const after = body.slice(summaryHeader + "## Summary".length);
  const nextSection = after.search(/\n##\s/);
  const slice = nextSection === -1 ? after : after.slice(0, nextSection);
  return slice.trim();
}

function alignProposalsToCandidates(args: {
  decisionId: string;
  candidates: CandidateAssertion[];
  proposals: RefinementProposal[];
}): RefinementProposal[] {
  const byId = new Map<string, RefinementProposal>();
  for (const p of args.proposals) byId.set(p.candidate_id, p);
  return args.candidates.map((c, idx) => {
    const id = c.id ?? `${args.decisionId}-A${(idx + 1).toString().padStart(2, "0")}`;
    const found = byId.get(id);
    if (found !== undefined) return found;
    log.warn(
      { decision_id: args.decisionId, candidate_id: id },
      "proposer dropped a candidate — auto-demoting",
    );
    return {
      candidate_id: id,
      candidate_kind: c.kind,
      status: "demote",
      confidence_signal: "low",
      rationale: "auto-demoted: proposer did not return a proposal for this candidate",
    };
  });
}

function validateLift(p: RefinementProposal): RefinementProposal {
  if (p.status !== "lift") return p;
  // human_review_hint always lifts cleanly: the strict shape only requires
  // `description`. If the proposer didn't provide one, fall back to the
  // candidate kind's name.
  if (p.candidate_kind === "human_review_hint") {
    const description =
      typeof p.strict_assertion?.["description"] === "string"
        ? (p.strict_assertion["description"] as string)
        : (p.rationale || "human review required");
    return {
      ...p,
      strict_assertion: { description },
    };
  }
  if (p.strict_assertion === undefined) {
    const { strict_assertion: _omit, ...rest } = p;
    void _omit;
    return {
      ...rest,
      status: "demote",
      rationale: `auto-demoted: lift verdict missing strict_assertion. Original rationale: ${p.rationale}`,
    };
  }

  // Inject id + kind to match the discriminated DecisionAssertion zod.
  // Note: id is a placeholder for validation only; the writer mints the
  // canonical `<DEC-id>-A<NN>` id before persisting.
  const candidate = {
    id: p.candidate_id,
    kind: p.candidate_kind,
    ...p.strict_assertion,
  };
  const parse = DecisionAssertion.safeParse(candidate);
  if (!parse.success) {
    const { strict_assertion: _omit, ...rest } = p;
    void _omit;
    return {
      ...rest,
      status: "demote",
      rationale: `auto-demoted: zod validation failed (${parse.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).slice(0, 2).join("; ")})`,
    };
  }
  return p;
}

function mapDialogChoice(response: {
  choiceId: string;
  freeText?: string;
  timedOut?: boolean;
}): RefinementResult["operator_choice"] {
  if (response.timedOut) return "skip";
  switch (response.choiceId) {
    case CHOICE_APPROVE_ALL:
      return "approve_all";
    case CHOICE_APPROVE_HIGH_ONLY:
      return "approve_high_only";
    case CHOICE_DEMOTE_ALL:
      return "demote_all";
    case CHOICE_SKIP:
      return "skip";
    default:
      // Unknown / E) Other → conservative skip; preserves candidates.
      return "skip";
  }
}

function applyOperatorChoice(args: {
  proposals: RefinementProposal[];
  candidates: CandidateAssertion[];
  choice: RefinementResult["operator_choice"];
}): LiftVerdict[] {
  const descById = new Map<string, string>();
  for (let i = 0; i < args.candidates.length; i++) {
    const c = args.candidates[i];
    if (c === undefined) continue;
    const id = c.id ?? `unknown-A${(i + 1).toString().padStart(2, "0")}`;
    descById.set(id, c.description);
  }
  return args.proposals.map((p) => {
    const description = descById.get(p.candidate_id) ?? p.rationale;
    const base: LiftVerdict = {
      candidate_id: p.candidate_id,
      candidate_kind: p.candidate_kind,
      candidate_description: description,
      status: "skip",
    };
    if (args.choice === "skip") {
      return { ...base, status: "skip" };
    }
    if (args.choice === "demote_all") {
      return { ...base, status: "demote" };
    }
    if (args.choice === "approve_all") {
      if (p.status === "lift") {
        return p.strict_assertion !== undefined
          ? { ...base, status: "lift", strict_assertion: p.strict_assertion }
          : { ...base, status: "demote" };
      }
      return { ...base, status: p.status };
    }
    // approve_high_only
    if (p.status === "lift" && p.confidence_signal === "high") {
      return p.strict_assertion !== undefined
        ? { ...base, status: "lift", strict_assertion: p.strict_assertion }
        : { ...base, status: "skip" };
    }
    if (p.status === "demote") {
      return { ...base, status: "demote" };
    }
    return { ...base, status: "skip" };
  });
}

function renderDialogPrompt(args: {
  decisionId: string;
  subject: string;
  proposals: RefinementProposal[];
}): string {
  const lines: string[] = [];
  lines.push(`Refine ${args.decisionId} — ${args.proposals.length} candidate${args.proposals.length === 1 ? "" : "s"}`);
  lines.push(`"${args.subject}"`);
  lines.push("");
  for (const p of args.proposals) {
    const marker =
      p.status === "lift" && p.confidence_signal === "high"
        ? "✅"
        : p.status === "lift"
          ? "🟡"
          : p.status === "demote"
            ? "🟠"
            : "⚪";
    const rationale =
      p.rationale.length > RATIONALE_DISPLAY_CAP
        ? p.rationale.slice(0, RATIONALE_DISPLAY_CAP) + "…"
        : p.rationale;
    lines.push(
      `${marker} ${p.candidate_id} [${p.candidate_kind}] ${p.confidence_signal.toUpperCase()} → ${p.status}`,
    );
    lines.push(`   ${rationale}`);
    if (p.status === "lift" && p.strict_assertion !== undefined) {
      const preview = JSON.stringify(p.strict_assertion);
      const previewClipped =
        preview.length > 160 ? preview.slice(0, 160) + "…" : preview;
      lines.push(`   shape: ${previewClipped}`);
    }
  }
  lines.push("");
  const recLifts = args.proposals.filter((p) => p.status === "lift").length;
  const recDemotes = args.proposals.filter((p) => p.status === "demote").length;
  const recSkips = args.proposals.filter((p) => p.status === "skip").length;
  const highOnly = args.proposals.filter(
    (p) => p.status === "lift" && p.confidence_signal === "high",
  ).length;
  lines.push(
    `Recs: lift=${recLifts}, demote=${recDemotes}, skip=${recSkips}. HIGH-only lifts=${highOnly}.`,
  );

  let body = lines.join("\n");
  if (body.length > DIALOG_PROMPT_CHAR_CAP) {
    body = body.slice(0, DIALOG_PROMPT_CHAR_CAP - 16) + "\n…[truncated]";
  }
  return body;
}

function emptyResult(
  decisionId: string,
  choice: RefinementResult["operator_choice"],
): RefinementResult {
  return {
    decision_id: decisionId,
    proposals: [],
    operator_choice: choice,
    lifted_count: 0,
    demoted_count: 0,
    skipped_count: 0,
  };
}

function isRefinerOutput(value: unknown): value is RefinerOutput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v["proposals"])) return false;
  for (const p of v["proposals"] as unknown[]) {
    if (typeof p !== "object" || p === null) return false;
    const pp = p as Record<string, unknown>;
    if (typeof pp["candidate_id"] !== "string") return false;
    if (typeof pp["candidate_kind"] !== "string") return false;
    if (
      pp["status"] !== "lift" &&
      pp["status"] !== "demote" &&
      pp["status"] !== "skip"
    ) {
      return false;
    }
    if (
      pp["confidence_signal"] !== "high" &&
      pp["confidence_signal"] !== "medium" &&
      pp["confidence_signal"] !== "low"
    ) {
      return false;
    }
    if (typeof pp["rationale"] !== "string") return false;
    if (
      pp["strict_assertion"] !== undefined &&
      (typeof pp["strict_assertion"] !== "object" ||
        pp["strict_assertion"] === null)
    ) {
      return false;
    }
  }
  return true;
}

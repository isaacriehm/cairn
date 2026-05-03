/**
 * runDecisionCapture — orchestrates the full flow:
 *
 *   raw_text → extract → write draft → adapter dialog 🟢/🟡/🔴
 *                                  ├── 🟢 commit  → acceptDraft → ledger
 *                                  ├── 🟡 edit    → leave draft + return correction text
 *                                  └── 🔴 reject  → rejectDraft → no record
 *
 * The dialog is supplied by the caller (typically a FrontendAdapter's
 * requestDialog) so this entry point works equally well in tests with the
 * stub adapter, in CLI with a TTY prompt, and in Discord with the real
 * adapter.
 */

import { logger } from "../logger.js";
import type { FrontendAdapter } from "../frontend/index.js";
import type { ClaudeTier } from "../claude/index.js";
import { runDecisionExtractor } from "./extractor.js";
import { allocateDecisionId } from "./id.js";
import {
  acceptDraft,
  rejectDraft,
  writeDecisionDraft,
} from "./writer.js";
import {
  proposeStrictAssertions,
  runDecisionRefinement,
} from "./refinement.js";
import type {
  DecisionCaptureResult,
  DecisionDraft,
  DraftConfirmDecision,
} from "./types.js";

const log = logger("decision-capture");

export interface RunDecisionCaptureArgs {
  /** Repo root for the mirror checkout. */
  repoRoot: string;
  /** Raw operator text. */
  rawText: string;
  /** Operator id. */
  authorId: string;
  /** Source — `discord:slash:/direction` or `discord:free_text` etc. */
  source: string;
  /** ISO timestamp the message was received. Default = now. */
  receivedAt?: string;
  /** Tier for the extractor. Default = haiku. */
  tier?: ClaudeTier;
  /** Channel id to thread the confirm dialog through. */
  channelId?: string;
  /** Adapter that owns the confirm dialog. */
  adapter: FrontendAdapter;
  /** Confirm-dialog timeout. Default 60_000 ms. */
  confirmTimeoutMs?: number;
  /**
   * Optional: override the extractor entry point. Smokes inject a stub so
   * the smoke runs without burning claude quota when only the
   * draft/confirm/ledger flow needs verifying.
   */
  extractorOverride?: typeof runDecisionExtractor;
  /**
   * Skip the post-commit refinement step. Defaults to false. The
   * orchestrator's `bypassRefinement` mirrors this for production runs;
   * smokes that don't care about refinement can flip it on.
   */
  bypassRefinement?: boolean;
  /** Tier for the refinement proposer. Default = haiku. */
  refinementTier?: ClaudeTier;
  /** Refinement dialog timeout. Default 60_000 ms. */
  refinementDialogTimeoutMs?: number;
  /** Smokes inject a stub proposer to avoid burning claude quota. */
  refinementProposerOverride?: typeof proposeStrictAssertions;
}

const CHOICE_COMMIT = "a";
const CHOICE_EDIT = "b";
const CHOICE_REJECT = "c";

export async function runDecisionCapture(
  args: RunDecisionCaptureArgs,
): Promise<DecisionCaptureResult> {
  const startedAt = Date.now();
  const tier = args.tier ?? "haiku";
  const receivedAt = args.receivedAt ?? new Date().toISOString();
  const extract = args.extractorOverride ?? runDecisionExtractor;

  const extractorResult = await extract({
    raw_text: args.rawText,
    author_id: args.authorId,
    received_at: receivedAt,
    source: args.source,
    tier,
  });

  if (extractorResult.output.not_a_decision) {
    log.info(
      { source: args.source, author: args.authorId },
      "decision-extractor flagged not_a_decision — short-circuiting",
    );
    return {
      short_circuited: true,
      duration_ms: Date.now() - startedAt,
    };
  }

  const id = allocateDecisionId(args.repoRoot);
  const draft = writeDecisionDraft({
    repoRoot: args.repoRoot,
    id,
    output: extractorResult.output,
    rawText: args.rawText,
    authorId: args.authorId,
    receivedAt,
    source: args.source,
  });

  log.info(
    { id, draft_path: draft.draft_path, confidence: extractorResult.output.confidence_signal },
    "draft written; awaiting confirm",
  );

  const decision = await promptConfirm({
    adapter: args.adapter,
    draft,
    ...(args.channelId !== undefined ? { channelId: args.channelId } : {}),
    timeoutMs: args.confirmTimeoutMs ?? 60_000,
  });

  if (decision.decision === "commit") {
    const accepted = acceptDraft({ repoRoot: args.repoRoot, draft });
    log.info(
      { id, accepted_path: accepted.acceptedPath, ledger_size: accepted.ledgerSize },
      "draft accepted; ledger regenerated",
    );

    let refinement: DecisionCaptureResult["refinement"] | undefined;
    const hasCandidates = extractorResult.output.candidate_assertions.length > 0;
    if (!args.bypassRefinement && hasCandidates) {
      try {
        refinement = await runDecisionRefinement({
          repoRoot: args.repoRoot,
          decisionId: id,
          adapter: args.adapter,
          ...(args.channelId !== undefined ? { channelId: args.channelId } : {}),
          tier: args.refinementTier ?? tier,
          ...(args.refinementDialogTimeoutMs !== undefined
            ? { dialogTimeoutMs: args.refinementDialogTimeoutMs }
            : {}),
          ...(args.refinementProposerOverride !== undefined
            ? { proposerOverride: args.refinementProposerOverride }
            : {}),
        });
        log.info(
          {
            id,
            operator_choice: refinement.operator_choice,
            lifted: refinement.lifted_count,
            demoted: refinement.demoted_count,
            kept_candidate: refinement.skipped_count,
          },
          "refinement complete",
        );
      } catch (err) {
        // Refinement failure must NEVER roll back the accept. Log and move
        // on; candidates stay loose under candidate_assertions: for the
        // operator's next refine pass.
        log.error(
          { err: String(err), id },
          "refinement threw — accept stands; candidates remain loose",
        );
      }
    }

    return {
      short_circuited: false,
      draft,
      confirm: {
        decision: "commit",
        accepted_path: accepted.acceptedPath,
        ledger_size: accepted.ledgerSize,
        draft,
        confidence: extractorResult.output.confidence_signal,
      },
      ...(refinement !== undefined ? { refinement } : {}),
      duration_ms: Date.now() - startedAt,
    };
  }

  if (decision.decision === "edit") {
    log.info({ id, correction: decision.correction?.slice(0, 120) }, "draft edit requested");
    return {
      short_circuited: false,
      draft,
      confirm: {
        decision: "edit",
        draft,
        ...(decision.correction !== undefined ? { correction: decision.correction } : {}),
        confidence: extractorResult.output.confidence_signal,
      },
      duration_ms: Date.now() - startedAt,
    };
  }

  // reject
  rejectDraft({ repoRoot: args.repoRoot, draft });
  log.info({ id }, "draft rejected; file removed");
  return {
    short_circuited: false,
    draft,
    confirm: {
      decision: "reject",
      draft,
      confidence: extractorResult.output.confidence_signal,
    },
    duration_ms: Date.now() - startedAt,
  };
}

async function promptConfirm(args: {
  adapter: FrontendAdapter;
  draft: DecisionDraft;
  channelId?: string;
  timeoutMs: number;
}): Promise<{ decision: DraftConfirmDecision; correction?: string }> {
  const summary = args.draft.output.summary.split(/\r?\n/).slice(0, 3).join(" ").trim();
  const scope =
    args.draft.output.scope_globs.length > 0
      ? args.draft.output.scope_globs.join(", ")
      : "(no scope captured)";
  const supersedes = args.draft.output.supersedes
    ? `Supersedes ${args.draft.output.supersedes}. `
    : "";
  const assertions = args.draft.output.candidate_assertions.length;

  const prompt = [
    `Confirm ${args.draft.id}? "${args.draft.output.subject}"`,
    summary,
    `Scope: ${scope}`,
    `${supersedes}Candidate assertions: ${assertions}`,
  ].join("\n");

  const dialogSpec: import("../frontend/index.js").DialogSpec = {
    bundleId: args.draft.id,
    prompt,
    choices: [
      { id: CHOICE_COMMIT, label: "🟢 commit" },
      { id: CHOICE_EDIT, label: "🟡 edit" },
      { id: CHOICE_REJECT, label: "🔴 not a decision" },
      { id: "e_other", label: "E) Other" },
    ],
    timeoutMs: args.timeoutMs,
  };
  if (args.channelId !== undefined) dialogSpec.channelId = args.channelId;
  const response = await args.adapter.requestDialog(dialogSpec);

  if (response.timedOut) {
    // Timeout = treat as edit-with-no-correction so the draft survives in
    // _inbox/ and the operator can come back to it. This avoids losing the
    // capture on a transient inattentiveness.
    return { decision: "edit" };
  }
  if (response.choiceId === CHOICE_COMMIT) {
    return { decision: "commit" };
  }
  if (response.choiceId === CHOICE_REJECT) {
    return { decision: "reject" };
  }
  if (response.choiceId === CHOICE_EDIT || response.choiceId === "e_other") {
    return {
      decision: "edit",
      ...(response.freeText !== undefined ? { correction: response.freeText } : {}),
    };
  }
  // Unknown id — fall back to edit (preserve the draft).
  return { decision: "edit" };
}

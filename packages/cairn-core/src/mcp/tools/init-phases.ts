/**
 * MCP tools for the v0.9.0 init pipeline.
 *
 * Two tools, single surface:
 *   1. `cairn_init_resume` → { status, nextPhase, repoRoot }
 *   2. `cairn_init_run({ phase, answer? })` → { status, nextPhase | question | error }
 *
 * The cairn-adopt skill drives the pipeline by:
 *   1. cairn_init_resume          → { status, nextPhase, repoRoot }
 *   2. cairn_init_run({ phase })  → { status, nextPhase | question | error }
 *   3. AskUserQuestion if needs_input → re-call same tool with { answer }
 *   4. loop on complete + advance until nextPhase === null
 *
 * Phase 9b-curate is a skill-driven pseudo-phase: between Phase 9a
 * (walker) and Phase 9c (emit), the cairn-adopt skill spawns
 * `cairn:curator-map` and `cairn:curator-reduce` subagents that write
 * `.cairn/init/curator/final.jsonl`. The 9b runner only confirms the
 * file exists + counts entries before advancing; the heavy work
 * happens outside the MCP server.
 *
 * State persists to .cairn/init-state.json after every successful
 * phase result so the operator can crash-recover. The skill no longer
 * threads state through arguments — `cairn_init_run` reads state from
 * disk and only needs an optional `answer` field for needs_input phases.
 *
 * Why no state echo: returning the full state in tool responses
 * triggered MCP-level spillover-to-file once mapper output landed,
 * which broke the skill's state machine (see v0.3.5 incident report).
 * Skinny responses keep the conversation cache warm and let the LLM
 * progress through phases without re-reading 90KB JSON each round.
 *
 * Why no clobber on error: prior versions persisted `result.state`
 * unconditionally. An error path that echoed the input state with
 * `outputs: {}` would overwrite the on-disk state and lose all prior
 * phase outputs — a single bad call could nuke a 90KB mapper run.
 */

import { z } from "zod";
import {
  PHASE_IDS,
  clearPhaseState,
  clearProgress,
  freshPhaseState,
  readPhaseState,
  resumePhases,
  runPhase1Detect,
  runPhase2Walker,
  runPhase3Mapper,
  runPhase4Seed,
  runPhase5Preflight,
  runPhase6Brand,
  runPhase7TopicIndex,
  runPhase8DocsIngest,
  runPhase9aWalker,
  runPhase9bCurate,
  runPhase9cEmit,
  runPhase9dCompWalk,
  runPhase9eCompAnnotate,
  runPhase9fCompEmit,
  runPhase10RulesMerge,
  runPhase11Baseline,
  runPhase12Strip,
  runPhase13Multidev,
  writePhaseState,
  writeProgress,
  type PhaseError,
  type PhaseId,
  type PhaseQuestion,
  type PhaseResult,
  type PhaseState,
} from "../../init/index.js";
import type { McpContext } from "../context.js";
import { mcpError } from "../errors.js";
import type { ToolDef } from "./types.js";

const phaseIdEnum = z.enum(PHASE_IDS);

const phaseStateSchema = z.object({
  repoRoot: z.string().min(1),
  currentPhase: phaseIdEnum,
  outputs: z.record(z.string(), z.unknown()),
  answer: z.string().optional(),
  startedAt: z.string().min(1),
  schemaVersion: z.literal(3),
});

const phaseRunInput = {
  phase: phaseIdEnum,
  // State is optional — `cairn_init_run` reads .cairn/init-state.json
  // by default. Callers can still pass an explicit state object (smoke
  // tests, debug tooling) but the cairn-adopt skill should pass nothing
  // here.
  state: phaseStateSchema.optional(),
  // Operator answer for needs_input phases. The wrapper splices this
  // into state.answer before invoking the phase runner.
  answer: z.string().optional(),
};

const initResumeInput = {};

const RUNNERS: Record<PhaseId, (s: PhaseState) => Promise<PhaseResult>> = {
  "1-detect": runPhase1Detect,
  "2-walker": runPhase2Walker,
  "3-mapper": runPhase3Mapper,
  "4-seed": runPhase4Seed,
  "5-preflight": runPhase5Preflight,
  "6-brand": runPhase6Brand,
  "7-topic-index": runPhase7TopicIndex,
  "8-docs-ingest": runPhase8DocsIngest,
  "9a-walker": runPhase9aWalker,
  "9b-curate": runPhase9bCurate,
  "9c-emit": runPhase9cEmit,
  "9d-comp-walk": runPhase9dCompWalk,
  "9e-comp-annotate": runPhase9eCompAnnotate,
  "9f-comp-emit": runPhase9fCompEmit,
  "10-rules-merge": runPhase10RulesMerge,
  "11-baseline": runPhase11Baseline,
  "12-strip": runPhase12Strip,
  "13-multidev": runPhase13Multidev,
};

interface PhaseRunInput {
  phase: PhaseId;
  state?: PhaseState;
  answer?: string;
}

interface ResumeToolInput {
  // empty
}

/**
 * Public response shape — strictly skinnier than PhaseResult so the
 * MCP transport never spills the full state into a tool-result file.
 * The skill driver gets `nextPhase` (advance), `question` (ask), or
 * `error` (surface). State stays on disk; readers reload from there.
 */
type SlimPhaseResponse =
  | {
      readonly status: "complete";
      readonly nextPhase: PhaseId | null;
    }
  | {
      readonly status: "needs_input";
      readonly question: PhaseQuestion;
    }
  | {
      readonly status: "error";
      readonly error: PhaseError;
    };

function toSlim(result: PhaseResult): SlimPhaseResponse {
  if (result.status === "complete") {
    return { status: "complete", nextPhase: result.nextPhase };
  }
  if (result.status === "needs_input") {
    return { status: "needs_input", question: result.question };
  }
  return { status: "error", error: result.error };
}

async function handlePhaseRun(
  ctx: McpContext,
  id: PhaseId,
  input: { state?: PhaseState; answer?: string },
): Promise<unknown> {
  // Resolve state: prefer the explicit arg (smoke tests, debug
  // tooling), fall back to disk (cairn-adopt skill default).
  let state: PhaseState | null = input.state ?? null;
  if (state === null) {
    state = readPhaseState(ctx.repoRoot);
  }
  if (state === null) {
    return mcpError(
      "VALIDATION_FAILED",
      `cairn_init_run for phase ${id} found no init state at .cairn/init-state.json. Call cairn_init_resume to start a fresh pipeline.`,
    );
  }
  // Sanity: the tool's id must match the phase id baked into state.
  if (state.currentPhase !== id) {
    return mcpError(
      "VALIDATION_FAILED",
      `cairn_init_run for phase ${id} requires state.currentPhase=${id}, got ${state.currentPhase}`,
    );
  }
  // The state's repoRoot drives the phase, but we sanity-check it
  // against the MCP context's repoRoot so a misaddressed call
  // (e.g. an old state file from a different repo) gets caught.
  if (state.repoRoot !== ctx.repoRoot) {
    return mcpError(
      "VALIDATION_FAILED",
      `state.repoRoot ${state.repoRoot} does not match MCP context ${ctx.repoRoot}`,
    );
  }
  // Splice the operator's answer into state for needs_input phases.
  const stateForRun: PhaseState =
    input.answer !== undefined && input.answer.length > 0
      ? { ...state, answer: input.answer }
      : state;

  const runner = RUNNERS[id];
  // Coarse-grained statusline coverage
  const isLongPhase =
    id === "3-mapper" || id === "9a-walker" || id === "9c-emit";
  if (!isLongPhase) {
    writeProgress(state.repoRoot, {
      phase: id,
      batch: 1,
      total: 1,
      startedAt: Date.now(),
    });
  }
  const t0 = performance.now();
  const result = await runner(stateForRun);
  const durationMs = Math.round(performance.now() - t0);
  clearProgress(state.repoRoot);
  // Stamp `duration_ms` on the phase's output entry
  if (result.status !== "error") {
    const phaseOut = result.state.outputs[id];
    if (typeof phaseOut === "object" && phaseOut !== null && !("duration_ms" in phaseOut)) {
      Object.assign(phaseOut, { duration_ms: durationMs });
    }
  }
  // Persist state ONLY on non-error results. Terminal completion
  // (nextPhase === null) clears the state file instead of writing —
  // adoption is done, so `.cairn/init-state.json` should disappear.
  // If left behind, the resume probe in the cairn-adopt skill +
  // SessionStart's renderMidAdoptionBanner classify the repo as
  // "mid-adoption" forever, re-prompting on every session even
  // though every phase succeeded.
  if (result.status !== "error") {
    const isTerminalComplete =
      result.status === "complete" && result.nextPhase === null;
    try {
      if (isTerminalComplete) {
        clearPhaseState(result.state.repoRoot);
      } else {
        writePhaseState(result.state);
      }
    } catch (err) {
      return mcpError(
        "INTERNAL_ERROR",
        `failed to ${isTerminalComplete ? "clear" : "persist"} init state: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return toSlim(result);
}

function makePhaseRunTool(): ToolDef<PhaseRunInput> {
  return {
    name: "cairn_init_run",
    description:
      "Run the next initialization phase. Call cairn_init_resume to find the next phase, then invoke this tool with that phase ID. Phase 8-docs-ingest and 10-rules-merge are no-op markers in v0.9.0 (the curator pipeline 9a-walker → 9b-curate → 9c-emit subsumes both); 10-rules-merge advances to 11-baseline. Phase 9b-curate is a skill-driven pseudo-phase: the cairn-adopt skill must dispatch curator-map + curator-reduce subagents and write .cairn/init/curator/final.jsonl before invoking it. The cairn-adopt skill loops on this tool until nextPhase === null.",
    inputSchema: phaseRunInput,
    handler: async (ctx, input) => {
      return handlePhaseRun(ctx, input.phase as PhaseId, input);
    },
  };
}

function makeResumeTool(): ToolDef<ResumeToolInput> {
  return {
    name: "cairn_init_resume",
    description:
      "Read the on-disk init state for the current repo and return the next phase to invoke. The cairn-adopt skill calls this once at the start of the pipeline (and after any operator interruption) to find where to pick up. Returns { status: 'ready' | 'done', nextPhase: PhaseId | null, repoRoot }. For a fresh start (no `.cairn/init-state.json`), the tool persists a fresh PhaseState to disk so the very next `cairn_init_run` call can read it back without the skill having to thread state through tool arguments.",
    inputSchema: initResumeInput,
    handler: async (ctx) => {
      const report = resumePhases(ctx.repoRoot);
      // For a fresh start, ensure state.repoRoot matches ctx.repoRoot
      // (resumePhases uses freshPhaseState(ctx.repoRoot) for this case).
      const stateForCtx =
        report.state.repoRoot !== ctx.repoRoot
          ? freshPhaseState(ctx.repoRoot)
          : report.state;
      // Persist fresh state to disk so the next `cairn_init_run` call
      // (which by SKILL.md contract omits the `state` arg) finds
      // something to read. Without this, the loop deadlocks at Phase
      // 1-detect with `VALIDATION_FAILED ... no init state at
      // .cairn/init-state.json` on every fresh adoption.
      const onDisk = readPhaseState(ctx.repoRoot);
      if (onDisk === null) {
        try {
          writePhaseState(stateForCtx);
        } catch (err) {
          return mcpError(
            "INTERNAL_ERROR",
            `failed to seed init state: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return {
        status: report.status,
        nextPhase: report.nextPhase,
        repoRoot: stateForCtx.repoRoot,
      };
    },
  };
}

export const initRunTool: ToolDef<PhaseRunInput> = makePhaseRunTool();
export const initResumeTool: ToolDef<ResumeToolInput> = makeResumeTool();

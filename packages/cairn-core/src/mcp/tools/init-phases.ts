/**
 * MCP tools for the v0.3.5 init pipeline.
 *
 * Twelve `cairn_init_phase_<id>` tools — one per PHASE_IDS entry —
 * plus `cairn_init_resume`. The cairn-adopt skill drives the
 * pipeline by:
 *   1. cairn_init_resume          → { status, nextPhase, repoRoot }
 *   2. cairn_init_phase_<next>()  → { status, nextPhase | question | error }
 *   3. AskUserQuestion if needs_input → re-call same tool with { answer }
 *   4. loop on complete + advance until nextPhase === null
 *
 * State persists to .cairn/init-state.json after every successful
 * phase result so the operator can crash-recover. The skill no longer
 * threads state through arguments — phase tools read state from disk
 * and only need an optional `answer` field for needs_input phases.
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
  clearProgress,
  freshPhaseState,
  readPhaseState,
  resumePhases,
  runPhase10Strip,
  runPhase12Multidev,
  runPhase1Detect,
  runPhase2Walker,
  runPhase3Mapper,
  runPhase3bSeed,
  runPhase4Pilot,
  runPhase5Brand,
  runPhase5bTopicIndex,
  runPhase6DocsIngest,
  runPhase7bSourceComments,
  runPhase7cRulesMerge,
  runPhase8Baseline,
  runPhases678Parallel,
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

const phaseIdEnum = z.enum(
  PHASE_IDS as unknown as [PhaseId, ...PhaseId[]],
);

const phaseStateSchema = z.object({
  repoRoot: z.string().min(1),
  currentPhase: phaseIdEnum,
  outputs: z.record(z.string(), z.unknown()),
  answer: z.string().optional(),
  startedAt: z.string().min(1),
  schemaVersion: z.literal(1),
});

const initPhaseInput = {
  // State is optional — phase tools read .cairn/init-state.json by
  // default. Callers can still pass an explicit state object (e.g.
  // smoke tests) but the cairn-adopt skill should pass nothing here.
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
  "3b-seed": runPhase3bSeed,
  "4-pilot": runPhase4Pilot,
  "5-brand": runPhase5Brand,
  "5b-topic-index": runPhase5bTopicIndex,
  "6-docs-ingest": runPhase6DocsIngest,
  "7b-source-comments": runPhase7bSourceComments,
  "7c-rules-merge": runPhase7cRulesMerge,
  "8-baseline": runPhase8Baseline,
  "10-strip": runPhase10Strip,
  "12-multidev": runPhase12Multidev,
};

interface PhaseToolInput {
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

function makePhaseTool(id: PhaseId): ToolDef<PhaseToolInput> {
  return {
    name: `cairn_init_phase_${normalizeId(id)}`,
    description: phaseDescription(id),
    inputSchema: initPhaseInput,
    handler: async (ctx, input) => {
      // Resolve state: prefer the explicit arg (smoke tests, debug
      // tooling), fall back to disk (cairn-adopt skill default).
      let state: PhaseState | null = input.state ?? null;
      if (state === null) {
        state = readPhaseState(ctx.repoRoot);
      }
      if (state === null) {
        return mcpError(
          "VALIDATION_FAILED",
          `cairn_init_phase_${normalizeId(id)} found no init state at .cairn/init-state.json. Call cairn_init_resume to start a fresh pipeline.`,
        );
      }
      // Sanity: the tool's id must match the phase id baked into state.
      if (state.currentPhase !== id) {
        return mcpError(
          "VALIDATION_FAILED",
          `cairn_init_phase_${normalizeId(id)} requires state.currentPhase=${id}, got ${state.currentPhase}`,
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
      // The runner clears `state.answer` once it has consumed it (via
      // `advancePhase`), so passing an answer to a phase that doesn't
      // expect one is a no-op rather than a hazard.
      const stateForRun: PhaseState =
        input.answer !== undefined && input.answer.length > 0
          ? { ...state, answer: input.answer }
          : state;
      const runner = RUNNERS[id];
      // Coarse-grained statusline coverage: every phase gets at least
      // one heartbeat write (batch=1, total=1) at entry so the operator
      // sees the current phase id mid-init even for fast phases. The
      // long phases (3-mapper, 6-docs-ingest, 7b-source-comments,
      // 7c-rules-merge) overwrite with finer-grained per-batch progress
      // from inside the runner. clearProgress at the end of every
      // phase ensures stale heartbeats don't survive into the next.
      const isLongPhase =
        id === "3-mapper" ||
        id === "6-docs-ingest" ||
        id === "7b-source-comments" ||
        id === "7c-rules-merge";
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
      // Stamp `duration_ms` on the phase's output entry so init-state.json
      // carries an ETA-auditable record for every phase, not just the ones
      // that bother to track time internally (3-mapper). The result.state
      // returned by the runner is freshly constructed; mutating its
      // current-phase entry is safe and doesn't ripple to prior phases.
      if (result.status !== "error") {
        const phaseOut = result.state.outputs[id];
        if (typeof phaseOut === "object" && phaseOut !== null) {
          const obj = phaseOut as Record<string, unknown>;
          if (obj["duration_ms"] === undefined) {
            obj["duration_ms"] = durationMs;
          }
        }
      }
      // Persist state ONLY on non-error results. An error path returns
      // the input state echo unchanged; persisting it would clobber
      // the on-disk state file with whatever shape the caller sent in
      // (in v0.3.4 a malformed state nuked a 90KB mapper run this way).
      if (result.status !== "error") {
        try {
          writePhaseState(result.state);
        } catch (err) {
          return mcpError(
            "INTERNAL_ERROR",
            `failed to persist init state: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // The state file lingers after terminal phase 12-multidev so the
      // cairn-adopt skill can read outputs for its final summary
      // banner. Cleanup is a manual concern (cairn doctor / re-init).
      return toSlim(result);
    },
  };
}

function makeResumeTool(): ToolDef<ResumeToolInput> {
  return {
    name: "cairn_init_resume",
    description:
      "Read the on-disk init state for the current repo and return the next phase to invoke. The cairn-adopt skill calls this once at the start of the pipeline (and after any operator interruption) to find where to pick up. Returns { status: 'ready' | 'done', nextPhase: PhaseId | null, repoRoot }.",
    inputSchema: initResumeInput,
    handler: async (ctx) => {
      const report = resumePhases(ctx.repoRoot);
      // For a fresh start, ensure state.repoRoot matches ctx.repoRoot
      // (resumePhases uses freshPhaseState(ctx.repoRoot) for this case).
      const repoRoot =
        report.state.repoRoot !== ctx.repoRoot
          ? freshPhaseState(ctx.repoRoot).repoRoot
          : report.state.repoRoot;
      return {
        status: report.status,
        nextPhase: report.nextPhase,
        repoRoot,
      };
    },
  };
}

function normalizeId(id: PhaseId): string {
  // Tool names go through MCP's allowed-character set — the dash in
  // "7b-source-comments" is fine but we underscore for consistency
  // with cairn_init_resume / cairn_record_decision conventions.
  return id.replace(/-/g, "_");
}

function phaseDescription(id: PhaseId): string {
  switch (id) {
    case "1-detect":
      return "Phase 1-detect — scan the project's environment + stack signatures. Always advances; no operator input.";
    case "2-walker":
      return "Phase 2-walker — build the repo summary (manifest previews, by-extension counts, framework signals). Always advances.";
    case "3-mapper":
      return "Phase 3-mapper — Sonnet-driven domain map (chunked across module slices). Long-running; no operator input.";
    case "3b-seed":
      return "Phase 3b-seed — write .cairn/ skeleton + config.yaml + scope-index from templates and mapper output. Always advances; no operator input.";
    case "4-pilot":
      return "Phase 4-pilot — operator picks the seed module from mapper's top candidates (1 question).";
    case "5-brand":
      return "Phase 5-brand — operator picks how to populate the brand DEC drafts: skip / auto-fill / manual (1 question).";
    case "5b-topic-index":
      return "Phase 5b-topic-index — cross-source dedup pre-pass. Walks docs/*.md + CLAUDE.md + AGENTS.md + .claude/rules/* and emits topic-index.yaml + anchor-map.yaml so phases 6/7b/7c can dedup-by-topic instead of one DEC per source.";
    case "6-docs-ingest":
      return "Phase 6-docs-ingest — Haiku batch over README + docs/ → DEC drafts + canonical-map topics. No operator input.";
    case "7b-source-comments":
      return "Phase 7b-source-comments — Haiku batch over docblock-class source comments → DEC drafts + invariant proposals.";
    case "7c-rules-merge":
      return "Phase 7c-rules-merge — Haiku batch over CLAUDE.md / AGENTS.md / .claude/rules/* → propose net-new rules + flag conflicts.";
    case "8-baseline":
      return "Phase 8-baseline — first sensor sweep against synthetic full-tree diff. No operator input.";
    case "10-strip":
      return "Phase 10-strip — per-module strip-replace consent for source-comment essays. Operator picks strip / keep / skip per flagged module.";
    case "12-multidev":
      return "Phase 12-multidev — detect per-host package manager(s) and emit JOIN.md hints for new contributors. No filesystem mutations. Idempotent.";
  }
}

/**
 * Combined parallel runner for the post-pilot ingestion window. Runs
 * phases 6-docs-ingest, 7b-source-comments, and 7c-rules-merge in
 * parallel inside a single MCP call. The cairn-adopt skill prefers
 * this tool when state.currentPhase=6-docs-ingest; the per-phase
 * sequential tools remain registered for fallback / debug paths.
 */
function makeParallel678Tool(): ToolDef<PhaseToolInput> {
  return {
    name: "cairn_init_phases_678_parallel",
    description:
      "Run phases 6-docs-ingest, 7b-source-comments, and 7c-rules-merge concurrently. Pre-scans existing DEC + INV ids and threads shared Sets through all three so id allocations don't collide. Returns the combined slim response with nextPhase=8-baseline. Skill prefers this when state.currentPhase=6-docs-ingest; the per-phase sequential tools stay available for fallback. Wall-clock saves the smaller-two phases' time on real-world adoptions.",
    inputSchema: initPhaseInput,
    handler: async (ctx, input) => {
      let state: PhaseState | null = input.state ?? null;
      if (state === null) {
        state = readPhaseState(ctx.repoRoot);
      }
      if (state === null) {
        return mcpError(
          "VALIDATION_FAILED",
          "cairn_init_phases_678_parallel found no init state at .cairn/init-state.json. Call cairn_init_resume to start a fresh pipeline.",
        );
      }
      if (state.currentPhase !== "6-docs-ingest") {
        return mcpError(
          "VALIDATION_FAILED",
          `cairn_init_phases_678_parallel requires state.currentPhase=6-docs-ingest, got ${state.currentPhase}`,
        );
      }
      if (state.repoRoot !== ctx.repoRoot) {
        return mcpError(
          "VALIDATION_FAILED",
          `state.repoRoot ${state.repoRoot} does not match MCP context ${ctx.repoRoot}`,
        );
      }
      const t0 = performance.now();
      const result = await runPhases678Parallel(state);
      const durationMs = Math.round(performance.now() - t0);
      if (result.status !== "error") {
        for (const id of ["6-docs-ingest", "7b-source-comments", "7c-rules-merge"] as const) {
          const phaseOut = result.state.outputs[id];
          if (typeof phaseOut === "object" && phaseOut !== null) {
            const obj = phaseOut as Record<string, unknown>;
            if (obj["duration_ms"] === undefined) {
              obj["duration_ms"] = durationMs;
            }
          }
        }
        try {
          writePhaseState(result.state);
        } catch (err) {
          return mcpError(
            "INTERNAL_ERROR",
            `failed to persist init state: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return toSlim(result);
    },
  };
}

export const initPhaseTools: ToolDef<PhaseToolInput>[] = PHASE_IDS.map(
  (id) => makePhaseTool(id),
);
export const initParallel678Tool: ToolDef<PhaseToolInput> = makeParallel678Tool();
export const initResumeTool: ToolDef<ResumeToolInput> = makeResumeTool();

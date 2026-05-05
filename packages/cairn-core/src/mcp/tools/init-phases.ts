/**
 * MCP tools for the v0.2.0 init pipeline.
 *
 * Eleven `cairn_init_phase_<id>` tools — one per PHASE_IDS entry —
 * plus `cairn_init_resume`. The cairn-adopt skill drives the
 * pipeline by:
 *   1. cairn_init_resume          → { nextPhase, state }
 *   2. cairn_init_phase_<next>    → { complete | needs_input | error, state }
 *   3. AskUserQuestion if needs_input → re-call same tool with state.answer
 *   4. loop on complete + advance until nextPhase === null
 *
 * State persists to .cairn/init-state.json after every phase result
 * (whether complete or needs_input) so the operator can crash-recover.
 */

import { z } from "zod";
import {
  PHASE_IDS,
  freshPhaseState,
  resumePhases,
  runPhase10Strip,
  runPhase12Multidev,
  runPhase1Detect,
  runPhase2Walker,
  runPhase3Mapper,
  runPhase3bSeed,
  runPhase4Pilot,
  runPhase5Brand,
  runPhase6DocsIngest,
  runPhase7bSourceComments,
  runPhase7cRulesMerge,
  runPhase8Baseline,
  writePhaseState,
  clearPhaseState,
  type PhaseId,
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
  state: phaseStateSchema,
};

const initResumeInput = {};

const RUNNERS: Record<PhaseId, (s: PhaseState) => Promise<PhaseResult>> = {
  "1-detect": runPhase1Detect,
  "2-walker": runPhase2Walker,
  "3-mapper": runPhase3Mapper,
  "3b-seed": runPhase3bSeed,
  "4-pilot": runPhase4Pilot,
  "5-brand": runPhase5Brand,
  "6-docs-ingest": runPhase6DocsIngest,
  "7b-source-comments": runPhase7bSourceComments,
  "7c-rules-merge": runPhase7cRulesMerge,
  "8-baseline": runPhase8Baseline,
  "10-strip": runPhase10Strip,
  "12-multidev": runPhase12Multidev,
};

interface PhaseToolInput {
  state: PhaseState;
}

interface ResumeToolInput {
  // empty
}

function makePhaseTool(id: PhaseId): ToolDef<PhaseToolInput> {
  return {
    name: `cairn_init_phase_${normalizeId(id)}`,
    description: phaseDescription(id),
    inputSchema: initPhaseInput,
    handler: async (ctx, input) => {
      // Sanity: the tool's id must match the phase id baked into state.
      if (input.state.currentPhase !== id) {
        return mcpError(
          "VALIDATION_FAILED",
          `cairn_init_phase_${normalizeId(id)} requires state.currentPhase=${id}, got ${input.state.currentPhase}`,
        );
      }
      // The state's repoRoot drives the phase, but we sanity-check it
      // against the MCP context's repoRoot so a misaddressed call
      // (e.g. an old state file from a different repo) gets caught.
      if (input.state.repoRoot !== ctx.repoRoot) {
        return mcpError(
          "VALIDATION_FAILED",
          `state.repoRoot ${input.state.repoRoot} does not match MCP context ${ctx.repoRoot}`,
        );
      }
      const runner = RUNNERS[id];
      const result = await runner(input.state);
      // Persist state after every phase result so the operator can
      // /exit Claude Code mid-init and resume on the next session.
      try {
        writePhaseState(result.state);
      } catch (err) {
        return mcpError(
          "OPERATION_TIMEOUT",
          `failed to persist init state: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Pipeline complete — clean up the state file so the next init
      // starts fresh rather than resuming.
      if (result.status === "complete" && result.nextPhase === null) {
        try {
          clearPhaseState(ctx.repoRoot);
        } catch {
          // best-effort cleanup
        }
      }
      return result;
    },
  };
}

function makeResumeTool(): ToolDef<ResumeToolInput> {
  return {
    name: "cairn_init_resume",
    description:
      "Read the on-disk init state for the current repo and return the next phase to invoke. The cairn-adopt skill calls this once at the start of the pipeline (and after any operator interruption) to find where to pick up. Returns { status: 'ready' | 'done', nextPhase: PhaseId | null, state: PhaseState }.",
    inputSchema: initResumeInput,
    handler: async (ctx) => {
      const report = resumePhases(ctx.repoRoot);
      // For a fresh start, ensure state.repoRoot matches ctx.repoRoot
      // (resumePhases uses freshPhaseState(ctx.repoRoot) for this case).
      if (report.state.repoRoot !== ctx.repoRoot) {
        return {
          ...report,
          state: { ...freshPhaseState(ctx.repoRoot), startedAt: report.state.startedAt },
        };
      }
      return report;
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
      return "Phase 12-multidev — install per-clone enforcement (git hooks + package.json prepare patch + .attested-commits seed). Idempotent.";
  }
}

export const initPhaseTools: ToolDef<PhaseToolInput>[] = PHASE_IDS.map(
  (id) => makePhaseTool(id),
);
export const initResumeTool: ToolDef<ResumeToolInput> = makeResumeTool();

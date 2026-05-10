/**
 * Mission roadmap drafting — Haiku call that turns a planning doc into
 * an ordered phase array. One LLM-cost touchpoint per mission
 * lifecycle. All subsequent phase advance / linking is deterministic.
 *
 * The model receives ONLY the spec doc + a tight system prompt; no
 * project ground state, no MCP tools, no ambient CLAUDE.md hierarchy.
 * `isolateAmbientContext: true` enforces that.
 */

import { runClaude } from "../claude/index.js";
import { logger } from "../logger.js";
import { z } from "zod";
import type { MissionPhase } from "@isaacriehm/cairn-state";

const log = logger("mission.draft");

const TIMEOUT_MS = 180_000;
const MAX_SPEC_CHARS = 60_000;
const MAX_PHASES = 24;

const SYSTEM_PROMPT = `You parse a software-project planning document into an ordered list of implementation phases.

Return STRICT JSON matching the schema. No prose, no markdown.

Phase rules:
- Each phase id is kebab-case, prefixed by an ordinal (e.g. "phase-1-schema", "phase-2-jwt"). Lowercase ASCII letters, digits, hyphens only.
- title is a tight noun-phrase summarizing the phase's deliverable (≤60 chars).
- depends_on lists prior phase ids that must complete before this phase starts. Empty array for the first phase.
- exit_criteria is one tight sentence describing the operator-verifiable end state of this phase. Cite concrete artifacts ("migration applied", "smoke green") not vague verbs ("works", "done").
- Maximum ${MAX_PHASES} phases. If the spec describes finer-grained sub-tasks, group them into phases.
- Linear or DAG, never cyclic. Every depends_on entry must be an earlier phase id.

Keep phase count tight — one phase per coherent deliverable, not one per file. The roadmap is the operator's mental map; pad it and you waste their attention.`;

const OUTPUT_SCHEMA = {
  type: "object",
  required: ["phases"],
  properties: {
    phases: {
      type: "array",
      minItems: 1,
      maxItems: MAX_PHASES,
      items: {
        type: "object",
        required: ["id", "title", "depends_on", "exit_criteria"],
        properties: {
          id: { type: "string", pattern: "^phase-[0-9]+-[a-z0-9-]+$" },
          title: { type: "string", minLength: 1, maxLength: 80 },
          depends_on: { type: "array", items: { type: "string" } },
          exit_criteria: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
    },
  },
} satisfies object;

const DraftResponseSchema = z.object({
  phases: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      depends_on: z.array(z.string()),
      exit_criteria: z.string(),
    }),
  ),
});

export interface DraftRoadmapArgs {
  repoRoot: string;
  spec: string;
  specPath: string;
}

export interface DraftRoadmapResult {
  phases: MissionPhase[];
  /** Char count of the spec slice actually fed to Haiku. */
  spec_chars_used: number;
  /** True when the spec was truncated to fit MAX_SPEC_CHARS. */
  truncated: boolean;
}

export async function draftRoadmapFromSpec(
  args: DraftRoadmapArgs,
): Promise<DraftRoadmapResult | null> {
  const truncated = args.spec.length > MAX_SPEC_CHARS;
  const slice = truncated ? args.spec.slice(0, MAX_SPEC_CHARS) : args.spec;
  const prompt = `Source planning document (${args.specPath}):\n\n${slice}\n\nReturn the phase array.`;

  let result;
  try {
    result = await runClaude({
      tier: "haiku",
      prompt,
      system: SYSTEM_PROMPT,
      jsonSchema: OUTPUT_SCHEMA,
      timeoutMs: TIMEOUT_MS,
      repoRoot: args.repoRoot,
      cacheable: false,
      isolateAmbientContext: true,
      purpose: "mission.draft",
    });
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "mission draft Haiku call failed",
    );
    return null;
  }

  const parsed = DraftResponseSchema.safeParse(result.parsed);
  if (!parsed.success) {
    log.warn(
      { error: parsed.error.message },
      "mission draft response failed schema",
    );
    return null;
  }

  const phases: MissionPhase[] = parsed.data.phases.map((p) => ({
    id: p.id,
    title: p.title,
    depends_on: p.depends_on,
    exit_criteria: p.exit_criteria,
  }));

  return {
    phases,
    spec_chars_used: slice.length,
    truncated,
  };
}

/**
 * Single-phase fallback used when `no_llm: true` or Haiku is offline.
 * Lets the operator hand-edit roadmap.md before approving.
 */
export function stubRoadmap(): MissionPhase[] {
  return [
    {
      id: "phase-1-todo",
      title: "Implement (single-phase stub)",
      depends_on: [],
      exit_criteria:
        "Operator hand-edits this phase list before accepting the draft.",
    },
  ];
}

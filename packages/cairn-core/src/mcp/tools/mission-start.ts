import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { findActiveMission } from "@isaacriehm/cairn-state";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { missionStartInput } from "../schemas.js";
import { draftRoadmapFromSpec, stubRoadmap } from "../../missions/index.js";
import type { ToolDef } from "./types.js";

interface Input {
  spec_path: string;
  exit_gate: "prompt" | "auto" | "manual";
  no_llm?: boolean;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  if (findActiveMission(ctx.repoRoot) !== null) {
    return mcpError(
      "MISSION_ALREADY_ACTIVE",
      "An active mission already exists. Close or abort it before starting another (one active mission per repo).",
    );
  }

  const absSpec = isAbsolute(input.spec_path)
    ? input.spec_path
    : resolve(ctx.repoRoot, input.spec_path);
  if (!absSpec.startsWith(ctx.repoRoot)) {
    return mcpError("PATH_OUTSIDE_REPO", `${input.spec_path} resolves outside the repo`);
  }
  if (!existsSync(absSpec)) {
    return mcpError("FILE_NOT_FOUND", `Spec doc not found: ${input.spec_path}`);
  }

  let source: string;
  try {
    source = readFileSync(absSpec, "utf8");
  } catch (err) {
    return mcpError(
      "INTERNAL_ERROR",
      `Failed to read spec doc: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const proposedTitle = deriveTitleFromSpec(source, input.spec_path);

  if (input.no_llm === true) {
    return {
      ok: true,
      proposed_title: proposedTitle,
      spec_path: input.spec_path,
      exit_gate: input.exit_gate,
      phases: stubRoadmap(),
      truncated: false,
      llm_used: false,
    };
  }

  const draft = await draftRoadmapFromSpec({
    repoRoot: ctx.repoRoot,
    spec: source,
    specPath: input.spec_path,
  });

  if (draft === null) {
    return mcpError(
      "MISSION_DRAFT_FAILED",
      "Haiku failed to parse the spec doc. Retry, or pass `no_llm: true` to write a single-phase stub roadmap and hand-edit it.",
    );
  }

  return {
    ok: true,
    proposed_title: proposedTitle,
    spec_path: input.spec_path,
    exit_gate: input.exit_gate,
    phases: draft.phases,
    truncated: draft.truncated,
    llm_used: true,
  };
}

/**
 * First H1 in the spec, or the spec's filename without extension.
 * Capped at 60 chars so the slug fits within the statusline budget.
 */
function deriveTitleFromSpec(source: string, fallback: string): string {
  const m = source.match(/^#\s+(.+?)\s*$/m);
  const raw = m?.[1] ?? fallback.replace(/^.*\//, "").replace(/\.[a-z]+$/i, "");
  return raw.slice(0, 60);
}

export const missionStartTool: ToolDef<Input> = {
  name: "cairn_mission_start",
  description:
    "Read a planning spec doc and draft a mission roadmap via Haiku. Returns the draft (proposed_title + ordered phases + spec_path + exit_gate) for operator approval. Does NOT write anything to disk; the caller invokes cairn_mission_accept_draft once the operator confirms. Pass `no_llm: true` to skip Haiku and return a single-phase stub.",
  inputSchema: missionStartInput,
  handler,
};

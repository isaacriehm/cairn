import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { missionStartInput } from "../schemas.js";
import { runMissionStart } from "../../missions/index.js";
import { mapMissionCliError } from "./mission-cli-error.js";
import type { ToolDef } from "./types.js";

interface Input {
  spec_path: string;
  exit_gate: "prompt" | "auto" | "manual";
  no_llm?: boolean;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  try {
    const result = await runMissionStart({
      repoRoot: ctx.repoRoot,
      specPath: input.spec_path,
      exitGate: input.exit_gate,
      ...(input.no_llm === true ? { noLlm: true } : {}),
    });
    return {
      ok: true,
      proposed_title: result.proposed_title,
      spec_path: result.spec_path,
      exit_gate: result.exit_gate,
      phases: result.phases,
      truncated: result.truncated,
      llm_used: result.llm_used,
    };
  } catch (err) {
    return mapMissionCliError(err);
  }
}

export const missionStartTool: ToolDef<Input> = {
  name: "cairn_mission_start",
  description:
    "Read a planning spec doc and draft a mission roadmap via Haiku. Returns the draft (proposed_title + ordered phases + spec_path + exit_gate) for operator approval. Does NOT write anything to disk; the caller invokes cairn_mission_accept_draft once the operator confirms. Pass `no_llm: true` to skip Haiku and return a single-phase stub.",
  inputSchema: missionStartInput,
  handler,
};

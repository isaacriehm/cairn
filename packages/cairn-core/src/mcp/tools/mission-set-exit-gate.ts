/**
 * `cairn_mission_set_exit_gate` — flip a mission's top-level exit gate
 * between `prompt`, `auto`, and `manual` without hand-editing the
 * roadmap.md frontmatter.
 *
 * Primary use case: operator says "execute this mission autonomously,
 * don't ask me between phases". The cairn-direction skill detects the
 * autonomy intent + checks `cairn_mission_get` for the current gate.
 * When the gate is `prompt`, the skill surfaces a one-time question:
 * "flip mission to auto?". On confirm, the skill calls this tool with
 * `{exit_gate: "auto"}`. The next `cairn_task_complete` no longer
 * blocks on phase boundaries — the cursor auto-advances silently.
 *
 * Server-side rewrite uses the same `readRoadmap` / `writeRoadmap`
 * helpers as the rest of the mission system so the frontmatter
 * stays schema-validated. Per-phase `exit_gate` overrides are
 * untouched — the operator can still pin individual phases to a
 * different gate after a flip.
 */

import {
  findActiveMission,
  readRoadmap,
  writeRoadmap,
  appendMissionJournal,
} from "@isaacriehm/cairn-state";
import { z } from "zod";

import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import type { ToolDef } from "./types.js";

const ExitGate = z.enum(["prompt", "auto", "manual"]);

export const missionSetExitGateInput = {
  exit_gate: ExitGate,
  mission_id: z.string().min(1).optional(),
};

interface Input {
  exit_gate: "prompt" | "auto" | "manual";
  mission_id?: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  const missionId = input.mission_id ?? findActiveMission(ctx.repoRoot);
  if (missionId === null) {
    return mcpError(
      "MISSION_NOT_FOUND",
      "No active mission and no mission_id provided.",
    );
  }

  let parsed;
  try {
    parsed = readRoadmap(ctx.repoRoot, missionId);
  } catch (err) {
    return mcpError(
      "INTERNAL_ERROR",
      `roadmap.md failed validation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null) {
    return mcpError(
      "MISSION_NOT_FOUND",
      `roadmap.md missing for mission ${missionId}.`,
    );
  }

  const previousGate = parsed.frontmatter.exit_gate;
  if (previousGate === input.exit_gate) {
    return {
      ok: true,
      mission_id: missionId,
      exit_gate: input.exit_gate,
      changed: false,
      message: `exit_gate already \`${input.exit_gate}\` — no change.`,
    };
  }

  const updated = {
    ...parsed.frontmatter,
    exit_gate: input.exit_gate,
  };
  writeRoadmap(ctx.repoRoot, missionId, updated, parsed.prose);

  appendMissionJournal(ctx.repoRoot, missionId, {
    ts: new Date().toISOString(),
    kind: "exit-gate-changed",
    detail: `${previousGate} → ${input.exit_gate}`,
  });

  return {
    ok: true,
    mission_id: missionId,
    exit_gate: input.exit_gate,
    previous_exit_gate: previousGate,
    changed: true,
  };
}

export const missionSetExitGateTool: ToolDef<Input> = {
  name: "cairn_mission_set_exit_gate",
  description:
    "Flip a mission's top-level `exit_gate` between `prompt` (default — `cairn_task_complete` blocks at phase boundaries with `AskUserQuestion`), `auto` (cursor advances silently, model self-chains via `next_action_hint`), or `manual` (no auto-advance; operator runs `cairn_mission_advance`). Use after detecting an autonomy intent in the operator's prompt — call once, the change persists across sessions via roadmap.md. `mission_id` defaults to the active mission. Returns `{ok, exit_gate, previous_exit_gate, changed}`; `changed: false` when the gate already matched the requested value. Per-phase `exit_gate` overrides on individual phases are not touched.",
  inputSchema: missionSetExitGateInput,
  handler,
};

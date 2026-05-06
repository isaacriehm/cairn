/**
 * `cairn_bulk_accept_attention` MCP tool.
 *
 * Wraps `bulkAcceptObvious` so the cairn-attention skill can drain
 * obvious DEC drafts in one tool call instead of N rounds of
 * `cairn_resolve_attention(choice="a")` per draft. Loads the project
 * globs + pilot module from `.cairn/config.yaml` so the scoring
 * heuristic has the same context the cli subcommand does.
 *
 * Returns a slim count-distribution shape — no draft bodies, no file
 * paths beyond the accepted ID list. Skill renders the summary inline,
 * then proceeds to interactive triage of the remaining (medium + low)
 * drafts via the existing per-item flow.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  bulkAcceptObvious,
  type BulkAcceptResult,
  type DraftConfidence,
} from "../../attention/index.js";
import type { ProjectGlobs } from "../../sensors/types.js";
import type { McpContext } from "../context.js";
import type { ToolDef } from "./types.js";

const confidenceSchema = z.enum(["high", "medium", "low"]);

const inputShape = {
  threshold: confidenceSchema.optional(),
  dryRun: z.boolean().optional(),
};

interface BulkAcceptInput {
  threshold?: DraftConfidence;
  dryRun?: boolean;
}

function loadProjectGlobs(repoRoot: string): {
  globs: ProjectGlobs;
  pilotModule?: string;
} {
  const configPath = join(repoRoot, ".cairn", "config.yaml");
  if (!existsSync(configPath)) {
    return { globs: {} };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(configPath, "utf8"));
  } catch {
    return { globs: {} };
  }
  if (typeof parsed !== "object" || parsed === null) return { globs: {} };
  const cfg = parsed as Record<string, unknown>;
  const globs: ProjectGlobs = {};
  const pickList = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    return v.filter((x): x is string => typeof x === "string");
  };
  const high = pickList(cfg["high_stakes_globs"]);
  if (high !== undefined) globs.high_stakes_globs = high;
  const off = pickList(cfg["off_limits"]);
  if (off !== undefined) globs.off_limits = off;
  const projectGlobs = cfg["project_globs"];
  if (typeof projectGlobs === "object" && projectGlobs !== null) {
    const pg = projectGlobs as Record<string, unknown>;
    const route = pickList(pg["route_handler_globs"]);
    if (route !== undefined) globs.route_handler_globs = route;
    const dto = pickList(pg["dto_globs"]);
    if (dto !== undefined) globs.dto_globs = dto;
    const gen = pickList(pg["generator_source_globs"]);
    if (gen !== undefined) globs.generator_source_globs = gen;
    const hi = pickList(pg["high_stakes_globs"]);
    if (hi !== undefined && globs.high_stakes_globs === undefined) {
      globs.high_stakes_globs = hi;
    }
  }
  const pilot =
    typeof cfg["pilot_module"] === "string" ? (cfg["pilot_module"] as string) : undefined;
  return pilot !== undefined ? { globs, pilotModule: pilot } : { globs };
}

export const bulkAcceptAttentionTool: ToolDef<BulkAcceptInput> = {
  name: "cairn_bulk_accept_attention",
  description:
    "Score every DEC draft + invariant in `.cairn/ground/decisions/_inbox/` and `.cairn/ground/invariants/` against a confidence heuristic (file in high_stakes_globs / pilot module / route or dto globs, prose substantiveness, decision verbs, JSDoc tags). Auto-promote DEC drafts at or above `threshold` (default 'high') out of the inbox to accepted state and rebuild the decisions ledger. Stamp `capture_confidence` on every draft + invariant so subsequent attention surfaces can sort. Use this once per adoption to drain the obvious classifications before per-item triage. Returns count distributions and the accepted ID list. `dryRun: true` reports the same distribution without writing.",
  inputSchema: inputShape,
  handler: async (
    ctx: McpContext,
    input: BulkAcceptInput,
  ): Promise<BulkAcceptResult> => {
    const { globs, pilotModule } = loadProjectGlobs(ctx.repoRoot);
    return bulkAcceptObvious({
      repoRoot: ctx.repoRoot,
      globs,
      ...(pilotModule !== undefined ? { pilotModule } : {}),
      threshold: input.threshold ?? "high",
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
    });
  },
};

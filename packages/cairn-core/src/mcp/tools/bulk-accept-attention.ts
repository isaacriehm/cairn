/**
 * `cairn_bulk_accept_attention` MCP tool.
 *
 * Wraps `bulkAcceptObvious` so the cairn-attention skill can drain
 * obvious DEC drafts in one tool call instead of N rounds of
 * `cairn_resolve_attention(choice="a")` per draft. Loads the project
 * globs from `.cairn/config.yaml` so the scoring
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

const ConfigSchema = z.object({
  project_globs: z.object({
    route_handler_globs: z.array(z.string()).optional(),
    dto_globs: z.array(z.string()).optional(),
    generator_source_globs: z.array(z.string()).optional(),
    high_stakes_globs: z.array(z.string()).optional(),
  }).optional(),
  high_stakes_globs: z.array(z.string()).optional(),
  off_limits: z.array(z.string()).optional(),
}).passthrough();

function loadProjectGlobs(repoRoot: string): { globs: ProjectGlobs } {
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
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) return { globs: {} };

  const cfg = result.data;
  const globs: ProjectGlobs = {};
  if (cfg.high_stakes_globs) globs.high_stakes_globs = cfg.high_stakes_globs;
  if (cfg.off_limits) globs.off_limits = cfg.off_limits;

  const pg = cfg.project_globs;
  if (pg !== undefined) {
    if (pg.route_handler_globs) globs.route_handler_globs = pg.route_handler_globs;
    if (pg.dto_globs) globs.dto_globs = pg.dto_globs;
    if (pg.generator_source_globs) globs.generator_source_globs = pg.generator_source_globs;
    if (pg.high_stakes_globs && globs.high_stakes_globs === undefined) {
      globs.high_stakes_globs = pg.high_stakes_globs;
    }
  }

  return { globs };
}

export const bulkAcceptAttentionTool: ToolDef<BulkAcceptInput> = {
  name: "cairn_bulk_accept_attention",
  description:
    "Score every DEC draft + invariant in `.cairn/ground/decisions/_inbox/` and `.cairn/ground/invariants/` against a confidence heuristic (file in high_stakes_globs / route or dto globs, prose substantiveness, decision verbs, JSDoc tags). Auto-promote DEC drafts at or above `threshold` (default 'high') out of the inbox to accepted state and rebuild the decisions ledger. Stamp `capture_confidence` on every draft + invariant so subsequent attention surfaces can sort. Use this once per adoption to drain the obvious classifications before per-item triage. Returns count distributions and the accepted ID list. `dryRun: true` reports the same distribution without writing.",
  inputSchema: inputShape,
  handler: async (
    ctx: McpContext,
    input: BulkAcceptInput,
  ): Promise<BulkAcceptResult> => {
    const { globs } = loadProjectGlobs(ctx.repoRoot);
    return bulkAcceptObvious({
      repoRoot: ctx.repoRoot,
      globs,
      threshold: input.threshold ?? "high",
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
    });
  },
};

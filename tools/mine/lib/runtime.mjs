// Shared op runtime — resolve flags → stream JSONLs → project → filter.

import { homedir } from "node:os";
import { resolveJsonlPaths, streamEvents } from "./parse.mjs";
import { projectEvent } from "./project.mjs";
import { resolveTruncate } from "./args.mjs";

const DEFAULT_GLOB = `${homedir()}/.claude/projects/**/*.jsonl`;

/**
 * @typedef {object} OpContext
 * @property {string[]} sources
 * @property {{total_lines:number, parsed:number, skipped:number}} parseStats
 * @property {import("./types.mjs").TruncatePolicy} policy
 * @property {Record<string, unknown>} args
 * @property {(ev: import("./types.mjs").ProjectedEvent) => boolean} filter
 * @property {string} format
 * @property {number} limit
 */

/**
 * Resolve sources + filters + policy from CLI args.
 * @param {Record<string, unknown>} args
 * @param {{default_limit?: number}} opts
 * @returns {Promise<OpContext>}
 */
export async function buildContext(args, opts = {}) {
  const sources = await resolveJsonlPaths(
    { jsonl: args.jsonl, jsonl_glob: args["jsonl-glob"] },
    DEFAULT_GLOB,
  );
  const policy = await resolveTruncate(args);
  const filter = buildFilter(args);
  const format = (args.format ?? "md") === "ndjson" ? "ndjson" : "md";
  const limit = parseLimit(args.limit, opts.default_limit ?? 0);
  return {
    sources,
    parseStats: { total_lines: 0, parsed: 0, skipped: 0 },
    policy,
    args,
    filter,
    format,
    limit,
  };
}

function parseLimit(v, fallback) {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Build a filter closure that:
 *   - applies session, time, errors-only filters statelessly
 *   - applies --tool filter with stateful tool_use_id passthrough so
 *     paired tool_result events for kept tool_use calls survive
 *     (without this, histogram/errors saw zero `results` per filtered
 *     tool because tool_result events have no `tool` field of their own)
 * @param {Record<string, unknown>} args
 */
function buildFilter(args) {
  const sessions = new Set(toArray(args.session));
  const tools = new Set(toArray(args.tool));
  const since = args.since ? Date.parse(String(args.since)) : null;
  const until = args.until ? Date.parse(String(args.until)) : null;
  const errorsOnly = args["errors-only"] === true;
  const includeMeta = args["include-meta"] === true;
  // tool_use_id -> kept (true). Lets paired tool_result events through.
  const keptToolUseIds = new Set();
  return (ev) => {
    if (!includeMeta && (ev.kind === "snapshot" || ev.kind === "attachment")) return false;
    if (sessions.size > 0 && !sessions.has(ev.session_id)) return false;
    if (tools.size > 0) {
      if (ev.kind === "tool_use") {
        if (!tools.has(ev.tool)) return false;
        if (ev.tool_use_id) keptToolUseIds.add(ev.tool_use_id);
      } else if (ev.kind === "tool_result") {
        if (!ev.tool_use_id || !keptToolUseIds.has(ev.tool_use_id)) return false;
      } else {
        // Non-tool events (user/assistant text, system, thinking) drop
        // when --tool is active. Op-side aggregators (histogram, errors)
        // only need tool_use + tool_result pairs.
        return false;
      }
    }
    if (since != null && ev.ts && Date.parse(ev.ts) < since) return false;
    if (until != null && ev.ts && Date.parse(ev.ts) >= until) return false;
    if (errorsOnly) {
      const isErr = (ev.kind === "tool_result" && ev.is_error) ||
        (ev.kind === "system" && ev.hook_errors?.length);
      if (!isErr) return false;
    }
    return true;
  };
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Stream every event across every source, project it, apply the filter,
 * and yield. Caller handles limit + output formatting.
 * @param {OpContext} ctx
 * @returns {AsyncGenerator<import("./types.mjs").ProjectedEvent>}
 */
export async function* iterate(ctx) {
  for (const src of ctx.sources) {
    for await (const raw of streamEvents(src, { result: ctx.parseStats })) {
      for (const ev of projectEvent(raw, ctx.policy)) {
        if (ctx.filter(ev)) yield ev;
      }
    }
  }
}

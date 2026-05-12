// `errors` op — extract errors + their initiating tool_use + brief context.
// Pairs every tool_result with is_error=true to its tool_use by id, and
// reports the input + the error text. Also surfaces hook_errors from
// system events.

import { buildContext, iterate } from "../runtime.mjs";
import { shortToolName } from "../enrich.mjs";

export const USAGE = `
mine errors — error events with initiating tool + context

Flags:
  --jsonl <path> | --jsonl-glob <pattern>   sources
  --session <id>                            limit to one session
  --tool NAME                               filter to specific tools
  --since ISO --until ISO                   time window
  --repo <path>                             filter sessions by cwd prefix
  --format md|ndjson                        default md
  --limit N                                 cap errors emitted (default 30)
  --head N --tail N                         truncation (defaults: 200/200)
  --full text|args|result|all               disable truncation
  --include patterns                        also emit pattern aggregation
`.trimStart();

export async function run(args) {
  const ctx = await buildContext(args, { default_limit: 30 });
  const repoPrefix = args.repo ? String(args.repo) : null;
  const includePatterns = toArr(args.include).includes("patterns");

  /** @type {Map<string, {tool:string, args?:Record<string,unknown>, edit?:Record<string,unknown>, ts?:string, cwd?:string, session_id:string, uuid?:string}>} */
  const inflight = new Map();
  /** @type {ErrorRow[]} */
  const errors = [];
  /** @type {Map<string, number>} */
  const patterns = new Map();

  for await (const ev of iterate(ctx)) {
    if (repoPrefix && ev.cwd && !ev.cwd.startsWith(repoPrefix)) continue;
    if (ev.kind === "tool_use") {
      inflight.set(ev.tool_use_id, {
        tool: ev.tool,
        args: ev.args,
        edit: ev.edit,
        ts: ev.ts,
        cwd: ev.cwd,
        session_id: ev.session_id,
        uuid: ev.uuid,
      });
    } else if (ev.kind === "tool_result" && ev.is_error) {
      const linked = inflight.get(ev.tool_use_id ?? "");
      const row = {
        session_id: ev.session_id,
        ts: ev.ts ?? linked?.ts,
        cwd: ev.cwd ?? linked?.cwd,
        tool: linked?.tool ?? "(unknown)",
        tool_use_id: ev.tool_use_id,
        args: linked?.args,
        edit: linked?.edit,
        error_text: ev.result_text,
        pattern: extractPattern(ev.result_text),
      };
      errors.push(row);
      if (row.pattern) patterns.set(row.pattern, (patterns.get(row.pattern) ?? 0) + 1);
      if (linked) inflight.delete(ev.tool_use_id);
    } else if (ev.kind === "system" && ev.hook_errors?.length) {
      for (const e of ev.hook_errors) {
        const row = {
          session_id: ev.session_id,
          ts: ev.ts,
          cwd: ev.cwd,
          tool: "(hook)",
          tool_use_id: undefined,
          args: undefined,
          edit: undefined,
          error_text: e,
          pattern: extractPattern(e),
        };
        errors.push(row);
        if (row.pattern) patterns.set(row.pattern, (patterns.get(row.pattern) ?? 0) + 1);
      }
    }
  }

  const limit = ctx.limit > 0 ? ctx.limit : errors.length;
  const sliced = errors.slice(0, limit);

  if (ctx.format === "ndjson") {
    for (const r of sliced) process.stdout.write(JSON.stringify(r) + "\n");
    if (includePatterns) {
      for (const [p, n] of patterns) process.stdout.write(JSON.stringify({ kind: "pattern", pattern: p, count: n }) + "\n");
    }
    return;
  }

  const out = [];
  out.push("# cairn-mine errors");
  out.push(`_sources: ${ctx.sources.length} file(s) · ${ctx.parseStats.parsed} parsed · ${errors.length} error(s) · showing ${sliced.length}_`);
  out.push("");
  if (includePatterns && patterns.size > 0) {
    out.push("## patterns");
    out.push(`| pattern | count |`);
    out.push(`| --- | ---: |`);
    for (const [p, n] of [...patterns.entries()].sort((a, b) => b[1] - a[1])) {
      out.push(`| \`${p}\` | ${n} |`);
    }
    out.push("");
  }
  out.push("## errors");
  for (const r of sliced) {
    out.push(`### \`${shortToolName(r.tool)}\` — ${shortTs(r.ts)} — \`${r.session_id}\``);
    if (r.cwd) out.push(`- repo: \`${r.cwd}\``);
    if (r.edit) out.push(`- target: \`${r.edit.path}\` (${r.edit.kind})`);
    if (r.args && !r.edit) {
      const argsBrief = Object.entries(r.args).slice(0, 5).map(([k, v]) => `${k}=${truncLine(typeof v === "string" ? v : JSON.stringify(v))}`).join(", ");
      if (argsBrief) out.push(`- args: ${argsBrief}`);
    }
    out.push("");
    out.push("```");
    out.push(String(r.error_text ?? "(no error text)"));
    out.push("```");
    out.push("");
  }
  process.stdout.write(out.join("\n"));
}

/**
 * @typedef {{session_id:string, ts?:string, cwd?:string, tool:string, tool_use_id?:string, args?:Record<string,unknown>, edit?:Record<string,unknown>, error_text?:string, pattern?:string}} ErrorRow
 */

// Heuristic pattern extraction — strip variable bits, keep the shape.
function extractPattern(s) {
  if (typeof s !== "string" || s.length === 0) return undefined;
  // Take the first line, drop file paths, line numbers, ids.
  let first = s.split("\n").find((l) => l.trim().length > 0) ?? s;
  first = first
    .replace(/\/[\w\-./ ]+/g, "<path>")
    .replace(/\b[0-9a-f]{6,}\b/g, "<hash>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  if (first.length > 160) first = first.slice(0, 150) + "…";
  return first;
}

function shortTs(ts) {
  if (!ts) return "?";
  try {
    return new Date(ts).toISOString().slice(0, 19) + "Z";
  } catch {
    return ts;
  }
}

function truncLine(s) {
  if (s == null) return "";
  const str = String(s).replace(/\s+/g, " ").trim();
  return str.length > 80 ? str.slice(0, 70) + "…" : str;
}

function toArr(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

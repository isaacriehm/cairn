// `histogram` op — per-tool counts, token totals, failure rate.
// Aggregates across every supplied source unless --session restricts.

import { buildContext, iterate } from "../runtime.mjs";
import { shortToolName } from "../enrich.mjs";

export const USAGE = `
mine histogram — per-tool counts + tokens + failure rate

Flags:
  --jsonl <path> | --jsonl-glob <pattern>   sources
  --session <id>                            limit to one session
  --since ISO --until ISO                   time window
  --tool NAME                               include only these (repeatable)
  --repo <path>                             filter sessions by cwd prefix
  --format md|ndjson                        default md
  --limit N                                 top N tools (default 20; 0 = all)
  --sort calls|errors|tok_out|err_rate      default calls
  --include sessions                        also include per-session aggregate
`.trimStart();

export async function run(args) {
  const ctx = await buildContext(args, { default_limit: 20 });
  const repoPrefix = args.repo ? String(args.repo) : null;
  const includeSessions = toArr(args.include).includes("sessions");

  /** @type {Map<string, ToolStat>} */
  const byTool = new Map();
  /** @type {Map<string, SessionStat>} */
  const bySession = new Map();
  /** @type {Map<string, {tool: string, ts?: string}>} */
  const inflight = new Map();

  for await (const ev of iterate(ctx)) {
    if (repoPrefix && ev.cwd && !ev.cwd.startsWith(repoPrefix)) continue;

    const sess = sessionStat(bySession, ev);

    if (ev.kind === "tool_use") {
      inflight.set(ev.tool_use_id, { tool: ev.tool, ts: ev.ts });
      const s = toolStat(byTool, ev.tool);
      s.calls += 1;
      s.tok_out += ev.tok_out ?? 0;
      s.tok_in += ev.tok_in ?? 0;
      sess.tool_calls += 1;
    }
    if (ev.kind === "tool_result") {
      const linked = inflight.get(ev.tool_use_id ?? "");
      if (linked) {
        const s = toolStat(byTool, linked.tool);
        s.results += 1;
        if (ev.is_error) {
          s.errors += 1;
          sess.errors += 1;
        }
        inflight.delete(ev.tool_use_id);
      }
    }
    if (ev.kind === "assistant_text" || ev.kind === "tool_use") {
      sess.tok_in_total += ev.tok_in ?? 0;
      sess.tok_out_total += ev.tok_out ?? 0;
    }
  }

  let rows = [...byTool.entries()].map(([tool, s]) => ({
    tool,
    short: shortToolName(tool),
    ...s,
    err_rate: s.results > 0 ? s.errors / s.results : 0,
  }));

  rows.sort(sorterFor(String(args.sort ?? "calls")));
  if (ctx.limit > 0) rows = rows.slice(0, ctx.limit);

  if (ctx.format === "ndjson") {
    for (const r of rows) process.stdout.write(JSON.stringify(r) + "\n");
    if (includeSessions) {
      for (const s of bySession.values()) process.stdout.write(JSON.stringify({ kind: "session", ...s }) + "\n");
    }
    return;
  }

  const out = [];
  out.push("# cairn-mine histogram");
  out.push(`_sources: ${ctx.sources.length} file(s) · ${ctx.parseStats.parsed} parsed · ${ctx.parseStats.skipped} skipped_`);
  out.push("");
  out.push(`| tool | calls | results | errors | err% | tok_in | tok_out |`);
  out.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const r of rows) {
    const pct = (r.err_rate * 100).toFixed(1);
    out.push(`| \`${r.short}\` | ${r.calls} | ${r.results} | ${r.errors} | ${pct}% | ${r.tok_in} | ${r.tok_out} |`);
  }
  out.push("");
  if (includeSessions) {
    out.push("## sessions");
    out.push(`| session | tool_calls | errors | tok_in | tok_out |`);
    out.push(`| --- | ---: | ---: | ---: | ---: |`);
    for (const s of bySession.values()) {
      out.push(`| \`${s.session_id}\` | ${s.tool_calls} | ${s.errors} | ${s.tok_in_total} | ${s.tok_out_total} |`);
    }
  }
  process.stdout.write(out.join("\n") + "\n");
}

/**
 * @typedef {{calls:number, results:number, errors:number, tok_in:number, tok_out:number}} ToolStat
 * @typedef {{session_id:string, tool_calls:number, errors:number, tok_in_total:number, tok_out_total:number, cwd?:string, git_branch?:string}} SessionStat
 */
function toolStat(map, tool) {
  let s = map.get(tool);
  if (!s) {
    s = { calls: 0, results: 0, errors: 0, tok_in: 0, tok_out: 0 };
    map.set(tool, s);
  }
  return s;
}

function sessionStat(map, ev) {
  let s = map.get(ev.session_id);
  if (!s) {
    s = { session_id: ev.session_id, tool_calls: 0, errors: 0, tok_in_total: 0, tok_out_total: 0 };
    map.set(ev.session_id, s);
  }
  if (ev.cwd && !s.cwd) s.cwd = ev.cwd;
  if (ev.git_branch && !s.git_branch) s.git_branch = ev.git_branch;
  return s;
}

function sorterFor(key) {
  switch (key) {
    case "errors": return (a, b) => b.errors - a.errors;
    case "tok_out": return (a, b) => b.tok_out - a.tok_out;
    case "err_rate": return (a, b) => b.err_rate - a.err_rate;
    case "calls":
    default: return (a, b) => b.calls - a.calls;
  }
}

function toArr(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

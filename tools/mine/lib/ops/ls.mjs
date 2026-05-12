// `ls` op — list sessions present in the supplied JSONLs.
// Default scope: every JSONL under ~/.claude/projects/.
//
// Aggregates per session:
//   session_id, source_path, first_ts, last_ts, n_events,
//   tool_use_count, error_count, git_branch, cwd, ai_title,
//   first_user_prompt, last_assistant_text

import { resolveJsonlPaths, streamEvents } from "../parse.mjs";
import { projectEvent } from "../project.mjs";
import { DEFAULT_TRUNCATE } from "../types.mjs";
import { homedir } from "node:os";

const DEFAULT_GLOB = `${homedir()}/.claude/projects/**/*.jsonl`;

export const USAGE = `
mine ls — list sessions

Flags:
  --jsonl <path>          One transcript. Repeatable.
  --jsonl-glob <pattern>  Glob. Default: ${DEFAULT_GLOB}
  --repo <path>           Filter to sessions whose cwd starts with <path>
  --since ISO --until ISO Time window
  --format md|ndjson      Default md
  --limit N               Cap rows. Default 50 (md) / unlimited (ndjson)
  --sort first|last|events|errors|tools  Default: last desc
`.trimStart();

export async function run(args) {
  const sources = await resolveJsonlPaths(
    { jsonl: args.jsonl, jsonl_glob: args["jsonl-glob"] },
    DEFAULT_GLOB,
  );
  const repoFilter = args.repo ? String(args.repo) : null;
  const since = args.since ? Date.parse(String(args.since)) : null;
  const until = args.until ? Date.parse(String(args.until)) : null;
  const sort = String(args.sort ?? "last");
  const format = args.format === "ndjson" ? "ndjson" : "md";
  const limit = parseInt(args.limit ?? (format === "md" ? 50 : 0), 10) || 0;

  /** @type {Map<string, ReturnType<typeof emptyRow>>} */
  const bySession = new Map();
  const parseStats = { total_lines: 0, parsed: 0, skipped: 0 };

  for (const src of sources) {
    for await (const raw of streamEvents(src, { result: parseStats })) {
      const projs = projectEvent(raw, DEFAULT_TRUNCATE);
      for (const ev of projs) {
        if (!ev.session_id) continue;
        let row = bySession.get(ev.session_id);
        if (!row) {
          row = emptyRow(ev.session_id, src);
          bySession.set(ev.session_id, row);
        }
        ingest(row, ev);
      }
    }
  }

  /** @type {ReturnType<typeof emptyRow>[]} */
  let rows = [...bySession.values()];

  if (repoFilter) rows = rows.filter((r) => (r.cwd ?? "").startsWith(repoFilter));
  if (since != null) rows = rows.filter((r) => !r.last_ts || Date.parse(r.last_ts) >= since);
  if (until != null) rows = rows.filter((r) => !r.first_ts || Date.parse(r.first_ts) < until);

  rows.sort((a, b) => sortKey(b, sort) - sortKey(a, sort));
  if (limit > 0) rows = rows.slice(0, limit);

  if (format === "ndjson") {
    for (const r of rows) process.stdout.write(JSON.stringify(r) + "\n");
    return;
  }

  process.stdout.write(renderMd(rows, sources, parseStats));
}

function emptyRow(session_id, source) {
  return {
    session_id,
    source,
    first_ts: undefined,
    last_ts: undefined,
    n_events: 0,
    tool_use_count: 0,
    error_count: 0,
    git_branch: undefined,
    cwd: undefined,
    cc_version: undefined,
    ai_title: undefined,
    first_user_prompt: undefined,
    last_assistant_text: undefined,
    tools: /** @type {Record<string, number>} */ ({}),
    tok_in_total: 0,
    tok_out_total: 0,
  };
}

function ingest(row, ev) {
  row.n_events += 1;
  if (ev.ts) {
    if (!row.first_ts || ev.ts < row.first_ts) row.first_ts = ev.ts;
    if (!row.last_ts || ev.ts > row.last_ts) row.last_ts = ev.ts;
  }
  if (ev.cwd && !row.cwd) row.cwd = ev.cwd;
  if (ev.git_branch && !row.git_branch) row.git_branch = ev.git_branch;
  if (ev.cc_version && !row.cc_version) row.cc_version = ev.cc_version;
  if (ev.tok_in) row.tok_in_total += ev.tok_in;
  if (ev.tok_out) row.tok_out_total += ev.tok_out;
  if (ev.kind === "tool_use") {
    row.tool_use_count += 1;
    row.tools[ev.tool] = (row.tools[ev.tool] ?? 0) + 1;
  }
  if (ev.kind === "tool_result" && ev.is_error) row.error_count += 1;
  if (ev.kind === "system" && Array.isArray(ev.hook_errors) && ev.hook_errors.length > 0) row.error_count += 1;
  if (ev.kind === "title" && !row.ai_title) row.ai_title = ev.text;
  if (ev.kind === "user_text" && !row.first_user_prompt) row.first_user_prompt = ev.text;
  if (ev.kind === "assistant_text") row.last_assistant_text = ev.text;
}

function sortKey(r, sort) {
  switch (sort) {
    case "first":
      return r.first_ts ? Date.parse(r.first_ts) : 0;
    case "events":
      return r.n_events;
    case "errors":
      return r.error_count;
    case "tools":
      return r.tool_use_count;
    case "last":
    default:
      return r.last_ts ? Date.parse(r.last_ts) : 0;
  }
}

function renderMd(rows, sources, parseStats) {
  const lines = [];
  lines.push("# cairn-mine ls");
  lines.push(`_sources: ${sources.length} file(s) · ${parseStats.parsed} parsed · ${parseStats.skipped} skipped · ${rows.length} session(s)_`);
  lines.push("");
  for (const r of rows) {
    const title = r.ai_title ?? r.first_user_prompt ?? "(no title)";
    const top3 = Object.entries(r.tools).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}×${v}`).join(", ");
    lines.push(`## \`${r.session_id}\``);
    lines.push(`- title: ${truncLine(title)}`);
    lines.push(`- ${r.first_ts ?? "?"} → ${r.last_ts ?? "?"}`);
    lines.push(`- ${r.n_events} events · ${r.tool_use_count} tool_use · ${r.error_count} errors · tok ${r.tok_in_total}/${r.tok_out_total}`);
    lines.push(`- repo: \`${r.cwd ?? "?"}\` · branch: \`${r.git_branch ?? "?"}\` · cc: \`${r.cc_version ?? "?"}\``);
    if (top3) lines.push(`- top tools: ${top3}`);
    lines.push(`- source: \`${r.source}\``);
    lines.push("");
  }
  return lines.join("\n");
}

function truncLine(s) {
  if (s == null) return "";
  const str = String(s).replace(/\s+/g, " ").trim();
  return str.length > 160 ? str.slice(0, 150) + "…" : str;
}

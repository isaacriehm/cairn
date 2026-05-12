// Output formatters. Two modes:
//   md     — markdown for AI context (default)
//   ndjson — machine-readable, one JSON per line

import { shortToolName } from "./enrich.mjs";

/**
 * @param {import("./types.mjs").ProjectedEvent} ev
 */
export function ndjson(ev) {
  return JSON.stringify(ev);
}

/**
 * Single-line markdown row. Compact for timeline rendering.
 * @param {import("./types.mjs").ProjectedEvent} ev
 */
export function mdRow(ev) {
  const ts = ev.ts ? `\`${shortTs(ev.ts)}\`` : "`?`";
  switch (ev.kind) {
    case "user_text":
      return `${ts} **user** ${truncOneLine(ev.text)}`;
    case "assistant_text":
      return `${ts} **asst** ${truncOneLine(ev.text)}`;
    case "thinking": {
      const t = truncOneLine(ev.text);
      return t ? `${ts} _think_ ${t}` : `${ts} _think_ _(redacted)_`;
    }
    case "tool_use": {
      const tool = shortToolName(ev.tool ?? "?");
      const edit = ev.edit ? ` \`${ev.edit.path}\` (${ev.edit.kind}/${ev.edit.lines_changed ?? "?"} lines)` : "";
      const argsBrief = ev.edit ? "" : ` ${argsOneLine(ev.args)}`;
      const cost = ev.tok_out ? ` _tok_out=${ev.tok_out}_` : "";
      return `${ts} **tool** \`${tool}\`${edit}${argsBrief}${cost}`;
    }
    case "tool_result":
      return `${ts} ${ev.is_error ? "**❌ err**" : "← ok"} ${truncOneLine(ev.result_text)}`;
    case "system": {
      const dur = ev.dur_ms ? `${(ev.dur_ms / 1000).toFixed(1)}s` : "";
      const hooks = ev.hook_errors ? ` hook_errors=${ev.hook_errors.length}` : "";
      return `${ts} _sys_ ${ev.subtype ?? "?"} ${dur}${hooks}`;
    }
    case "permission":
      return `${ts} _perm_ → ${ev.text}`;
    case "title":
      return `${ts} _title_ ${ev.text}`;
    case "last_prompt":
      return `${ts} _last_prompt_ ${truncOneLine(ev.text)}`;
    case "attachment":
      return `${ts} _attach_`;
    case "snapshot":
      return `${ts} _snap_`;
    default:
      return `${ts} ${ev.kind}`;
  }
}

function shortTs(ts) {
  try {
    return new Date(ts).toISOString().slice(11, 19);
  } catch {
    return ts;
  }
}

function truncOneLine(s) {
  if (s == null) return "";
  const collapsed = String(s).replace(/\s+/g, " ").trim();
  return collapsed.length > 240 ? collapsed.slice(0, 220) + `…[+${collapsed.length - 220}ch]` : collapsed;
}

function argsOneLine(args) {
  if (!args || typeof args !== "object") return "";
  const entries = Object.entries(args).slice(0, 3);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `${k}=${truncOneLine(typeof v === "string" ? v : JSON.stringify(v))}`)
    .join(" ");
}

/**
 * Approximate token count for the budgeter (4 chars ≈ 1 token).
 * @param {string} s
 */
export function approxTokens(s) {
  return Math.ceil(s.length / 4);
}

/**
 * Wrap output with a header showing source files + counts.
 * @param {string[]} sources
 * @param {{parsed:number, skipped:number, total_lines:number}} parseStats
 */
export function header(sources, parseStats) {
  return [
    `# cairn-mine output`,
    `_sources: ${sources.length} file(s) · ${parseStats.parsed} parsed · ${parseStats.skipped} skipped_`,
    "",
  ].join("\n");
}

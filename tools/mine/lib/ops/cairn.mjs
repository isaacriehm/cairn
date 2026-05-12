// `cairn` op — Cairn-specific signal extraction.
// Surfaces:
//   - cairn_* MCP tool calls (with short name + args)
//   - cairn-named Skill invocations (cairn:cairn-adopt, etc.)
//   - cairn_init_run phase progression (per-session phase timeline)
//   - cairn_resolve_attention picks (kind, item_id, choice)
//   - cairn_record_decision writes
//   - Errors on cairn_* tools (highest-signal: adoption/runtime bugs)

import { buildContext, iterate } from "../runtime.mjs";
import {
  isCairnMcpCall,
  isCairnSkillCall,
  shortToolName,
  cairnInitPhase,
  cairnAttentionResolve,
  cairnRecordDecision,
} from "../enrich.mjs";

export const USAGE = `
mine cairn — Cairn-specific signal (MCP calls, phases, attention, decisions)

Flags:
  --jsonl <path> | --jsonl-glob <pattern>   sources
  --session <id>                            limit to one session
  --since ISO --until ISO                   time window
  --repo <path>                             filter sessions by cwd prefix
  --format md|ndjson                        default md
  --limit N                                 cap rows per section (default 50)
  --errors-only                             only emit cairn-tool errors
  --include phases|attention|decisions|tools|skills|errors
                                            comma-separated list of sections.
                                            default: all
`.trimStart();

const ALL_SECTIONS = ["phases", "attention", "decisions", "tools", "skills", "errors"];

export async function run(args) {
  const ctx = await buildContext(args, { default_limit: 50 });
  const repoPrefix = args.repo ? String(args.repo) : null;
  const sections = toArr(args.include).flatMap((s) => String(s).split(","));
  const wanted = sections.length > 0 ? new Set(sections) : new Set(ALL_SECTIONS);

  /** @type {Map<string, {tool:string, args?:Record<string,unknown>, ts?:string, cwd?:string, session_id:string}>} */
  const inflight = new Map();

  /** @type {Map<string, number>} */
  const toolCalls = new Map();
  /** @type {Map<string, number>} */
  const skillCalls = new Map();
  /** @type {{session_id:string, ts?:string, phase:string, cwd?:string}[]} */
  const phases = [];
  /** @type {{session_id:string, ts?:string, kind?:string, item_id?:string, choice?:string, cwd?:string}[]} */
  const attention = [];
  /** @type {{session_id:string, ts?:string, args:Record<string,unknown>, cwd?:string}[]} */
  const decisions = [];
  /** @type {{session_id:string, ts?:string, tool:string, args?:Record<string,unknown>, error_text?:string, cwd?:string}[]} */
  const errors = [];

  for await (const ev of iterate(ctx)) {
    if (repoPrefix && ev.cwd && !ev.cwd.startsWith(repoPrefix)) continue;

    if (ev.kind === "tool_use") {
      const isMcp = isCairnMcpCall(ev);
      const isSkill = isCairnSkillCall(ev);
      if (isMcp || isSkill) {
        inflight.set(ev.tool_use_id, {
          tool: ev.tool,
          args: ev.args,
          ts: ev.ts,
          cwd: ev.cwd,
          session_id: ev.session_id,
        });
      }
      if (isMcp) {
        const short = shortToolName(ev.tool);
        toolCalls.set(short, (toolCalls.get(short) ?? 0) + 1);
        const phase = cairnInitPhase(ev);
        if (phase) phases.push({ session_id: ev.session_id, ts: ev.ts, phase, cwd: ev.cwd });
        const att = cairnAttentionResolve(ev);
        if (att) attention.push({ session_id: ev.session_id, ts: ev.ts, ...att, cwd: ev.cwd });
        const dec = cairnRecordDecision(ev);
        if (dec) decisions.push({ session_id: ev.session_id, ts: ev.ts, args: dec, cwd: ev.cwd });
      }
      if (isSkill) {
        const skill = String(ev.args?.skill ?? "?");
        skillCalls.set(skill, (skillCalls.get(skill) ?? 0) + 1);
      }
    } else if (ev.kind === "tool_result" && ev.is_error) {
      const linked = inflight.get(ev.tool_use_id ?? "");
      if (linked && (linked.tool.startsWith("mcp__plugin_cairn_cairn__") || /^cairn:/i.test(String(linked.args?.skill ?? "")))) {
        errors.push({
          session_id: linked.session_id,
          ts: ev.ts ?? linked.ts,
          tool: linked.tool,
          args: linked.args,
          error_text: ev.result_text,
          cwd: linked.cwd,
        });
      }
      inflight.delete(ev.tool_use_id ?? "");
    }
  }

  if (args["errors-only"] === true) {
    wanted.clear();
    wanted.add("errors");
  }

  if (ctx.format === "ndjson") {
    if (wanted.has("tools")) for (const [t, n] of toolCalls) process.stdout.write(JSON.stringify({ kind: "tool", tool: t, count: n }) + "\n");
    if (wanted.has("skills")) for (const [s, n] of skillCalls) process.stdout.write(JSON.stringify({ kind: "skill", skill: s, count: n }) + "\n");
    if (wanted.has("phases")) for (const p of phases.slice(0, ctx.limit || phases.length)) process.stdout.write(JSON.stringify({ kind: "phase", ...p }) + "\n");
    if (wanted.has("attention")) for (const a of attention.slice(0, ctx.limit || attention.length)) process.stdout.write(JSON.stringify({ kind: "attention", ...a }) + "\n");
    if (wanted.has("decisions")) for (const d of decisions.slice(0, ctx.limit || decisions.length)) process.stdout.write(JSON.stringify({ kind: "decision", ...d }) + "\n");
    if (wanted.has("errors")) for (const e of errors.slice(0, ctx.limit || errors.length)) process.stdout.write(JSON.stringify({ kind: "error", ...e }) + "\n");
    return;
  }

  const out = [];
  out.push("# cairn-mine cairn");
  out.push(`_sources: ${ctx.sources.length} file(s) · ${ctx.parseStats.parsed} parsed · ${ctx.parseStats.skipped} skipped_`);
  out.push("");

  if (wanted.has("tools") && toolCalls.size > 0) {
    out.push("## cairn MCP tools");
    out.push(`| tool | calls |`);
    out.push(`| --- | ---: |`);
    const sorted = [...toolCalls.entries()].sort((a, b) => b[1] - a[1]);
    const sliced = ctx.limit > 0 ? sorted.slice(0, ctx.limit) : sorted;
    for (const [t, n] of sliced) out.push(`| \`${t}\` | ${n} |`);
    out.push("");
  }

  if (wanted.has("skills") && skillCalls.size > 0) {
    out.push("## cairn skills");
    out.push(`| skill | calls |`);
    out.push(`| --- | ---: |`);
    for (const [s, n] of [...skillCalls.entries()].sort((a, b) => b[1] - a[1])) out.push(`| \`${s}\` | ${n} |`);
    out.push("");
  }

  if (wanted.has("phases") && phases.length > 0) {
    out.push(`## init phases (${phases.length})`);
    const sliced = ctx.limit > 0 ? phases.slice(0, ctx.limit) : phases;
    for (const p of sliced) out.push(`- \`${shortTs(p.ts)}\` \`${p.session_id}\` → **${p.phase}** _${shortCwd(p.cwd)}_`);
    if (phases.length > sliced.length) out.push(`_…[+${phases.length - sliced.length} more]_`);
    out.push("");
  }

  if (wanted.has("attention") && attention.length > 0) {
    out.push(`## attention resolutions (${attention.length})`);
    const sliced = ctx.limit > 0 ? attention.slice(0, ctx.limit) : attention;
    for (const a of sliced) out.push(`- \`${shortTs(a.ts)}\` \`${a.session_id}\` → **${a.kind}**/${a.item_id}/**${a.choice}**`);
    if (attention.length > sliced.length) out.push(`_…[+${attention.length - sliced.length} more]_`);
    out.push("");
  }

  if (wanted.has("decisions") && decisions.length > 0) {
    out.push(`## record_decision writes (${decisions.length})`);
    const sliced = ctx.limit > 0 ? decisions.slice(0, ctx.limit) : decisions;
    for (const d of sliced) {
      const title = String(d.args?.title ?? d.args?.summary ?? "(no title)");
      out.push(`- \`${shortTs(d.ts)}\` \`${d.session_id}\` → ${truncLine(title)}`);
    }
    if (decisions.length > sliced.length) out.push(`_…[+${decisions.length - sliced.length} more]_`);
    out.push("");
  }

  if (wanted.has("errors") && errors.length > 0) {
    out.push(`## cairn tool errors (${errors.length})`);
    const sliced = ctx.limit > 0 ? errors.slice(0, ctx.limit) : errors;
    for (const e of sliced) {
      out.push(`### \`${shortToolName(e.tool)}\` — \`${shortTs(e.ts)}\` — \`${e.session_id}\``);
      out.push("```");
      out.push(String(e.error_text ?? ""));
      out.push("```");
      out.push("");
    }
    if (errors.length > sliced.length) out.push(`_…[+${errors.length - sliced.length} more]_`);
  }

  process.stdout.write(out.join("\n") + "\n");
}

function shortTs(ts) {
  if (!ts) return "?";
  try {
    return new Date(ts).toISOString().slice(0, 19) + "Z";
  } catch {
    return ts;
  }
}

function shortCwd(p) {
  if (!p) return "?";
  return p.replace(/.*\//, "");
}

function truncLine(s) {
  if (s == null) return "";
  const str = String(s).replace(/\s+/g, " ").trim();
  return str.length > 120 ? str.slice(0, 110) + "…" : str;
}

function toArr(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

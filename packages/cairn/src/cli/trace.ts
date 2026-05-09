/**
 * `cairn trace` — pretty-print the unified trace log.
 *
 * Reads `~/.cairn/trace/trace-<YYYY-MM-DD>.jsonl` for the most
 * recent two days, time-sorts the rows, and prints a one-line-per-event
 * summary. Optional flags filter by session, repo, source, kind, or
 * follow live.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { traceDir, type TraceEvent } from "@isaacriehm/cairn-core";

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function colorFor(source: string, ok?: boolean): string {
  if (ok === false) return "\x1b[31m"; // red — failure
  switch (source) {
    case "hook":
      return "\x1b[36m"; // cyan
    case "mcp":
      return "\x1b[35m"; // magenta
    case "claude":
      return "\x1b[33m"; // yellow
    case "init-phase":
      return "\x1b[34m"; // blue
    case "subagent":
      return "\x1b[32m"; // green
    default:
      return "";
  }
}
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function formatRow(ev: TraceEvent, opts: { wide: boolean }): string {
  const time = ev.ts.slice(11, 23); // HH:MM:SS.mmm
  const src = ev.source.padEnd(11);
  const kind = ev.kind.padEnd(28);
  const ok = ev.ok === false ? " ✗" : ev.ok === true ? " ✓" : "  ";
  const dur = ev.duration_ms !== undefined ? ` ${Math.round(ev.duration_ms)}ms` : "";
  const repo = ev.repo_root !== null ? ` ${DIM}${ev.repo_root.split("/").slice(-2).join("/")}${RESET}` : "";
  const sess = ev.session_id !== null ? ` ${DIM}sid=${ev.session_id.slice(0, 8)}${RESET}` : "";
  const color = colorFor(ev.source, ev.ok);
  const head = `${DIM}${time}${RESET}  ${color}${src}${RESET}${kind}${ok}${dur}${repo}${sess}`;

  if (!opts.wide) return head;

  const payloadLines: string[] = [];
  for (const [k, v] of Object.entries(ev.payload)) {
    let rendered: string;
    if (typeof v === "string") {
      rendered = v.length > 200 ? `${v.slice(0, 200)}…(+${v.length - 200} chars)` : v;
      rendered = rendered.replace(/\n/g, "\\n");
    } else if (v === null) {
      rendered = "null";
    } else {
      rendered = JSON.stringify(v);
      if (rendered.length > 240) rendered = `${rendered.slice(0, 240)}…`;
    }
    payloadLines.push(`    ${DIM}${k}=${RESET}${rendered}`);
  }
  return [head, ...payloadLines].join("\n");
}

function loadTraceFiles(daysBack: number): string[] {
  const dir = traceDir();
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.startsWith("trace-") || !f.endsWith(".jsonl")) continue;
    out.push(join(dir, f));
  }
  out.sort();
  return out.slice(-daysBack);
}

function readEvents(paths: string[]): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const p of paths) {
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const ev = JSON.parse(line) as TraceEvent;
        events.push(ev);
      } catch {
        // skip malformed
      }
    }
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return events;
}

function applyFilters(events: TraceEvent[], flags: Record<string, string | boolean>): TraceEvent[] {
  return events.filter((ev) => {
    if (typeof flags["session"] === "string" && ev.session_id !== flags["session"]) return false;
    if (typeof flags["repo"] === "string") {
      const want = resolve(flags["repo"]);
      if (ev.repo_root !== want) return false;
    }
    if (typeof flags["source"] === "string" && ev.source !== flags["source"]) return false;
    if (typeof flags["kind"] === "string" && !ev.kind.includes(flags["kind"])) return false;
    if (typeof flags["since"] === "string" && ev.ts < flags["since"]) return false;
    if (flags["errors-only"] === true && ev.ok !== false) return false;
    return true;
  });
}

async function followTail(filterFlags: Record<string, string | boolean>, wide: boolean): Promise<void> {
  // Simple polling tail: every 500ms, re-read today's file, emit rows we
  // haven't shown yet. Cheap; trace files are append-only.
  let lastSize = 0;
  let firstPass = true;
  // Print last 20 rows on entry so the operator has context.
  const initial = applyFilters(readEvents(loadTraceFiles(2)), filterFlags).slice(-20);
  for (const ev of initial) console.log(formatRow(ev, { wide }));
  const path = loadTraceFiles(1)[0];
  if (path !== undefined) {
    try {
      lastSize = statSync(path).size;
    } catch {
      lastSize = 0;
    }
  }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, 500));
    const todayPath = loadTraceFiles(1)[0];
    if (todayPath === undefined) continue;
    let st;
    try {
      st = statSync(todayPath);
    } catch {
      continue;
    }
    if (st.size <= lastSize && !firstPass) continue;
    firstPass = false;
    let raw: string;
    try {
      raw = readFileSync(todayPath, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    // Re-emit anything new since lastSize. Easier than tracking line count: parse all, slice by ts > last seen.
    const events = lines
      .map((l) => {
        try {
          return JSON.parse(l) as TraceEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is TraceEvent => e !== null);
    const filtered = applyFilters(events, filterFlags);
    // Print any rows whose ts is strictly greater than the last emitted ts.
    const lastTs = initial.length > 0 ? initial[initial.length - 1]?.ts : "";
    let newCount = 0;
    for (const ev of filtered) {
      if (lastTs !== undefined && ev.ts <= lastTs) continue;
      console.log(formatRow(ev, { wide }));
      newCount++;
    }
    lastSize = st.size;
    if (newCount === 0) continue;
    // Update marker.
    initial.push(...filtered.filter((e) => lastTs !== undefined && e.ts > lastTs));
  }
}

export async function traceCli(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);

  if (flags["help"] === true || flags["h"] === true) {
    console.log(
      [
        "Usage: cairn trace [flags]",
        "",
        "Show the unified Cairn trace (hooks, MCP tools, claude calls, init phases).",
        "",
        "Filters:",
        "  --session <id>     filter by Claude Code session id",
        "  --repo <path>      filter by repo root (absolute)",
        "  --source <name>    hook | mcp | claude | init-phase | subagent",
        "  --kind <substr>    substring match on kind",
        "  --since <ISO>      only rows at or after timestamp",
        "  --errors-only      only failing events",
        "",
        "Output:",
        "  --tail             follow live (poll every 500ms)",
        "  --wide             expand payload fields under each row",
        "  --tail-n <N>       print last N rows on entry to --tail (default 20)",
        "  --days <N>         how many days back to read (default 2)",
        "  --json             one trace row per line, no formatting",
        "",
        "Trace files: ~/.cairn/trace/trace-<YYYY-MM-DD>.jsonl",
      ].join("\n"),
    );
    return;
  }

  const days = typeof flags["days"] === "string" ? parseInt(flags["days"], 10) : 2;
  const wide = flags["wide"] === true;

  if (flags["tail"] === true) {
    await followTail(flags, wide);
    return;
  }

  const events = applyFilters(readEvents(loadTraceFiles(Number.isFinite(days) ? days : 2)), flags);

  if (flags["json"] === true) {
    for (const ev of events) console.log(JSON.stringify(ev));
    return;
  }

  if (events.length === 0) {
    console.log(`(no trace events under ${traceDir()})`);
    return;
  }
  for (const ev of events) console.log(formatRow(ev, { wide }));
}

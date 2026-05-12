#!/usr/bin/env node
// cairn-mine — dev-internal datamining tool for Claude Code session
// JSONL transcripts + .cairn/ state. Read tools/mine/README.md before
// invoking. Not shipped; lives in repo for the Cairn-coding AI loop.
//
// Usage:
//   node tools/mine/mine.mjs <subcommand> [flags]
//
// Subcommands:
//   ls         — list sessions found in the supplied JSONL(s)
//   session    — full timeline for one session id (or a single jsonl)
//   histogram  — per-tool histogram, tokens, failure rate
//   errors     — extract errors + nearby context
//   cairn      — cairn-specific events (MCP calls, phases, attention)
//   help       — print this message

import { parseArgs } from "./lib/args.mjs";

const USAGE = `
cairn-mine — dev-internal Claude Code JSONL datamining tool

Usage: node tools/mine/mine.mjs <subcommand> [flags]

Subcommands:
  ls         List sessions in JSONL files (with first/last ts, event count, title)
  session    Render full timeline for one session
  histogram  Tool histogram, token totals, failure rate
  errors     Errors + retries + nearby context
  cairn      Cairn-specific signal (MCP calls, phases, attention resolutions)
  help       Print this usage

Common flags (most subcommands):
  --jsonl <path>          One transcript JSONL. Repeatable.
  --jsonl-glob <pattern>  Glob over JSONLs. Repeatable. Default:
                          ~/.claude/projects/**/*.jsonl
  --session <id>          Limit to this session id (uuid).
  --cairn <path>          Optional path to a .cairn/ dir (milestone 2: cross-ref)
  --repo <path>           Optional path to a repo (milestone 2: git log join)
  --format md|ndjson      Output format. Default md.
  --limit N               Cap events / rows. Default per-op.
  --since ISO             Filter ts >= ISO.
  --until ISO             Filter ts < ISO.
  --tool NAME             Filter to a specific tool name. Repeatable.
  --errors-only           Keep only error events.
  --head N --tail N       Override per-string truncation defaults.
  --full text|args|result|all  Disable truncation for the named field(s).
  --unlimited             Disable all truncation (raw projection).
  -h, --help              Print subcommand help.

Output:
  md format wraps with a header (sources + parse stats).
  ndjson writes one ProjectedEvent per line.

See tools/mine/README.md for shape reference + AI usage examples.
`.trimStart();

const SUBCOMMANDS = {
  ls: () => import("./lib/ops/ls.mjs"),
  session: () => import("./lib/ops/session.mjs"),
  histogram: () => import("./lib/ops/histogram.mjs"),
  errors: () => import("./lib/ops/errors.mjs"),
  cairn: () => import("./lib/ops/cairn.mjs"),
};

async function main() {
  const [, , sub, ...rest] = process.argv;
  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  const loader = SUBCOMMANDS[sub];
  if (!loader) {
    process.stderr.write(`unknown subcommand: ${sub}\n\n${USAGE}`);
    process.exit(2);
  }
  const args = parseArgs(rest);
  if (args.help || args.h) {
    const mod = await loader();
    process.stdout.write((mod.USAGE ?? `(no usage for ${sub})`) + "\n");
    return;
  }
  const mod = await loader();
  try {
    await mod.run(args);
  } catch (err) {
    process.stderr.write(`cairn-mine ${sub} failed: ${err?.stack ?? err}\n`);
    process.exit(1);
  }
}

main();

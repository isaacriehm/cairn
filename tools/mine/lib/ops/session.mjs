// `session` op — full timeline of one session as an AI-context-budgeted
// markdown timeline, or ndjson stream.
//
// Picks a session id from --session, or auto-picks when there's only
// one session across all sources, or when the source is a single JSONL
// file.

import { buildContext, iterate } from "../runtime.mjs";
import { mdRow, ndjson, header } from "../format.mjs";

export const USAGE = `
mine session — full event timeline for one session

Flags:
  --session <id>          Session uuid. Required unless sources resolve to one session.
  --jsonl <path>          Source JSONL. Repeatable.
  --jsonl-glob <pattern>  Glob (default: ~/.claude/projects/**/*.jsonl)
  --since ISO --until ISO Time window
  --tool NAME             Filter to specific tool. Repeatable.
  --errors-only           Only error events
  --include-meta          Include snapshot + attachment events (off by default)
  --format md|ndjson      Default md
  --limit N               Cap events (md default 500; ndjson 0 = unlimited)
  --head N --tail N       Truncation overrides
  --full text|args|result|all  Disable truncation
  --unlimited             Disable all truncation
`.trimStart();

export async function run(args) {
  const ctx = await buildContext(args, { default_limit: args.format === "ndjson" ? 0 : 500 });

  if (!args.session && ctx.sources.length === 1) {
    const detected = await detectSingleSession(ctx.sources[0]);
    if (detected) {
      args.session = detected;
      // Rebuild filter via buildContext for hygiene.
      return runWithSession(args, detected);
    }
  }

  if (!args.session) {
    process.stderr.write(`mine session: must supply --session <id> or a single-session source.\n`);
    process.exit(2);
  }

  return runWithSession(args, String(args.session));
}

async function runWithSession(args, session_id) {
  const ctx = await buildContext({ ...args, session: session_id }, {
    default_limit: args.format === "ndjson" ? 0 : 500,
  });
  const events = [];
  for await (const ev of iterate(ctx)) {
    events.push(ev);
  }
  events.sort(eventOrder);

  if (ctx.format === "ndjson") {
    const sliced = ctx.limit > 0 ? events.slice(0, ctx.limit) : events;
    for (const ev of sliced) process.stdout.write(ndjson(ev) + "\n");
    return;
  }

  // Split timeline vs metadata. Metadata renders once in the header.
  const META_KINDS = new Set(["title", "last_prompt", "permission", "attachment", "snapshot"]);
  const timeline = events.filter((e) => !META_KINDS.has(e.kind));
  const meta = events.filter((e) => META_KINDS.has(e.kind));
  const sliced = ctx.limit > 0 ? timeline.slice(0, ctx.limit) : timeline;

  // Pull repo/branch/cc from any event that has them.
  const probe = events.find((e) => e.cwd || e.git_branch || e.cc_version) ?? {};
  const title = meta.find((e) => e.kind === "title")?.text;
  const firstPrompt = meta.find((e) => e.kind === "last_prompt")?.text;
  const permModes = [...new Set(meta.filter((e) => e.kind === "permission").map((e) => e.text))];

  process.stdout.write(header(ctx.sources, ctx.parseStats));
  const headerLines = [
    `## session \`${session_id}\``,
    `- repo: \`${probe.cwd ?? "?"}\` · branch: \`${probe.git_branch ?? "?"}\` · cc: \`${probe.cc_version ?? "?"}\``,
    `- title: ${title ?? "(none)"}`,
    `- first prompt: ${firstPrompt ?? "(none)"}`,
    `- permission modes seen: ${permModes.length > 0 ? permModes.join(", ") : "(none)"}`,
    `- ${sliced.length} of ${timeline.length} timeline events shown (+${meta.length} metadata folded above)`,
    "",
    "### timeline",
    "",
  ];
  process.stdout.write(headerLines.join("\n"));
  for (const ev of sliced) {
    process.stdout.write(mdRow(ev) + "\n");
  }
  if (timeline.length > sliced.length) {
    process.stdout.write(`\n_…[+${timeline.length - sliced.length} timeline events truncated] — pass --limit 0 or --format ndjson for all_\n`);
  }
}

function eventOrder(a, b) {
  // Events with ts first, sorted by ts. Events without ts sort after.
  const aHasTs = !!a.ts;
  const bHasTs = !!b.ts;
  if (aHasTs && !bHasTs) return -1;
  if (!aHasTs && bHasTs) return 1;
  if (aHasTs && bHasTs) {
    const cmp = a.ts.localeCompare(b.ts);
    if (cmp !== 0) return cmp;
  }
  return (a.uuid ?? "").localeCompare(b.uuid ?? "");
}

async function detectSingleSession(path) {
  const { streamEvents } = await import("../parse.mjs");
  const seen = new Set();
  for await (const raw of streamEvents(path)) {
    if (typeof raw.sessionId === "string") {
      seen.add(raw.sessionId);
      if (seen.size > 1) return null;
    }
  }
  return seen.size === 1 ? [...seen][0] : null;
}

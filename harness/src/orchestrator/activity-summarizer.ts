/**
 * Tier-0 (Ollama llama3.2:3b) summarizer for the implementer's
 * stream-jsonl events.
 *
 * The per-task channel's live status embed shows a static phase badge
 * during the long `running` phase (60-300s typical). Operators want
 * insight into WHAT the agent is doing — which file it's reading,
 * what command it's running, what it's planning. Tier-0 is fast +
 * cheap (~200ms locally, $0/call) so we can refresh on a tight
 * cadence without burning Anthropic plan quota.
 *
 * Input: a sliding window of recent stream-jsonl events.
 * Output: a single-line, present-progressive description (≤120 chars).
 *
 * Failures (Ollama down, parse errors, timeout) return "Working…"
 * gracefully — the live status badge keeps moving, just without the
 * activity nuance.
 */

import { logger } from "../logger.js";
import {
  DEFAULT_OLLAMA_HOST,
  DEFAULT_OLLAMA_MODEL,
  ollamaGenerate,
} from "../tier0/index.js";

const log = logger("orchestrator.activity");

const SYSTEM_PROMPT = `You describe what a coding agent is currently doing, in present-progressive English.

OUTPUT RULES:
- ONE LINE only.
- Maximum 120 characters.
- No emoji, no markdown, no quotes, no preamble.
- Start with a verb-ing form: "Reading", "Editing", "Running", "Searching", "Planning", "Thinking".
- Mention the file path, command, or pattern when present.
- If you can't tell from the events, output: "Working…".

Examples:
  Reading core/src/integrations/oauth.ts
  Editing platform/api/routes/admin.ts
  Running pnpm exec tsc -b
  Searching repo for "process.env"
  Planning migration of session middleware`;

export interface SummarizeActivityArgs {
  /** Recent stream-jsonl events; the function picks out the load-bearing ones. */
  events: ReadonlyArray<Record<string, unknown>>;
  /** Ollama host. Default = process.env OLLAMA_HOST or http://localhost:11434. */
  host?: string;
  /** Ollama model. Default = llama3.2:3b. */
  model?: string;
  /** Per-call timeout. Default 6_000 ms — Tier-0 should be <1s typically. */
  timeoutMs?: number;
}

/**
 * Summarize the agent's current activity from a sliding window of
 * events. Returns one line ≤120 chars. Never throws.
 */
export async function summarizeActivity(args: SummarizeActivityArgs): Promise<string> {
  const compact = compactEvents(args.events);
  if (compact.length === 0) return "Working…";

  const prompt = `Recent events:\n${compact}\n\nWhat is the agent doing right now?`;
  try {
    const res = await ollamaGenerate({
      host: args.host ?? DEFAULT_OLLAMA_HOST,
      model: args.model ?? DEFAULT_OLLAMA_MODEL,
      prompt,
      system: SYSTEM_PROMPT,
      timeoutMs: args.timeoutMs ?? 6_000,
    });
    const raw = (res.response ?? "").trim();
    const firstLine = raw.split("\n")[0] ?? "";
    return firstLine.replace(/^["'`]+|["'`]+$/g, "").slice(0, 120) || "Working…";
  } catch (err) {
    log.debug({ err: String(err) }, "tier-0 activity summarize failed");
    return "Working…";
  }
}

/**
 * Pull the load-bearing signals out of stream-jsonl events: tool_use
 * names + paths/commands, and the agent's text snippets. Cap at 12
 * lines so the prompt stays small. Skip user (tool_result) blocks —
 * they're verbose and the surrounding tool_use already captures the
 * intent.
 */
function compactEvents(events: ReadonlyArray<Record<string, unknown>>): string {
  const lines: string[] = [];
  const recent = events.slice(-30);
  for (const e of recent) {
    if (e["type"] !== "assistant") continue;
    const message = e["message"] as Record<string, unknown> | undefined;
    const content = message?.["content"];
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (typeof item !== "object" || item === null) continue;
      const it = item as Record<string, unknown>;
      const itemType = it["type"];
      if (itemType === "tool_use") {
        const name = typeof it["name"] === "string" ? (it["name"] as string) : "?";
        const input = (it["input"] as Record<string, unknown> | undefined) ?? {};
        if (name === "Read" || name === "Edit" || name === "Write" || name === "NotebookEdit") {
          const path = input["file_path"] ?? input["path"];
          lines.push(`${name}: ${typeof path === "string" ? path : "?"}`);
        } else if (name === "Bash") {
          const cmd = typeof input["command"] === "string" ? (input["command"] as string) : "?";
          lines.push(`Bash: ${cmd.slice(0, 140)}`);
        } else if (name === "Glob" || name === "Grep") {
          const pattern = typeof input["pattern"] === "string" ? (input["pattern"] as string) : "?";
          const path = input["path"];
          lines.push(
            `${name}: ${pattern.slice(0, 80)}${typeof path === "string" ? ` in ${path}` : ""}`,
          );
        } else if (name === "Task") {
          const desc = typeof input["description"] === "string" ? (input["description"] as string) : "?";
          lines.push(`Task: ${desc.slice(0, 100)}`);
        } else {
          lines.push(name);
        }
      } else if (itemType === "text") {
        const text = typeof it["text"] === "string" ? (it["text"] as string) : "";
        if (text.length > 0) {
          lines.push(`Said: ${text.slice(0, 200)}`);
        }
      }
    }
  }
  return lines.slice(-12).join("\n");
}

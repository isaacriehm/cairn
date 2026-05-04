/**
 * Tool-digest extractor — second-source visibility for §3.3.
 *
 * Reads claude stream-json events (from events.jsonl or the live activity
 * window) and surfaces what the agent is actually doing — the file paths
 * it edited, the bash commands it ran, the search patterns it grep'd.
 *
 * Operator-facing surface: rendered as embed FIELDS alongside the Tier-0
 * Ollama summary. Independent of LLM availability — pure pattern match
 * on tool_use entries. When the Ollama summary fails ("Working…"), the
 * tool digest still gives the operator something concrete.
 *
 * Claude stream-json shape (only the fields we read):
 *   { type: "assistant", message: { content: [{ type: "tool_use",
 *     name: "Edit"|"Write"|"MultiEdit"|"Bash"|"Grep"|"Glob"|...,
 *     input: { file_path?, command?, pattern?, ... } }] } }
 */

export interface ToolDigest {
  files: string[];
  bash: string[];
  searches: string[];
}

const FILE_EDIT_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);
const BASH_TOOLS = new Set(["Bash"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);

export interface ExtractToolDigestOptions {
  /** Max file paths kept (deduped, most-recent-last). Default 8. */
  maxFiles?: number;
  /** Max bash commands kept (most-recent-last). Default 6. */
  maxBash?: number;
  /** Max search patterns kept (most-recent-last). Default 6. */
  maxSearches?: number;
  /** Trim each captured string to this length. Default 120. */
  truncateTo?: number;
}

export function extractToolDigest(
  events: readonly Record<string, unknown>[],
  opts: ExtractToolDigestOptions = {},
): ToolDigest {
  const maxFiles = opts.maxFiles ?? 8;
  const maxBash = opts.maxBash ?? 6;
  const maxSearches = opts.maxSearches ?? 6;
  const truncateTo = opts.truncateTo ?? 120;

  const files: string[] = [];
  const bash: string[] = [];
  const searches: string[] = [];

  for (const event of events) {
    if (event["type"] !== "assistant") continue;
    const msg = event["message"];
    if (typeof msg !== "object" || msg === null) continue;
    const content = (msg as Record<string, unknown>)["content"];
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p["type"] !== "tool_use") continue;
      const name = typeof p["name"] === "string" ? (p["name"] as string) : "";
      const input =
        typeof p["input"] === "object" && p["input"] !== null
          ? (p["input"] as Record<string, unknown>)
          : undefined;
      if (input === undefined) continue;
      if (FILE_EDIT_TOOLS.has(name)) {
        const path = stringFrom(input, ["file_path", "filePath", "notebook_path"]);
        if (path !== undefined) pushUnique(files, truncate(path, truncateTo));
      } else if (BASH_TOOLS.has(name)) {
        const cmd = stringFrom(input, ["command"]);
        if (cmd !== undefined) bash.push(truncate(cmd, truncateTo));
      } else if (SEARCH_TOOLS.has(name)) {
        const pat = stringFrom(input, ["pattern", "query", "glob"]);
        if (pat !== undefined) searches.push(truncate(pat, truncateTo));
      }
    }
  }

  return {
    files: tailDedup(files, maxFiles),
    bash: bash.slice(-maxBash),
    searches: searches.slice(-maxSearches),
  };
}

function stringFrom(
  obj: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function pushUnique(arr: string[], value: string): void {
  const idx = arr.indexOf(value);
  if (idx !== -1) arr.splice(idx, 1);
  arr.push(value);
}

function tailDedup(arr: readonly string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v === undefined) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.unshift(v);
    if (out.length >= cap) break;
  }
  return out;
}

function truncate(s: string, n: number): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed.length > n ? `${trimmed.slice(0, n - 1)}…` : trimmed;
}

/** True if any of files/bash/searches are populated. */
export function digestIsEmpty(d: ToolDigest): boolean {
  return d.files.length === 0 && d.bash.length === 0 && d.searches.length === 0;
}

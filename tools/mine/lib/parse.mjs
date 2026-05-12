// Streaming JSONL parser. Reads line-by-line via readline over a file
// stream so we never load multi-hundred-MB transcripts into memory.
// Yields raw event objects. Skip-on-parse-error: count + report, never throw.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * @typedef {object} ParseResult
 * @property {number} total_lines
 * @property {number} parsed
 * @property {number} skipped
 */

/**
 * Stream the events of a JSONL file. Iterates raw event objects.
 * Each yielded value carries _source_line for diagnostics.
 * Caller can attach a result accumulator via the second arg.
 * @param {string} path
 * @param {{result?: ParseResult, on_skip?: (line:string, err:unknown, lineNum:number) => void}} [opts]
 * @returns {AsyncGenerator<Record<string, unknown> & {_source_line: number, _source_path: string}>}
 */
export async function* streamEvents(path, opts = {}) {
  const result = opts.result ?? { total_lines: 0, parsed: 0, skipped: 0 };
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    n += 1;
    result.total_lines = n;
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      result.parsed += 1;
      obj._source_line = n;
      obj._source_path = path;
      yield obj;
    } catch (err) {
      result.skipped += 1;
      if (opts.on_skip) opts.on_skip(line, err, n);
    }
  }
}

/**
 * Expand --jsonl-glob patterns + --jsonl repeats into a flat sorted list.
 * Falls back to default glob if neither is supplied.
 * @param {{jsonl?: string[], jsonl_glob?: string[]}} args
 * @param {string} default_glob
 */
export async function resolveJsonlPaths(args, default_glob) {
  const { glob } = await import("node:fs/promises");
  const seen = new Set();
  const direct = args.jsonl ?? [];
  for (const p of direct) seen.add(p);

  const patterns = args.jsonl_glob && args.jsonl_glob.length > 0
    ? args.jsonl_glob
    : direct.length === 0
    ? [default_glob]
    : [];

  for (const pattern of patterns) {
    for await (const p of glob(pattern)) {
      seen.add(p);
    }
  }
  return [...seen].sort();
}

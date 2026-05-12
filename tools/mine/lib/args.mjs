// Lightweight argv parser. Avoids adding a deps-heavy CLI lib for a
// dev-internal tool. Supports `--flag value`, `--flag=value`, repeated
// flags, boolean flags, and positional args.
//
// Convention: every flag that can repeat is parsed as an array.

const ARRAY_FLAGS = new Set(["jsonl", "jsonl-glob", "cairn", "repo", "tool", "session", "include"]);
const BOOL_FLAGS = new Set(["errors-only", "unlimited", "help", "h", "no-color", "include-meta", "verbose", "v"]);

/**
 * @param {string[]} argv  — already stripped of node + script
 */
export function parseArgs(argv) {
  /** @type {Record<string, unknown>} */
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!tok.startsWith("--") && !tok.startsWith("-")) {
      out._.push(tok);
      continue;
    }
    const flag = tok.replace(/^-+/, "");
    const eq = flag.indexOf("=");
    let name, value;
    if (eq >= 0) {
      name = flag.slice(0, eq);
      value = flag.slice(eq + 1);
    } else {
      name = flag;
      if (BOOL_FLAGS.has(name)) {
        value = true;
      } else {
        value = argv[i + 1];
        i += 1;
      }
    }
    if (ARRAY_FLAGS.has(name)) {
      if (!Array.isArray(out[name])) out[name] = [];
      out[name].push(value);
    } else {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Translate dashed flag names to snake_case fields for code-side use.
 * @param {Record<string,unknown>} args
 */
export function camelize(args) {
  /** @type {Record<string,unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k.replaceAll("-", "_")] = v;
  }
  return out;
}

/**
 * Resolve the truncate policy from CLI flags.
 * @param {Record<string,unknown>} args
 * @returns {import("./types.mjs").TruncatePolicy}
 */
export async function resolveTruncate(args) {
  const { DEFAULT_TRUNCATE } = await import("./types.mjs");
  const full = args.full;
  return {
    ...DEFAULT_TRUNCATE,
    text_head: numFlag(args.head, DEFAULT_TRUNCATE.text_head),
    text_tail: numFlag(args.tail, DEFAULT_TRUNCATE.text_tail),
    args_head: numFlag(args.args_head, DEFAULT_TRUNCATE.args_head),
    args_tail: numFlag(args.args_tail, DEFAULT_TRUNCATE.args_tail),
    result_head: numFlag(args.result_head, DEFAULT_TRUNCATE.result_head),
    result_tail: numFlag(args.result_tail, DEFAULT_TRUNCATE.result_tail),
    keep_full_text: args.unlimited === true || full === "text" || full === "all",
    keep_full_args: args.unlimited === true || full === "args" || full === "all",
    keep_full_result: args.unlimited === true || full === "result" || full === "all",
  };
}

function numFlag(v, fallback) {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

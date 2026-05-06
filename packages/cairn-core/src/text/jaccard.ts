/**
 * Tokenize + Jaccard similarity, shared between dedup (DEC draft
 * clustering) and the SoT alignment / topic-index resolver.
 *
 * The tokenizer lowercases, strips non-alphanumerics, splits on
 * whitespace, applies a tiny stem (drop trailing s / ed / ing for
 * words longer than 4 chars), and filters stopwords. A second
 * stopword set tuned for source-comment / code-shaped prose can be
 * mixed in for the SoT layer (function, method, class, etc.).
 */

const ENGLISH_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "to", "for", "with",
  "by", "from", "is", "are", "was", "were", "be", "been", "being", "has",
  "have", "had", "do", "does", "did", "this", "that", "these", "those",
  "it", "its", "as", "at", "but", "if", "than", "so", "use", "used",
  "using", "via", "out", "off", "up", "our", "their", "one", "two",
  "when", "where", "what", "how", "why", "who", "which", "can", "should",
  "must", "will", "shall", "may", "not", "no", "any", "all", "some",
  "few", "more", "most", "only", "also",
]);

const CAIRN_DOMAIN_STOPWORDS = new Set(["rationale", "decision"]);

const CODE_STOPWORDS = new Set([
  "function", "method", "class", "module", "request", "response",
  "endpoint", "param", "user", "data", "value", "result", "input",
  "output", "type", "interface", "object", "array", "string", "number",
  "boolean", "null", "undefined",
]);

function stem(w: string): string {
  if (w.length <= 4) return w;
  if (w.endsWith("ing")) return w.slice(0, -3);
  if (w.endsWith("ed")) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

interface TokenizeOptions {
  /** Mix in source-shape stopwords (function / method / class / …). */
  codeAware?: boolean;
  /** Add caller-supplied stopwords on top of the defaults. */
  extraStopwords?: Iterable<string>;
}

export function tokenize(text: string, opts: TokenizeOptions = {}): Set<string> {
  const stop = new Set<string>(ENGLISH_STOPWORDS);
  for (const w of CAIRN_DOMAIN_STOPWORDS) stop.add(w);
  if (opts.codeAware) {
    for (const w of CODE_STOPWORDS) stop.add(w);
  }
  if (opts.extraStopwords) {
    for (const w of opts.extraStopwords) stop.add(w);
  }
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map(stem)
      .filter((w) => w.length >= 3 && !stop.has(w)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}


import { ClaudeError, runClaude } from "../claude/index.js";
import { logger } from "../logger.js";
import type {
  ClassificationResult,
  Tier0ClassifyOptions,
  Tier0Intent,
  Tier0RegexFallback,
} from "./types.js";

const log = logger("tier0.classify");

const VALID_INTENTS: readonly Tier0Intent[] = [
  "code_task",
  "review",
  "direction",
  "question",
  "halt",
  "status",
  "unknown",
];

const SYSTEM_PROMPT = [
  "You classify a free-text developer message into a single intent for the harness.",
  'Respond ONLY with JSON: { "intent": <one of: code_task, review, direction, question, halt, status, unknown>, "confidence": <number between 0 and 1> }.',
  "Definitions:",
  "- code_task: operator wants code written or changed (fix, add, build, refactor, delete, migrate, wire, hook).",
  "- review: read-only audit/check of code or docs (no code change).",
  "- direction: a binding decision change. Phrases like 'scrap that', 'going forward', 'from now on', 'new direction'.",
  "- question: operator is asking, not directing.",
  "- halt: operator wants something stopped/cancelled.",
  "- status: operator wants current state of harness or run.",
  "- unknown: none of the above match.",
  "Be honest with confidence; below 0.7 means it is genuinely ambiguous.",
].join("\n");

const INTENT_SCHEMA = {
  type: "object",
  required: ["intent", "confidence"],
  additionalProperties: false,
  properties: {
    intent: {
      type: "string",
      enum: [
        "code_task",
        "review",
        "direction",
        "question",
        "halt",
        "status",
        "unknown",
      ],
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

function regexFallbackDefault(text: string): {
  intent: Tier0Intent;
  confidence: number;
} {
  const rules: { intent: Tier0Intent; pattern: RegExp }[] = [
    { intent: "halt", pattern: /^\s*(halt|stop|cancel|kill)\b/i },
    { intent: "status", pattern: /^\s*(status|state|how['’]?s it going)\b/i },
    {
      intent: "direction",
      pattern: /^\s*(scrap that|actually|new direction|going forward|from now on)\b/i,
    },
    {
      intent: "code_task",
      pattern:
        /^\s*(fix|add|update|create|build|implement|refactor|delete|remove|migrate|wire|hook|land|rip out|rip)\b/i,
    },
    {
      intent: "review",
      pattern: /^\s*(review|audit|check|inspect|look at|smoke|sanity)\b/i,
    },
    {
      intent: "question",
      pattern: /^\s*(why|how|what|when|where|which|is|are|does|do|can|should)\b/i,
    },
  ];
  for (const r of rules) {
    if (r.pattern.test(text)) return { intent: r.intent, confidence: 0.6 };
  }
  return { intent: "unknown", confidence: 0 };
}

export const REGEX_FALLBACK: Tier0RegexFallback = regexFallbackDefault;

/**
 * Classify a free-text developer message into a tier0 intent. Calls the
 * Claude binary (Haiku tier) for nuanced reasoning; falls back to a regex
 * matcher when the binary is unreachable so smoke tests + scripted callers
 * stay green. The regex fallback is escape-only — production flows assume
 * the Claude binary is present (per docs/PLUGIN_ARCHITECTURE.md §16).
 */
export async function classifyTier0(
  text: string,
  opts: Tier0ClassifyOptions = {},
): Promise<ClassificationResult> {
  const fallback = opts.regexFallback ?? REGEX_FALLBACK;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  try {
    const res = await runClaude({
      tier: "haiku",
      system: SYSTEM_PROMPT,
      prompt: `Message:\n${text}\n\nReturn the JSON now.`,
      jsonSchema: INTENT_SCHEMA,
      timeoutMs,
    });
    const parsed = (res.parsed ??
      JSON.parse(res.text)) as { intent?: string; confidence?: number };
    const intent =
      typeof parsed.intent === "string" &&
      (VALID_INTENTS as readonly string[]).includes(parsed.intent)
        ? (parsed.intent as Tier0Intent)
        : "unknown";
    const confidence =
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0;
    return { intent, confidence, source: "claude" };
  } catch (err) {
    const reason =
      err instanceof ClaudeError ? err.kind : err instanceof Error ? err.message : String(err);
    log.warn({ reason }, "tier0 claude classify failed; falling back to regex");
    const r = fallback(text);
    return { intent: r.intent, confidence: r.confidence, source: "fallback" };
  }
}

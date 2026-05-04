/**
 * Tier-0 free-text intent classifier — Phase 5 stub.
 *
 * Per `RESUME_PROMPT.md` §10 deliverable 4: real Tier-0 = Ollama llama3.2:3b
 * (Phase 6, alongside Whisper). Phase 5 ships a deterministic regex matcher
 * so smoke tests pass without an Ollama install. Same return shape as the
 * future Ollama path — drop-in replacement when Phase 6 lands.
 *
 * Output `intent` matches the inbox-row vocabulary the orchestrator (Phase 8)
 * will dispatch on. Add intents here as they are needed.
 */
export type FreeTextIntent =
  | "code_task" // implementer dispatch (fix / add / build / etc.)
  | "review" // sensor + reviewer pass without code change
  | "direction" // candidate decision change ("/direction" without slash)
  | "question" // operator clarification, no dispatch
  | "halt" // operator wants something stopped
  | "status" // operator wants current state
  | "unknown"; // classifier could not match — orchestrator surfaces dialog

interface ClassifyRule {
  intent: FreeTextIntent;
  pattern: RegExp;
}

const RULES: readonly ClassifyRule[] = [
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

export function classifyFreeText(text: string): {
  intent: FreeTextIntent;
  confidence: number;
} {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      return { intent: rule.intent, confidence: 0.6 };
    }
  }
  return { intent: "unknown", confidence: 0 };
}

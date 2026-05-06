/**
 * Brand inference — Haiku-derived overview / voice / personas / avoid
 * from project signals (README + CLAUDE.md / AGENTS.md tone +
 * mapper's domain_summary). Called by Phase 5-brand auto-fill so the
 * adopted project gets meaningful brand drafts instead of mechanical
 * defaults. Falls back to the mechanical defaults when the call fails
 * — the result shape always matches `BrandAnswers`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runClaude } from "../claude/index.js";
import { logger } from "../logger.js";
import type { BrandAnswers } from "./brand-setup.js";

const log = logger("init.brand-derive");

const TIMEOUT_MS = 30_000;
const README_CHARS = 800;
const RULES_CHARS = 1_000;

const SYSTEM_PROMPT = `You write SHORT brand-identity drafts for a software project, given:
  - the project slug
  - a one-sentence domain summary (what the project does)
  - the README first 800 chars (if any)
  - the CLAUDE.md / AGENTS.md tone signals (if any)

Return STRICT JSON matching the schema below. No markdown, no
preamble. Each field is a tight, scannable paragraph the operator
will refine — not marketing copy.

Field guidance:
  - overview: 1 paragraph, ≤120 words. What the product is + its
    personality + tone + what it avoids. Ground every claim in
    the input signals; don't speculate beyond them.
  - voice: 1 paragraph, ≤80 words. How the brand TALKS (register,
    sentence shape, vocabulary). Match the existing CLAUDE.md /
    AGENTS.md tone if those files set a register; otherwise default
    to short, direct, project-aware.
  - avoid: 1 paragraph, ≤60 words. What's off-limits — generic
    marketing language, speculative claims about behavior the code
    doesn't implement, anything contradicting cited DECs / §INVs.
  - personas: 1-3 entries, each with {name (kebab-case),
    description (≤120 chars)}. Default \`name=primary\` when only
    one user type is evident.

Never invent product features that aren't in the input signals.
Never reference real companies, real customers, or real people.`;

const OUTPUT_SCHEMA: object = {
  type: "object",
  required: ["overview", "voice", "avoid", "personas"],
  properties: {
    overview: { type: "string", minLength: 1 },
    voice: { type: "string", minLength: 1 },
    avoid: { type: "string", minLength: 1 },
    personas: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        required: ["name", "description"],
        properties: {
          name: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

interface DerivedBrand {
  overview: string;
  voice: string;
  avoid: string;
  personas: { name: string; description: string }[];
}

interface DeriveArgs {
  repoRoot: string;
  projectSlug: string;
  domainSummary: string;
}

function readSignalFile(repoRoot: string, name: string, cap: number): string | null {
  const path = join(repoRoot, name);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return raw.length > cap ? raw.slice(0, cap) : raw;
  } catch {
    return null;
  }
}

function buildUserPrompt(args: DeriveArgs): string {
  const readme = readSignalFile(args.repoRoot, "README.md", README_CHARS);
  const agents = readSignalFile(args.repoRoot, "AGENTS.md", RULES_CHARS);
  const claudeMd = readSignalFile(args.repoRoot, "CLAUDE.md", RULES_CHARS);

  const lines: string[] = [];
  lines.push(`Project slug: ${args.projectSlug}`);
  lines.push("");
  lines.push("Domain summary (mapper output):");
  lines.push(args.domainSummary);
  lines.push("");
  if (readme !== null) {
    lines.push("README.md (first 800 chars):");
    lines.push(readme);
    lines.push("");
  }
  if (agents !== null) {
    lines.push("AGENTS.md (first 1000 chars — tone signal):");
    lines.push(agents);
    lines.push("");
  }
  if (claudeMd !== null) {
    lines.push("CLAUDE.md (first 1000 chars — tone signal):");
    lines.push(claudeMd);
    lines.push("");
  }
  return lines.join("\n");
}

export async function deriveBrandFromProject(
  args: DeriveArgs,
): Promise<DerivedBrand | null> {
  try {
    const result = await runClaude({
      tier: "haiku",
      prompt: buildUserPrompt(args),
      system: SYSTEM_PROMPT,
      jsonSchema: OUTPUT_SCHEMA,
      timeoutMs: TIMEOUT_MS,
    });
    const parsed = result.parsed;
    if (typeof parsed !== "object" || parsed === null) return null;
    const v = parsed as Record<string, unknown>;
    const overview = typeof v["overview"] === "string" ? v["overview"] : null;
    const voice = typeof v["voice"] === "string" ? v["voice"] : null;
    const avoid = typeof v["avoid"] === "string" ? v["avoid"] : null;
    const rawPersonas = Array.isArray(v["personas"]) ? v["personas"] : null;
    if (overview === null || voice === null || avoid === null || rawPersonas === null) {
      log.warn(
        { hasOverview: overview !== null, hasVoice: voice !== null, hasAvoid: avoid !== null, hasPersonas: rawPersonas !== null },
        "brand-derive: missing fields in Haiku response",
      );
      return null;
    }
    const personas: { name: string; description: string }[] = [];
    for (const entry of rawPersonas) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e["name"] === "string" && typeof e["description"] === "string") {
        personas.push({ name: e["name"], description: e["description"] });
      }
    }
    if (personas.length === 0) return null;
    return { overview, voice, avoid, personas };
  } catch (err) {
    log.warn({ err: String(err) }, "brand-derive: Haiku call failed");
    return null;
  }
}

/**
 * Convert derived brand to the `BrandAnswers` shape consumed by
 * `applyBrandAnswers`. Combines voice + avoid since the brand voice
 * file already takes both. Personas collapse to the first entry's
 * description (multi-persona support → v0.4 schema extension).
 */
export function derivedToBrandAnswers(d: DerivedBrand): BrandAnswers {
  return {
    whatItDoes: d.overview,
    mainUsers: d.personas.map((p) => `${p.name}: ${p.description}`).join(" · "),
    voice: d.voice,
    avoid: d.avoid,
  };
}

/**
 * 0005 — demote auto-filled brand drafts back to `status: draft`.
 *
 * Before 0.25.0, the adoption brand step DEFAULTED to auto-fill and, on
 * apply, flipped each written file `draft → current`. SessionStart then
 * injected every `current` brand file as authoritative voice — so a
 * generic, machine-written first draft (or the mechanical fallback when
 * the Haiku derive timed out) burned context every session as if the
 * operator had confirmed it.
 *
 * 0.25.0 fixed this going forward (auto-fill writes `draft`; SessionStart
 * injects only confirmed brand). This migration repairs EXISTING repos:
 * it finds brand/product docs that are provably auto-generated yet marked
 * `current`/`accepted`, and demotes them to `draft` so they stop being
 * injected. Operator-written brand is left alone; a demoted file is one
 * frontmatter edit (or a re-run of brand setup) away from `current` again.
 *
 * `review`-class: it rewrites committed ground state, so it surfaces for
 * the operator and applies via `cairn migrate` — never silently.
 *
 * Ships in 0.26.0, so `introducedIn` is 0.26.0 (not 0.25.0): a repo whose
 * pin already advanced to 0.25.0 must still re-evaluate it. `detect()`
 * carries correctness.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cairnDir, parseFrontmatter } from "@isaacriehm/cairn-state";
import type { Migration, MigrationResult } from "../types.js";

/** Distinctive substrings only the pre-0.25.0 mechanical fallback emits. */
const VOICE_MARKER =
  "Match the existing tone in CLAUDE.md / AGENTS.md if those files set a register";
const AVOID_MARKER =
  'Marketing fluff ("world-class", "revolutionary", "game-changing")';
const PERSONAS_MARKER = "Refine when adding consumer-facing or external personas";

interface BrandDoc {
  /** Repo-relative label for reporting. */
  rel: string;
  /** Absolute path under the (ghost-aware) state home. */
  abs: string;
}

function brandDocs(repoRoot: string): BrandDoc[] {
  return [
    { rel: "brand/overview.md", abs: cairnDir(repoRoot, "ground", "brand", "overview.md") },
    { rel: "brand/voice.md", abs: cairnDir(repoRoot, "ground", "brand", "voice.md") },
    { rel: "product/positioning.md", abs: cairnDir(repoRoot, "ground", "product", "positioning.md") },
    { rel: "product/personas.yaml", abs: cairnDir(repoRoot, "ground", "product", "personas.yaml") },
  ];
}

interface ParsedDoc {
  status: string | null;
  body: string;
  raw: string;
}

function readDoc(abs: string): ParsedDoc | null {
  if (!existsSync(abs)) return null;
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  // personas.yaml is pure YAML (status as a top-level key, no `---` fence);
  // the brand .md files use frontmatter. parseFrontmatter handles the .md;
  // for the .yaml fall back to a status-line scan over the whole text.
  const parsed = parseFrontmatter(raw);
  const fm = (parsed.frontmatter ?? {}) as Record<string, unknown>;
  let status =
    typeof fm["status"] === "string" ? (fm["status"] as string) : null;
  if (status === null) {
    const m = raw.match(/^status:\s*(\S+)\s*$/m);
    status = m?.[1] ?? null;
  }
  return { status, body: parsed.body, raw };
}

const CONFIRMED = new Set(["current", "accepted"]);

/** Strip headings + collapse whitespace, matching SessionStart's dedup. */
function normalize(s: string): string {
  return s
    .replace(/^\s*#{1,6}\s+.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Repo-relative labels of confirmed brand docs that are provably the
 * pre-0.25.0 auto-fill output:
 *   - voice.md carrying a mechanical-default marker,
 *   - personas.yaml carrying the placeholder marker,
 *   - overview.md and positioning.md whose bodies are byte-identical
 *     (auto-fill wrote the same domain summary to both; a hand-written
 *     pair would diverge).
 */
function autofilledConfirmed(repoRoot: string): string[] {
  const docs = brandDocs(repoRoot);
  const byRel = new Map<string, ParsedDoc | null>();
  for (const d of docs) byRel.set(d.rel, readDoc(d.abs));

  const hits = new Set<string>();
  const confirmed = (rel: string): ParsedDoc | null => {
    const p = byRel.get(rel) ?? null;
    return p !== null && p.status !== null && CONFIRMED.has(p.status) ? p : null;
  };

  const voice = confirmed("brand/voice.md");
  if (voice && (voice.body.includes(VOICE_MARKER) || voice.body.includes(AVOID_MARKER))) {
    hits.add("brand/voice.md");
  }
  const personas = confirmed("product/personas.yaml");
  if (personas && personas.raw.includes(PERSONAS_MARKER)) {
    hits.add("product/personas.yaml");
  }
  const overview = confirmed("brand/overview.md");
  const positioning = confirmed("product/positioning.md");
  if (
    overview &&
    positioning &&
    normalize(overview.body).length > 0 &&
    normalize(overview.body) === normalize(positioning.body)
  ) {
    hits.add("brand/overview.md");
    hits.add("product/positioning.md");
  }
  return [...hits];
}

/** Rewrite the first `status: current|accepted` line to `status: draft`. */
function demoteToDraft(abs: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return false;
  }
  const next = raw.replace(/^status:\s*(current|accepted)\s*$/m, "status: draft");
  if (next === raw) return false;
  try {
    writeFileSync(abs, next, "utf8");
  } catch {
    return false;
  }
  return true;
}

export const demoteAutofilledBrand: Migration = {
  id: "0005-demote-autofilled-brand",
  introducedIn: "0.26.0",
  describe:
    "Demote auto-generated brand drafts (marked confirmed before 0.25.0) back to status: draft so generic voice/positioning stops being injected every session",
  class: "review",
  detect(repoRoot: string): boolean {
    return autofilledConfirmed(repoRoot).length > 0;
  },
  apply(repoRoot: string): MigrationResult {
    const docs = brandDocs(repoRoot);
    const relToAbs = new Map(docs.map((d) => [d.rel, d.abs]));
    const targets = autofilledConfirmed(repoRoot);
    const demoted: string[] = [];
    for (const rel of targets) {
      const abs = relToAbs.get(rel);
      if (abs !== undefined && demoteToDraft(abs)) demoted.push(rel);
    }
    return {
      changed: demoted.length > 0,
      detail:
        demoted.length > 0
          ? `demoted ${demoted.length} auto-generated brand doc(s) to draft: ${demoted.join(", ")} — review and set status: current on any you actually wrote`
          : "no auto-generated confirmed brand docs found",
    };
  },
};

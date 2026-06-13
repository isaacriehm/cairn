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
 * The 0.26.0 detection only caught the mechanical fallback (fixed marker
 * strings) and the byte-identical overview/positioning pair — it missed
 * Haiku-derived auto-fill (voice.md / personas.yaml), which is worded
 * freshly each run. 0.27.0 adds a co-generation cohort channel: once the
 * overview≡positioning identity proves the pass auto-filled brand, every
 * confirmed doc stamped with the same `generated` timestamp is demoted too.
 *
 * `review`-class: it rewrites committed ground state, so it surfaces for
 * the operator and applies via `cairn migrate` — never silently.
 *
 * The cohort channel ships in 0.27.0, so `introducedIn` advances to 0.27.0:
 * a repo that already ran the 0.26.0 pass (demoting only the pair) must
 * re-evaluate to catch the co-generated siblings. `detect()` carries
 * correctness.
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
  /** The adoption pass stamps every co-generated doc the same `generated`. */
  generated: string | null;
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
  let generated =
    typeof fm["generated"] === "string" ? (fm["generated"] as string) : null;
  if (generated === null) {
    const g = raw.match(/^generated:\s*(\S+)\s*$/m);
    generated = g?.[1] ?? null;
  }
  return { status, generated, body: parsed.body, raw };
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
 * pre-0.25.0 auto-fill output. Two evidence channels:
 *
 *   1. Per-doc markers — voice.md / personas.yaml carrying a mechanical
 *      fallback's distinctive string. Precise but narrow: it ONLY catches
 *      the timeout fallback, never the Haiku-derived auto-fill (which is
 *      worded freshly each run and so carries no fixed marker).
 *
 *   2. Co-generation cohort — overview.md and positioning.md with
 *      byte-identical bodies is near-certain auto-fill proof (a hand-author
 *      doesn't write the exact same domain summary into two files). When
 *      that fires, every confirmed brand doc stamped with the SAME
 *      `generated` timestamp came out of the same automated pass and is
 *      demoted too. This is what catches a Haiku-derived voice.md the
 *      marker channel misses. The identity check is status-independent —
 *      an earlier run may have already demoted the pair to draft, yet its
 *      still-confirmed siblings must follow.
 *
 * A demoted file is one frontmatter edit from `current` again, so the
 * asymmetry favors demoting: a false demote costs one keystroke, a false
 * keep burns context every session as machine-written "authoritative" voice.
 */
function autofilledConfirmed(repoRoot: string): string[] {
  const docs = brandDocs(repoRoot);
  const byRel = new Map<string, ParsedDoc | null>();
  for (const d of docs) byRel.set(d.rel, readDoc(d.abs));

  const hits = new Set<string>();
  const get = (rel: string): ParsedDoc | null => byRel.get(rel) ?? null;
  const confirmed = (rel: string): ParsedDoc | null => {
    const p = get(rel);
    return p !== null && p.status !== null && CONFIRMED.has(p.status) ? p : null;
  };

  // Channel 1 — per-doc mechanical-fallback markers.
  const voice = confirmed("brand/voice.md");
  if (voice && (voice.body.includes(VOICE_MARKER) || voice.body.includes(AVOID_MARKER))) {
    hits.add("brand/voice.md");
  }
  const personas = confirmed("product/personas.yaml");
  if (personas && personas.raw.includes(PERSONAS_MARKER)) {
    hits.add("product/personas.yaml");
  }

  // Channel 2 — co-generation cohort, proven by the overview≡positioning
  // identity (checked regardless of either doc's current status).
  const overviewAny = get("brand/overview.md");
  const positioningAny = get("product/positioning.md");
  const pairAutofilled =
    overviewAny !== null &&
    positioningAny !== null &&
    normalize(overviewAny.body).length > 0 &&
    normalize(overviewAny.body) === normalize(positioningAny.body);

  if (pairAutofilled) {
    // Cohort timestamp — the pass stamps every co-generated doc identically.
    const cohortGen = overviewAny.generated ?? positioningAny.generated;
    // overview/positioning are themselves cohort members; demote if still confirmed.
    if (confirmed("brand/overview.md")) hits.add("brand/overview.md");
    if (confirmed("product/positioning.md")) hits.add("product/positioning.md");
    // A confirmed voice.md sharing the cohort timestamp is the same pass's
    // output — the timestamp guard spares a voice the operator hand-wrote later.
    if (voice && cohortGen !== null && voice.generated === cohortGen) {
      hits.add("brand/voice.md");
    }
    // personas.yaml carries no `generated`; it's the lowest-value, most
    // placeholder-prone doc, so the pair-proof alone demotes a confirmed one.
    if (personas) hits.add("product/personas.yaml");
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
  introducedIn: "0.27.0",
  describe:
    "Demote auto-generated brand (marked confirmed before 0.25.0) back to status: draft so machine-written voice/positioning/personas stops being injected every session — now catches the full co-generated cohort, not just the mechanical fallback",
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

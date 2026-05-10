/**
 * Phase 5-preflight — count the units the long Haiku phases will
 * process (markdown paragraphs, essay-class comment blocks, rule
 * sections, jaccard pair estimate), then compute an aggregate ETA
 * by multiplying counts against the per-machine calibration cache.
 *
 * No operator input. Always advances. Output is consumed by the
 * cairn-adopt skill which renders a single banner immediately after
 * this phase so the operator sees an honest pre-commit estimate
 * before the long phases (7-topic-index → 10-rules-merge) start.
 *
 * Pilot scoping is gone — adoption always covers the whole repo.
 * The operator can narrow surface area post-adoption via
 * `cairn scope` if desired.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { walkFs } from "@isaacriehm/cairn-state";
import { walkSourceComments } from "../source-comments/walker.js";
import { discoverRuleSources } from "../rules-merge/discover.js";
import { parseRuleSections } from "../rules-merge/parse-sections.js";
import { readCalibration, type EtaPhase } from "../eta-calibration.js";
import { advancePhase, isSelfAdoptState } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

/** Hard upper bound on jaccard pair-judge calls (matches phase 7 cap). */
const JACCARD_PAIR_CAP = 200;

/** Skip dirs for the markdown walk — match the source walker's set. */
const DOC_SKIP_DIRS = new Set<string>([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  "vendor",
  ".venv",
  ".direnv",
  ".cache",
  "coverage",
  ".next",
  ".turbo",
  ".cairn",
  ".archive",
]);

export interface PreflightUnits {
  docFiles: number;
  docParagraphs: number;
  sourceFiles: number;
  essayBlocks: number;
  ruleH2Sections: number;
  jaccardPairsEstimate: number;
}

export interface PreflightEta {
  /** Best-case seconds per phase (units × calibrated rate). */
  perPhaseSeconds: Record<EtaPhase, number>;
  /** Sum across all four long phases. */
  totalSeconds: number;
  /** Buffered upper bound (totalSeconds × 1.5) for jitter / throttling. */
  totalSecondsHigh: number;
}

export interface PreflightOutput {
  units: PreflightUnits;
  eta: PreflightEta;
  /** Lines the cairn-adopt skill should render verbatim as the ETA banner. */
  bannerLines: string[];
  /** True when self-adopt skipped the unit scan. */
  skipped?: "self-adopt";
}

export async function runPhase5Preflight(state: PhaseState): Promise<PhaseResult> {
  if (isSelfAdoptState(state)) {
    const skipped: PreflightOutput = {
      units: emptyUnits(),
      eta: zeroEta(),
      bannerLines: ["Self-adopt mode — long phases skipped, no ETA estimate."],
      skipped: "self-adopt",
    };
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "5-preflight": skipped },
    };
    return {
      status: "complete",
      nextPhase: "6-brand",
      state: advancePhase(next),
    };
  }

  const units = countUnits(state.repoRoot);
  const eta = estimateEta(units);
  const bannerLines = renderBanner(units, eta);

  const out: PreflightOutput = { units, eta, bannerLines };
  const next: PhaseState = {
    ...state,
    outputs: { ...state.outputs, "5-preflight": out },
  };
  return {
    status: "complete",
    nextPhase: "6-brand",
    state: advancePhase(next),
  };
}

function emptyUnits(): PreflightUnits {
  return {
    docFiles: 0,
    docParagraphs: 0,
    sourceFiles: 0,
    essayBlocks: 0,
    ruleH2Sections: 0,
    jaccardPairsEstimate: 0,
  };
}

function zeroEta(): PreflightEta {
  return {
    perPhaseSeconds: {
      "7-topic-index": 0,
      "8-docs-ingest": 0,
      "9-source-comments": 0,
      "10-rules-merge": 0,
    },
    totalSeconds: 0,
    totalSecondsHigh: 0,
  };
}

function countUnits(repoRoot: string): PreflightUnits {
  const docs = countDocs(repoRoot);
  const source = walkSourceComments({ repoRoot });
  const rules = countRuleH2(repoRoot);
  // Conservative jaccard pair estimate — phase 7 caps at 200 and the
  // hit rate on monorepos saturates quickly. Below 50 paragraphs, every
  // pair counts; above, assume the cap.
  const jaccardPairsEstimate =
    docs.paragraphs <= 50
      ? (docs.paragraphs * (docs.paragraphs - 1)) / 2
      : JACCARD_PAIR_CAP;
  return {
    docFiles: docs.files,
    docParagraphs: docs.paragraphs,
    sourceFiles: source.fileCountByLang
      ? Object.values(source.fileCountByLang).reduce((a, b) => a + b, 0)
      : source.files.length,
    essayBlocks: source.blocks.length,
    ruleH2Sections: rules,
    jaccardPairsEstimate: Math.min(JACCARD_PAIR_CAP, Math.round(jaccardPairsEstimate)),
  };
}

interface DocCounts {
  files: number;
  paragraphs: number;
}

function countDocs(repoRoot: string): DocCounts {
  let files = 0;
  let paragraphs = 0;
  // Repo-root markdown (README.md, CHANGELOG.md, AGENTS.md, etc.).
  for (const name of safeReaddir(repoRoot)) {
    if (!isMarkdown(name)) continue;
    const abs = join(repoRoot, name);
    const counts = countMarkdownFile(abs);
    if (counts !== null) {
      files += 1;
      paragraphs += counts.paragraphs;
    }
  }
  // docs/ subtree.
  const docsDir = join(repoRoot, "docs");
  if (existsSync(docsDir)) {
    walkFs({
      dir: docsDir,
      repoRoot,
      onDir: (_rel, _abs, ent) => {
        if (DOC_SKIP_DIRS.has(ent.name)) return false;
        return true;
      },
      onFile: (_rel, abs, ent) => {
        if (!isMarkdown(ent.name)) return;
        const counts = countMarkdownFile(abs);
        if (counts !== null) {
          files += 1;
          paragraphs += counts.paragraphs;
        }
      },
    });
  }
  return { files, paragraphs };
}

function isMarkdown(name: string): boolean {
  const ext = extname(name).toLowerCase();
  return ext === ".md" || ext === ".mdx";
}

function safeReaddir(dir: string): string[] {
  try {
    const ents = require("node:fs").readdirSync(dir) as string[];
    return ents;
  } catch {
    return [];
  }
}

function countMarkdownFile(absPath: string): { paragraphs: number } | null {
  try {
    const stat = statSync(absPath);
    // Skip giant files — phase 8 skips them too in practice (over a few
    // MB the embedding cost dominates and the operator usually wants
    // them excluded).
    if (stat.size > 2 * 1024 * 1024) return null;
    const body = readFileSync(absPath, "utf8");
    // Paragraph = run of non-empty lines, separated by blank line(s).
    const paragraphs = body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0).length;
    return { paragraphs };
  } catch {
    return null;
  }
}

function countRuleH2(repoRoot: string): number {
  const sources = discoverRuleSources(repoRoot);
  let total = 0;
  for (const src of sources) {
    try {
      const body = readFileSync(src.absPath, "utf8");
      const sections = parseRuleSections(body);
      // Phase 10 issues one Haiku call per H2 (level 2). H3 sections
      // ride along inside their parent H2's classification, so they
      // don't add to the call count.
      total += sections.filter((s) => s.level === 2).length;
    } catch {
      // Unreadable rule file — skip silently; phase 10 will surface it.
    }
  }
  return total;
}

function estimateEta(units: PreflightUnits): PreflightEta {
  const cal = readCalibration();
  const perPhaseSeconds: Record<EtaPhase, number> = {
    "7-topic-index":
      units.jaccardPairsEstimate * cal.phases["7-topic-index"].secondsPerUnit,
    "8-docs-ingest":
      units.docParagraphs * cal.phases["8-docs-ingest"].secondsPerUnit,
    "9-source-comments":
      units.essayBlocks * cal.phases["9-source-comments"].secondsPerUnit,
    "10-rules-merge":
      units.ruleH2Sections * cal.phases["10-rules-merge"].secondsPerUnit,
  };
  const totalSeconds =
    perPhaseSeconds["7-topic-index"] +
    perPhaseSeconds["8-docs-ingest"] +
    perPhaseSeconds["9-source-comments"] +
    perPhaseSeconds["10-rules-merge"];
  return {
    perPhaseSeconds,
    totalSeconds,
    totalSecondsHigh: totalSeconds * 1.5,
  };
}

function renderBanner(units: PreflightUnits, eta: PreflightEta): string[] {
  const totalLow = formatDuration(eta.totalSeconds);
  const totalHigh = formatDuration(eta.totalSecondsHigh);
  const lines: string[] = [];
  lines.push(
    `Indexing whole repo (${units.sourceFiles} source files, ${units.essayBlocks} essay-class comments, ${units.docFiles} docs / ${units.docParagraphs} paragraphs, ${units.ruleH2Sections} rule sections).`,
  );
  lines.push(
    `Estimated time: ${totalLow}–${totalHigh}. Live ETA on statusline. /exit safe — SessionStart resumes.`,
  );
  return lines;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins === 0 ? `${hours}h` : `${hours}h${remMins}m`;
}

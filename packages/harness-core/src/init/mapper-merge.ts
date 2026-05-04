/**
 * Merge call — synthesize per-module ModuleProposals into one MapperOutput.
 *
 * Per `docs/INIT_SPEC.md` §3:
 *   - Cheap Haiku call gets all proposals + the workspace-level package.json.
 *   - Task: dedupe overlapping sensor proposals (same id → keep highest
 *     confidence), pick pilot module (first pilotModuleCandidate, else
 *     highest confidence), merge highStakesGlobs / offLimitsGlobs, assemble
 *     final scope_index by union, set top-level domain summary.
 *   - If merge call fails: assemble MapperOutput mechanically from
 *     proposals (union arrays, first pilot candidate, no synthesized prose).
 *
 * Output is a `MapperOutput` matching the existing wire shape so downstream
 * init writers (workflow.md slug-block patcher, config.yaml builder, scope
 * index seeder) need no changes.
 */

import { runClaude } from "../claude/index.js";
import { logger } from "../logger.js";
import type {
  MapperKeyModule,
  MapperOutput,
  MapperProposedSensor,
  MapperScopeIndex,
} from "./mapper.js";
import type { ModuleProposal } from "./mapper-parallel.js";

const log = logger("init.mapper-merge");

const MERGE_TIMEOUT_MS = 90_000;

const MERGE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    pilot_module: { type: "string" },
    domain_summary: { type: "string" },
    notes: { type: "string" },
  },
  required: ["pilot_module", "domain_summary", "notes"],
} as const;

const MERGE_SYSTEM_PROMPT = [
  "You are the MERGE step for a code-agent harness adopting a new project.",
  "",
  "You receive per-module proposals from prior Sonnet calls (one per module). Your job is small and cheap:",
  "  1. Pick the `pilot_module` glob — bias toward the proposal where pilot_module_candidate is true. If multiple candidates, pick the one with highest confidence. If none, pick the highest-confidence module overall.",
  "  2. Write a 60-200 word `domain_summary` that synthesizes per-module domains into a single description of the whole project.",
  "  3. Write a short `notes` string covering anything cross-cutting (monorepo layout, shared packages, etc.). EMPTY string is fine.",
  "",
  "You DO NOT pick globs or sensors — those are unioned mechanically by the harness after your call. You only pick the pilot, write the summary, and add notes.",
  "",
  "Return ONLY the JSON object. No preamble.",
].join("\n");

export interface MergeArgs {
  proposals: ModuleProposal[];
  /** Workspace-level package.json content if present. */
  workspacePackageJson: string | null;
  /** Project slug for filling MapperOutput. */
  projectSlug: string;
}

export async function mergeModuleProposals(args: MergeArgs): Promise<MapperOutput> {
  // Mechanical assembly first — guaranteed even if Haiku call fails.
  const baseline = mechanicalMerge(args.proposals);

  // Fast path: if all proposals failed, no point calling Haiku.
  const successful = args.proposals.filter((p) => !p.failed);
  if (successful.length === 0) {
    log.warn(
      { total: args.proposals.length },
      "all module proposals failed; merge skipped",
    );
    return baseline;
  }

  // Haiku merge call — only synthesizes pilot pick + domain summary + notes.
  // If it fails, fall back to baseline (already complete).
  try {
    const userPrompt = buildMergeUserPrompt(args);
    const result = await runClaude({
      tier: "haiku",
      prompt: userPrompt,
      system: MERGE_SYSTEM_PROMPT,
      jsonSchema: MERGE_OUTPUT_SCHEMA as object,
      timeoutMs: MERGE_TIMEOUT_MS,
    });
    const parsed = result.parsed;
    if (typeof parsed !== "object" || parsed === null) return baseline;
    const v = parsed as Record<string, unknown>;
    const pilot = typeof v["pilot_module"] === "string" ? v["pilot_module"] : baseline.pilot_module;
    const summary =
      typeof v["domain_summary"] === "string" && v["domain_summary"].length > 0
        ? v["domain_summary"]
        : baseline.domain_summary;
    const notes = typeof v["notes"] === "string" ? v["notes"] : baseline.notes;
    return { ...baseline, pilot_module: pilot, domain_summary: summary, notes };
  } catch (err) {
    log.warn({ err: String(err) }, "merge call failed; using mechanical baseline");
    return baseline;
  }
}

/**
 * Build a MapperOutput from ModuleProposals without an LLM call.
 *
 *   - sensors: dedupe by id, keeping the variant with the highest module confidence.
 *   - globs: union across all proposals, deduped (string equality).
 *   - pilot_module: first proposal flagged as candidate; else highest-confidence proposal's path.
 *   - domain_summary: per-module domain lines joined.
 *   - key_modules: one entry per proposal, name = slug, path = moduleRel, purpose = domain.
 *   - scope_index: union of per-module file maps.
 *   - notes: list of any failed-module reasons.
 */
export function mechanicalMerge(proposals: ModuleProposal[]): MapperOutput {
  if (proposals.length === 0) {
    return emptyMapperOutput();
  }
  const successful = proposals.filter((p) => !p.failed);

  // pilot_module
  const candidates = successful.filter((p) => p.pilotModuleCandidate);
  const pilotProposal =
    candidates.length > 0
      ? sortByConfidence(candidates)[0]
      : successful.length > 0
        ? sortByConfidence(successful)[0]
        : proposals[0];
  const pilotPath =
    pilotProposal === undefined
      ? "ALL"
      : pilotProposal.moduleRel === "."
        ? "ALL"
        : `${pilotProposal.moduleRel}/**`;

  // domain_summary — concat per-module domain lines, capped to 600 chars.
  const summaryParts: string[] = [];
  for (const p of successful) {
    if (p.domain.length > 0) summaryParts.push(`${p.moduleSlug}: ${p.domain}`);
  }
  let domainSummary = summaryParts.join(" ");
  if (domainSummary.length === 0) domainSummary = "(no per-module domains produced)";
  if (domainSummary.length > 600) domainSummary = domainSummary.slice(0, 597) + "...";

  // key_modules
  const keyModules: MapperKeyModule[] = successful.map((p) => ({
    name: p.moduleSlug,
    path: p.moduleRel === "." ? "" : p.moduleRel,
    purpose: p.domain.length > 0 ? p.domain : "(no domain proposed)",
  }));

  // sensors — dedupe by id, keep highest-confidence variant.
  const sensorMap = new Map<string, { sensor: MapperProposedSensor; confidence: number }>();
  for (const p of successful) {
    for (const s of p.sensorProposals) {
      const existing = sensorMap.get(s.id);
      if (existing === undefined || existing.confidence < p.confidence) {
        sensorMap.set(s.id, { sensor: s, confidence: p.confidence });
      }
    }
  }
  const proposedSensors = [...sensorMap.values()].map((x) => x.sensor);

  // scope_index — union of per-module maps. On collision: union decisions + invariants.
  const scopeIndex: MapperScopeIndex = { files: {} };
  for (const p of successful) {
    for (const [path, entry] of Object.entries(p.scopeIndex.files)) {
      const existing = scopeIndex.files[path];
      if (existing === undefined) {
        const out: { decisions: string[]; invariants: string[]; unscoped?: true } = {
          decisions: [...entry.decisions],
          invariants: [...entry.invariants],
        };
        if (entry.unscoped === true) out.unscoped = true;
        scopeIndex.files[path] = out;
      } else {
        existing.decisions = [...new Set([...existing.decisions, ...entry.decisions])];
        existing.invariants = [...new Set([...existing.invariants, ...entry.invariants])];
        if (entry.unscoped === true) existing.unscoped = true;
      }
    }
  }

  // notes — failed module reasons + summary.
  const failed = proposals.filter((p) => p.failed);
  const notesParts: string[] = [];
  if (failed.length > 0) {
    notesParts.push(
      `${failed.length} module(s) failed mapper call: ${failed.map((p) => p.moduleSlug).join(", ")}`,
    );
  }
  if (proposals.length === 1 && proposals[0]?.moduleRel === ".") {
    notesParts.push("single-package repo — no module split");
  }
  const notes = notesParts.join(" — ");

  return {
    pilot_module: pilotPath,
    domain_summary: domainSummary,
    key_modules: keyModules,
    route_handler_globs: unionGlobs(successful, (p) => p.routeHandlerGlobs),
    dto_globs: unionGlobs(successful, (p) => p.dtoGlobs),
    generator_source_globs: unionGlobs(successful, (p) => p.generatorSourceGlobs),
    high_stakes_globs: unionGlobs(successful, (p) => p.highStakesGlobs),
    off_limits_globs: unionGlobs(successful, (p) => p.offLimitsGlobs),
    proposed_sensors: proposedSensors,
    notes,
    scope_index: scopeIndex,
  };
}

function unionGlobs(
  proposals: ModuleProposal[],
  pick: (p: ModuleProposal) => string[],
): string[] {
  const set = new Set<string>();
  for (const p of proposals) {
    for (const g of pick(p)) set.add(g);
  }
  return [...set];
}

function sortByConfidence(proposals: ModuleProposal[]): ModuleProposal[] {
  return [...proposals].sort((a, b) => b.confidence - a.confidence);
}

function emptyMapperOutput(): MapperOutput {
  return {
    pilot_module: "ALL",
    domain_summary: "",
    key_modules: [],
    route_handler_globs: [],
    dto_globs: [],
    generator_source_globs: [],
    high_stakes_globs: [],
    off_limits_globs: [],
    proposed_sensors: [],
    notes: "no module proposals available",
    scope_index: { files: {} },
  };
}

function buildMergeUserPrompt(args: MergeArgs): string {
  const parts: string[] = [];
  parts.push(`# Merge per-module proposals into a project-level summary`);
  parts.push("");
  parts.push(`Project slug: ${args.projectSlug}`);
  parts.push("");
  if (args.workspacePackageJson !== null) {
    parts.push("## Workspace-level package.json");
    parts.push("```json");
    parts.push(args.workspacePackageJson);
    parts.push("```");
    parts.push("");
  }
  parts.push("## Per-module proposals");
  for (const p of args.proposals) {
    if (p.failed) {
      parts.push(`### ${p.moduleSlug} (FAILED)`);
      parts.push(p.notes);
      parts.push("");
      continue;
    }
    parts.push(`### ${p.moduleSlug} — confidence ${p.confidence}`);
    parts.push(`Path: ${p.moduleRel}`);
    parts.push(`Domain: ${p.domain}`);
    parts.push(`Pilot candidate: ${p.pilotModuleCandidate}`);
    parts.push(`Notes: ${p.notes || "(none)"}`);
    parts.push("");
  }
  parts.push(
    `Now produce the JSON object: { pilot_module, domain_summary, notes }. Pilot must reference one of the module paths above (or the literal "ALL" for whole-repo).`,
  );
  return parts.join("\n");
}

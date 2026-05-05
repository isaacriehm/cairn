/**
 * Phase 3b-seed — write `.cairn/` skeleton + project overlay.
 *
 * Bridges 3-mapper and 4-pilot. Without this phase the v0.2.0 init
 * pipeline produced an `.cairn/` populated only by side effects of
 * downstream phases (events/, baseline/, ground/decisions/_inbox/)
 * but never wrote `config.yaml`, `git-hooks/`, or the brand /
 * canonical-map / capabilities skeleton — leaving the project in a
 * "half-adopted" shape that subsequent SessionStarts could not
 * detect as adopted.
 *
 * This phase wraps the same three steps the legacy `runInit` does:
 *   1. seedCairnLayout (templates → .cairn/)
 *   2. updateWorkflowSlugBlock (mapper output → workflow.md)
 *   3. write .cairn/config.yaml + .cairn/ground/scope-index.yaml
 *
 * No operator input. Always advances. Idempotent — re-running on a
 * project that already has .cairn/ keeps existing files (collisions
 * recorded in seed.collisions but not fatal).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  scopeIndexPath,
  writeScopeIndex,
  type ScopeIndex,
  type ScopeIndexEntry,
} from "../../ground/scope-index.js";
import type { MapperResult } from "../mapper.js";
import { buildProjectOverlay } from "../overlay.js";
import { seedCairnLayout } from "../seed.js";
import type { DetectionResult } from "../types.js";
import { updateWorkflowSlugBlock } from "../workflow-block.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

interface SeedPhaseOutput {
  written_files: string[];
  collisions: string[];
  config_path: string;
  scope_index_path: string;
  workflow_slug_patched: boolean;
}

export async function runPhase3bSeed(state: PhaseState): Promise<PhaseResult> {
  const detection = state.outputs["1-detect"] as DetectionResult | undefined;
  const mapperResult = state.outputs["3-mapper"] as MapperResult | undefined;
  if (detection === undefined) {
    return {
      status: "error",
      error: {
        code: "missing-prereqs",
        message: "Phase 3b-seed needs phase 1-detect output",
      },
      state,
    };
  }
  const projectSlug = detection.project_slug;
  const mapperOutput = mapperResult?.output;

  try {
    // Step 1 — seed templates into .cairn/.
    const seed = seedCairnLayout({ repoRoot: state.repoRoot, projectSlug });

    // Step 2 — patch <slug>: workflow.md block when workflow.md was
    // freshly seeded (existing workflow stays untouched on re-run).
    const wfRel = ".cairn/config/workflow.md";
    const wfWasSeeded = seed.written_files.includes(wfRel);
    let workflowSlugPatched = false;
    if (mapperOutput !== undefined && wfWasSeeded) {
      try {
        updateWorkflowSlugBlock({
          workflowMdPath: join(state.repoRoot, wfRel),
          slug: projectSlug,
          update: {
            pilot_module: mapperOutput.pilot_module,
            route_handler_globs: mapperOutput.route_handler_globs,
            dto_globs: mapperOutput.dto_globs,
            generator_source_globs: mapperOutput.generator_source_globs,
            high_stakes_globs: mapperOutput.high_stakes_globs,
            off_limits_append: mapperOutput.off_limits_globs,
          },
        });
        workflowSlugPatched = true;
      } catch (err) {
        // Soft fail — config.yaml still gets written below; the operator
        // can hand-edit workflow.md after init. Don't abort adoption for
        // a workflow patch error.
        return {
          status: "error",
          error: {
            code: "workflow-patch-failed",
            message: `workflow.md slug-block update failed for ${projectSlug}`,
            detail:
              err instanceof Error ? err.stack ?? err.message : String(err),
          },
          state,
        };
      }
    }

    // Step 3 — write .cairn/config.yaml.
    const configPath = join(state.repoRoot, ".cairn", "config.yaml");
    mkdirSync(join(state.repoRoot, ".cairn"), { recursive: true });
    if (!existsSync(configPath)) {
      const config = buildProjectOverlay({
        detection,
        decidedSlug: projectSlug,
        ...(mapperOutput !== undefined ? { mapperOutput } : {}),
      });
      writeFileSync(configPath, stringifyYaml(config), "utf8");
    }

    // Step 4 — write .cairn/ground/scope-index.yaml from mapper.
    const scopeFile = scopeIndexPath(state.repoRoot);
    if (!existsSync(scopeFile)) {
      const seedFiles: Record<string, ScopeIndexEntry> = {};
      const mapperFiles = mapperOutput?.scope_index?.files ?? {};
      for (const [path, e] of Object.entries(mapperFiles)) {
        const entry: ScopeIndexEntry = {
          decisions: e.decisions,
          invariants: e.invariants,
        };
        if (e.unscoped === true) entry.unscoped = true;
        seedFiles[path] = entry;
      }
      writeScopeIndex(state.repoRoot, {
        generated: new Date().toISOString(),
        files: seedFiles,
      });
    }

    const out: SeedPhaseOutput = {
      written_files: seed.written_files,
      collisions: seed.collisions,
      config_path: ".cairn/config.yaml",
      scope_index_path: ".cairn/ground/scope-index.yaml",
      workflow_slug_patched: workflowSlugPatched,
    };
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "3b-seed": out },
    };
    return {
      status: "complete",
      nextPhase: "4-pilot",
      state: advancePhase(next),
    };
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "seed-failed",
        message: "Failed to seed .cairn/ skeleton",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
}

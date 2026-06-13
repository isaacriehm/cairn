/**
 * Phase 4-seed — write `.cairn/` skeleton + project overlay +
 * grandfather pre-adoption commits.
 *
 * Steps:
 *   1. seedCairnLayout (templates → .cairn/)
 *   2. updateWorkflowSlugBlock (mapper output → workflow.md)
 *   3. write .cairn/config.yaml + .cairn/ground/scope-index.yaml
 *   4. seed .cairn/.attested-commits with every reachable HEAD SHA
 *      so the Stop-hook bypass detector grandfathers pre-adoption
 *      history.
 *
 * No operator input. Always advances. Idempotent — re-running on a
 * project that already has .cairn/ keeps existing files (collisions
 * recorded in seed.collisions but not fatal).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { stringify as stringifyYaml } from "yaml";
import { cairnDir,
  scopeIndexPath,
  writeScopeIndex,
  type ScopeIndexEntry,
} from "@isaacriehm/cairn-state";
import { seedAttestedCommits } from "../../hooks/seed-attested.js";
import { detectComponentsConfig } from "../detect-components.js";
import { buildProjectOverlay } from "../overlay.js";
import { seedCairnLayout } from "../seed.js";
import { updateWorkflowSlugBlock } from "../workflow-block.js";
import { readMapperOutputFile } from "./mapper-output-io.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState, SeedPhaseOutput } from "./types.js";

export async function runPhase4Seed(state: PhaseState): Promise<PhaseResult> {
  const detection = state.outputs["1-detect"];
  const mapperResult = state.outputs["3-mapper"];
  if (detection === undefined) {
    return {
      status: "error",
      error: {
        code: "missing-prereqs",
        message: "Phase 4-seed needs phase 1-detect output",
      },
      state,
    };
  }
  const projectSlug = detection.project_slug;
  const mapperOutput = mapperResult?.output;
  // scope_index lives in the side file (it's the heaviest field in the
  // mapper payload); reload it lazily for the seed step.
  const mapperFull = readMapperOutputFile(state.repoRoot);

  try {
    // Step 1 — seed templates into .cairn/. Stamp the real adoption time
    // into every `<seed_timestamp>` token (one clock read for the pass).
    const seed = seedCairnLayout({
      repoRoot: state.repoRoot,
      projectSlug,
      nowIso: new Date().toISOString(),
    });

    // Step 2 — patch <slug>: workflow.md block when workflow.md was
    // freshly seeded (existing workflow stays untouched on re-run).
    const wfRel = ".cairn/config/workflow.md";
    const wfWasSeeded = seed.written_files.includes(wfRel);
    let workflowSlugPatched = false;
    let workflowPatchError: string | null = null;
    if (mapperOutput !== undefined && wfWasSeeded) {
      try {
        updateWorkflowSlugBlock({
          // Resolve through cairnHome — the seed wrote workflow.md out-of-repo
          // in ghost, so an in-repo `join(repoRoot, …)` would patch a file that
          // doesn't exist (silent soft-fail, unpatched slug block).
          workflowMdPath: cairnDir(state.repoRoot, "config", "workflow.md"),
          slug: projectSlug,
          update: {
            off_limits_append: mapperOutput.off_limits_globs,
          },
        });
        workflowSlugPatched = true;
      } catch (err) {
        // Soft fail — record the error and continue. config.yaml +
        // scope-index still get written below; the operator can
        // hand-edit workflow.md after init if needed.
        workflowPatchError =
          err instanceof Error ? err.stack ?? err.message : String(err);
      }
    }

    // Step 3 — write .cairn/config.yaml.
    const configPath = cairnDir(state.repoRoot, "config.yaml");
    mkdirSync(cairnDir(state.repoRoot), { recursive: true });
    if (!existsSync(configPath)) {
      const config = buildProjectOverlay({
        detection,
        decidedSlug: projectSlug,
        ...(mapperOutput !== undefined ? { mapperOutput } : {}),
      });
      // Attach a detected `components:` block (LLM-driven, agnostic — no
      // convention list). Null for non-UI repos — the key is simply
      // omitted, so the whole component store stays inert. overlay.ts is
      // pure (no IO); the detection lives here where 4-seed already does IO.
      const components = await detectComponentsConfig(state.repoRoot);
      if (components !== null) config["components"] = components;
      writeFileSync(configPath, stringifyYaml(config), "utf8");
    }

    // Step 4 — write .cairn/ground/scope-index.yaml from mapper.
    const scopeFile = scopeIndexPath(state.repoRoot);
    if (!existsSync(scopeFile)) {
      const seedFiles: Record<string, ScopeIndexEntry> = {};
      const mapperFiles = mapperFull?.output.scope_index?.files ?? {};
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

    // Step 5 — grandfather pre-adoption commits in
    // `.cairn/.attested-commits` so the Stop-hook bypass detector
    // doesn't flag every pre-existing SHA on the next turn.
    const attestedSeed = seedAttestedCommits(state.repoRoot);

    const out: SeedPhaseOutput = {
      written_files: seed.written_files,
      collisions: seed.collisions,
      config_path: ".cairn/config.yaml",
      scope_index_path: ".cairn/ground/scope-index.yaml",
      workflow_slug_patched: workflowSlugPatched,
      workflow_patch_error: workflowPatchError,
      attested_seeded: attestedSeed.count ?? 0,
      attested_seed_status: attestedSeed.status,
    };
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "4-seed": out },
    };
    return {
      status: "complete",
      nextPhase: "5-preflight",
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

/**
 * Phase 9d-comp-walk — list component files missing a `@cairn` header.
 *
 * Deterministic (no LLM), the first leg of the component trio
 * (9d-comp-walk → 9e-comp-annotate → 9f-comp-emit). Writes a corpus of
 * un-headered component files to `.cairn/init/components/missing.jsonl`
 * for the skill-driven annotate step to work from. Each record carries
 * the best-effort detected export name (the likely `@cairn` value) and
 * the workspace's category taxonomy so the annotator picks a valid
 * `@category`.
 *
 * No-ops on self-adopt or when the project carries no `components:`
 * config — those skip the WHOLE trio straight to `10-rules-merge`, so
 * non-UI repos are untouched.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cairnDir,
  collectComponents,
  extractExportName,
  hasComponentConfig,
  loadComponentsConfig,
  type ComponentWorkspace,
  type NormalizedComponentsConfig,
} from "@isaacriehm/cairn-state";
import { advancePhase, isSelfAdoptState } from "./orchestrator.js";
import type { CompWalkOutput, PhaseResult, PhaseState } from "./types.js";

export const COMP_MISSING_PATH = join(
  ".cairn",
  "init",
  "components",
  "missing.jsonl",
);

/** One un-headered component file the annotate step should fill. */
interface MissingHeaderRecord {
  file: string;
  workspace: string;
  /** Best-effort detected export name — the likely `@cairn` value. */
  export_name: string | null;
  /** The workspace's category taxonomy (annotator picks from this). */
  categories: string[];
}

/** Longest-prefix match of a repo-relative file to its owning workspace. */
function resolveWorkspace(
  file: string,
  config: NormalizedComponentsConfig,
): ComponentWorkspace | null {
  let best: ComponentWorkspace | null = null;
  let bestLen = -1;
  for (const ws of config.workspaces) {
    for (const d of ws.componentDirs) {
      if ((file === d || file.startsWith(`${d}/`)) && d.length > bestLen) {
        bestLen = d.length;
        best = ws;
      }
    }
  }
  return best;
}

export async function runPhase9dCompWalk(
  state: PhaseState,
): Promise<PhaseResult> {
  // Skip the whole component trio for self-adopt / non-UI repos —
  // jump currentPhase straight to 10-rules-merge so the skill loop
  // never visits 9e / 9f.
  const skipToRulesMerge = (out: CompWalkOutput): PhaseResult => ({
    status: "complete",
    nextPhase: "10-rules-merge",
    state: {
      ...state,
      outputs: { ...state.outputs, "9d-comp-walk": out },
      currentPhase: "10-rules-merge",
      answer: undefined,
    },
  });

  if (isSelfAdoptState(state)) {
    return skipToRulesMerge({ skipped: "self-adopt" });
  }
  const config = loadComponentsConfig(state.repoRoot);
  if (!hasComponentConfig(config)) {
    return skipToRulesMerge({ skipped: "no-components" });
  }

  try {
    const { missing } = collectComponents(state.repoRoot, config);
    const records: MissingHeaderRecord[] = missing.map((file) => {
      const ws = resolveWorkspace(file, config);
      let exportName: string | null = null;
      try {
        exportName = extractExportName(
          readFileSync(join(state.repoRoot, file), "utf8"),
          file,
        );
      } catch {
        /* unreadable — leave null */
      }
      return {
        file,
        workspace: ws?.name ?? "",
        export_name: exportName,
        categories: ws?.categories ?? [],
      };
    });

    const dir = cairnDir(state.repoRoot, "init", "components");
    mkdirSync(dir, { recursive: true });
    const body =
      records.length > 0
        ? `${records.map((r) => JSON.stringify(r)).join("\n")}\n`
        : "";
    writeFileSync(join(dir, "missing.jsonl"), body, "utf8");

    const out: CompWalkOutput = {
      missing_count: records.length,
      corpus_path: COMP_MISSING_PATH,
    };
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "9d-comp-walk": out },
    };
    return {
      status: "complete",
      nextPhase: "9e-comp-annotate",
      state: advancePhase(next),
    };
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "9d-comp-walk-failed",
        message: "Component header walk failed",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
}

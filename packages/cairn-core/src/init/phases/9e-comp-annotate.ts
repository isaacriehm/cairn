/**
 * Phase 9e-comp-annotate — skill-driven header annotation (confirm leg).
 *
 * The actual work runs in the cairn-adopt skill (Step 3.6): it reads
 * the `.cairn/init/components/missing.jsonl` corpus from 9d-comp-walk
 * and dispatches `component-annotator` subagents in parallel batches
 * that write `@cairn` headers into the source files (per-batch
 * operator consent, like Phase 12).
 *
 * This MCP runner is the state-machine bookkeeper. Unlike 9b-curate —
 * which HARD-errors when its subagent output is missing — annotation is
 * opportunistic: any file the operator declined or a subagent couldn't
 * confidently header simply stays un-headered and surfaces as
 * missing-header debt in 9f-comp-emit's attention baseline. So this
 * runner is tolerant: it counts how many of the walk's files now carry
 * a header and always advances.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cairnDir,
  hasComponentConfig,
  isGhost,
  loadComponentsConfig,
  lookupComponentEntryByFile,
  parseComponentHeader,
  readComponentRegistry,
} from "@isaacriehm/cairn-state";
import { advancePhase, isSelfAdoptState } from "./orchestrator.js";
import type { CompAnnotateOutput, PhaseResult, PhaseState } from "./types.js";

const NEXT_PHASE = "9f-comp-emit" as const;

function complete(state: PhaseState, out: CompAnnotateOutput): PhaseResult {
  const next: PhaseState = {
    ...state,
    outputs: { ...state.outputs, "9e-comp-annotate": out },
  };
  return { status: "complete", nextPhase: NEXT_PHASE, state: advancePhase(next) };
}

/**
 * Ghost confirm leg: count how many of the walk's corpus units now resolve in
 * the out-of-repo registry (registered by the `component-registrar` subagents)
 * vs. left unregistered. Source is never read for a header — registration is
 * the out-of-repo write. Mirrors the committed header count; always advances.
 */
function countGhostRegistrations(state: PhaseState, corpusAbs: string): PhaseResult {
  let registered = 0;
  let stillUnregistered = 0;
  let text: string;
  try {
    text = readFileSync(corpusAbs, "utf8");
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "9e-comp-annotate-failed",
        message: "Failed to read the component annotation corpus",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
  const reg = readComponentRegistry(state.repoRoot);
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let rec: { file?: unknown };
    try {
      rec = JSON.parse(trimmed) as { file?: unknown };
    } catch {
      continue;
    }
    if (typeof rec.file !== "string") continue;
    if (lookupComponentEntryByFile(reg, rec.file) !== null) registered += 1;
    else stillUnregistered += 1;
  }
  if (registered + stillUnregistered === 0) {
    return complete(state, { skipped: "nothing-missing" });
  }
  return complete(state, { registered, still_unregistered: stillUnregistered });
}

export async function runPhase9eCompAnnotate(
  state: PhaseState,
): Promise<PhaseResult> {
  if (isSelfAdoptState(state)) {
    return complete(state, { skipped: "self-adopt" });
  }
  const config = loadComponentsConfig(state.repoRoot);
  if (!hasComponentConfig(config)) {
    return complete(state, { skipped: "no-components" });
  }

  // Resolve the walk corpus through `cairnDir` — committed = the in-repo state
  // dir (byte-identical to before), ghost = the out-of-repo state home where 9d
  // actually wrote it. A raw repo-root join would miss the ghost corpus entirely.
  const corpusAbs = cairnDir(state.repoRoot, "init", "components", "missing.jsonl");
  if (!existsSync(corpusAbs)) {
    return complete(state, { skipped: "nothing-missing" });
  }

  // Ghost: the `@cairn` header is forbidden in client source, so the cairn-adopt
  // skill (Step 3.6) dispatches `component-registrar` subagents that classify
  // each unit and REGISTER it via `cairn_component_register` (out-of-repo, no
  // source edit) instead of writing a header. This runner is the same tolerant
  // bookkeeper — it counts how many of the walk's units now resolve in the
  // out-of-repo registry; anything the operator declined surfaces as a soft
  // `unregistered-unit` offer in 9f-comp-emit's baseline. (§3.8.1)
  if (isGhost(state.repoRoot)) {
    return countGhostRegistrations(state, corpusAbs);
  }

  let annotated = 0;
  let stillMissing = 0;
  try {
    const text = readFileSync(corpusAbs, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let rec: { file?: unknown };
      try {
        rec = JSON.parse(trimmed) as { file?: unknown };
      } catch {
        continue;
      }
      if (typeof rec.file !== "string") continue;
      let hasHeader = false;
      try {
        hasHeader =
          parseComponentHeader(
            readFileSync(join(state.repoRoot, rec.file), "utf8"),
          ) !== null;
      } catch {
        /* file gone / unreadable → counts as still missing */
      }
      if (hasHeader) annotated += 1;
      else stillMissing += 1;
    }
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "9e-comp-annotate-failed",
        message: "Failed to read the component annotation corpus",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }

  if (annotated + stillMissing === 0) {
    return complete(state, { skipped: "nothing-missing" });
  }
  return complete(state, { annotated, still_missing: stillMissing });
}

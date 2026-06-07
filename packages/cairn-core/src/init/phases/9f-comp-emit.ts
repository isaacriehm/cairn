/**
 * Phase 9f-comp-emit — build the component store at adoption.
 *
 * Deterministic (no LLM), the final leg of the component trio
 * (9d-comp-walk → 9e-comp-annotate → 9f-comp-emit). No-ops on
 * self-adopt or when the project carries no `components:` config, so
 * non-UI repos flow straight through. Otherwise, now that 9e has had a
 * chance to annotate source headers:
 *
 *   1. Build the derived index under `.cairn/ground/components/`.
 *   2. Promote every `@singleton` header to a §INV ledger entry
 *      (verbatim auto-accept, like 9c-emit — the rule is mechanical;
 *      "exists exactly once" is enforced by the check's duplicate-name
 *      gate, not a generic assertion).
 *   3. Run the advisory audit + collect any still-missing-header debt
 *      and write both to a baseline file the cairn-attention skill
 *      triages.
 *
 * Advisory vs gate stays unblurred (port invariant 5): nothing here
 * blocks. The audit + missing headers are surfaced for triage; the
 * daily-flow check is the gate.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  bodyContentHash,
  collectComponents,
  deriveInvId,
  hasComponentConfig,
  invariantsDir,
  loadComponentsConfig,
  writeInvariantsLedger,
} from "@isaacriehm/cairn-state";
import { buildComponentIndex } from "../../components/index-build.js";
import { runComponentAudit, type ComponentAuditResult } from "../../components/audit.js";
import { advancePhase, isSelfAdoptState } from "./orchestrator.js";
import type {
  ComponentsPhaseOutput,
  PhaseResult,
  PhaseState,
} from "./types.js";

const NEXT_PHASE = "10-rules-merge" as const;
const CAPTURE_SOURCE = "cairn-init-components";

function complete(state: PhaseState, out: ComponentsPhaseOutput): PhaseResult {
  const next: PhaseState = {
    ...state,
    outputs: { ...state.outputs, "9f-comp-emit": out },
  };
  return { status: "complete", nextPhase: NEXT_PHASE, state: advancePhase(next) };
}

export async function runPhase9fCompEmit(
  state: PhaseState,
): Promise<PhaseResult> {
  if (isSelfAdoptState(state)) {
    return complete(state, { skipped: "self-adopt" });
  }

  const config = loadComponentsConfig(state.repoRoot);
  if (!hasComponentConfig(config)) {
    return complete(state, { skipped: "no-components" });
  }

  try {
    // 1. Build the derived index (writes .cairn/ground/components/).
    const build = buildComponentIndex(state.repoRoot);

    // 2. Singleton headers → §INV ledger entries (status: active, scoped to
    //    the workspace's component dirs). Written directly rather than via
    //    sot-emit's emitInv, whose renderer stamps status "accepted" — the
    //    invariants ledger only carries "active" entries, so an "accepted"
    //    invariant would never surface in the ledger / Lens / scope.
    const collected = collectComponents(state.repoRoot, config);
    const wsDirs = new Map(
      config.workspaces.map((w) => [w.name, w.componentDirs]),
    );
    let singletons = 0;
    for (const c of collected.components) {
      if (!c.tags.singleton) continue;
      const name = c.tags.cairn;
      if (name === undefined || name.length === 0) continue;
      writeSingletonInvariant(state.repoRoot, {
        name,
        workspace: c.workspace,
        sourceFile: c.file,
        scopeGlobs: (wsDirs.get(c.workspace) ?? []).map((d) => `${d}/**`),
      });
      singletons += 1;
    }
    if (singletons > 0) writeInvariantsLedger({ repoRoot: state.repoRoot });

    // 3. Advisory audit + still-missing-header debt → attention baseline.
    const audit = runComponentAudit(state.repoRoot);
    const baselineRel = writeComponentBaseline(
      state.repoRoot,
      audit,
      collected.missing,
    );

    const out: ComponentsPhaseOutput = {
      indexed: build.total,
      missing: build.missing,
      singletons_drafted: singletons,
      audit_findings: audit.findings.length,
    };
    if (baselineRel !== null) out.baseline_path = baselineRel;
    return complete(state, out);
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "9f-comp-emit-failed",
        message: "Component store build failed",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
}

/**
 * Write a singleton component's §INV ledger entity. Mirrors the curator
 * emit shape (`status: active`, `sot_kind: ledger`, content-addressed id)
 * so the invariants ledger, Lens, and scope-index pick it up. Enforcement
 * of "exists exactly once" is the component check's duplicate-name gate —
 * no generic decision-assertion is attached.
 */
function writeSingletonInvariant(
  repoRoot: string,
  args: {
    name: string;
    workspace: string;
    sourceFile: string;
    scopeGlobs: string[];
  },
): void {
  const where =
    args.workspace.length > 0 ? `workspace ${args.workspace}` : "the application";
  const title = `${args.name} exists exactly once in ${where}`;
  const body = [
    `${args.name} is a singleton component — it exists exactly once in ${where}.`,
    "Extend it in place; never fork, copy, or rebuild it. Enforced by the",
    "component check's duplicate-name gate.",
    "",
    `Source: ${args.sourceFile}`,
  ].join("\n");
  const id = deriveInvId({
    sot_path: "ledger",
    title,
    capture_source: CAPTURE_SOURCE,
  });
  const now = new Date().toISOString();
  const fm: Record<string, unknown> = {
    id,
    title,
    type: "invariant",
    status: "active",
    audience: "dual",
    generated: now,
    "verified-at": now,
    capture_source: CAPTURE_SOURCE,
    sot_kind: "ledger",
    sot_path: "ledger",
    sot_content_hash: bodyContentHash(body),
    scope_globs: args.scopeGlobs,
    source_file: args.sourceFile,
  };
  const md = ["---", stringifyYaml(fm).trimEnd(), "---", "", body, ""].join("\n");
  const dir = invariantsDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), md, "utf8");
}

/**
 * Write advisory audit findings + missing-header debt to
 * `.cairn/baseline/components-<ISO>.yaml` in the same payload shape the
 * baseline sensor sweep uses, so the cairn-attention skill parses it
 * with the existing `baseline_finding` path. Returns the repo-relative
 * path, or `null` when there is nothing to triage (no empty files).
 */
function writeComponentBaseline(
  repoRoot: string,
  audit: ComponentAuditResult,
  missing: string[],
): string | null {
  const auditFindings = audit.findings.map((f) => ({
    path: f.file,
    line: f.line ?? 0,
    severity: "soft" as const,
    message: `${f.message} — ${f.recommendation}`,
  }));
  const missingFindings = missing.map((p) => ({
    path: p,
    line: 0,
    severity: "hard" as const,
    message:
      "missing @cairn header — annotate this component so it joins the registry (the daily-flow check blocks on this)",
  }));
  const total = auditFindings.length + missingFindings.length;
  if (total === 0) return null;

  const dir = join(repoRoot, ".cairn", "baseline");
  mkdirSync(dir, { recursive: true });
  const nowIso = new Date().toISOString();
  const filename = `components-${nowIso.replace(/[:.]/g, "-")}.yaml`;
  const payload = {
    run_at: nowIso,
    total_findings: total,
    sensors: [
      { sensor_id: "component-audit", findings: auditFindings },
      { sensor_id: "component-missing-header", findings: missingFindings },
    ],
  };
  writeFileSync(join(dir, filename), stringifyYaml(payload), "utf8");
  return join(".cairn", "baseline", filename);
}

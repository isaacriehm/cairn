/**
 * Component store emit — build the derived index, promote `@singleton`
 * headers to §INV ledger entries, and write advisory audit + missing-header
 * debt to an attention baseline.
 *
 * This is the deterministic core of adoption Phase 9f-comp-emit, lifted out
 * so it has a single home. Two callers share it:
 *
 *   1. `runPhase9fCompEmit` — the adoption trio's final leg.
 *   2. `cairn components emit` — the standalone backfill path for repos that
 *      were adopted before the component store shipped (the
 *      cairn-adopt-components skill drives it).
 *
 * Advisory vs gate stays unblurred (port invariant 5): nothing here blocks.
 * The audit + missing headers are surfaced for triage; the daily-flow check
 * is the gate.
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
import { buildComponentIndex } from "./index-build.js";
import { runComponentAudit, type ComponentAuditResult } from "./audit.js";

const CAPTURE_SOURCE = "cairn-init-components";

export interface ComponentEmitResult {
  /** True when the repo carries no `components:` config — nothing was built. */
  skipped: boolean;
  /** Components indexed across all workspaces. */
  indexed: number;
  /** Component files still missing a `@cairn` header. */
  missing: number;
  /** `@singleton` headers promoted to §INV ledger entries this run. */
  singletonsDrafted: number;
  /** Advisory audit findings (inline rebuilds + name collisions). */
  auditFindings: number;
  /** Repo-relative path to the written baseline, or null when nothing to triage. */
  baselinePath: string | null;
}

/**
 * Build the component store for `repoRoot`. No-op (skipped) when the repo
 * carries no `components:` config, so non-UI repos are untouched.
 */
export function emitComponentStore(repoRoot: string): ComponentEmitResult {
  const config = loadComponentsConfig(repoRoot);
  if (!hasComponentConfig(config)) {
    return {
      skipped: true,
      indexed: 0,
      missing: 0,
      singletonsDrafted: 0,
      auditFindings: 0,
      baselinePath: null,
    };
  }

  // 1. Build the derived index (writes .cairn/ground/components/).
  const build = buildComponentIndex(repoRoot);

  // 2. Singleton headers → §INV ledger entries (status: active, scoped to
  //    the workspace's component dirs). Written directly rather than via
  //    sot-emit's emitInv, whose renderer stamps status "accepted" — the
  //    invariants ledger only carries "active" entries, so an "accepted"
  //    invariant would never surface in the ledger / Lens / scope.
  const collected = collectComponents(repoRoot, config);
  const wsDirs = new Map(config.workspaces.map((w) => [w.name, w.componentDirs]));
  let singletons = 0;
  for (const c of collected.components) {
    if (!c.tags.singleton) continue;
    const name = c.tags.cairn;
    if (name === undefined || name.length === 0) continue;
    writeSingletonInvariant(repoRoot, {
      name,
      workspace: c.workspace,
      sourceFile: c.file,
      scopeGlobs: (wsDirs.get(c.workspace) ?? []).map((d) => `${d}/**`),
    });
    singletons += 1;
  }
  if (singletons > 0) writeInvariantsLedger({ repoRoot });

  // 3. Advisory audit + still-missing-header debt → attention baseline.
  const audit = runComponentAudit(repoRoot);
  const baselinePath = writeComponentBaseline(repoRoot, audit, collected.missing);

  return {
    skipped: false,
    indexed: build.total,
    missing: build.missing,
    singletonsDrafted: singletons,
    auditFindings: audit.findings.length,
    baselinePath,
  };
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

/**
 * Batch canary — verifies a multi-commit GC batch hasn't broken anything that
 * shows only when the commits are taken together. Per L46 (Codex audit
 * must-fix): "individually safe, collectively broken."
 *
 * Two checks run after the batch lands locally and BEFORE any push:
 *
 *   1. workflow.md re-render against a synthetic-task fixture.
 *      The orchestrator injects this template on every run; if a GC batch
 *      removed a placeholder section, broke a `{{var}}` token, or left
 *      orphaned `{{#each}}` blocks, the next live run would silently produce
 *      a malformed prompt. Render the template against a known-good fixture
 *      and assert (a) every `{{...}}` resolves and (b) the expected section
 *      headers (`## Task`, `## Acceptance criteria`, `## Decisions in scope`,
 *      `## Sensors that will run`) survive.
 *
 *   2. Manifest rebuild + ground-zone consistency.
 *      Re-run `buildManifest` against the post-batch tree. If it throws or
 *      produces zero entries (the canonical zone went empty), the batch
 *      broke ground.
 *
 * Both checks are pure-mechanical — no claude burn — and run in milliseconds.
 * They are not exhaustive (no runtime sensor sweep against a synthetic diff
 * yet; that's deferred to a richer Phase 12.x revision when the orchestrator
 * exposes an "isolated sensor sweep" entry point).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifest } from "../ground/manifest.js";
import { loadWorkflowTemplate, renderTemplate } from "../prompt.js";
import type { CanarySyntheticContext } from "./types.js";

const REQUIRED_SECTION_HEADINGS = [
  "## Task",
  "## Acceptance criteria",
  "## Decisions in scope",
  "## Off-limits paths",
  "## Sensors that will run",
];

const UNRESOLVED_TOKEN_RE = /\{\{[^}]*\}\}/;

export interface BatchCanaryResult {
  ok: boolean;
  failures: string[];
  /** Number of files in the rebuilt manifest. */
  manifest_files: number;
  /** Length of the rendered workflow.md template. */
  rendered_length: number;
}

export interface BatchCanaryOptions {
  repoRoot: string;
  /** Override the synthetic context. Defaults to a minimal fixture. */
  syntheticContext?: CanarySyntheticContext;
}

export function buildSyntheticContext(): CanarySyntheticContext {
  return {
    agent_role: "implementer",
    project_name: "canary",
    run_id: "canary-run",
    mirror_path: "/tmp/canary-mirror",
    sha_pin: "0000000000000000000000000000000000000000",
    tightened_spec_body: "Canary fixture body — non-empty.",
    acceptance_criteria: ["Renders workflow.md without unresolved tokens."],
    in_scope_decisions: [
      { id: "D-CANARY-1", title: "Canary decision", scope_summary: "fixture" },
    ],
    in_scope_invariants: [{ id: "V-CANARY-1", title: "Canary invariant" }],
    off_limits: [".git/**", ".archive/**"],
    scoped_sensors: [
      { id: "stub-pattern-catalog", description: "Layer A stub catalog" },
      { id: "attestation-cross-check", description: "Layer B attestation cross-check" },
    ],
  };
}

export function verifyBatchCanary(opts: BatchCanaryOptions): BatchCanaryResult {
  const failures: string[] = [];
  const ctx = opts.syntheticContext ?? buildSyntheticContext();

  // 1. Workflow template re-render.
  let template = "";
  let rendered = "";
  try {
    template = loadWorkflowTemplate(opts.repoRoot);
  } catch (err) {
    failures.push(
      `workflow.md template missing or unreadable: ${(err as Error).message}`,
    );
  }
  if (template.length === 0) {
    failures.push("workflow.md template is empty after frontmatter strip");
  } else {
    rendered = renderTemplate(template, {
      agent_role: ctx.agent_role,
      project_name: ctx.project_name,
      run_id: ctx.run_id,
      mirror_path: ctx.mirror_path,
      sha_pin: ctx.sha_pin,
      tightened_spec_body: ctx.tightened_spec_body,
      acceptance_criteria: ctx.acceptance_criteria,
      in_scope_decisions: ctx.in_scope_decisions,
      in_scope_invariants: ctx.in_scope_invariants,
      off_limits: ctx.off_limits,
      scoped_sensors: ctx.scoped_sensors,
    });
    if (UNRESOLVED_TOKEN_RE.test(rendered)) {
      const m = rendered.match(UNRESOLVED_TOKEN_RE);
      failures.push(`workflow.md rendered prompt contains unresolved token: ${m?.[0] ?? "<unknown>"}`);
    }
    for (const heading of REQUIRED_SECTION_HEADINGS) {
      if (!rendered.includes(heading)) {
        failures.push(`workflow.md rendered prompt missing section: \`${heading}\``);
      }
    }
  }

  // 2. Manifest rebuild (canonical-zone integrity).
  let manifestFiles = 0;
  try {
    const manifest = buildManifest({ repoRoot: opts.repoRoot, generator: "gc.canary" });
    manifestFiles = manifest.files.length;
    if (manifestFiles === 0) {
      failures.push("manifest rebuild produced zero canonical-zone files");
    }
  } catch (err) {
    failures.push(`manifest rebuild threw: ${(err as Error).message}`);
  }

  // 3. Sanity: workflow.md exists at the expected path (loadWorkflowTemplate
  // already throws when missing, but a missing template yields the more
  // detailed failure above; this check ensures the path itself is right).
  const workflowPath = join(opts.repoRoot, ".harness", "config", "workflow.md");
  if (!existsSync(workflowPath)) {
    failures.push(`workflow.md not found at .harness/config/workflow.md`);
  } else {
    // Cheap re-read to ensure we can read it post-batch (catches an edit that
    // wrote invalid utf-8 etc).
    try {
      readFileSync(workflowPath, "utf8");
    } catch (err) {
      failures.push(`workflow.md unreadable post-batch: ${(err as Error).message}`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    manifest_files: manifestFiles,
    rendered_length: rendered.length,
  };
}

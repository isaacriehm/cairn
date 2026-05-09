/**
 * Batch canary — verifies a multi-commit GC batch hasn't broken ground state
 * in ways that show only when the commits are taken together.
 *
 * Two checks run after the batch lands locally and BEFORE any push:
 *
 *   1. Manifest rebuild + ground-zone consistency.
 *      Re-run `buildManifest` against the post-batch tree. If it throws or
 *      produces zero entries (the canonical zone went empty), the batch
 *      broke ground.
 *
 *   2. workflow.md sanity — file exists, is readable, has parseable YAML
 *      frontmatter (the project-extension block that `sensors/runner.ts`
 *      reads via Object.keys). Catches a GC batch that mangled the
 *      frontmatter or removed the file entirely.
 *
 * Both checks are pure-mechanical — no LLM burn — and run in milliseconds.
 *
 * The earlier prompt-template re-render check was retired with the
 * orchestrator (the workflow.md body no longer carries Liquid-style
 * tokens; cairn-direction writes spec.tightened.md per task instead).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildManifest } from "@isaacriehm/cairn-state";

export interface BatchCanaryResult {
  ok: boolean;
  failures: string[];
  /** Number of files in the rebuilt manifest. */
  manifest_files: number;
}

export interface BatchCanaryOptions {
  repoRoot: string;
}

export function verifyBatchCanary(opts: BatchCanaryOptions): BatchCanaryResult {
  const failures: string[] = [];

  // 1. Manifest rebuild (canonical-zone integrity).
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

  // 2. workflow.md sanity — file present, readable, frontmatter parseable.
  const workflowPath = join(opts.repoRoot, ".cairn", "config", "workflow.md");
  if (!existsSync(workflowPath)) {
    failures.push("workflow.md not found at .cairn/config/workflow.md");
  } else {
    let body = "";
    try {
      body = readFileSync(workflowPath, "utf8");
    } catch (err) {
      failures.push(`workflow.md unreadable post-batch: ${(err as Error).message}`);
    }
    if (body.length > 0) {
      const fmMatch = body.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch === null) {
        failures.push("workflow.md missing YAML frontmatter delimiters");
      } else {
        try {
          const fm = parseYaml(fmMatch[1] ?? "");
          if (typeof fm !== "object" || fm === null) {
            failures.push("workflow.md frontmatter parses to non-object");
          }
        } catch (err) {
          failures.push(`workflow.md frontmatter parse failed: ${(err as Error).message}`);
        }
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    manifest_files: manifestFiles,
  };
}

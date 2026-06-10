/**
 * Batch canary — verifies a multi-commit GC batch hasn't broken ground state
 * in ways that show only when the commits are taken together.
 *
 * Two checks run after the batch lands locally and BEFORE any push:
 *
 *   1. Manifest rebuild — verifies all files in `.cairn/ground/` are still
 *      valid, parseable, and linked.
 *   2. workflow.md check — verifies the project config hasn't been corrupted.
 */

import { existsSync, readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";
import { cairnDir, writeManifest } from "@isaacriehm/cairn-state";

export interface GcCanaryOptions {
  repoRoot: string;
}

export interface GcCanaryResult {
  ok: boolean;
  failures: string[];
  manifest_files: number;
}

/**
 * Verifies the monorepo is still healthy after a GC batch lands.
 */
export function runGcCanary(opts: GcCanaryOptions): GcCanaryResult {
  const failures: string[] = [];
  let manifestFiles = 0;

  // 1. Manifest rebuild.
  try {
    const result = writeManifest({ repoRoot: opts.repoRoot });
    manifestFiles = result.manifest.files.length;
    if (manifestFiles === 0) {
      failures.push("manifest is empty — ground state likely wiped");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`manifest rebuild threw: ${message}`);
  }

  // 2. workflow.md sanity — file present, readable, frontmatter parseable.
  const workflowPath = cairnDir(opts.repoRoot, "config", "workflow.md");
  if (!existsSync(workflowPath)) {
    failures.push("workflow.md not found at .cairn/config/workflow.md");
  } else {
    let body = "";
    try {
      body = readFileSync(workflowPath, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`workflow.md unreadable post-batch: ${message}`);
    }
    if (body.length > 0) {
      const fmMatch = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch === null) {
        failures.push("workflow.md missing YAML frontmatter delimiters");
      } else {
        try {
          const fm: unknown = parseYaml(fmMatch[1] ?? "");
          if (typeof fm !== "object" || fm === null) {
            failures.push("workflow.md frontmatter parses to non-object");
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push(`workflow.md frontmatter parse failed: ${message}`);
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

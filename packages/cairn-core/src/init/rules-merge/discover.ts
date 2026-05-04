/**
 * Phase 7c discovery — find existing project-rules sources.
 *
 * Per spec §6 Phase 7c, the four sources harness reconciles are:
 *   - <repoRoot>/CLAUDE.md
 *   - <repoRoot>/AGENTS.md
 *   - <repoRoot>/.claude/CLAUDE.md
 *   - <repoRoot>/.claude/rules/**.md
 *
 * Returns absolute + repo-relative paths that exist. Caller drives the rest.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface RuleSourceFile {
  /** Repo-relative POSIX path. */
  path: string;
  absPath: string;
  /** Logical kind drives the regeneration template choice. */
  kind: "claude-md-root" | "agents-md-root" | "claude-md-claude-dir" | "rule";
  /** File size (for largest-first ordering when batched). */
  size: number;
}

export function discoverRuleSources(repoRoot: string): RuleSourceFile[] {
  const out: RuleSourceFile[] = [];
  const tryFile = (rel: string, kind: RuleSourceFile["kind"]): void => {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) return;
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (!st.isFile()) return;
    out.push({ path: toPosix(rel), absPath: abs, kind, size: st.size });
  };
  tryFile("CLAUDE.md", "claude-md-root");
  tryFile("AGENTS.md", "agents-md-root");
  tryFile(join(".claude", "CLAUDE.md"), "claude-md-claude-dir");

  const rulesDir = join(repoRoot, ".claude", "rules");
  if (existsSync(rulesDir)) {
    walkRules(rulesDir, repoRoot, out);
  }
  return out;
}

function walkRules(dir: string, repoRoot: string, out: RuleSourceFile[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      walkRules(abs, repoRoot, out);
      continue;
    }
    if (!e.isFile()) continue;
    if (!e.name.toLowerCase().endsWith(".md")) continue;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    out.push({
      path: toPosix(relative(repoRoot, abs)),
      absPath: abs,
      kind: "rule",
      size: st.size,
    });
  }
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

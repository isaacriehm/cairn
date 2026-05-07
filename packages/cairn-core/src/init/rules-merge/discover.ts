/**
 * Phase 7c discovery — find existing project-rules sources.
 *
 * Plan §5.4 ownership set (v0.5.0):
 *   - <repoRoot>/CLAUDE.md
 *   - <repoRoot>/AGENTS.md
 *   - <repoRoot>/.claude/rules/**.md
 *
 * `.claude/CLAUDE.md` was previously discovered here too (kind
 * `claude-md-claude-dir`). The phase 5b walker treats every reachable
 * `.md` outside the rule-owned set as `kind="doc"` — so phase 6 already
 * owns `.claude/CLAUDE.md`. Re-discovering it here would race with phase
 * 6's emit and double-bind the slug.
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
  kind: "claude-md-root" | "agents-md-root" | "rule";
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

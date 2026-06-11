/**
 * `cairn uninstall` — remove Cairn from a repo, cleanly.
 *
 * The inverse of adoption (`cairn init`) + per-clone bootstrap
 * (`cairn join`). The install footprint is:
 *
 *   - `.cairn/`                       the ground state + config + hooks
 *   - `.claude/rules/cairn.md`        the plugin-absent onboarding notice
 *   - an `@.claude/rules/cairn.md`    import block in CLAUDE.md / AGENTS.md
 *   - `git config core.hooksPath`     pointed at `.cairn/git-hooks`
 *   - in-source `// §DEC-/§INV-`       citations from sot-align strip-replace
 *
 * Uninstall reverses these in dependency order. Cites are expanded FIRST
 * (while `.cairn/ground/` still exists to resolve them), so removing
 * `.cairn/` doesn't leave dangling `§` references — the source ends up
 * self-documenting. `core.hooksPath` is only unset when it is Cairn's own
 * value (a foreign husky/lefthook path is never clobbered).
 *
 * Every step reports a status; nothing throws on a recoverable issue. The
 * machine-level Claude Code plugin (`/plugin install`) is user-scoped, not
 * repo-scoped — uninstall can't remove it and says so.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cairnDir, COMMITTED_HOOKS_PATH } from "@isaacriehm/cairn-state";
import { expandCitesInRepo } from "../cites/expand.js";
import { CAIRN_RULE_IMPORT, IMPORT_MARKER } from "../init/claude-rule.js";

export type UninstallStepStatus = "ok" | "skipped" | "warn";

export interface UninstallStep {
  step: string;
  status: UninstallStepStatus;
  detail: string;
}

export interface UninstallOptions {
  repoRoot: string;
  /** Expand DEC/INV cites to inline comments first. Default true. */
  expandCites?: boolean;
  /** Report what would happen; change nothing. */
  dryRun?: boolean;
}

export interface UninstallResult {
  repoRoot: string;
  steps: UninstallStep[];
  /** True when `.cairn/` was (or would be) removed. */
  removed: boolean;
}

export function uninstallCairn(opts: UninstallOptions): UninstallResult {
  const root = opts.repoRoot;
  const dryRun = opts.dryRun ?? false;
  const doExpand = opts.expandCites ?? true;
  const steps: UninstallStep[] = [];

  // 1. Expand cites FIRST — needs `.cairn/ground/` to resolve bodies.
  if (doExpand) {
    const r = expandCitesInRepo({ repoRoot: root, dryRun });
    const bits = [`${r.expanded} citation(s) inlined across ${r.filesChanged} file(s)`];
    if (r.danglingSkipped > 0) bits.push(`${r.danglingSkipped} dangling left in place`);
    if (r.inlineSkipped > 0) bits.push(`${r.inlineSkipped} inline left in place`);
    steps.push({ step: "expand-cites", status: "ok", detail: bits.join("; ") });
  } else {
    steps.push({
      step: "expand-cites",
      status: "skipped",
      detail: "--keep-cites: in-source §DEC-/§INV- tokens will dangle after removal",
    });
  }

  // 2. Remove the `@.claude/rules/cairn.md` import block from the memory file.
  steps.push(unwireRuleImport(root, dryRun));

  // 3. Remove `.claude/rules/cairn.md` and prune the dirs if they empty out.
  steps.push(removeRuleFile(root, dryRun));

  // 4. Unset `core.hooksPath` — only when it is Cairn's own value.
  steps.push(unsetHooksPath(root, dryRun));

  // 5. Remove `.cairn/`.
  const cairnPath = cairnDir(root);
  let removed = false;
  if (existsSync(cairnPath)) {
    removed = true;
    if (!dryRun) rmSync(cairnPath, { recursive: true, force: true });
    steps.push({ step: "remove-cairn-dir", status: "ok", detail: `${dryRun ? "would remove" : "removed"} .cairn/` });
  } else {
    steps.push({ step: "remove-cairn-dir", status: "skipped", detail: ".cairn/ not present" });
  }

  // 6. Advisory — the machine-level plugin is user-scoped.
  steps.push({
    step: "plugin",
    status: "skipped",
    detail: "Claude Code plugin is machine-scoped — remove with `/plugin uninstall cairn` if no other repo uses it",
  });

  return { repoRoot: root, steps, removed };
}

/* -------------------------------------------------------------------------- */

function unwireRuleImport(root: string, dryRun: boolean): UninstallStep {
  for (const rel of ["CLAUDE.md", "AGENTS.md"]) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (!content.includes(CAIRN_RULE_IMPORT)) continue;

    const next = stripImportBlock(content);
    if (!dryRun) writeFileSync(abs, next, "utf8");
    return {
      step: "unwire-import",
      status: "ok",
      detail: `${dryRun ? "would remove" : "removed"} the cairn rule import from ${rel}`,
    };
  }
  return { step: "unwire-import", status: "skipped", detail: "no cairn rule import found in CLAUDE.md / AGENTS.md" };
}

/** Remove the marker + import lines, then collapse the blank-line run they left. */
export function stripImportBlock(content: string): string {
  const lines = content.split(/\r?\n/);
  const kept = lines.filter((l) => l.trim() !== IMPORT_MARKER && l.trim() !== CAIRN_RULE_IMPORT);
  // Collapse 3+ consecutive blank lines (the import block was fenced by blanks)
  // down to a single blank, then normalize the trailing newline.
  const collapsed: string[] = [];
  let blanks = 0;
  for (const l of kept) {
    if (l.trim() === "") {
      blanks += 1;
      if (blanks >= 2) continue;
    } else {
      blanks = 0;
    }
    collapsed.push(l);
  }
  return `${collapsed.join("\n").replace(/\s*$/, "")}\n`;
}

function removeRuleFile(root: string, dryRun: boolean): UninstallStep {
  const ruleAbs = join(root, ".claude", "rules", "cairn.md");
  if (!existsSync(ruleAbs)) {
    return { step: "remove-rule", status: "skipped", detail: ".claude/rules/cairn.md not present" };
  }
  if (!dryRun) {
    rmSync(ruleAbs, { force: true });
    pruneIfEmpty(join(root, ".claude", "rules"));
    pruneIfEmpty(join(root, ".claude"));
  }
  return { step: "remove-rule", status: "ok", detail: `${dryRun ? "would remove" : "removed"} .claude/rules/cairn.md` };
}

function pruneIfEmpty(dir: string): void {
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function unsetHooksPath(root: string, dryRun: boolean): UninstallStep {
  if (!existsSync(join(root, ".git"))) {
    return { step: "unset-hooks", status: "skipped", detail: "not a git repo" };
  }
  const current = readGitConfig(root, "core.hooksPath");
  if (current === null) {
    return { step: "unset-hooks", status: "skipped", detail: "core.hooksPath not set" };
  }
  const ours = current === COMMITTED_HOOKS_PATH || current === cairnDir(root, "git-hooks");
  if (!ours) {
    return {
      step: "unset-hooks",
      status: "warn",
      detail: `core.hooksPath is '${current}' (not Cairn's) — left untouched`,
    };
  }
  if (!dryRun) {
    try {
      execFileSync("git", ["config", "--unset", "core.hooksPath"], { cwd: root, stdio: "ignore" });
    } catch {
      return { step: "unset-hooks", status: "warn", detail: "failed to unset core.hooksPath" };
    }
  }
  return { step: "unset-hooks", status: "ok", detail: `${dryRun ? "would unset" : "unset"} core.hooksPath` };
}

function readGitConfig(root: string, key: string): string | null {
  try {
    const out = execFileSync("git", ["config", "--get", key], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed.length === 0 ? null : trimmed;
  } catch {
    return null;
  }
}

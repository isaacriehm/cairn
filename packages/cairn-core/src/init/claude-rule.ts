/**
 * Plugin-absent onboarding wiring.
 *
 * The Cairn surface (SessionStart banner, MCP tools, scoped rule
 * injection) is delivered by the Claude Code plugin, which is installed
 * per-machine — cloning an adopted repo does NOT install it. The only
 * repo-committed, plugin-independent fallback is
 * `.claude/rules/cairn.md`, which tells a plugin-less agent to install
 * the plugin.
 *
 * But Claude Code does not auto-load `.claude/rules/*.md` on its own —
 * something has to import it. The one file Claude Code always loads with
 * zero plugin is the root memory file (`CLAUDE.md`). So the fallback rule
 * is only effective if that memory file `@`-imports it. Writing the rule
 * without wiring the import (the prior behavior) left it orphaned: a
 * teammate who cloned an adopted repo without the plugin saw nothing.
 *
 * `ensureCairnRuleImport` wires the import idempotently;
 * `installCairnRuleAndImport` writes the rule template AND wires the
 * import, for the adoption path.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { getLogger, isGhost } from "@isaacriehm/cairn-state";

const log = getLogger();

/** The repo-root-relative @import line Claude Code resolves. */
export const CAIRN_RULE_IMPORT = "@.claude/rules/cairn.md";

const IMPORT_MARKER =
  "<!-- cairn: plugin-absent onboarding — loads the install notice for clones without the Cairn plugin -->";

export interface EnsureImportResult {
  /** True when the import line was added (false = already present). */
  changed: boolean;
  /** Repo-relative memory file that carries the import. */
  file: string;
  /** True when the memory file had to be created. */
  created: boolean;
}

/**
 * Ensure the project's auto-loaded memory file `@`-imports
 * `.claude/rules/cairn.md`. Targets `CLAUDE.md` (the file Claude Code
 * always auto-loads); falls back to `AGENTS.md` only when `CLAUDE.md` is
 * absent but `AGENTS.md` exists. Creates `CLAUDE.md` if neither exists.
 * Idempotent.
 */
export function ensureCairnRuleImport(repoRoot: string): EnsureImportResult {
  // Ghost mode: never mutate the client's tracked CLAUDE.md / AGENTS.md. The
  // guard lives in the function (not the caller) so all four call sites —
  // Phase 13, the CLI runInit path, and `cairn fix` re-injection — are covered.
  if (isGhost(repoRoot)) {
    return { changed: false, file: "CLAUDE.md", created: false };
  }

  const claudeAbs = join(repoRoot, "CLAUDE.md");
  const agentsAbs = join(repoRoot, "AGENTS.md");

  let targetAbs = claudeAbs;
  let rel = "CLAUDE.md";
  if (!existsSync(claudeAbs) && existsSync(agentsAbs)) {
    targetAbs = agentsAbs;
    rel = "AGENTS.md";
  }

  const existed = existsSync(targetAbs);
  const content = existed ? readFileSync(targetAbs, "utf8") : "";

  if (content.includes(CAIRN_RULE_IMPORT)) {
    return { changed: false, file: rel, created: false };
  }

  const importBlock = `${IMPORT_MARKER}\n${CAIRN_RULE_IMPORT}\n`;
  const next = existed
    ? `${content.replace(/\s*$/, "")}\n\n${importBlock}`
    : `# ${basename(repoRoot)}\n\n${importBlock}`;

  writeFileSync(targetAbs, next, "utf8");
  log.debug({ repoRoot, file: rel, created: !existed }, "wired cairn rule import");
  return { changed: true, file: rel, created: !existed };
}

/* -------------------------------------------------------------------------- */
/* Template install (adoption path)                                           */
/* -------------------------------------------------------------------------- */

const RULE_REL = join(".claude", "rules", "cairn.md");

/** Locate the bundled `.claude/rules/cairn.md` template. */
function findRuleTemplate(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dist/init/ → cairn-core/templates
    join(here, "..", "..", "templates", ".claude", "rules", "cairn.md"),
    // src/init/ → cairn-core/templates (dev / ts-node)
    join(here, "..", "..", "..", "templates", ".claude", "rules", "cairn.md"),
    // plugin bundle mirror: here/templates
    join(here, "templates", ".claude", "rules", "cairn.md"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export interface InstallRuleResult extends EnsureImportResult {
  /** True when the rule file was written/updated. */
  ruleWritten: boolean;
}

/**
 * Adoption-side: write `.claude/rules/cairn.md` from the bundled template
 * (if missing or stale) and wire the `@`-import so plugin-less clones see
 * the install notice. Best-effort — a missing template is logged and the
 * import is still ensured.
 */
export function installCairnRuleAndImport(repoRoot: string): InstallRuleResult {
  // Ghost mode: never write `.claude/rules/cairn.md` into the client tree, and
  // never touch its memory file. ensureCairnRuleImport is guarded too, but stop
  // here first so the rule template is never written either.
  if (isGhost(repoRoot)) {
    return { changed: false, file: "CLAUDE.md", created: false, ruleWritten: false };
  }

  let ruleWritten = false;
  const targetAbs = join(repoRoot, RULE_REL);
  const template = findRuleTemplate();
  if (template !== null) {
    const desired = readFileSync(template, "utf8");
    const current = existsSync(targetAbs) ? readFileSync(targetAbs, "utf8") : null;
    if (current !== desired) {
      mkdirSync(dirname(targetAbs), { recursive: true });
      writeFileSync(targetAbs, desired, "utf8");
      ruleWritten = true;
    }
  } else {
    log.warn({ repoRoot }, "cairn rule template not found; wiring import only");
  }
  const imp = ensureCairnRuleImport(repoRoot);
  return { ...imp, ruleWritten };
}

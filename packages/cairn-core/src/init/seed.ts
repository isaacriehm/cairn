/**
 * Seed an adopted project's .cairn/ from cairn/templates/.
 *
 * Walks the templates dir, copies every file to the target preserving
 * directory layout. Files where the `<project_name>` YAML key needs
 * substitution are passed through `applyPlaceholders`. Existing files
 * collide-fail unless `force: true`.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cairnDir, isGhost, walkFs } from "@isaacriehm/cairn-state";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * dist/init/seed.js → walk up to package root, then into templates/.
 * The Claude Code plugin bundle co-locates templates beside the bundle
 * (packages/cairn-frontend-claudecode/dist/templates/) — esbuild
 * --define flips the lookup so the bundled binary finds them as a
 * sibling of dist/cli.cjs rather than two levels up from a per-module
 * dist file.
 */
const TEMPLATES_ROOT =
  typeof __CAIRN_BUNDLED__ !== "undefined" && __CAIRN_BUNDLED__
    ? join(HERE, "templates")
    : join(HERE, "..", "..", "templates");

export interface SeedOptions {
  repoRoot: string;
  projectSlug: string;
  /** Allow overwriting existing files. Default false (collide-fail). */
  force?: boolean;
}

export interface SeedResult {
  written_files: string[];
  collisions: string[];
}

/**
 * Allowlist of top-level entries the seed walker may descend into. Any
 * file or directory at the `templates/` root that is NOT in this set is
 * IGNORED — defensive so a stray template-meta file (a README about the
 * templates dir, an editor scratch file, etc.) never clobbers a
 * top-level project file like `<repoRoot>/README.md`.
 *
 * Pre-v0.2.0 cairn shipped a `templates/README.md` documentation file
 * by accident; the walker happily copied it to `<repoRoot>/README.md`
 * and overwrote project READMEs in the wild. The file was removed in
 * v0.2.0 but the walker stayed permissive. This allowlist forecloses
 * the regression — only paths under these top-level entries land in
 * the adopted project.
 */
const SEED_TOP_LEVEL_ALLOWLIST: ReadonlySet<string> = new Set([
  ".cairn",
  ".claude",
  ".github",
]);

/**
 * Ghost mode seeds ONLY `.cairn/*` (redirected out-of-repo via `cairnDir`).
 * The `.claude/` rule + `.github/` CI workflow templates are client-tree
 * artifacts — never written in ghost (constraint 1: nothing Cairn-shaped in
 * the client repo). See ghost-mode design.
 */
const GHOST_SEED_ALLOWLIST: ReadonlySet<string> = new Set([".cairn"]);

/**
 * Resolve a template's repo-relative path to its on-disk destination.
 * `.cairn/<rest>` routes through `cairnHome` — out-of-repo in ghost,
 * `<repoRoot>/.cairn/<rest>` in committed (byte-identical to the old
 * `join(repoRoot, rel)`). `.claude/`/`.github/` stay in the client tree
 * (committed only — gated out of the ghost allowlist).
 */
function seedDstPath(repoRoot: string, rel: string): string {
  const parts = rel.split("/");
  if (parts[0] === ".cairn") {
    return cairnDir(repoRoot, ...parts.slice(1));
  }
  return join(repoRoot, rel);
}

/**
 * Belt-and-suspenders for ghost: add `/.cairn/` to `.git/info/exclude` (local,
 * untracked — never committed). Ghost writes nothing under the client tree, but
 * a missed code path that emitted a stray `.cairn/` would still be git-invisible.
 * Never touches the tracked `.gitignore`. Best-effort.
 */
function addGitInfoExclude(repoRoot: string): void {
  try {
    const gitDir = join(repoRoot, ".git");
    if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return;
    const infoDir = join(gitDir, "info");
    mkdirSync(infoDir, { recursive: true });
    const excludePath = join(infoDir, "exclude");
    const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    if (/^\s*\/?\.cairn\/?\s*$/m.test(existing)) return; // already excluded
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(excludePath, `${existing}${sep}/.cairn/\n`, "utf8");
  } catch {
    // best-effort; a missing/locked .git/info never blocks adoption
  }
}

export function seedCairnLayout(opts: SeedOptions): SeedResult {
  const written: string[] = [];
  const collisions: string[] = [];
  const ghost = isGhost(opts.repoRoot);
  const allowlist = ghost ? GHOST_SEED_ALLOWLIST : SEED_TOP_LEVEL_ALLOWLIST;
  walkFs({
    dir: TEMPLATES_ROOT,
    onDir: (rel) => {
      if (rel === ".") return true;
      const top = rel.split("/")[0]!;
      return allowlist.has(top);
    },
    onFile: (rel, absSrc) => {
      const top = rel.split("/")[0]!;
      if (!allowlist.has(top)) return;

      const absDst = seedDstPath(opts.repoRoot, rel);
      if (existsSync(absDst) && opts.force !== true) {
        collisions.push(rel);
        return;
      }
      mkdirSync(dirname(absDst), { recursive: true });
      const raw = readFileSync(absSrc, "utf8");
      const out = applyPlaceholders({ content: raw, projectSlug: opts.projectSlug, relPath: rel });
      writeFileSync(absDst, out, "utf8");
      if (isExecutableTemplate(rel)) {
        try {
          chmodSync(absDst, 0o755);
        } catch {
          // Filesystems that don't support chmod (e.g. some Windows volumes)
          // — git itself will set the executable bit on tracked content via
          // the index, and `cairn join` re-chmods on bootstrap.
        }
      }
      written.push(rel);
    },
  });
  if (ghost) addGitInfoExclude(opts.repoRoot);
  return { written_files: written, collisions };
}

/**
 * Substitute the `<project_name>` placeholder in shipped templates.
 * Only `.cairn/config/workflow.md` and `.cairn/config/sensors.yaml`
 * carry it today; the function is broad enough to safely no-op on other
 * files.
 *
 * Two replacement targets:
 *   1. `<project_name>:` YAML key → `<slug>:` (the per-project extension block)
 *   2. Inline mentions in comments, e.g. ``<project_name>:` extension block``
 *
 * The Liquid-style `{{project_name}}` placeholders inside the agent
 * prompt body are NOT touched here — those resolve at run time when the
 * orchestrator renders the prompt.
 */
function applyPlaceholders(args: {
  content: string;
  projectSlug: string;
  relPath: string;
}): string {
  // Only mutate workflow.md / sensors.yaml; other files pass through.
  const norm = args.relPath.split("\\").join("/");
  if (
    norm !== ".cairn/config/workflow.md" &&
    norm !== ".cairn/config/sensors.yaml"
  ) {
    return args.content;
  }
  return args.content
    .replace(/<project_name>:/g, `${args.projectSlug}:`)
    .replace(/`<project_name>`/g, `\`${args.projectSlug}\``)
    .replace(/<project_name>/g, args.projectSlug);
}

/** Exposed for the smoke test — locate the templates root from runtime. */
export function templatesRoot(): string {
  return TEMPLATES_ROOT;
}

/**
 * Templates that must land with 0755 so git hooks fire on commit. Tracked
 * separately from the placeholder substitution list — the executable bit
 * is metadata the seed function owns, not file content.
 */
function isExecutableTemplate(rel: string): boolean {
  const norm = rel.split("\\").join("/");
  return (
    norm === ".cairn/git-hooks/pre-commit" ||
    norm === ".cairn/git-hooks/post-commit" ||
    norm === ".cairn/git-hooks/commit-msg"
  );
}

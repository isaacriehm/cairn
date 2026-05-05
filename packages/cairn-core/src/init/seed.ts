/**
 * Seed an adopted project's .cairn/ + .archive/ from cairn/templates/.
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
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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

export function seedCairnLayout(opts: SeedOptions): SeedResult {
  const written: string[] = [];
  const collisions: string[] = [];
  walk(TEMPLATES_ROOT, (absSrc) => {
    const rel = relative(TEMPLATES_ROOT, absSrc);
    const absDst = join(opts.repoRoot, rel);
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
  });
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

function walk(dir: string, onFile: (abs: string) => void): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const s = statSync(abs);
    if (s.isDirectory()) {
      walk(abs, onFile);
    } else if (s.isFile()) {
      onFile(abs);
    }
  }
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

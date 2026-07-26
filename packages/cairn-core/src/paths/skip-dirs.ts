/**
 * Shared directory-exclusion sets for repo walkers.
 *
 * `SOURCE_SKIP_DIRS` — full source-tree walks (comments, curator corpus,
 * GC flat scans, init mapper inventory).
 *
 * `DOC_SKIP_DIRS` — markdown / prose discovery under `docs/` and similar.
 */

/** Directories never descended during source-code tree walks. */
export const SOURCE_SKIP_DIRS = new Set<string>([
  ".git",
  "node_modules",
  ".pnpm-store",
  "dist",
  "build",
  "target",
  "out",
  "__pycache__",
  "vendor",
  ".venv",
  ".direnv",
  ".cache",
  "coverage",
  ".next",
  ".turbo",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  ".parcel-cache",
  ".vercel",
  ".netlify",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".gradle",
  ".idea",
  ".vscode",
  ".cairn",
]);

/** Directories never descended when discovering markdown / doc candidates. */
export const DOC_SKIP_DIRS = new Set<string>([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  "vendor",
  ".venv",
  ".direnv",
  ".cache",
  "coverage",
  ".next",
  ".turbo",
  ".cairn",
]);

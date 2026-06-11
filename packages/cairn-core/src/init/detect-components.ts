/**
 * LLM-driven, convention-agnostic component-layout detection.
 *
 * Cairn adoption ALWAYS runs inside an LLM coding agent, so detection
 * leans on a model rather than a hardcoded convention list — there is no
 * `src/components` / `packages/*` assumption baked in. A Sonnet call reads
 * the repo's structural digest (per-directory file-extension histogram,
 * the dirs that hold a per-module manifest, and any workspace-manifest files)
 * and returns the `components:` config: which workspaces carry reusable
 * UI — web (React/Vue/Svelte/Astro) or native (SwiftUI/Flutter/Compose/
 * Razor) — where their component dirs live, the extensions in play, and a
 * taxonomy that fits THAT workspace. A non-UI repo (a backend with no
 * components) returns null and is left untouched.
 *
 * Only mechanical, repo-agnostic facts stay deterministic: the file walk
 * and the universal build-output exclude list. Everything that requires
 * understanding "what is this directory for" is the model's job — naming,
 * monorepo tooling, framework, and taxonomy are all inferred, never
 * assumed.
 *
 * Isolation invariant (port invariant 3): a workspace is NEVER emitted as
 * `shared`. The flag is omitted (it normalizes to isolated); the operator
 * opts in afterward (the skill asks).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { cairnDir,
  DEFAULT_EXCLUDE,
  walkFs,
  type ComponentsConfig,
} from "@isaacriehm/cairn-state";
import { runClaude } from "../claude/index.js";
import { logger } from "../logger.js";

const log = logger("init.detect-components");

const TIMEOUT_MS = 120_000;
/** Cap the directory histogram so a huge repo can't blow the prompt. */
const MAX_DIGEST_DIRS = 600;
const MAX_MANIFEST_CHARS = 2_000;

/** Workspace-tooling manifests, read verbatim as grouping signal. */
const WORKSPACE_MANIFESTS = [
  "pnpm-workspace.yaml",
  "lerna.json",
  "nx.json",
  "turbo.json",
  "rush.json",
  "settings.gradle",
  "settings.gradle.kts",
] as const;

/**
 * Per-module manifests whose directory is a workspace/module boundary —
 * language-agnostic, not just `package.json`. A Gradle/Flutter/Swift monorepo
 * has no package.json, so without this its module roots would be invisible.
 */
const MODULE_MANIFESTS = new Set<string>([
  "package.json",
  "build.gradle",
  "build.gradle.kts",
  "pom.xml",
  "pubspec.yaml",
  "Package.swift",
  "Cargo.toml",
  "go.mod",
]);

interface RepoDigest {
  /** `dir: <count><ext> …` per directory containing source files. */
  histogram: string;
  /** Repo-relative dirs that hold a per-module manifest (workspace boundaries). */
  moduleRoots: string[];
}

/**
 * Walk the repo once and build an agnostic structural digest: a
 * per-directory extension histogram plus the set of dirs that carry a
 * `package.json`. No convention names are consulted — this is raw shape.
 */
function buildRepoDigest(repoRoot: string): RepoDigest {
  const skip = new Set<string>([...DEFAULT_EXCLUDE]);
  const perDir = new Map<string, Map<string, number>>();
  const moduleRoots: string[] = [];

  walkFs({
    dir: repoRoot,
    repoRoot,
    skipDirs: skip,
    onFile: (rel, _abs, entry) => {
      const slash = rel.lastIndexOf("/");
      const dir = slash === -1 ? "." : rel.slice(0, slash);
      if (MODULE_MANIFESTS.has(entry.name)) moduleRoots.push(dir);
      const dot = rel.lastIndexOf(".");
      const ext = dot > slash ? rel.slice(dot) : "(noext)";
      let m = perDir.get(dir);
      if (m === undefined) {
        m = new Map();
        perDir.set(dir, m);
      }
      m.set(ext, (m.get(ext) ?? 0) + 1);
    },
  });

  const dirs = [...perDir.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const lines: string[] = [];
  for (const [dir, exts] of dirs) {
    const parts = [...exts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([e, c]) => `${c}${e}`);
    lines.push(`${dir}: ${parts.join(" ")}`);
    if (lines.length >= MAX_DIGEST_DIRS) {
      lines.push(`… (${dirs.length - MAX_DIGEST_DIRS} more dirs truncated)`);
      break;
    }
  }
  return { histogram: lines.join("\n"), moduleRoots: moduleRoots.sort() };
}

function readWorkspaceManifests(repoRoot: string): string {
  const out: string[] = [];
  for (const name of WORKSPACE_MANIFESTS) {
    const p = join(repoRoot, name);
    if (!existsSync(p)) continue;
    try {
      out.push(`${name}:\n${readFileSync(p, "utf8").slice(0, MAX_MANIFEST_CHARS)}`);
    } catch {
      /* unreadable → skip */
    }
  }
  const rootPkg = join(repoRoot, "package.json");
  if (existsSync(rootPkg)) {
    try {
      out.push(
        `package.json (root):\n${readFileSync(rootPkg, "utf8").slice(0, MAX_MANIFEST_CHARS)}`,
      );
    } catch {
      /* skip */
    }
  }
  return out.join("\n\n");
}

const SYSTEM_PROMPT = `You map a repository's reusable-UI-component layout for a component registry. You receive the repo's workspace-manifest files, the directories that contain a package.json, and a per-directory file-extension histogram.

Return STRICT JSON matching the schema. No prose, no markdown.

Definitions:
- A "component dir" is a directory whose primary contents are REUSABLE UI units. This is framework-AGNOSTIC: web components (React/Vue/Svelte/Astro buttons, cards, modals, layout, navigation, domain widgets) AND native UI units — SwiftUI views (\`struct X: View\`), Flutter/Jetpack-Compose widgets (\`extends StatelessWidget\`, \`@Composable fun\`), Razor/Blazor components. It is NOT a route/page/screen-entry dir, NOT tests, NOT stories, NOT backend/service/data/model code, NOT email templates.
- A "workspace" is an independently-scoped package or module. A monorepo has 2+ (each typically rooted at a package.json or a per-module manifest); a single app has one. Infer workspaces from the manifests / package roots / structure.

Hard rules — be convention-agnostic:
- Do NOT assume any naming OR any language. Component dirs are NOT necessarily named "components"; workspaces are NOT necessarily under "packages/" or "apps/"; the UI is NOT necessarily JS/React. Decide from the actual extension histogram and package roots, wherever they sit (top-level dirs, nested, anywhere).
- componentDirs are repo-relative POSIX paths that appear in the histogram.
- Include a workspace ONLY if it actually contains reusable UI units. A backend-only or data-only package (e.g. mostly .ts/.go/.kt services with no UI dir, or only email-template files) is OMITTED ENTIRELY.
- extensions: the UI file extensions actually present in that workspace's component dirs — web (".tsx", ".jsx", ".vue", ".svelte", ".astro", ".razor") or native (".swift" for SwiftUI, ".dart" for Flutter, ".kt" for Compose). Use whatever the histogram actually shows.
- categories: a SHORT taxonomy (5-12 lowercase kebab-case tags) derived from what THIS workspace actually is — a marketing site leans ["layout","navigation","marketing","forms","media","feedback"], an app shell leans ["layout","navigation","shell","domain","forms","overlay","feedback","data-display"]. Do not copy a fixed list; fit the workspace.
- name: "" for a single-app repo; for monorepo workspaces use the package's directory name (the last path segment of its root).
- If the repo has NO reusable UI components at all, return {"is_ui_repo": false, "monorepo": false, "workspaces": []}.`;

const OUTPUT_SCHEMA = {
  type: "object",
  required: ["is_ui_repo", "monorepo", "workspaces"],
  properties: {
    is_ui_repo: { type: "boolean" },
    monorepo: { type: "boolean" },
    workspaces: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "componentDirs", "extensions", "categories"],
        properties: {
          name: { type: "string" },
          componentDirs: { type: "array", items: { type: "string" } },
          extensions: { type: "array", items: { type: "string" } },
          categories: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} satisfies object;

const ResultSchema = z.object({
  is_ui_repo: z.boolean(),
  monorepo: z.boolean(),
  workspaces: z.array(
    z.object({
      name: z.string(),
      componentDirs: z.array(z.string()),
      extensions: z.array(z.string()),
      categories: z.array(z.string()),
    }),
  ),
});
type DetectResult = z.infer<typeof ResultSchema>;

function buildPrompt(repoRoot: string, digest: RepoDigest): string {
  const manifests = readWorkspaceManifests(repoRoot);
  return [
    "WORKSPACE MANIFESTS:",
    manifests.length > 0 ? manifests : "(none)",
    "",
    "DIRS CONTAINING A package/module manifest (workspace boundaries):",
    digest.moduleRoots.length > 0 ? digest.moduleRoots.join("\n") : "(none)",
    "",
    "DIRECTORY EXTENSION HISTOGRAM (path: <count><ext> …):",
    digest.histogram.length > 0 ? digest.histogram : "(no source files found)",
    "",
    "Return the component-layout JSON.",
  ].join("\n");
}

async function attempt(
  repoRoot: string,
  prompt: string,
): Promise<DetectResult | null> {
  let result;
  try {
    result = await runClaude({
      tier: "sonnet",
      prompt,
      system: SYSTEM_PROMPT,
      jsonSchema: OUTPUT_SCHEMA,
      timeoutMs: TIMEOUT_MS,
      repoRoot,
      cacheable: true,
      isolateAmbientContext: true,
      purpose: "init.detect-components",
    });
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "detect-components: runClaude failed",
    );
    return null;
  }
  const parsed = ResultSchema.safeParse(result.parsed);
  if (!parsed.success) {
    log.warn(
      { error: parsed.error.message },
      "detect-components: response failed schema",
    );
    return null;
  }
  return parsed.data;
}

function toConfig(parsed: DetectResult): ComponentsConfig | null {
  if (!parsed.is_ui_repo) return null;
  const ws = parsed.workspaces.filter((w) => w.componentDirs.length > 0);
  if (ws.length === 0) return null;

  const exclude = [...DEFAULT_EXCLUDE];

  // Multi-workspace → monorepo `workspaces` form. A lone workspace (even
  // if the model flagged the repo a monorepo) collapses to the flat form.
  if (ws.length >= 2) {
    const usedNames = new Set<string>();
    const workspaces: Record<string, unknown> = {};
    for (const w of ws) {
      let name = w.name.trim().length > 0 ? w.name.trim() : "app";
      let n = 2;
      while (usedNames.has(name)) name = `${w.name || "app"}-${n++}`;
      usedNames.add(name);
      workspaces[name] = {
        componentDirs: w.componentDirs,
        extensions: w.extensions,
        categories: w.categories,
      };
    }
    return { exclude, workspaces } as ComponentsConfig;
  }

  const single = ws[0]!;
  return {
    componentDirs: single.componentDirs,
    extensions: single.extensions,
    categories: single.categories,
    exclude,
  };
}

/**
 * Detect the repo's component layout via the model and return a
 * `components:` config block (raw yaml shape), or `null` when the repo
 * carries no reusable UI components. Retries the model call once before
 * giving up. There is no deterministic fallback by design: detection only
 * ever runs inside an LLM coding agent, so "no model" means adoption is
 * not happening at all.
 */
export async function detectComponentsConfig(
  repoRoot: string,
): Promise<ComponentsConfig | null> {
  const digest = buildRepoDigest(repoRoot);
  const prompt = buildPrompt(repoRoot, digest);
  const out = (await attempt(repoRoot, prompt)) ?? (await attempt(repoRoot, prompt));
  if (out === null) return null;
  // Coverage safety net: a single Sonnet pass routinely under-scopes
  // componentDirs — it picks a dense nested sub-directory of a component
  // container and misses the sibling sub-directories under the same
  // container, so 9d-comp-walk only ever sees that one cluster. Widen each
  // chosen dir up to its enclosing component-container root before building
  // the config. Bounded: stops at a package boundary, the repo root, or the
  // first ancestor whose name isn't a recognized container word. The
  // `isUnitShaped` filter in `collectComponents` keeps the wider walk from
  // flooding the gate with route/page/util files.
  const widened = widenDetectedDirs(out, new Set(digest.moduleRoots));
  return toConfig(widened);
}

/**
 * Generic component-container directory names. When a chosen componentDir's
 * parent is one of these, the chosen dir is a sub-category and the parent
 * is the real registry root — widen to it. Convention-agnostic detection
 * still leads; this only EXPANDS to a parent that literally is a component
 * container, never narrows or invents.
 */
const COMPONENT_CONTAINER_DIRS = new Set<string>([
  "components",
  "component",
  "ui",
  "widgets",
  "widget",
  "views",
  "view",
  "composables",
  "blocks",
  "elements",
  "partials",
  "fragments",
  "screens",
]);

/** POSIX dirname for repo-relative paths (no drive letters, no leading `/`). */
function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "." : p.slice(0, i);
}

/** Strip a leading `./` and any trailing slashes; collapse `\` → `/`. */
function normalizeRelDir(d: string): string {
  return d.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Walk a chosen componentDir up to its enclosing component-container root.
 * Each step climbs one level only while the PARENT's basename is a generic
 * container word and the parent is neither a package/module boundary nor the
 * repo root. A nested sub-directory of a container folder widens to the
 * container; a dir already at the container root stays put (its parent is
 * not a container word).
 */
function widenToContainerRoot(dir: string, moduleRoots: Set<string>): string {
  let cur = normalizeRelDir(dir);
  for (let i = 0; i < 12; i++) {
    const parent = posixDirname(cur);
    if (parent === "." || parent === cur) break;
    if (moduleRoots.has(parent)) break;
    const base = parent.slice(parent.lastIndexOf("/") + 1).toLowerCase();
    if (!COMPONENT_CONTAINER_DIRS.has(base)) break;
    cur = parent;
  }
  return cur;
}

/** Drop exact dupes and any dir nested under another dir already in the set. */
function dedupeNestedDirs(dirs: string[]): string[] {
  const uniq = [...new Set(dirs.map(normalizeRelDir))]
    .filter((d) => d.length > 0)
    .sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const d of uniq) {
    if (kept.some((k) => d === k || d.startsWith(`${k}/`))) continue;
    kept.push(d);
  }
  return kept;
}

/** Apply container-root widening + nested-dir collapse to every workspace. */
function widenDetectedDirs(
  parsed: DetectResult,
  moduleRoots: Set<string>,
): DetectResult {
  return {
    ...parsed,
    workspaces: parsed.workspaces.map((w) => ({
      ...w,
      componentDirs: dedupeNestedDirs(
        w.componentDirs.map((d) => widenToContainerRoot(d, moduleRoots)),
      ),
    })),
  };
}

export type EnsureComponentsStatus =
  /** No `.cairn/config.yaml` — the repo isn't adopted; run `/cairn-adopt` first. */
  | "not-adopted"
  /** A `components:` block already exists — left untouched (idempotent). */
  | "exists"
  /** No reusable UI components on disk — nothing written (non-UI repo). */
  | "none"
  /** A `components:` block was detected and merged into the config. */
  | "written";

export interface EnsureComponentsConfigResult {
  status: EnsureComponentsStatus;
  /** The detected block, present only on "written". */
  config?: ComponentsConfig;
  /** True when the written block uses the monorepo `workspaces` form. */
  monorepo: boolean;
}

/**
 * Backfill a `components:` block into an already-adopted repo's
 * `.cairn/config.yaml`. Runs the same LLM detection adoption Phase 4-seed
 * runs, but MERGES the key into a config that already exists (preserving
 * every other key) rather than writing a fresh file.
 *
 * Idempotent: a repo that already carries a `components:` block is left
 * untouched ("exists"). The standalone backfill path
 * (`cairn components detect`, driven by the cairn-adopt-components skill)
 * is the only caller; adoption keeps using `detectComponentsConfig`
 * directly inside 4-seed.
 *
 * Isolation invariant (port invariant 3): workspaces are never emitted as
 * `shared` — the operator opts in afterward (the skill asks).
 */
export async function ensureComponentsConfig(
  repoRoot: string,
): Promise<EnsureComponentsConfigResult> {
  const configPath = cairnDir(repoRoot, "config.yaml");
  if (!existsSync(configPath)) {
    return { status: "not-adopted", monorepo: false };
  }

  const raw = readFileSync(configPath, "utf8");
  const parsed = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  if (parsed["components"] !== undefined && parsed["components"] !== null) {
    return { status: "exists", monorepo: false };
  }

  const components = await detectComponentsConfig(repoRoot);
  if (components === null) {
    return { status: "none", monorepo: false };
  }

  parsed["components"] = components;
  writeFileSync(configPath, stringifyYaml(parsed), "utf8");
  return {
    status: "written",
    config: components,
    monorepo: components.workspaces !== undefined,
  };
}

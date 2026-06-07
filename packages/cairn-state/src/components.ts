/**
 * Component registry — Cairn's fourth ground store.
 *
 * Headers in source (`@cairn <ExportName>` comments) are the committed
 * source of truth; `.cairn/ground/components/` holds the *derived* index the
 * agent reads in full before UI work. This module is the pure state layer:
 * config loading, header parsing, repo walking, deterministic index
 * rendering, and validation. Disk writes, the advisory audit, MCP tools, and
 * adoption phases live in cairn-core.
 *
 * Two comment forms are accepted (framework-agnostic; defaults React-flavored):
 *   1. Block form  — the FIRST `/** *​/` comment in the file.
 *   2. Hash form   — the first contiguous run of `#` lines (shebang-aware).
 *
 * The `@cairn <Name>` registry header is disjoint from the pre-existing
 * `@cairn:decision` / `@cairn:rule` SoT markers: the header detector requires
 * whitespace then an identifier start, so a colon-form marker can never be
 * misread as a header. See docs/COMPONENT_STORE_PLAN.md §2.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { walkFs } from "./fs.js";

/* -------------------------------------------------------------------------- */
/* Defaults — the React/UI profile. Overridable per project in config.yaml.   */
/* -------------------------------------------------------------------------- */

export const DEFAULT_CATEGORIES = [
  "layout",
  "navigation",
  "data-display",
  "forms",
  "feedback",
  "overlay",
  "media",
  "marketing",
  "utility",
] as const;

export const DEFAULT_EXTENSIONS = [".tsx", ".jsx"] as const;

export const DEFAULT_EXCLUDE = [
  "node_modules",
  "dist",
  ".next",
  "build",
  "coverage",
  "__tests__",
  "__mocks__",
  "stories",
] as const;

/** Tags a header MUST carry. */
export const COMPONENT_REQUIRED_TAGS = ["cairn", "category", "purpose", "aliases"] as const;

/* -------------------------------------------------------------------------- */
/* Config — the `components:` section of .cairn/config.yaml                    */
/* -------------------------------------------------------------------------- */

export const ComponentsWorkspaceConfig = z
  .object({
    componentDirs: z.array(z.string()).default([]),
    extensions: z.array(z.string()).optional(),
    categories: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    shared: z.boolean().optional(),
  })
  .passthrough();
export type ComponentsWorkspaceConfig = z.infer<typeof ComponentsWorkspaceConfig>;

export const ComponentsConfig = z
  .object({
    componentDirs: z.array(z.string()).optional(),
    extensions: z.array(z.string()).optional(),
    categories: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    workspaces: z.record(z.string(), ComponentsWorkspaceConfig).optional(),
  })
  .passthrough();
export type ComponentsConfig = z.infer<typeof ComponentsConfig>;

/** A workspace after defaults are folded in. `name: ""` = single-app. */
export interface ComponentWorkspace {
  name: string;
  componentDirs: string[];
  exclude: string[];
  extensions: string[];
  categories: string[];
  shared: boolean;
}

export interface NormalizedComponentsConfig {
  workspaces: ComponentWorkspace[];
}

/**
 * Fold the raw `components:` config into a normalized workspace list.
 * Flat (single-app) config becomes one unnamed workspace; a `workspaces`
 * map becomes one entry per key, each inheriting the top-level
 * exclude/extensions/categories unless it overrides them.
 */
export function normalizeComponentsConfig(
  raw: ComponentsConfig,
): NormalizedComponentsConfig {
  const base = {
    exclude: raw.exclude ?? [...DEFAULT_EXCLUDE],
    extensions: raw.extensions ?? [...DEFAULT_EXTENSIONS],
    categories: raw.categories ?? [...DEFAULT_CATEGORIES],
  };
  if (raw.workspaces && Object.keys(raw.workspaces).length > 0) {
    return {
      workspaces: Object.entries(raw.workspaces).map(([name, ws]) => ({
        name,
        componentDirs: ws.componentDirs ?? [],
        exclude: ws.exclude ?? base.exclude,
        extensions: ws.extensions ?? base.extensions,
        categories: ws.categories ?? base.categories,
        // Isolation policy: a workspace is ISOLATED unless explicitly shared.
        shared: ws.shared === true,
      })),
    };
  }
  return {
    workspaces: [
      {
        name: "",
        componentDirs: raw.componentDirs ?? [],
        ...base,
        shared: false,
      },
    ],
  };
}

/** Read + normalize the `components:` config from `.cairn/config.yaml`. */
export function loadComponentsConfig(repoRoot: string): NormalizedComponentsConfig {
  const p = join(repoRoot, ".cairn", "config.yaml");
  let rawDoc: unknown = {};
  if (existsSync(p)) {
    try {
      rawDoc = parseYaml(readFileSync(p, "utf8"));
    } catch {
      rawDoc = {};
    }
  }
  const comp =
    typeof rawDoc === "object" && rawDoc !== null
      ? (rawDoc as Record<string, unknown>)["components"]
      : undefined;
  const parsed = ComponentsConfig.safeParse(comp ?? {});
  return normalizeComponentsConfig(parsed.success ? parsed.data : {});
}

/** True when any workspace declares at least one component dir. */
export function hasComponentConfig(config: NormalizedComponentsConfig): boolean {
  return config.workspaces.some((ws) => ws.componentDirs.length > 0);
}

/** True for monorepo configs (more than one workspace). */
export function isMonorepoComponents(config: NormalizedComponentsConfig): boolean {
  return config.workspaces.length > 1;
}

/* -------------------------------------------------------------------------- */
/* Header parsing                                                             */
/* -------------------------------------------------------------------------- */

export interface ComponentTags {
  cairn?: string;
  category?: string;
  purpose?: string;
  aliases?: string;
  props?: string;
  uses?: string;
  singleton?: string;
  status?: string;
  example?: string;
  [k: string]: string | undefined;
}

export interface ComponentRecord {
  /** Repo-relative POSIX path. */
  file: string;
  /** Owning workspace name; "" for single-app. */
  workspace: string;
  tags: ComponentTags;
  /** Best-effort detected export name, or null when undetectable. */
  exportName: string | null;
}

const BLOCK_RE = /\/\*\*([\s\S]*?)\*\//;
/**
 * Registry-header signal: `@cairn` then whitespace then an identifier start.
 * Deliberately excludes the colon-form `@cairn:decision` / `@cairn:rule`
 * SoT markers — those can never be whitespace-then-identifier.
 */
const HEADER_SIGNAL_RE = /@cairn[ \t]+[A-Za-z_$]/;

/**
 * True when a raw comment block is a `@cairn` registry header. Exported so
 * the source-comment + curator walkers can exclude headers from candidate
 * registration (headers must not pollute the topic index or be stripped).
 */
export function isComponentHeaderBlock(rawBlockText: string): boolean {
  return HEADER_SIGNAL_RE.test(rawBlockText);
}

function parseTagLines(lines: string[]): ComponentTags {
  const tags: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/@([a-zA-Z]+)\b(?:[ \t]+(.*))?/);
    if (m) {
      const value = (m[2] ?? "").trim();
      tags[m[1]!.toLowerCase()] = value.length > 0 ? value : "true";
    }
  }
  return tags as ComponentTags;
}

/**
 * Parse a file's component header into a tag map, or null if absent.
 * Honors the spec rule that the header must be the FIRST block comment
 * (block form) or the first contiguous `#` run (hash form).
 */
export function parseComponentHeader(source: string): ComponentTags | null {
  const block = source.match(BLOCK_RE);
  if (block && isComponentHeaderBlock(block[1] ?? "")) {
    return parseTagLines((block[1] ?? "").split("\n"));
  }

  const lines = source.split("\n");
  let i = 0;
  if (lines[0]?.startsWith("#!")) i = 1;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  const hash: string[] = [];
  while (i < lines.length && (lines[i] ?? "").trim().startsWith("#")) {
    hash.push((lines[i] ?? "").replace(/^\s*#+\s?/, ""));
    i++;
  }
  if (isComponentHeaderBlock(hash.join("\n"))) return parseTagLines(hash);
  return null;
}

/** Best-effort exported-name extraction (JS/TS). Null when undetectable. */
export function extractExportName(source: string): string | null {
  let m = source.match(
    /export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_]+)/,
  );
  if (m) return m[1] ?? null;
  m = source.match(/export\s+(?:async\s+)?(?:function|class|const)\s+([A-Za-z0-9_]+)/);
  if (m) return m[1] ?? null;
  m = source.match(/export\s+default\s+([A-Za-z0-9_]+)\s*;/);
  if (m) return m[1] ?? null;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Collection                                                                 */
/* -------------------------------------------------------------------------- */

export interface CollectResult {
  components: ComponentRecord[];
  /** Repo-relative paths of scanned files with no header. */
  missing: string[];
}

/**
 * Walk every workspace's component dirs and parse headers. Returns the
 * parsed components plus the files that are missing a header. Output is
 * deterministically sorted (workspace, then component name).
 */
export function collectComponents(
  repoRoot: string,
  config: NormalizedComponentsConfig,
): CollectResult {
  const components: ComponentRecord[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const ws of config.workspaces) {
    const skipDirs = new Set(ws.exclude);
    const exts = new Set(ws.extensions);
    for (const dir of ws.componentDirs) {
      const absDir = join(repoRoot, dir);
      if (!existsSync(absDir)) continue;
      walkFs({
        dir: absDir,
        repoRoot,
        skipDirs,
        onFile: (rel, abs) => {
          if (!exts.has(extname(abs))) return;
          if (seen.has(`${ws.name} ${rel}`)) return;
          seen.add(`${ws.name} ${rel}`);
          let source: string;
          try {
            source = readFileSync(abs, "utf8");
          } catch {
            return;
          }
          const tags = parseComponentHeader(source);
          if (tags === null) {
            missing.push(rel);
            return;
          }
          components.push({
            file: rel,
            workspace: ws.name,
            tags,
            exportName: extractExportName(source),
          });
        },
      });
    }
  }

  components.sort(
    (a, b) =>
      (a.workspace || "").localeCompare(b.workspace || "") ||
      (a.tags.cairn || "").localeCompare(b.tags.cairn || ""),
  );
  missing.sort();
  return { components, missing };
}

/* -------------------------------------------------------------------------- */
/* Index rendering — deterministic, sorted, no timestamps                     */
/* -------------------------------------------------------------------------- */

const GENERATED_NOTE =
  "<!-- GENERATED — do not edit. Rebuild: `cairn components index`. Source of truth is the @cairn headers in code. -->";

const FORMAT_LEGEND = [
  "Line format: `Name [S]? | aliases | purpose` — file is `<dir heading>/<Name>.<ext>` unless `file:` says otherwise.",
  "`[S]` = singleton: exists exactly once by project decision — extend in place, NEVER fork or rebuild.",
];

/** Filesystem-safe slice slug for a workspace name. */
export function sliceSlug(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

/** Relative path (under the components ground dir) of a workspace slice. */
export function sliceRelPath(name: string): string {
  return `index/${sliceSlug(name)}.md`;
}

function renderGroup(
  lines: string[],
  components: ComponentRecord[],
  categories: string[],
  extensions: string[],
  depth: number,
): void {
  const extRe = new RegExp(
    `(${extensions.map((e) => e.replace(".", "\\.")).join("|")})$`,
  );
  const byCat = new Map<string, ComponentRecord[]>();
  for (const c of components) {
    const cat = c.tags.category || "uncategorized";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(c);
  }
  const order = [
    ...categories,
    ...[...byCat.keys()].filter((k) => !categories.includes(k)).sort(),
  ];
  for (const cat of order) {
    const list = byCat.get(cat);
    if (!list || list.length === 0) continue;
    lines.push("", `${"#".repeat(depth)} ${cat}`);
    const byDir = new Map<string, ComponentRecord[]>();
    for (const c of list) {
      const dir = c.file.includes("/")
        ? c.file.slice(0, c.file.lastIndexOf("/"))
        : ".";
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir)!.push(c);
    }
    for (const dir of [...byDir.keys()].sort()) {
      lines.push(`${"#".repeat(depth + 1)} ${dir}/`);
      for (const c of byDir.get(dir)!) {
        const t = c.tags;
        const s = t.singleton ? " [S]" : "";
        const base = c.file.slice(c.file.lastIndexOf("/") + 1);
        const stem = base.replace(extRe, "");
        const fileNote = stem === t.cairn ? "" : ` | file: ${base}`;
        lines.push(`${t.cairn || "?"}${s} | ${t.aliases || ""} | ${t.purpose || ""}${fileNote}`);
      }
    }
  }
}

function renderSingle(
  components: ComponentRecord[],
  ws: ComponentWorkspace,
): string {
  const lines = [
    "# Cairn Components — Index",
    "",
    GENERATED_NOTE,
    "Read this entire file before any UI work — it is the complete component inventory.",
    ...FORMAT_LEGEND,
  ];
  renderGroup(lines, components, ws.categories, ws.extensions, 2);
  return `${lines.join("\n")}\n`;
}

function renderManifest(
  components: ComponentRecord[],
  config: NormalizedComponentsConfig,
): string {
  const hasShared = config.workspaces.some((w) => w.shared);
  const lines = [
    "# Cairn Components — Manifest",
    "",
    GENERATED_NOTE,
    "This is a MANIFEST, not the inventory. Resolve your workspace from the file paths you are touching",
    "(longest prefix match below), then read ONLY that workspace slice — it contains everything you may use.",
    "Do NOT read other slices unless the task explicitly spans multiple workspaces.",
    hasShared
      ? "Sharing policy: `[shared]` workspace components are included in every slice and usable everywhere. All other workspaces are ISOLATED."
      : "Sharing policy: ALL workspaces are ISOLATED — never import, copy, or adapt a component from another workspace.",
    "",
    "| Workspace | Paths | Slice | Components |",
    "| --- | --- | --- | --- |",
  ];
  for (const ws of config.workspaces) {
    const count = components.filter((c) => c.workspace === ws.name).length;
    lines.push(
      `| ${ws.name}${ws.shared ? " [shared]" : ""} | ${ws.componentDirs.join(", ")} | ${sliceRelPath(ws.name)} | ${count} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderSlice(
  ws: ComponentWorkspace,
  components: ComponentRecord[],
  config: NormalizedComponentsConfig,
): string {
  const own = components.filter((c) => c.workspace === ws.name);
  const sharedOthers = config.workspaces.filter(
    (w) => w.shared && w.name !== ws.name,
  );
  const isolatedOthers = config.workspaces
    .filter((w) => !w.shared && w.name !== ws.name)
    .map((w) => w.name);
  const lines = [
    `# Cairn Components — workspace: ${ws.name}${ws.shared ? " [shared]" : ""}`,
    "",
    GENERATED_NOTE,
    "Read this entire file before any UI work in this workspace — it is the complete inventory you are allowed to use.",
    ...FORMAT_LEGEND,
  ];
  if (isolatedOthers.length > 0) {
    lines.push(
      `OFF-LIMITS workspaces (isolated — never import, copy, or adapt their components): ${isolatedOthers.join(", ")}.`,
    );
  }
  renderGroup(lines, own, ws.categories, ws.extensions, 2);
  for (const sw of sharedOthers) {
    const swComponents = components.filter((c) => c.workspace === sw.name);
    if (swComponents.length === 0) continue;
    lines.push("", `## shared workspace: ${sw.name} — usable from here`);
    renderGroup(lines, swComponents, sw.categories, sw.extensions, 3);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Render every index artifact as a Map of relative path (under
 * `.cairn/ground/components/`) → content. Single workspace: one flat
 * INDEX.md. Monorepo: INDEX.md manifest + index/<ws>.md slices — never an
 * all-workspace inventory file (the honeypot invariant).
 */
export function renderComponentsIndex(
  components: ComponentRecord[],
  config: NormalizedComponentsConfig,
): Map<string, string> {
  const files = new Map<string, string>();
  if (config.workspaces.length <= 1) {
    files.set("INDEX.md", renderSingle(components, config.workspaces[0]!));
    return files;
  }
  files.set("INDEX.md", renderManifest(components, config));
  for (const ws of config.workspaces) {
    files.set(sliceRelPath(ws.name), renderSlice(ws, components, config));
  }
  return files;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export type ComponentFindingKind =
  | "missing-header"
  | "missing-tag"
  | "invalid-category"
  | "duplicate-name"
  | "export-mismatch"
  | "alias-collision";

export interface ComponentFinding {
  kind: ComponentFindingKind;
  severity: "hard" | "soft";
  /** Repo-relative path the finding is about, when applicable. */
  file?: string;
  message: string;
}

/**
 * Validate headers across all workspaces. Name uniqueness + alias collisions
 * are scoped per workspace — platform/Button and site/Button may coexist.
 * Hard findings are gate failures; soft findings are warnings.
 */
export function validateComponents(
  result: CollectResult,
  config: NormalizedComponentsConfig,
): ComponentFinding[] {
  const findings: ComponentFinding[] = [];
  const wsCategories = new Map(config.workspaces.map((w) => [w.name, w.categories]));

  for (const f of result.missing) {
    findings.push({
      kind: "missing-header",
      severity: "hard",
      file: f,
      message: `missing @cairn header: ${f}`,
    });
  }

  const names = new Map<string, string>();
  for (const c of result.components) {
    const t = c.tags;
    for (const tag of COMPONENT_REQUIRED_TAGS) {
      if (!t[tag]) {
        findings.push({
          kind: "missing-tag",
          severity: "hard",
          file: c.file,
          message: `${c.file}: missing required @${tag}`,
        });
      }
    }
    const categories = wsCategories.get(c.workspace) ?? [...DEFAULT_CATEGORIES];
    if (t.category && !categories.includes(t.category)) {
      findings.push({
        kind: "invalid-category",
        severity: "hard",
        file: c.file,
        message: `${c.file}: invalid @category "${t.category}" (allowed: ${categories.join(", ")})`,
      });
    }
    if (t.cairn) {
      const key = `${c.workspace} ${t.cairn}`;
      const prior = names.get(key);
      if (prior !== undefined) {
        findings.push({
          kind: "duplicate-name",
          severity: "hard",
          file: c.file,
          message: `duplicate @cairn name "${t.cairn}": ${prior} and ${c.file}`,
        });
      } else {
        names.set(key, c.file);
      }
    }
    if (t.cairn && c.exportName && t.cairn !== c.exportName) {
      findings.push({
        kind: "export-mismatch",
        severity: "soft",
        file: c.file,
        message: `${c.file}: @cairn "${t.cairn}" does not match exported name "${c.exportName}" — the registry must not lie about the code; rename the export or fix the header`,
      });
    }
  }

  const aliasMap = new Map<string, string>();
  for (const c of result.components) {
    const aliases = (c.tags.aliases || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    for (const a of aliases) {
      const key = `${c.workspace} ${a}`;
      const owner = aliasMap.get(key);
      if (owner !== undefined && owner !== c.tags.cairn) {
        findings.push({
          kind: "alias-collision",
          severity: "soft",
          file: c.file,
          message: `alias "${a}" claimed by both ${owner} and ${c.tags.cairn ?? "?"}`,
        });
      } else if (c.tags.cairn) {
        aliasMap.set(key, c.tags.cairn);
      }
    }
  }

  return findings;
}

/* -------------------------------------------------------------------------- */
/* Derived ledger — for Cairn Lens + MCP tools                                */
/* -------------------------------------------------------------------------- */

export interface ComponentLedgerEntry {
  name: string;
  workspace: string;
  file: string;
  category: string;
  purpose: string;
  aliases: string[];
  singleton: boolean;
  status?: string;
  uses: string[];
}

function toLedgerEntry(c: ComponentRecord): ComponentLedgerEntry {
  const entry: ComponentLedgerEntry = {
    name: c.tags.cairn ?? "?",
    workspace: c.workspace,
    file: c.file,
    category: c.tags.category ?? "",
    purpose: c.tags.purpose ?? "",
    aliases: (c.tags.aliases ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    singleton: Boolean(c.tags.singleton),
    uses: (c.tags.uses ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
  if (c.tags.status) entry.status = c.tags.status;
  return entry;
}

/** Collect + project the component registry into ledger entries. */
export function buildComponentsLedger(repoRoot: string): ComponentLedgerEntry[] {
  const config = loadComponentsConfig(repoRoot);
  const { components } = collectComponents(repoRoot, config);
  return components.map(toLedgerEntry);
}

/* -------------------------------------------------------------------------- */
/* In-scope resolution — used by cairn_components_in_scope                     */
/* -------------------------------------------------------------------------- */

export interface ComponentScope {
  /** Workspaces the requested paths resolved to (own + shared). */
  workspaces: string[];
  /** Isolated workspaces the caller may NOT use (awareness list). */
  offLimits: string[];
  /** The entitled inventory. */
  components: ComponentLedgerEntry[];
}

/**
 * Resolve which workspace(s) the given repo-relative path globs touch
 * (longest-prefix match against component dirs), and return the entitled
 * inventory: own workspace(s) + any `[shared]` workspace, with isolated
 * workspaces named in `offLimits`. Single-app → the whole inventory.
 */
export function componentsInScope(
  repoRoot: string,
  pathGlobs: string[],
): ComponentScope {
  const config = loadComponentsConfig(repoRoot);
  const { components } = collectComponents(repoRoot, config);
  const ledger = components.map(toLedgerEntry);

  if (config.workspaces.length <= 1) {
    return { workspaces: [config.workspaces[0]?.name ?? ""], offLimits: [], components: ledger };
  }

  // Resolve target workspaces by longest-prefix dir match against the globs.
  const targets = new Set<string>();
  for (const glob of pathGlobs) {
    let bestWs: string | null = null;
    let bestLen = -1;
    for (const ws of config.workspaces) {
      for (const dir of ws.componentDirs) {
        if ((glob === dir || glob.startsWith(`${dir}/`)) && dir.length > bestLen) {
          bestLen = dir.length;
          bestWs = ws.name;
        }
      }
    }
    if (bestWs !== null) targets.add(bestWs);
  }

  const sharedNames = config.workspaces.filter((w) => w.shared).map((w) => w.name);
  const entitled = new Set<string>([...targets, ...sharedNames]);
  const offLimits = config.workspaces
    .filter((w) => !entitled.has(w.name))
    .map((w) => w.name);

  return {
    workspaces: [...entitled].sort(),
    offLimits: offLimits.sort(),
    components: ledger.filter((c) => entitled.has(c.workspace)),
  };
}

/** Look up a single component by name (optionally scoped to a workspace). */
export function getComponent(
  repoRoot: string,
  name: string,
  workspace?: string,
): { entry: ComponentLedgerEntry; record: ComponentRecord } | null {
  const config = loadComponentsConfig(repoRoot);
  const { components } = collectComponents(repoRoot, config);
  const match = components.find(
    (c) =>
      c.tags.cairn === name &&
      (workspace === undefined || c.workspace === workspace),
  );
  if (match === undefined) return null;
  return { entry: toLedgerEntry(match), record: match };
}

/**
 * Component audit — advisory, read-only, never blocks (port invariant 5).
 *
 * Finds violations that predate adoption:
 *   1. Probable inline rebuilds — `className` lists in non-component code
 *      whose Tailwind utility ROOTS closely match an indexed component's
 *      (max-w-2xl ≈ max-w-4xl, so value-tweaked copies still match).
 *      Similarity is IDF-weighted over the component corpus: a utility root
 *      that nearly every component uses (`flex`, `gap`, `mx`, `px`) carries
 *      almost no weight, so a page sharing only generic layout scaffolding
 *      does NOT match — only overlap on DISTINCTIVE class roots counts. This
 *      is self-tuning to the project's own CSS; no hardcoded utility list.
 *   2. Name collisions — `@cairn` names colliding with a type/interface name.
 *   3. Unregistered components — a component-shaped file (PascalCase
 *      basename, real exports, JSX markup) sitting OUTSIDE the declared
 *      component dirs. These are co-located components the registry can't
 *      see; route entry files (page.tsx/layout.tsx — lowercase) are
 *      naturally excluded, so no framework convention list is hardcoded.
 *      Surfaced as an offer to relocate or register the dir — never moved.
 *
 * Findings are triage input surfaced to the attention queue with EXTEND /
 * rename / register recommendations; never auto-fixed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectComponents,
  extractExportName,
  extractExportNames,
  hasComponentConfig,
  loadComponentsConfig,
  walkFs,
  type ComponentRecord,
  type NormalizedComponentsConfig,
} from "@isaacriehm/cairn-state";

const SIMILARITY_THRESHOLD = 0.7;
const MIN_SHARED_ROOTS = 3;
const MIN_CLASSES = 3;
/**
 * A shared root only counts toward MIN_SHARED_ROOTS if it is distinctive —
 * idf ≥ ln(2), i.e. the root appears in fewer than ~half of all components.
 * Ubiquitous layout utilities fall below this and never satisfy the gate.
 */
const IDF_DISTINCTIVE_FLOOR = Math.log(2);

const CLASS_ATTR_RE = /className\s*=\s*(?:"([^"]+)"|'([^']+)'|\{`([^`]+)`\})/g;
const VALUE_SUFFIX = /-(?:\d[^-]*|xs|sm|md|lg|xl|\dxl|auto|full|none|screen|px)$/;

const SKIP_DIRS = new Set([".git", ".cairn", "node_modules", "dist", ".next", "build", "coverage"]);

export type ComponentAuditKind =
  | "inline-rebuild"
  | "name-collision"
  | "unregistered-component";

export interface ComponentAuditFinding {
  kind: ComponentAuditKind;
  /** Where the probable violation lives (repo-relative POSIX). */
  file: string;
  line?: number;
  /** The indexed component it matched. */
  component: string;
  componentFile: string;
  score?: number;
  message: string;
  recommendation: string;
}

export interface ComponentAuditResult {
  findings: ComponentAuditFinding[];
  scanned: number;
}

/** "max-w-2xl" → "max-w", "px-4" → "px", "items-center" → unchanged. */
function utilityRoot(cls: string): string {
  let prev: string;
  let cur = cls;
  do {
    prev = cur;
    cur = cur.replace(VALUE_SUFFIX, "");
  } while (cur !== prev && cur.includes("-"));
  return cur || prev;
}

interface ClassList {
  classes: string[];
  line: number;
}

function classLists(source: string): ClassList[] {
  const lists: ClassList[] = [];
  CLASS_ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLASS_ATTR_RE.exec(source)) !== null) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
    const classes = raw.split(/\s+/).filter(Boolean);
    if (classes.length >= MIN_CLASSES) {
      lists.push({ classes, line: source.slice(0, m.index).split("\n").length });
    }
  }
  return lists;
}

/** Distinct utility roots of a class list. */
function rootSet(classes: string[]): Set<string> {
  return new Set(classes.map(utilityRoot));
}

function inComponentDirs(rel: string, config: NormalizedComponentsConfig): boolean {
  return config.workspaces.some((ws) =>
    ws.componentDirs.some((d) => rel === d || rel.startsWith(`${d}/`)),
  );
}

/** JSX markup signal — a tag or a className attribute. */
const JSX_RE = /<[A-Za-z][^>]*\/?>|className\s*=/;

/**
 * If a file outside the component dirs looks like a misplaced COMPONENT
 * (rather than a hook/context/util, or markup duplicated inside
 * non-component code), return its exported names; otherwise null. Three
 * convention-based signals, no framework list:
 *   1. PascalCase basename — named component files are `FeaturedShell.tsx`;
 *      framework route entry files are lowercase (`page.tsx`, `layout.tsx`).
 *   2. Exports a PascalCase symbol — a component-like export exists (a file
 *      exporting only `useThing` / consts is a hook/util, not a component).
 *   3. Renders JSX — excludes type-only / pure-logic files.
 */
function misplacedComponentExports(rel: string, source: string): string[] | null {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const stem = base.includes(".") ? base.slice(0, base.indexOf(".")) : base;
  if (!/^[A-Z][a-z]/.test(stem)) return null;
  const names = extractExportNames(source);
  if (!names.some((n) => /^[A-Z][a-z]/.test(n))) return null;
  if (!JSX_RE.test(source)) return null;
  return names;
}

export function runComponentAudit(repoRoot: string): ComponentAuditResult {
  const config = loadComponentsConfig(repoRoot);
  if (!hasComponentConfig(config)) return { findings: [], scanned: 0 };

  const { components } = collectComponents(repoRoot, config);
  const extensions = new Set(config.workspaces.flatMap((w) => w.extensions));
  const typeExts = new Set([...extensions, ".ts"]);
  const skipDirs = new Set([...SKIP_DIRS, ...config.workspaces.flatMap((w) => w.exclude)]);

  const findings: ComponentAuditFinding[] = [];
  let scanned = 0;

  // ── 1. Inline-rebuild scan ────────────────────────────────────────────
  // Each component's className lists, with utility roots precomputed.
  const signatures = components
    .map((c: ComponentRecord) => {
      let src = "";
      try {
        src = readFileSync(join(repoRoot, c.file), "utf8");
      } catch {
        /* skip unreadable */
      }
      const lists = classLists(src).map((l) => ({
        line: l.line,
        roots: rootSet(l.classes),
      }));
      return { name: c.tags.cairn ?? "?", file: c.file, lists };
    })
    .filter((c) => c.lists.length > 0);

  // Corpus IDF: how distinctive each utility root is. A root present in many
  // components (df → N) gets idf → 0; a rare root gets a high weight. Document
  // = one component (union of its lists' roots), so repetition within a file
  // doesn't inflate frequency.
  const corpusN = signatures.length;
  const docFreq = new Map<string, number>();
  for (const c of signatures) {
    const compRoots = new Set<string>();
    for (const l of c.lists) for (const r of l.roots) compRoots.add(r);
    for (const r of compRoots) docFreq.set(r, (docFreq.get(r) ?? 0) + 1);
  }
  const idf = (root: string): number =>
    Math.log((corpusN + 1) / ((docFreq.get(root) ?? 0) + 1));

  // IDF-weighted Jaccard between two root sets, plus the count of shared
  // DISTINCTIVE roots (ubiquitous roots don't count toward the gate).
  const weightedSimilarity = (
    target: Set<string>,
    comp: Set<string>,
  ): { score: number; shared: number } => {
    let inter = 0;
    let union = 0;
    let shared = 0;
    for (const r of target) {
      const w = idf(r);
      union += w;
      if (comp.has(r)) {
        inter += w;
        if (w >= IDF_DISTINCTIVE_FLOOR) shared += 1;
      }
    }
    for (const r of comp) if (!target.has(r)) union += idf(r);
    return { score: union > 0 ? inter / union : 0, shared };
  };

  // ── 2. Name-collision prep ────────────────────────────────────────────
  const nameToComponent = new Map<string, ComponentRecord>();
  for (const c of components) if (c.tags.cairn) nameToComponent.set(c.tags.cairn, c);

  walkFs({
    dir: repoRoot,
    repoRoot,
    skipDirs,
    onFile: (rel, abs) => {
      const ext = rel.slice(rel.lastIndexOf("."));
      if (!typeExts.has(ext)) return;
      if (inComponentDirs(rel, config)) {
        // component files still get the name-collision scan below via the
        // type-ext branch, but skip inline-rebuild self-matches.
      }
      let source: string;
      try {
        source = readFileSync(abs, "utf8");
      } catch {
        return;
      }
      scanned += 1;

      // Inline rebuild — only in non-component code with a UI extension.
      if (extensions.has(ext) && !inComponentDirs(rel, config)) {
        // A component-shaped file outside the component dirs is not a
        // rebuild — it is a co-located component the registry can't see.
        // Surface it (with its export names + file) as an offer to
        // relocate/register; skip the rebuild scan for it.
        const exports = misplacedComponentExports(rel, source);
        if (exports !== null) {
          const primary = extractExportName(source) ?? exports[0]!;
          const others = exports.filter((n) => n !== primary);
          const dirs = config.workspaces.flatMap((w) => w.componentDirs).join(", ");
          findings.push({
            kind: "unregistered-component",
            file: rel,
            component: primary,
            componentFile: rel,
            message:
              `${primary} (${rel})${others.length > 0 ? ` — also exports ${others.join(", ")}` : ""} ` +
              `looks like a component but lives outside the declared component dir(s) (${dirs}); the registry can't see it`,
            recommendation: `move ${rel} into a component dir, or add its directory to the workspace's componentDirs — then header + index ${primary}`,
          });
          return;
        }
        for (const target of classLists(source)) {
          const troots = rootSet(target.classes);
          let best: { name: string; file: string; score: number } | null = null;
          for (const comp of signatures) {
            for (const list of comp.lists) {
              const { score, shared } = weightedSimilarity(troots, list.roots);
              if (score >= SIMILARITY_THRESHOLD && shared >= MIN_SHARED_ROOTS) {
                if (best === null || score > best.score) {
                  best = { name: comp.name, file: comp.file, score };
                }
              }
            }
          }
          if (best !== null) {
            findings.push({
              kind: "inline-rebuild",
              file: rel,
              line: target.line,
              component: best.name,
              componentFile: best.file,
              score: best.score,
              message: `${rel}:${target.line} matches ${best.name} (${best.file}), root-similarity ${best.score.toFixed(2)}`,
              recommendation: `EXTEND ${best.name} (add the variant) and replace the inline markup`,
            });
          }
        }
      }

      // Name collision — across all type/interface declarations.
      for (const [name, comp] of nameToComponent) {
        if (comp.file === rel) continue;
        const re = new RegExp(`\\b(?:interface|type)\\s+${name}\\b`);
        if (re.test(source)) {
          findings.push({
            kind: "name-collision",
            file: rel,
            component: name,
            componentFile: comp.file,
            message: `@cairn "${name}" (${comp.file}) collides with a type/interface in ${rel}`,
            recommendation: "rename the export (and header with it)",
          });
        }
      }
    },
  });

  return { findings, scanned };
}

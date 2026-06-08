/**
 * Component audit — advisory, read-only, never blocks (port invariant 5).
 *
 * Language-agnostic: class extraction, unit-shape, and style attributes come
 * from the shared `languages.ts` profile table (className for JSX, class= /
 * :class for Vue/Svelte/HTML, SwiftUI `View`, Flutter `Widget`, …). The
 * Tailwind-specific inline-rebuild scan (1) is gated on a detected Tailwind
 * config — a non-Tailwind repo skips it rather than misfiring.
 *
 * Finds violations that predate adoption:
 *   1. Probable inline rebuilds — class lists in non-component code
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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectComponents,
  escapeRegExp,
  extractExportName,
  hasComponentConfig,
  loadComponentsConfig,
  profileForExtension,
  profileForFile,
  typeDeclKeywordsForFile,
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

const VALUE_SUFFIX = /-(?:\d[^-]*|xs|sm|md|lg|xl|\dxl|auto|full|none|screen|px)$/;

/** Tailwind config filenames — presence gates the inline-rebuild scan. */
const TAILWIND_CONFIGS = [
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
  "tailwind.config.ts",
] as const;

/**
 * Whether the project uses Tailwind — the inline-rebuild scan's utility-root
 * grammar is Tailwind-specific, so a non-Tailwind repo skips it rather than
 * misfiring. Detected by config-file presence (root or any workspace's top
 * segment) or a `tailwindcss` dependency, never assumed.
 */
function usesTailwind(repoRoot: string, config: NormalizedComponentsConfig): boolean {
  const dirs = new Set<string>([""]);
  for (const ws of config.workspaces) {
    for (const d of ws.componentDirs) {
      const seg = d.split("/")[0];
      if (seg) dirs.add(seg);
    }
  }
  for (const dir of dirs) {
    for (const name of TAILWIND_CONFIGS) {
      if (existsSync(join(repoRoot, dir, name))) return true;
    }
  }
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (pkg.dependencies?.["tailwindcss"] ?? pkg.devDependencies?.["tailwindcss"]) return true;
  } catch {
    /* no / invalid package.json */
  }
  return false;
}

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

/**
 * Class lists found via the file's language profile style-attribute regexes
 * (`className=` for JSX, `class=` / `:class` for Vue/Svelte/HTML, …). The
 * captured class string is whichever of the alternation's groups matched.
 */
function classLists(source: string, styleAttrs: readonly RegExp[]): ClassList[] {
  const lists: ClassList[] = [];
  for (const attr of styleAttrs) {
    const re = new RegExp(attr.source, attr.flags.includes("g") ? attr.flags : `${attr.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      let captured = "";
      for (let i = 1; i < m.length; i++) {
        if (m[i] !== undefined) {
          captured = m[i]!;
          break;
        }
      }
      const raw = captured.replace(/\$\{[^}]*\}/g, " ");
      const classes = raw.split(/\s+/).filter(Boolean);
      if (classes.length >= MIN_CLASSES) {
        lists.push({ classes, line: source.slice(0, m.index).split("\n").length });
      }
      if (re.lastIndex === m.index) re.lastIndex += 1;
    }
  }
  return lists;
}

/** Style-attribute regexes for a file, or `[]` when the language is unknown. */
function styleAttrsFor(rel: string): readonly RegExp[] {
  return profileForFile(rel)?.styleAttrs ?? [];
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

/**
 * If a file outside the component dirs looks like a misplaced reusable UNIT
 * (rather than a hook/util/route entry or markup duplicated inside
 * non-component code), return its exported names; otherwise null. The
 * "looks like a unit" test is the file's language profile `isUnitShaped` —
 * React PascalCase + JSX, a Vue/Svelte SFC, a SwiftUI `View`, a Flutter
 * `Widget`, a Compose `@Composable` — never a hardcoded framework list.
 */
function misplacedUnitExports(rel: string, source: string): string[] | null {
  const profile = profileForFile(rel);
  if (profile === null || !profile.isUnitShaped(source, rel)) return null;
  const names = profile.exportSymbols(source, rel);
  return names.length > 0 ? names : null;
}

export function runComponentAudit(repoRoot: string): ComponentAuditResult {
  const config = loadComponentsConfig(repoRoot);
  if (!hasComponentConfig(config)) return { findings: [], scanned: 0 };

  const { components } = collectComponents(repoRoot, config);
  const extensions = new Set(config.workspaces.flatMap((w) => w.extensions));
  // Files scanned for type-name collisions: the configured UI extensions plus
  // their language families, so a `.tsx` project also scans sibling `.ts`
  // type files — derived from the registry, not a hardcoded `.ts`.
  const typeExts = new Set<string>(extensions);
  for (const e of extensions) {
    for (const x of profileForExtension(e)?.extensions ?? []) typeExts.add(x);
  }
  const skipDirs = new Set([...SKIP_DIRS, ...config.workspaces.flatMap((w) => w.exclude)]);
  // The inline-rebuild grammar is Tailwind-specific; non-Tailwind repos skip
  // it (unregistered-component + name-collision still run).
  const tailwind = usesTailwind(repoRoot, config);

  const findings: ComponentAuditFinding[] = [];
  let scanned = 0;

  // ── 1. Inline-rebuild scan ────────────────────────────────────────────
  // Each component's class lists (per the file's profile), utility roots
  // precomputed. Skipped entirely when the project isn't on Tailwind.
  const signatures = !tailwind
    ? []
    : components
        .map((c: ComponentRecord) => {
          let src = "";
          try {
            src = readFileSync(join(repoRoot, c.file), "utf8");
          } catch {
            /* skip unreadable */
          }
          const lists = classLists(src, styleAttrsFor(c.file)).map((l) => ({
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
        // A unit-shaped file outside the component dirs is not a rebuild — it
        // is a co-located component the registry can't see. Surface it (with
        // its export names + file) as an offer to relocate/register; skip the
        // rebuild scan for it.
        const exports = misplacedUnitExports(rel, source);
        if (exports !== null) {
          const primary = extractExportName(source, rel) ?? exports[0]!;
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
        for (const target of tailwind ? classLists(source, styleAttrsFor(rel)) : []) {
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

      // Name collision — across the file language's type declarations
      // (TS interface/type/class, Swift struct/protocol, Kotlin class, …).
      // Languages with no nominal types contribute no keywords → skipped.
      const declKeywords = typeDeclKeywordsForFile(rel);
      if (declKeywords.length > 0) {
        const kw = declKeywords.map(escapeRegExp).join("|");
        for (const [name, comp] of nameToComponent) {
          if (comp.file === rel) continue;
          const re = new RegExp(`\\b(?:${kw})\\s+${escapeRegExp(name)}\\b`);
          if (re.test(source)) {
            findings.push({
              kind: "name-collision",
              file: rel,
              component: name,
              componentFile: comp.file,
              message: `@cairn "${name}" (${comp.file}) collides with a type declaration in ${rel}`,
              recommendation: "rename the export (and header with it)",
            });
          }
        }
      }
    },
  });

  return { findings, scanned };
}

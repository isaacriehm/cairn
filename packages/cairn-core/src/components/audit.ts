/**
 * Component audit — advisory, read-only, never blocks (port invariant 5).
 *
 * Finds violations that predate adoption:
 *   1. Probable inline rebuilds — `className` lists in non-component code
 *      whose Tailwind utility ROOTS closely match an indexed component's
 *      (max-w-2xl ≈ max-w-4xl, so value-tweaked copies still match).
 *   2. Name collisions — `@cairn` names colliding with a type/interface name.
 *
 * Findings are triage input surfaced to the attention queue with EXTEND /
 * rename recommendations; never auto-fixed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectComponents,
  hasComponentConfig,
  loadComponentsConfig,
  walkFs,
  type ComponentRecord,
  type NormalizedComponentsConfig,
} from "@isaacriehm/cairn-state";
import { jaccard } from "../text/jaccard.js";

const SIMILARITY_THRESHOLD = 0.7;
const MIN_SHARED_ROOTS = 3;
const MIN_CLASSES = 3;

const CLASS_ATTR_RE = /className\s*=\s*(?:"([^"]+)"|'([^']+)'|\{`([^`]+)`\})/g;
const VALUE_SUFFIX = /-(?:\d[^-]*|xs|sm|md|lg|xl|\dxl|auto|full|none|screen|px)$/;

const SKIP_DIRS = new Set([".git", ".cairn", "node_modules", "dist", ".next", "build", "coverage"]);

export type ComponentAuditKind = "inline-rebuild" | "name-collision";

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

function rootSimilarity(
  a: string[],
  b: string[],
): { score: number; shared: number } {
  const ra = new Set(a.map(utilityRoot));
  const rb = new Set(b.map(utilityRoot));
  let shared = 0;
  for (const r of ra) if (rb.has(r)) shared += 1;
  return { score: jaccard(ra, rb), shared };
}

function inComponentDirs(rel: string, config: NormalizedComponentsConfig): boolean {
  return config.workspaces.some((ws) =>
    ws.componentDirs.some((d) => rel === d || rel.startsWith(`${d}/`)),
  );
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
  const signatures = components
    .map((c: ComponentRecord) => {
      let src = "";
      try {
        src = readFileSync(join(repoRoot, c.file), "utf8");
      } catch {
        /* skip unreadable */
      }
      return { name: c.tags.cairn ?? "?", file: c.file, lists: classLists(src) };
    })
    .filter((c) => c.lists.length > 0);

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
        for (const target of classLists(source)) {
          let best: { name: string; file: string; classes: string[]; score: number } | null = null;
          for (const comp of signatures) {
            for (const list of comp.lists) {
              const { score, shared } = rootSimilarity(target.classes, list.classes);
              if (score >= SIMILARITY_THRESHOLD && shared >= MIN_SHARED_ROOTS) {
                if (best === null || score > best.score) {
                  best = { name: comp.name, file: comp.file, classes: list.classes, score };
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

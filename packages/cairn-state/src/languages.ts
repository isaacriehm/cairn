/**
 * Language profile table — the single source of truth for every per-language
 * mechanical fact Cairn needs: which extensions belong to a language, what
 * comment forms a `@cairn` registry header may live in, how to pull the
 * top-level exported/public symbols out of a source file, whether a file
 * "looks like a reusable UI unit", and which style/class attributes its
 * markup uses.
 *
 * Why a data table and not branching code: Cairn runs INSIDE an LLM coding
 * agent, so semantic classification ("is this a component?", "what category?")
 * is the model's job (see `detect-components.ts`). The *mechanical* facts —
 * comment syntax, extension→language, export grammar — are pure lookup data
 * that should be easy to extend by adding a row, never a crash or a silent
 * JS/React default when a language is missing.
 *
 * This table is consumed by:
 *   - the component store (collection + audit) — export extraction, header
 *     comment-form parsing, unit-shape + style-attr detection;
 *   - the source-comment SoT walker — extension→`CommentLang` bucket;
 *   - the Layer-A stub-pattern sensor — extension→sensor language tag.
 *
 * A miss (extension not in the table) means "unknown": the file is skipped by
 * language-scoped features, never coerced into TypeScript.
 */

import { extname } from "node:path";
import type { CommentLang } from "./schemas.js";
import { isPascalCase, stemOf } from "./text.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** The comment syntaxes a registry header / essay comment can appear in. */
export type CommentForm = "block" | "line" | "hash" | "html" | "dash" | "docstring";

/**
 * Sensor/stub-pattern language tag — an OPEN string equal to a language
 * profile `id`. The registry IS the single source: any profile id (plus the
 * stub-pattern catalog's special `"all"`) is a valid tag, so a new language
 * becomes filterable just by living in the table. Common ids: typescript,
 * javascript, python, ruby, go, rust, sql.
 */
export type SensorLang = string;

export interface LanguageProfile {
  /** Canonical language id — "typescript", "vue", "swift", "kotlin", … */
  id: string;
  /** Extensions owned by this profile (lowercase, dot-prefixed). */
  extensions: readonly string[];
  /** Coarser bucket the source-comment walker groups by. */
  commentLang: CommentLang;
  /** Comment forms a `@cairn` header may be written in. */
  commentForms: readonly CommentForm[];
  /**
   * Every top-level exported / public symbol name (order-preserving,
   * de-duplicated). `basename` lets single-file-unit languages (Vue, Svelte,
   * Astro, Razor) report the file stem as their export.
   */
  exportSymbols(source: string, basename: string): string[];
  /**
   * Whether the file looks like a reusable UI unit (component / widget /
   * view) for THIS language — PascalCase React component, Vue/Svelte SFC,
   * SwiftUI `View` struct, Flutter `Widget`, Compose `@Composable`, etc.
   * Backend / non-UI languages return false.
   */
  isUnitShaped(source: string, basename: string): boolean;
  /** Class/style attribute regexes for the inline-rebuild audit. */
  styleAttrs: readonly RegExp[];
}

/* -------------------------------------------------------------------------- */
/* Export extractors — pluggable per language family                          */
/* -------------------------------------------------------------------------- */

type Pusher = (n: string | undefined) => void;

function collector(): { names: string[]; push: Pusher } {
  const names: string[] = [];
  const push: Pusher = (n) => {
    if (n && !names.includes(n)) names.push(n);
  };
  return { names, push };
}

/** `export (default)? function/class/const/let/var` + `export { … }` lists. */
function jsExportSymbols(source: string): string[] {
  const { names, push } = collector();
  for (const m of source.matchAll(
    /export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_$]+)/g,
  )) {
    push(m[1]);
  }
  for (const m of source.matchAll(
    /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g,
  )) {
    push(m[1]);
  }
  for (const m of source.matchAll(/export\s+default\s+([A-Za-z0-9_$]+)\s*;/g)) {
    push(m[1]);
  }
  for (const block of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const spec of (block[1] ?? "").split(",")) {
      const parts = spec.trim().split(/\s+as\s+/);
      push((parts[parts.length - 1] ?? "").trim() || undefined);
    }
  }
  return names;
}

/** Python: top-level `def` / `class` (no leading indentation = module scope). */
function pyExportSymbols(source: string): string[] {
  const { names, push } = collector();
  for (const m of source.matchAll(/^(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/gm)) push(m[1]);
  for (const m of source.matchAll(/^class[ \t]+([A-Za-z_]\w*)/gm)) push(m[1]);
  return names;
}

/** Go: exported = capitalized. Funcs (incl. receivers), types, vars, consts. */
function goExportSymbols(source: string): string[] {
  const { names, push } = collector();
  const pushCap: Pusher = (n) => {
    if (n && /^[A-Z]/.test(n)) push(n);
  };
  for (const m of source.matchAll(/^func[ \t]+([A-Za-z_]\w*)/gm)) pushCap(m[1]);
  for (const m of source.matchAll(/^func[ \t]*\([^)]*\)[ \t]*([A-Za-z_]\w*)/gm)) pushCap(m[1]);
  for (const m of source.matchAll(/^type[ \t]+([A-Za-z_]\w*)/gm)) pushCap(m[1]);
  for (const m of source.matchAll(/^(?:var|const)[ \t]+([A-Za-z_]\w*)/gm)) pushCap(m[1]);
  return names;
}

/** Rust: `pub` (incl. `pub(crate)`) fn/struct/enum/trait/const/static/mod/type. */
function rustExportSymbols(source: string): string[] {
  const { names, push } = collector();
  for (const m of source.matchAll(
    /^[ \t]*pub(?:\([^)]*\))?[ \t]+(?:async[ \t]+)?(?:unsafe[ \t]+)?(?:fn|struct|enum|trait|const|static|mod|type)[ \t]+([A-Za-z_]\w*)/gm,
  )) {
    push(m[1]);
  }
  return names;
}

/** Java: public class/interface/enum/record (the registry-relevant types). */
function javaExportSymbols(source: string): string[] {
  const { names, push } = collector();
  for (const m of source.matchAll(
    /\bpublic[ \t]+(?:final[ \t]+|abstract[ \t]+|sealed[ \t]+|static[ \t]+)*(?:class|interface|enum|record)[ \t]+([A-Za-z_]\w*)/g,
  )) {
    push(m[1]);
  }
  return names;
}

/** Kotlin: top-level decls (public is the default visibility) + @Composable. */
function kotlinExportSymbols(source: string): string[] {
  const { names, push } = collector();
  for (const m of source.matchAll(
    /^[ \t]*(?:public[ \t]+|internal[ \t]+)?(?:open[ \t]+|abstract[ \t]+|sealed[ \t]+|data[ \t]+)*(?:class|interface|object|fun|val|var)[ \t]+([A-Za-z_]\w*)/gm,
  )) {
    push(m[1]);
  }
  return names;
}

/** C#: public class/interface/record/struct/enum. */
function csharpExportSymbols(source: string): string[] {
  const { names, push } = collector();
  for (const m of source.matchAll(
    /\bpublic[ \t]+(?:partial[ \t]+|sealed[ \t]+|abstract[ \t]+|static[ \t]+)*(?:class|interface|record|struct|enum)[ \t]+([A-Za-z_]\w*)/g,
  )) {
    push(m[1]);
  }
  return names;
}

/** Swift: top-level func/class/struct/enum/protocol/actor declarations. */
function swiftExportSymbols(source: string): string[] {
  const { names, push } = collector();
  for (const m of source.matchAll(
    /\b(?:public[ \t]+|open[ \t]+|internal[ \t]+)?(?:final[ \t]+)?(?:func|class|struct|enum|protocol|actor)[ \t]+([A-Za-z_]\w*)/g,
  )) {
    push(m[1]);
  }
  return names;
}

/** Dart: class/mixin/enum (Flutter widgets are classes). */
function dartExportSymbols(source: string): string[] {
  const { names, push } = collector();
  for (const m of source.matchAll(
    /^[ \t]*(?:abstract[ \t]+)?(?:class|mixin|enum)[ \t]+([A-Za-z_]\w*)/gm,
  )) {
    push(m[1]);
  }
  return names;
}

/** Ruby: class/module/def. */
function rubyExportSymbols(source: string): string[] {
  const { names, push } = collector();
  for (const m of source.matchAll(/^[ \t]*(?:class|module|def)[ \t]+([A-Za-z_]\w*)/gm)) push(m[1]);
  return names;
}

/** PHP: class/interface/trait/function. */
function phpExportSymbols(source: string): string[] {
  const { names, push } = collector();
  for (const m of source.matchAll(/\b(?:class|interface|trait|function)[ \t]+([A-Za-z_]\w*)/g)) {
    push(m[1]);
  }
  return names;
}

/** Single-file-unit languages (Vue/Svelte/Astro/Razor): the export IS the file. */
function sfcExportSymbols(_source: string, basename: string): string[] {
  const stem = stemOf(basename);
  return stem.length > 0 ? [stem] : [];
}

/** Languages with no meaningful export grammar yet → empty. */
function noExports(): string[] {
  return [];
}

/* -------------------------------------------------------------------------- */
/* Unit-shape + style-attr detectors                                          */
/* -------------------------------------------------------------------------- */

/** JSX markup signal — a tag or a className attribute. */
const JSX_RE = /<[A-Za-z][^>]*\/?>|className\s*=/;

const CLASS_ATTR_JSX = /className\s*=\s*(?:"([^"]+)"|'([^']+)'|\{`([^`]+)`\})/g;
const CLASS_ATTR_HTML = /(?:^|\s)class\s*=\s*(?:"([^"]+)"|'([^']+)')/g;
const CLASS_BIND_VUE = /(?::class|\[class\]|class:)\s*=?\s*(?:"([^"]+)"|'([^']+)')/g;

const SWIFTUI_VIEW_RE = /\bstruct[ \t]+\w+[ \t]*:[ \t]*[^{]*\bView\b/;
const FLUTTER_WIDGET_RE = /\bclass[ \t]+\w+[ \t]+extends[ \t]+(?:StatelessWidget|StatefulWidget|\w*Widget)\b/;
const COMPOSE_RE = /@Composable\b[\s\S]{0,80}?\bfun[ \t]+[A-Z]\w*/;

/** React/JSX: PascalCase basename + a PascalCase export + JSX markup. */
function jsxUnitShaped(source: string, basename: string): boolean {
  if (!isPascalCase(stemOf(basename))) return false;
  if (!jsExportSymbols(source).some(isPascalCase)) return false;
  return JSX_RE.test(source);
}

/* -------------------------------------------------------------------------- */
/* The profile table                                                          */
/* -------------------------------------------------------------------------- */

const CSTYLE_FORMS: readonly CommentForm[] = ["block", "line"];

export const LANGUAGE_PROFILES: readonly LanguageProfile[] = [
  // ── JS/TS family ──────────────────────────────────────────────────────
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".cts", ".mts"],
    commentLang: "js",
    commentForms: CSTYLE_FORMS,
    exportSymbols: jsExportSymbols,
    isUnitShaped: jsxUnitShaped,
    styleAttrs: [CLASS_ATTR_JSX],
  },
  {
    id: "javascript",
    extensions: [".js", ".jsx", ".cjs", ".mjs"],
    commentLang: "js",
    commentForms: CSTYLE_FORMS,
    exportSymbols: jsExportSymbols,
    isUnitShaped: jsxUnitShaped,
    styleAttrs: [CLASS_ATTR_JSX],
  },
  // ── Single-file-component frameworks ──────────────────────────────────
  {
    id: "vue",
    extensions: [".vue"],
    commentLang: "js",
    commentForms: ["html", "block", "line"],
    exportSymbols: sfcExportSymbols,
    isUnitShaped: () => true,
    styleAttrs: [CLASS_ATTR_HTML, CLASS_BIND_VUE],
  },
  {
    id: "svelte",
    extensions: [".svelte"],
    commentLang: "js",
    commentForms: ["html", "block", "line"],
    exportSymbols: sfcExportSymbols,
    isUnitShaped: () => true,
    styleAttrs: [CLASS_ATTR_HTML, CLASS_BIND_VUE],
  },
  {
    id: "astro",
    extensions: [".astro"],
    commentLang: "js",
    commentForms: ["html", "block", "line"],
    exportSymbols: sfcExportSymbols,
    isUnitShaped: () => true,
    styleAttrs: [CLASS_ATTR_HTML, CLASS_ATTR_JSX],
  },
  {
    id: "razor",
    extensions: [".razor", ".cshtml"],
    commentLang: "cs",
    commentForms: ["html", "block", "line"],
    exportSymbols: sfcExportSymbols,
    isUnitShaped: () => true,
    styleAttrs: [CLASS_ATTR_HTML],
  },
  // ── Native UI ─────────────────────────────────────────────────────────
  {
    id: "swift",
    extensions: [".swift"],
    commentLang: "swift",
    commentForms: CSTYLE_FORMS,
    exportSymbols: swiftExportSymbols,
    isUnitShaped: (source) => SWIFTUI_VIEW_RE.test(source),
    styleAttrs: [],
  },
  {
    id: "dart",
    extensions: [".dart"],
    commentLang: "dart",
    commentForms: CSTYLE_FORMS,
    exportSymbols: dartExportSymbols,
    isUnitShaped: (source) => FLUTTER_WIDGET_RE.test(source),
    styleAttrs: [],
  },
  {
    id: "kotlin",
    extensions: [".kt", ".kts"],
    commentLang: "kt",
    commentForms: CSTYLE_FORMS,
    exportSymbols: kotlinExportSymbols,
    isUnitShaped: (source) => COMPOSE_RE.test(source),
    styleAttrs: [],
  },
  // ── Backend / general ─────────────────────────────────────────────────
  {
    id: "python",
    extensions: [".py", ".pyi"],
    commentLang: "py",
    commentForms: ["hash", "docstring"],
    exportSymbols: pyExportSymbols,
    isUnitShaped: () => false,
    styleAttrs: [],
  },
  {
    id: "go",
    extensions: [".go"],
    commentLang: "go",
    commentForms: CSTYLE_FORMS,
    exportSymbols: goExportSymbols,
    isUnitShaped: () => false,
    styleAttrs: [],
  },
  {
    id: "rust",
    extensions: [".rs"],
    commentLang: "rs",
    commentForms: CSTYLE_FORMS,
    exportSymbols: rustExportSymbols,
    isUnitShaped: () => false,
    styleAttrs: [],
  },
  {
    id: "java",
    extensions: [".java"],
    commentLang: "java",
    commentForms: CSTYLE_FORMS,
    exportSymbols: javaExportSymbols,
    isUnitShaped: () => false,
    styleAttrs: [],
  },
  {
    id: "csharp",
    extensions: [".cs"],
    commentLang: "cs",
    commentForms: CSTYLE_FORMS,
    exportSymbols: csharpExportSymbols,
    isUnitShaped: () => false,
    styleAttrs: [],
  },
  {
    id: "ruby",
    extensions: [".rb"],
    commentLang: "rb",
    commentForms: ["hash", "block"],
    exportSymbols: rubyExportSymbols,
    isUnitShaped: () => false,
    styleAttrs: [],
  },
  {
    id: "php",
    extensions: [".php"],
    commentLang: "php",
    commentForms: ["block", "line", "hash"],
    exportSymbols: phpExportSymbols,
    isUnitShaped: () => false,
    styleAttrs: [CLASS_ATTR_HTML],
  },
  {
    id: "elixir",
    extensions: [".ex", ".exs"],
    commentLang: "unknown",
    commentForms: ["hash"],
    exportSymbols: noExports,
    isUnitShaped: () => false,
    styleAttrs: [],
  },
  {
    id: "scala",
    extensions: [".scala", ".sc"],
    commentLang: "scala",
    commentForms: CSTYLE_FORMS,
    exportSymbols: noExports,
    isUnitShaped: () => false,
    styleAttrs: [],
  },
  {
    id: "c",
    extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp"],
    commentLang: "c",
    commentForms: CSTYLE_FORMS,
    exportSymbols: noExports,
    isUnitShaped: () => false,
    styleAttrs: [],
  },
  {
    id: "shell",
    extensions: [".sh", ".bash", ".zsh"],
    commentLang: "sh",
    commentForms: ["hash"],
    exportSymbols: noExports,
    isUnitShaped: () => false,
    styleAttrs: [],
  },
  {
    id: "lua",
    extensions: [".lua"],
    commentLang: "lua",
    commentForms: ["dash"],
    exportSymbols: noExports,
    isUnitShaped: () => false,
    styleAttrs: [],
  },
  {
    id: "sql",
    extensions: [".sql"],
    commentLang: "unknown",
    commentForms: ["dash", "block"],
    exportSymbols: noExports,
    isUnitShaped: () => false,
    styleAttrs: [],
  },
] as const;

/**
 * Type-declaring keywords per language id — what introduces a named type that
 * could collide with a unit name. Drives the audit's name-collision scan so
 * it isn't TS-only (`interface`/`type`). Languages with no nominal types map
 * to `[]` (the scan is skipped for them).
 */
const TYPE_DECL_KEYWORDS: Record<string, readonly string[]> = {
  typescript: ["interface", "type", "class", "enum"],
  javascript: ["class"],
  vue: ["interface", "type", "class", "enum"],
  svelte: ["interface", "type", "class", "enum"],
  astro: ["interface", "type", "class", "enum"],
  razor: ["class", "interface", "record", "struct", "enum"],
  swift: ["struct", "class", "protocol", "enum", "actor", "typealias"],
  dart: ["class", "mixin", "enum", "typedef"],
  kotlin: ["class", "interface", "object", "typealias"],
  python: ["class"],
  go: ["type"],
  rust: ["struct", "enum", "trait", "type"],
  java: ["class", "interface", "enum", "record"],
  csharp: ["class", "interface", "record", "struct", "enum"],
  ruby: ["class", "module"],
  php: ["class", "interface", "trait"],
  scala: ["class", "trait", "object"],
  c: ["struct", "enum", "union", "typedef"],
  elixir: ["defmodule", "defprotocol", "defstruct"],
};

/* -------------------------------------------------------------------------- */
/* Lookup index + public accessors                                            */
/* -------------------------------------------------------------------------- */

const BY_EXT = new Map<string, LanguageProfile>();
for (const p of LANGUAGE_PROFILES) {
  for (const ext of p.extensions) BY_EXT.set(ext, p);
}

const BY_ID = new Map<string, LanguageProfile>();
for (const p of LANGUAGE_PROFILES) BY_ID.set(p.id, p);

/** Profile for a bare extension (`.tsx`), case-insensitive. Null when unknown. */
export function profileForExtension(ext: string): LanguageProfile | null {
  return BY_EXT.get(ext.toLowerCase()) ?? null;
}

/** Profile for a file path. Null when the extension isn't in the table. */
export function profileForFile(path: string): LanguageProfile | null {
  return profileForExtension(extname(path));
}

/** Profile by canonical language id (`"vue"`). Null when unknown. */
export function profileForId(id: string): LanguageProfile | null {
  return BY_ID.get(id) ?? null;
}

/**
 * Type-declaration keywords for a file's language (`struct`/`class`/`type`/…),
 * or `[]` when the language has no nominal types or the extension is unknown.
 * Single source for the audit's name-collision scan.
 */
export function typeDeclKeywordsForFile(path: string): readonly string[] {
  const p = profileForFile(path);
  return p ? (TYPE_DECL_KEYWORDS[p.id] ?? []) : [];
}

/**
 * Extensions where reusable UI units live, across web + native frameworks.
 * Used as the component-store default when a config omits `extensions`, so an
 * absent signal scans every UI file type rather than silently assuming React
 * `.tsx`/`.jsx`. (Excludes `.ts`/`.js` — those hold logic, not components.)
 */
export const UI_EXTENSIONS: readonly string[] = [
  ".tsx",
  ".jsx",
  ".vue",
  ".svelte",
  ".astro",
  ".razor",
  ".cshtml",
  ".swift",
  ".dart",
  ".kt",
  ".kts",
];

/**
 * Whether `s` names a known language — a profile id. The open sensor-language
 * registry: the stub-pattern catalog validates yaml `languages:` tags against
 * this (plus its own `"all"`), so a typo is still rejected but any table
 * language is accepted.
 */
export function isSensorLang(s: unknown): boolean {
  return typeof s === "string" && BY_ID.has(s);
}

/** Every extension the table knows about. */
export function knownExtensions(): string[] {
  return [...BY_EXT.keys()];
}

/**
 * The source-comment `CommentLang` bucket for a file, or `"unknown"` when the
 * extension isn't in the table. Single source for the source-comment walker.
 */
export function commentLangForFile(path: string): CommentLang {
  return profileForFile(path)?.commentLang ?? "unknown";
}

/**
 * The sensor language tag for a file — the profile `id`, or `undefined` when
 * the extension isn't in the table. Single source for the Layer-A
 * stub-pattern catalog (a tag with no patterns simply matches nothing).
 */
export function sensorLangForFile(path: string): SensorLang | undefined {
  return profileForFile(path)?.id;
}

/* -------------------------------------------------------------------------- */
/* Export extraction — profile-routed, language-agnostic                      */
/* -------------------------------------------------------------------------- */

/**
 * Every top-level exported / public name in a source file, using the
 * language profile for `basename`'s extension. Order-preserving, de-duplicated.
 * Unknown extension → empty (caller treats as "no detectable exports").
 */
export function extractExportNames(source: string, basename: string): string[] {
  const profile = profileForFile(basename);
  if (profile === null) return [];
  return profile.exportSymbols(source, basename);
}

/**
 * Best-effort single exported name — the likely `@cairn` value, used as the
 * annotator's hint and for display. Prefers a PascalCase declaration (the
 * unit convention) over hooks / SCREAMING_CASE constants. Null when nothing
 * is exported.
 */
export function extractExportName(source: string, basename: string): string | null {
  const names = extractExportNames(source, basename);
  if (names.length === 0) return null;
  return names.find(isPascalCase) ?? names[0]!;
}

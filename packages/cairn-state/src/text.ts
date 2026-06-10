/**
 * Get the 1-based line number for a given character index in a text string.
 */
export function lineOf(text: string, charIndex: number): number {
  let line = 1;
  for (let i = 0; i < charIndex && i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line += 1;
    }
  }
  return line;
}

/* -------------------------------------------------------------------------- */
/* Shared regex + string primitives                                           */
/*                                                                            */
/* These collapse identifiers that were re-derived inline across the          */
/* component store, audit, sensors, and assertion engine. One definition,     */
/* imported everywhere — never re-spell a regex literal in a call site.       */
/* -------------------------------------------------------------------------- */

/**
 * Escape a string for literal use inside a `RegExp`. The single canonical
 * implementation — `components.ts`, the assertion engine, and the audit all
 * route through this instead of re-spelling the character class.
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split a comma-separated tag value (`@aliases`, `@uses`, …) into trimmed,
 * non-empty parts. Replaces the `.split(",").map(trim).filter(Boolean)`
 * triple that was repeated at every tag-list read site.
 */
export function splitCsv(value: string | undefined | null): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * PascalCase signal: a leading uppercase letter followed by a lowercase one.
 * Deliberately excludes SCREAMING_CASE constants (`FEATURED_TABS`) and bare
 * single-letter / acronym idents. The component convention for a unit name.
 */
const PASCAL_CASE_RE = /^[A-Z][a-z]/;

/** True when `name` is PascalCase by the {@link PASCAL_CASE_RE} signal. */
export function isPascalCase(name: string): boolean {
  return PASCAL_CASE_RE.test(name);
}

/**
 * The `@cairn` registry-header signal: `@cairn` then whitespace then an
 * identifier start. Single source of truth — deliberately disjoint from the
 * colon-form `@cairn:decision` / `@cairn:rule` SoT markers (those can never
 * be whitespace-then-identifier), so a marker is never misread as a header.
 */
export const HEADER_SIGNAL_RE = /@cairn[ \t]+[A-Za-z_$]/;

/** Strip a file's extension, returning the basename stem (`Button.vue` → `Button`). */
export function stemOf(basename: string): string {
  const slash = Math.max(basename.lastIndexOf("/"), basename.lastIndexOf("\\"));
  const base = slash === -1 ? basename : basename.slice(slash + 1);
  const dot = base.indexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}

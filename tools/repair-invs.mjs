#!/usr/bin/env node
// One-off: normalize INV titles in a target repo's .cairn/ground/invariants/.
//
// Strips `// AI: …` style prefixes leaked from source-comment captures and
// re-derives divider-only titles from the body. Edits the `title:` field
// in-place; never touches the id (filename + frontmatter id stay intact so
// every existing reference survives).
//
// Usage:
//   node tools/repair-invs.mjs <repo-root> [--dry-run]
//
// Exit code 0 on success. Prints a one-line summary + a sample table.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// yaml is a workspace dep of cairn-state/cairn-core but not the root.
// Resolve via the cairn-state node_modules so this one-off script doesn't
// require a top-level install.
const HERE = dirname(fileURLToPath(import.meta.url));
const YAML_URL = pathToFileURL(
  join(HERE, "..", "packages", "cairn-state", "node_modules", "yaml", "dist", "index.js"),
).href;
const { parse: parseYaml, stringify: stringifyYaml } = await import(YAML_URL);

const args = process.argv.slice(2);
const repoRoot = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");

if (!repoRoot) {
  console.error("usage: node tools/repair-invs.mjs <repo-root> [--dry-run]");
  process.exit(2);
}

const invDir = join(repoRoot, ".cairn", "ground", "invariants");

/**
 * Strip semantic-noise prefixes from source-derived titles. Mirrors
 * normalizeSotTitle in packages/cairn-core/src/init/sot-emit.ts.
 */
function normalizeTitle(raw) {
  let s = String(raw ?? "").trim();
  for (let i = 0; i < 6; i++) {
    const before = s;
    s = s
      .replace(/^(?:@?AI\s*[:\-—]\s*)/i, "")
      .replace(/^(?:NOTE|TODO|XXX|FIXME|HACK|WARN|WARNING|IMPORTANT)\s*[:\-—]\s*/i, "")
      .replace(/^(?:§?\s*(?:INV|DEC|ADR|RULE|CONSTRAINT))\s*[:\-—]\s*/i, "")
      .replace(/^(?:INV|DEC|ADR)-[0-9a-zA-Z]{3,}\s*[:\-—]\s*/i, "")
      .replace(/^[-*]\s+/, "")
      .trim();
    if (s === before) break;
  }
  return s.length === 0 ? String(raw ?? "").trim() : s;
}

/**
 * True when the title is composed entirely of divider chars (─ ━ – — = * ~ _ -)
 * plus whitespace. These are source-file section separators that leaked into
 * INV titles and carry no semantic content.
 */
function isDividerOnly(title) {
  const s = String(title ?? "").trim();
  if (s.length === 0) return true;
  return /^[─━–—=*~_\-\s]+$/.test(s);
}

/**
 * Walk body lines, strip comment markers, return the first prose-bearing line.
 * Mirrors firstLineFallback() in sot-emit.ts.
 */
function firstLineFallback(body) {
  const PURE_MARKER_LINE = /^("""|'''|=begin\b.*|=end\b.*|--\[\[|--\]\]|\{-|-\}|\(\*|\*\))$/;
  for (const raw of String(body ?? "").split("\n")) {
    const cleaned = raw
      .replace(/^\s+/, "")
      .replace(/\*+\/\s*$/, "")
      .replace(/^\/\*+\s*/, "")
      .replace(/^\/\/+\s*/, "")
      .replace(/^\*+\s*/, "")
      .replace(/^("""|''')\s*/, "")
      .replace(/\s*("""|''')\s*$/, "")
      .replace(/^#+\s*/, "")
      .replace(/^[─━–—=*~_-]{2,}\s*/, "")
      .replace(/\s*[─━–—=*~_-]{2,}\s*$/, "")
      .trim();
    if (cleaned.length === 0) continue;
    if (PURE_MARKER_LINE.test(cleaned)) continue;
    if (cleaned.startsWith("@")) continue;
    if (/^[─━–—=*~_-]+$/.test(cleaned)) continue;
    return normalizeTitle(cleaned).slice(0, 120);
  }
  return "";
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

function splitFrontmatter(text) {
  const m = text.match(FM_RE);
  if (!m) return null;
  return { fmText: m[1], body: m[2] };
}

let files;
try {
  files = readdirSync(invDir).filter((f) => f.startsWith("INV-") && f.endsWith(".md"));
} catch (err) {
  console.error(`failed to read ${invDir}: ${err?.message ?? err}`);
  process.exit(1);
}

const changes = [];
let scanned = 0;
let skipped = 0;
let alreadyClean = 0;
let unparseable = 0;

for (const f of files.sort()) {
  scanned += 1;
  const path = join(invDir, f);
  const text = readFileSync(path, "utf8");
  const split = splitFrontmatter(text);
  if (!split) {
    unparseable += 1;
    continue;
  }
  let fm;
  try {
    fm = parseYaml(split.fmText);
  } catch {
    unparseable += 1;
    continue;
  }
  if (!fm || typeof fm !== "object" || typeof fm.title !== "string") {
    skipped += 1;
    continue;
  }
  const originalTitle = fm.title;
  let newTitle = normalizeTitle(originalTitle);
  if (isDividerOnly(newTitle)) {
    const derived = firstLineFallback(split.body);
    if (derived.length > 0) newTitle = derived;
  }
  if (newTitle === originalTitle) {
    alreadyClean += 1;
    continue;
  }
  changes.push({ file: f, old: originalTitle, new: newTitle });
  if (!dryRun) {
    fm.title = newTitle;
    const rendered = `---\n${stringifyYaml(fm).trimEnd()}\n---\n${split.body}`;
    writeFileSync(path, rendered, "utf8");
  }
}

console.log(`\n=== ${dryRun ? "DRY RUN " : ""}repair-invs ===`);
console.log(`scanned ${scanned} INVs in ${invDir}`);
console.log(`already-clean: ${alreadyClean}`);
console.log(`changed: ${changes.length}${dryRun ? " (not written)" : ""}`);
if (skipped > 0) console.log(`skipped (no string title): ${skipped}`);
if (unparseable > 0) console.log(`unparseable: ${unparseable}`);
console.log("");

if (changes.length > 0) {
  const sample = changes.slice(0, 25);
  for (const c of sample) {
    const oldShort = c.old.replace(/\s+/g, " ").slice(0, 80);
    const newShort = c.new.replace(/\s+/g, " ").slice(0, 80);
    console.log(`  ${c.file}`);
    console.log(`    - ${oldShort}`);
    console.log(`    + ${newShort}`);
  }
  if (changes.length > sample.length) {
    console.log(`  …[+${changes.length - sample.length} more]`);
  }
}

// Rebuild the invariants ledger so the SessionStart payload + every
// `cairn_in_scope` lookup picks up the cleaned titles. Skip on dry-run.
if (!dryRun && changes.length > 0) {
  const LEDGER_URL = pathToFileURL(
    join(HERE, "..", "packages", "cairn-state", "dist", "ledgers.js"),
  ).href;
  try {
    const { writeInvariantsLedger } = await import(LEDGER_URL);
    const { entries, path } = writeInvariantsLedger({ repoRoot });
    console.log(`\nrebuilt invariants ledger: ${entries.length} entries → ${path}`);
  } catch (err) {
    console.error(`\nwarning: ledger rebuild failed: ${err?.message ?? err}`);
    console.error(`run \`pnpm --filter @isaacriehm/cairn-state build\` then re-run repair-invs to rebuild ledger.`);
  }
}

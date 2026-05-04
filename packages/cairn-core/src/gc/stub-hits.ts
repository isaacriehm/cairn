/**
 * GC pass 3 — stub-catalog hits (full-tree scan).
 *
 * Layer A in `harness/src/sensors/stub-catalog.ts` only flags genuinely-NEW
 * stubs (added lines per diff). That keeps per-task feedback tight and avoids
 * paying for pre-existing debt over and over.
 *
 * GC closes the loop on accumulated debt: walks the canonical zone and runs
 * the same regex catalog against every file's CURRENT content. Hits become
 * findings the operator can triage. Phase 12 v1 surfaces only — opening a
 * targeted refactor commit (per spec) requires generating a diff that actually
 * fixes the stub, which needs an agent. That belongs in Phase 14+.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadStubCatalog } from "../sensors/catalog.js";
import { detectLanguage } from "../sensors/stub-catalog.js";
import type { SensorLanguage, StubCatalog } from "../sensors/types.js";
import type { GcFinding } from "./types.js";
import { walkSourceTree } from "./walk-source.js";

const PASS_ID = "stub-catalog-hits" as const;

export interface StubCatalogHitsOptions {
  repoRoot: string;
  /** Languages active for this profile. Filters which patterns run. */
  languages?: readonly SensorLanguage[];
  /** Pre-loaded catalog (smoke convenience). Otherwise loaded from project. */
  catalog?: StubCatalog;
  /**
   * Cap on file size to scan (bytes). Files larger than this are skipped to
   * keep the pass cheap on big artifacts. Default 256 KB.
   */
  maxFileBytes?: number;
}

export interface StubCatalogHitsResult {
  findings: GcFinding[];
}

export function runStubCatalogHits(
  opts: StubCatalogHitsOptions,
): StubCatalogHitsResult {
  const findings: GcFinding[] = [];
  const catalog = opts.catalog ?? loadStubCatalog(opts.repoRoot);
  const allowedLangs = opts.languages;
  const maxBytes = opts.maxFileBytes ?? 256 * 1024;

  const files = walkSourceTree(opts.repoRoot);

  for (const rel of files) {
    const lang = detectLanguage(rel);
    if (lang === undefined) continue;
    if (allowedLangs !== undefined && !allowedLangs.includes(lang)) continue;
    const abs = resolve(opts.repoRoot, rel);
    let content: string;
    try {
      const buf = readFileSync(abs);
      if (buf.length > maxBytes) continue;
      content = buf.toString("utf8");
    } catch {
      continue;
    }
    if (content.length === 0) continue;

    for (const pattern of catalog.patterns) {
      if (!pattern.languages.includes(lang)) continue;
      const re = new RegExp(pattern.regex, "gm");
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const lineIdx = lineOf(content, m.index);
        const matched = m[0];
        findings.push({
          pass: PASS_ID,
          kind: "stub_hit",
          path: rel,
          detail: `${rel}:${lineIdx} matches stub pattern \`${pattern.id}\` — ${pattern.description}`,
          severity: pattern.severity === "hard" ? "block" : "warn",
          pattern_id: pattern.id,
          line: lineIdx,
          matched_text: matched.length > 200 ? matched.slice(0, 200) + "…" : matched,
        });
        if (re.lastIndex === m.index) re.lastIndex += 1;
      }
    }
  }

  return { findings };
}

function lineOf(text: string, charIndex: number): number {
  let line = 1;
  for (let i = 0; i < charIndex && i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) line += 1;
  }
  return line;
}

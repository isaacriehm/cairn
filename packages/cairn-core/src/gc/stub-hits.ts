import { resolve } from "node:path";
import { loadStubCatalog } from "../sensors/catalog.js";
import { detectLanguage } from "../sensors/stub-catalog.js";
import type { SensorLanguage, StubCatalog } from "../sensors/types.js";
import type { GcFinding } from "./types.js";
import { lineOf } from "@isaacriehm/cairn-state";
import { walkSourceTree } from "./walk-source.js";

const PASS_ID = "stub-catalog-hits" as const;

export interface StubCatalogHitsOptions {
  repoRoot: string;
  catalog?: StubCatalog;
}

/**
 * GC pass 1 — surfaces every file containing a pattern from the
 * mechanical stub-pattern catalog.
 */
export async function runStubCatalogHits(
  opts: StubCatalogHitsOptions,
): Promise<{ findings: GcFinding[] }> {
  const catalog = opts.catalog ?? (await loadStubCatalog(opts.repoRoot));
  const files = walkSourceTree(opts.repoRoot);

  const findings: GcFinding[] = [];
  for (const rel of files) {
    const lang = detectLanguage(rel);
    if (lang === undefined) continue;

    const patterns = catalog.patterns.filter(
      (p) => (p.languages as string[]).includes(lang) || (p.languages as string[]).includes("all"),
    );
    if (patterns.length === 0) continue;

    let content: string;
    try {
      content = (await import("node:fs")).readFileSync(resolve(opts.repoRoot, rel), "utf8");
    } catch {
      continue;
    }

    for (const pattern of patterns) {
      const re = new RegExp(pattern.regex, "gm");
      let m;
      while ((m = re.exec(content)) !== null) {
        const lineIdx = lineOf(content, m.index);
        const matched = m[0] ?? "";
        findings.push({
          pass: PASS_ID,
          kind: "stub_hit",
          path: rel,
          detail: `stub detected: ${pattern.description}`,
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

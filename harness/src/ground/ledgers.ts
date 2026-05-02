import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { logger } from "../logger.js";
import { parseFrontmatter } from "./frontmatter.js";
import {
  decisionsDir,
  decisionsLedgerPath,
  invariantsDir,
  invariantsLedgerPath,
} from "./paths.js";
import {
  DecisionFrontmatter,
  type DecisionLedgerEntry,
  InvariantFrontmatter,
  type InvariantLedgerEntry,
} from "./schemas.js";

const log = logger("ground.ledgers");

export interface LedgerOptions {
  repoRoot: string;
}

export function buildDecisionsLedger(opts: LedgerOptions): DecisionLedgerEntry[] {
  const dir = decisionsDir(opts.repoRoot);
  if (!existsSync(dir)) return [];
  const entries: DecisionLedgerEntry[] = [];
  for (const file of listMarkdown(dir)) {
    const abs = join(dir, file);
    const fm = parseFrontmatter(readFileSync(abs, "utf8")).frontmatter;
    const parsed = DecisionFrontmatter.safeParse(fm);
    if (!parsed.success) {
      log.warn({ path: abs, error: parsed.error.message }, "decision frontmatter invalid; skipping");
      continue;
    }
    if (parsed.data.status !== "accepted") continue;
    if (parsed.data.superseded_by) continue;
    entries.push({
      id: parsed.data.id,
      title: parsed.data.title,
      status: parsed.data.status,
      ...(parsed.data.scope_globs !== undefined ? { scope_globs: parsed.data.scope_globs } : {}),
      ...(parsed.data.supersedes !== undefined ? { supersedes: parsed.data.supersedes } : {}),
      ...(parsed.data.superseded_by !== undefined
        ? { superseded_by: parsed.data.superseded_by }
        : {}),
    });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}

export function writeDecisionsLedger(opts: LedgerOptions): {
  entries: DecisionLedgerEntry[];
  path: string;
} {
  const entries = buildDecisionsLedger(opts);
  const path = decisionsLedgerPath(opts.repoRoot);
  mkdirSync(decisionsDir(opts.repoRoot), { recursive: true });
  writeFileSync(path, stringifyYaml(entries), "utf8");
  log.debug({ path, count: entries.length }, "wrote decisions ledger");
  return { entries, path };
}

export function buildInvariantsLedger(opts: LedgerOptions): InvariantLedgerEntry[] {
  const dir = invariantsDir(opts.repoRoot);
  if (!existsSync(dir)) return [];
  const entries: InvariantLedgerEntry[] = [];
  for (const file of listMarkdown(dir)) {
    const abs = join(dir, file);
    const fm = parseFrontmatter(readFileSync(abs, "utf8")).frontmatter;
    const parsed = InvariantFrontmatter.safeParse(fm);
    if (!parsed.success) {
      log.warn({ path: abs, error: parsed.error.message }, "invariant frontmatter invalid; skipping");
      continue;
    }
    const status = parsed.data.status ?? "active";
    if (status !== "active") continue;
    entries.push({
      id: parsed.data.id,
      title: parsed.data.title,
      status,
      ...(parsed.data.source_decision !== undefined
        ? { source_decision: parsed.data.source_decision }
        : {}),
      ...(parsed.data.superseded_by !== undefined
        ? { superseded_by: parsed.data.superseded_by }
        : {}),
    });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}

export function writeInvariantsLedger(opts: LedgerOptions): {
  entries: InvariantLedgerEntry[];
  path: string;
} {
  const entries = buildInvariantsLedger(opts);
  const path = invariantsLedgerPath(opts.repoRoot);
  mkdirSync(invariantsDir(opts.repoRoot), { recursive: true });
  writeFileSync(path, stringifyYaml(entries), "utf8");
  log.debug({ path, count: entries.length }, "wrote invariants ledger");
  return { entries, path };
}

function listMarkdown(dir: string): string[] {
  let dirents: Dirent[];
  try {
    dirents = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
  return dirents
    .filter((d) => d.isFile() && d.name.endsWith(".md") && !d.name.startsWith("_"))
    .map((d) => d.name)
    .sort();
}

// Re-exports for tests / callers that want raw entries.
export { parseYaml };
export { resolve };

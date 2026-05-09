/**
 * GC pass 10 — doc-claims-vs-runtime drift sensor.
 *
 * Scans operator-authored prose (README.md, CLAUDE.md, docs/*.md) for
 * extractable claims about the workspace shape — package count, smoke-gate
 * count, MCP tool count, hook event count — and flags any value that
 * disagrees with the runtime. Surfaces as `warn` findings; the
 * cairn-attention skill turns each into an inline A/B/C
 * (`doc wrong → regenerate`, `code wrong → file task`, `defer`).
 *
 * Closes the dogfood loop where adoption Phase 8 silently ingests stale
 * docs as ground truth.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { GcFinding } from "./types.js";

const PASS_ID = "doc-claims-vs-runtime" as const;

const ROOT_DOCS = ["README.md", "CLAUDE.md"] as const;
const DOCS_DIR = "docs";

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

export type DocClaimKind =
  | "packageCount"
  | "smokeCount"
  | "mcpToolCount"
  | "hookEventCount";

export interface RuntimeTruth {
  packageCount: number;
  smokeCount: number;
  mcpToolCount: number;
  hookEventCount: number;
}

export interface DocClaimsOptions {
  repoRoot: string;
  /** Test injection: pretend the runtime is this. */
  runtimeOverride?: Partial<RuntimeTruth>;
}

export interface DocClaimsResult {
  findings: GcFinding[];
  runtime: RuntimeTruth;
}

interface ClaimPattern {
  kind: DocClaimKind;
  regex: RegExp;
  numericGroup: number;
  wordy?: boolean;
}

const CLAIM_PATTERNS: ClaimPattern[] = [
  // "5 packages" — plural only; rejects "§3 Package contents" headings.
  { kind: "packageCount", regex: /\b(\d+)\s+packages\b/g, numericGroup: 1 },
  // "5-package boundary", "5-packages" — hyphenated form admits singular.
  { kind: "packageCount", regex: /\b(\d+)-packages?\b/gi, numericGroup: 1 },
  // "five packages" — wordy plural.
  {
    kind: "packageCount",
    regex: /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+packages\b/gi,
    numericGroup: 1,
    wordy: true,
  },
  // "five-package boundary" — wordy hyphenated.
  {
    kind: "packageCount",
    regex: /\b(one|two|three|four|five|six|seven|eight|nine|ten)-packages?\b/gi,
    numericGroup: 1,
    wordy: true,
  },
  // "29-smoke gate", "27 smoke gate"
  { kind: "smokeCount", regex: /\b(\d+)[-\s]smoke gate\b/gi, numericGroup: 1 },
  // "5 hooks (SessionStart, ...)" — paren disambiguates from "Stop hook"
  { kind: "hookEventCount", regex: /\b(\d+)\s+hooks?\s*\(/gi, numericGroup: 1 },
  // "28 typed tools", "25 MCP tools"
  {
    kind: "mcpToolCount",
    regex: /\b(\d+)\s+(?:typed tools|MCP tools)\b/gi,
    numericGroup: 1,
  },
];

export function runDocClaimsVsRuntime(opts: DocClaimsOptions): DocClaimsResult {
  const detected = readRuntimeTruth(opts.repoRoot);
  const runtime: RuntimeTruth = { ...detected, ...(opts.runtimeOverride ?? {}) };
  const findings: GcFinding[] = [];
  for (const rel of collectDocFiles(opts.repoRoot)) {
    const abs = resolve(opts.repoRoot, rel);
    let body: string;
    try {
      body = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    findings.push(...scanFile(rel, body, runtime));
  }
  return { findings, runtime };
}

function collectDocFiles(repoRoot: string): string[] {
  const out: string[] = [];
  for (const rel of ROOT_DOCS) {
    if (existsSync(resolve(repoRoot, rel))) out.push(rel);
  }
  const docsAbs = resolve(repoRoot, DOCS_DIR);
  if (existsSync(docsAbs)) {
    let entries: string[];
    try {
      entries = readdirSync(docsAbs);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.endsWith(".md")) out.push(`${DOCS_DIR}/${entry}`);
    }
  }
  return out;
}

function scanFile(
  rel: string,
  body: string,
  truth: RuntimeTruth,
): GcFinding[] {
  const findings: GcFinding[] = [];
  for (const pattern of CLAIM_PATTERNS) {
    const re = new RegExp(pattern.regex.source, pattern.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const raw = m[pattern.numericGroup];
      if (raw === undefined) continue;
      const claimed = pattern.wordy
        ? NUMBER_WORDS[raw.toLowerCase()] ?? Number.NaN
        : Number.parseInt(raw, 10);
      if (!Number.isFinite(claimed)) continue;
      const expected = truth[pattern.kind];
      if (claimed === expected) continue;
      const line = lineOf(body, m.index);
      findings.push({
        pass: PASS_ID,
        kind: "doc_claim_drift",
        path: rel,
        detail: `${rel}:${line} — \`${m[0]}\` claims ${pattern.kind}=${claimed}, runtime=${expected}`,
        severity: "warn",
        line,
        matched_text: m[0],
      });
    }
  }
  return findings;
}

function lineOf(source: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function readRuntimeTruth(repoRoot: string): RuntimeTruth {
  return {
    packageCount: countPackages(repoRoot),
    smokeCount: countSmokeGate(repoRoot),
    mcpToolCount: countMcpTools(repoRoot),
    hookEventCount: countHookEvents(repoRoot),
  };
}

function countPackages(repoRoot: string): number {
  const dir = resolve(repoRoot, "packages");
  if (!existsSync(dir)) return 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const entry of entries) {
    if (existsSync(resolve(dir, entry, "package.json"))) n++;
  }
  return n;
}

function countSmokeGate(repoRoot: string): number {
  const pkg = resolve(repoRoot, "packages", "cairn", "package.json");
  if (!existsSync(pkg)) return 0;
  try {
    const json = JSON.parse(readFileSync(pkg, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const chain = json.scripts?.["smokes"];
    if (typeof chain !== "string") return 0;
    return (chain.match(/pnpm\s+smoke:[a-z-]+/g) ?? []).length;
  } catch {
    return 0;
  }
}

function countMcpTools(repoRoot: string): number {
  const file = resolve(
    repoRoot,
    "packages",
    "cairn-core",
    "src",
    "mcp",
    "tools",
    "index.ts",
  );
  if (!existsSync(file)) return 0;
  try {
    const src = readFileSync(file, "utf8");
    const decl = src.indexOf("allTools");
    if (decl === -1) return 0;
    const open = src.indexOf("[", decl);
    const close = src.indexOf("];", open);
    if (open === -1 || close === -1) return 0;
    const block = src.slice(open + 1, close);
    const stripped = block.replace(/\/\/[^\n]*/g, "");
    return (stripped.match(/[A-Za-z][A-Za-z0-9_]*Tool\b/g) ?? []).length;
  } catch {
    return 0;
  }
}

function countHookEvents(repoRoot: string): number {
  const file = resolve(
    repoRoot,
    "packages",
    "cairn-frontend-claudecode",
    "hooks",
    "hooks.json",
  );
  if (!existsSync(file)) return 0;
  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as {
      hooks?: Record<string, unknown>;
    };
    return Object.keys(json.hooks ?? {}).length;
  } catch {
    return 0;
  }
}

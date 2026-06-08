/**
 * Parallel module mapper — dispatches one Sonnet call per ModuleSlice in
 * parallel via Promise.allSettled, with a per-module progress display.
 *
 * Dispatch strategy:
 *   - One Sonnet call per slice, ~8k token input each.
 *   - Failed call → ModuleProposal with confidence: 0 and empty arrays.
 *     Never throws; allSettled handles errors.
 *   - >8 modules: batch into rounds of 4 to avoid rate limits. Still parallel
 *     within each round.
 *   - Progress: per-module line, updated in-place as each Promise resolves.
 *
 * Output is a list of ModuleProposal objects. The merge module (Haiku call)
 * synthesizes them into the final MapperOutput.
 */

import { runClaude } from "../claude/index.js";
import { logger } from "../logger.js";
import { coerceDecisionIds, coerceInvariantIds } from "@isaacriehm/cairn-state";
import type {
  DecisionLedgerEntry,
  InvariantLedgerEntry,
} from "@isaacriehm/cairn-state";
import type { MapperScopeIndex } from "./mapper.js";
import type { ModuleSlice } from "./module-slicer.js";

const log = logger("init.mapper-parallel");

const PARALLEL_ROUND_SIZE = 4;
const PARALLEL_THRESHOLD = 8;
// 10min ceiling. Sonnet with `--json-schema` and a fat scope_index.files
// output (one entry per file in the module) on a 35k-char prompt can
// genuinely run 4-6min. Below this ceiling we were timing out on
// legitimate large modules. Successful proposals are cached
// (`cacheable: true` below), so a re-run after a failure only retries
// the slow module — no quota burn on the modules that already finished.
const PER_MODULE_TIMEOUT_MS = 600_000;

export interface ModuleProposal {
  moduleName: string;
  moduleSlug: string;
  modulePath: string;
  /** "." for whole-repo single-package case. Else module-relative path. */
  moduleRel: string;
  domain: string;
  confidence: number;
  routeHandlerGlobs: string[];
  dtoGlobs: string[];
  generatorSourceGlobs: string[];
  highStakesGlobs: string[];
  offLimitsGlobs: string[];
  scopeIndex: MapperScopeIndex;
  notes: string;
  /** Set when the module call failed; downstream merge skips it. */
  failed: boolean;
  durationMs: number;
}

const MODULE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    domain: { type: "string" },
    confidence: { type: "number" },
    route_handler_globs: { type: "array", items: { type: "string" } },
    dto_globs: { type: "array", items: { type: "string" } },
    generator_source_globs: { type: "array", items: { type: "string" } },
    high_stakes_globs: { type: "array", items: { type: "string" } },
    off_limits_globs: { type: "array", items: { type: "string" } },
    scope_index: {
      type: "object",
      additionalProperties: false,
      properties: {
        files: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            properties: {
              decisions: { type: "array", items: { type: "string" } },
              invariants: { type: "array", items: { type: "string" } },
              unscoped: { type: "boolean" },
            },
            required: ["decisions", "invariants"],
          },
        },
      },
      required: ["files"],
    },
    notes: { type: "string" },
  },
  required: [
    "domain",
    "confidence",
    "route_handler_globs",
    "dto_globs",
    "generator_source_globs",
    "high_stakes_globs",
    "off_limits_globs",
    "notes",
  ],
} as const;

const MODULE_SYSTEM_PROMPT = [
  "You are the per-module INIT MAPPER for a code-agent cairn adopting a project.",
  "",
  "You see ONE module of a (possibly larger) repo. Your job: read this slice and produce a structured per-module proposal so the cairn can run useful sensors against this module's diffs.",
  "",
  "You DO NOT execute code. You DO NOT modify files. You produce one JSON object.",
  "",
  "Inputs you receive:",
  "  - module path (relative to repo root) + module slug",
  "  - directory tree (paths only, no file content)",
  "  - the module's package.json (full)",
  "  - up to 5 representative files (full content) — controllers, services, schemas, routers, entry points",
  "  - module-level docs (README / AGENTS.md / docs/*.md)",
  "  - existing in-scope decisions/invariants from the project ledger (if any)",
  "",
  "Required outputs (all paths must be REPO-ROOT-RELATIVE — prepend the module path):",
  "  - `domain` — one short sentence describing what this module does.",
  "  - `confidence` — 0.0–1.0 estimate of how reliable your output is. < 0.4 = low confidence, > 0.7 = high.",
  "  - `route_handler_globs` — globs matching HTTP / CLI / RPC handlers in this module. Examples: `core/src/**/*.controller.ts`, `apps/api/routes/**/*.py`. EMPTY if no handlers.",
  "  - `dto_globs` — globs matching DTO / schema / form-input / request-validator definitions in this module.",
  "  - `generator_source_globs` — globs whose changes mean a generator must re-run. Examples: `core/openapi.json`, `core/src/db/schema.ts` (Drizzle), `**/*.proto`, `prisma/schema.prisma`.",
  "  - `high_stakes_globs` — globs for high-risk surfaces in this module (auth, billing, payments, multi-tenant, integrations storing tokens, telephony). Be conservative.",
  "  - `off_limits_globs` — globs the cairn MUST NOT touch beyond defaults. Vendored code, large fixtures, copied snapshots.",
  '  - `scope_index` — `{ files: { "<repo-relative-path>": { decisions: [], invariants: [], unscoped?: true } } }`. The user prompt provides the in-scope decisions + invariants list. Map only files within THIS module. Use `unscoped: true` for lockfiles, generated, vendored, or dotfile config.',
  '  - IMPORTANT: scope_index decisions[] and invariants[] arrays MUST contain ONLY IDs (e.g. "DEC-a3f7b2c", "INV-5e9d10a" — content-addressed 7+ hex chars). NEVER copy ledger titles or descriptive prose into these arrays — IDs only.',
  "  - `notes` — anything notable that didn't fit a structured field.",
  "",
  "Rules:",
  "  - Globs MUST be repo-root-relative, no leading slash, forward slashes only.",
  "  - Do not invent paths absent from the inventory.",
  "  - Prefer EMPTY arrays over guessed entries.",
  "  - Return ONLY the JSON object. No prose, no preamble.",
].join("\n");

export interface MapModulesParallelArgs {
  slices: ModuleSlice[];
  decisions: DecisionLedgerEntry[];
  invariants: InvariantLedgerEntry[];
  /** Optional progress callback fired as each slice resolves/rejects. */
  onModuleStart?: (slice: ModuleSlice) => void;
  onModuleEnd?: (slice: ModuleSlice, proposal: ModuleProposal) => void;
}

export async function mapModulesParallel(
  args: MapModulesParallelArgs,
): Promise<ModuleProposal[]> {
  const slices = args.slices;
  if (slices.length === 0) return [];
  const rounds = chunkRounds(slices, PARALLEL_THRESHOLD, PARALLEL_ROUND_SIZE);
  log.info(
    {
      total_slices: slices.length,
      rounds: rounds.length,
      round_sizes: rounds.map((r) => r.length),
    },
    "parallel mapper dispatch",
  );
  const out: ModuleProposal[] = [];
  for (const round of rounds) {
    const settled = await Promise.allSettled(
      round.map((slice) => mapOneSlice(slice, args)),
    );
    for (let i = 0; i < settled.length; i++) {
      const slice = round[i];
      if (slice === undefined) continue;
      const result = settled[i];
      if (result === undefined) continue;
      if (result.status === "fulfilled") {
        out.push(result.value);
      } else {
        // Fail-soft proposal so the merge step still has an entry to acknowledge.
        const reason = String(result.reason ?? "unknown");
        log.warn({ slice: slice.moduleSlug, reason }, "module call failed");
        out.push(buildFailedProposal(slice, reason));
        if (args.onModuleEnd !== undefined) {
          args.onModuleEnd(slice, buildFailedProposal(slice, reason));
        }
      }
    }
  }
  return out;
}

function chunkRounds<T>(items: T[], threshold: number, size: number): T[][] {
  if (items.length <= threshold) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function mapOneSlice(
  slice: ModuleSlice,
  args: MapModulesParallelArgs,
): Promise<ModuleProposal> {
  if (args.onModuleStart !== undefined) args.onModuleStart(slice);
  const startedAt = Date.now();
  let proposal: ModuleProposal;
  try {
    const userPrompt = buildModuleUserPrompt({
      slice,
      decisions: args.decisions,
      invariants: args.invariants,
    });
    const result = await runClaude({
      tier: "sonnet",
      prompt: userPrompt,
      system: MODULE_SYSTEM_PROMPT,
      jsonSchema: MODULE_OUTPUT_SCHEMA as object,
      timeoutMs: PER_MODULE_TIMEOUT_MS,
      // Isolate ambient context — without this every per-module Sonnet
      // call ingests the operator's user-level CLAUDE.md, the project
      // CLAUDE.md hierarchy, all plugin slash commands, and every MCP
      // tool definition. On a 50-slice repo that's the ambient context
      // multiplied 50x against the operator's coding-plan quota for
      // zero benefit — the mapper only needs the caller-supplied
      // module slice + ledger excerpt.
      isolateAmbientContext: true,
      cacheable: true,
    });
    proposal = parseModuleProposal(
      slice,
      result.parsed,
      Date.now() - startedAt,
    );
  } catch (err) {
    proposal = buildFailedProposal(slice, String(err));
    proposal.durationMs = Date.now() - startedAt;
  }
  if (args.onModuleEnd !== undefined) args.onModuleEnd(slice, proposal);
  return proposal;
}

function buildModuleUserPrompt(args: {
  slice: ModuleSlice;
  decisions: DecisionLedgerEntry[];
  invariants: InvariantLedgerEntry[];
}): string {
  const slice = args.slice;
  const parts: string[] = [];
  parts.push(`# Module slice: ${slice.moduleSlug}`);
  parts.push("");
  parts.push(`Module path (repo-relative): ${slice.moduleRel}`);
  parts.push("");
  if (args.decisions.length > 0 || args.invariants.length > 0) {
    parts.push("## In-scope decisions + invariants (project ledger)");
    if (args.decisions.length > 0) {
      parts.push("Decisions:");
      for (const d of args.decisions) {
        parts.push(`  - ${d.id} — ${d.title} (status: ${d.status})`);
      }
    }
    if (args.invariants.length > 0) {
      parts.push("Invariants:");
      for (const v of args.invariants) {
        parts.push(`  - ${v.id} — ${v.title} (status: ${v.status})`);
      }
    }
    parts.push("");
  }
  parts.push(`## Directory tree (relative to module root)`);
  parts.push("```");
  parts.push(slice.directoryTree);
  parts.push("```");
  parts.push("");
  if (slice.packageJson !== null) {
    parts.push(`## package.json`);
    parts.push("```json");
    parts.push(slice.packageJson);
    parts.push("```");
    parts.push("");
  }
  if (slice.representativeFiles.length > 0) {
    parts.push(`## Representative files (full content)`);
    for (const f of slice.representativeFiles) {
      parts.push(`### ${f.path}`);
      parts.push("```");
      parts.push(f.content);
      parts.push("```");
      parts.push("");
    }
  }
  if (slice.localDocs !== null) {
    parts.push(`## Module docs`);
    parts.push("```markdown");
    parts.push(slice.localDocs);
    parts.push("```");
    parts.push("");
  }
  parts.push(
    `Now produce the JSON object per the schema. Remember: globs are repo-root-relative (prepend "${slice.moduleRel === "." ? "" : slice.moduleRel + "/"}" to module-relative paths). No preamble.`,
  );
  return parts.join("\n");
}

function parseModuleProposal(
  slice: ModuleSlice,
  parsed: unknown,
  durationMs: number,
): ModuleProposal {
  if (typeof parsed !== "object" || parsed === null) {
    return {
      ...buildFailedProposal(slice, "non-object parsed output"),
      durationMs,
    };
  }
  const v = parsed as Record<string, unknown>;
  const arr = (k: string): string[] => {
    const x = v[k];
    return Array.isArray(x)
      ? x.filter((s): s is string => typeof s === "string")
      : [];
  };
  const scopeRaw = v["scope_index"];
  const scopeIndex: MapperScopeIndex = { files: {} };
  if (
    typeof scopeRaw === "object" &&
    scopeRaw !== null &&
    typeof (scopeRaw as Record<string, unknown>)["files"] === "object" &&
    (scopeRaw as Record<string, unknown>)["files"] !== null
  ) {
    const filesRaw = (scopeRaw as Record<string, unknown>)["files"] as Record<
      string,
      unknown
    >;
    for (const [path, entry] of Object.entries(filesRaw)) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      // ID-coerce — mapper LLMs occasionally smuggle ledger title prose
      // past the `items: { type: "string" }` JSON-mode gate. Drop anything
      // not matching the canonical DEC-<hash> / INV-<hash> format.
      const decs = Array.isArray(e["decisions"])
        ? coerceDecisionIds(e["decisions"])
        : [];
      const invs = Array.isArray(e["invariants"])
        ? coerceInvariantIds(e["invariants"])
        : [];
      const out: {
        decisions: string[];
        invariants: string[];
        unscoped?: true;
      } = {
        decisions: decs,
        invariants: invs,
      };
      if (e["unscoped"] === true) out.unscoped = true;
      scopeIndex.files[path] = out;
    }
  }
  const conf = typeof v["confidence"] === "number" ? v["confidence"] : 0;
  return {
    moduleName: slice.moduleSlug,
    moduleSlug: slice.moduleSlug,
    modulePath: slice.modulePath,
    moduleRel: slice.moduleRel,
    domain: typeof v["domain"] === "string" ? v["domain"] : "",
    confidence: conf,
    routeHandlerGlobs: arr("route_handler_globs"),
    dtoGlobs: arr("dto_globs"),
    generatorSourceGlobs: arr("generator_source_globs"),
    highStakesGlobs: arr("high_stakes_globs"),
    offLimitsGlobs: arr("off_limits_globs"),
    scopeIndex,
    notes: typeof v["notes"] === "string" ? v["notes"] : "",
    failed: false,
    durationMs,
  };
}

/**
 * Heuristic keywords for the partial-fallback high-stakes scan. Files / dirs
 * matching any of these on a path segment get globbed when the LLM call
 * fails — so even a timed-out module surfaces obvious risk surfaces in the
 * final proposal.
 */
const FALLBACK_HIGH_STAKES_PATTERNS: RegExp[] = [
  /^auth(entication)?$/i,
  /^billing$/i,
  /^payment(s)?$/i,
  /^security$/i,
];

/**
 * Build a ModuleProposal for a slice whose Sonnet call timed out or threw.
 *
 * Fallback policy: don't drop the module entirely.
 * Mark it `failed: true` (so completion summary can name it), give it a
 * confidence: 0.1, derive high-stakes globs heuristically from path
 * segments, and stamp the slice's full directory tree into the scope index
 * as `unscoped: true` so PostToolUse hooks downstream don't re-flag the
 * files for missing scope. Operator can re-run `cairn scope rebuild` to
 * upgrade the partial entry into a full proposal later.
 */
function buildFailedProposal(
  slice: ModuleSlice,
  reason: string,
): ModuleProposal {
  const treePaths = slice.directoryTree
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("…"));

  const moduleRel = slice.moduleRel;
  const repoRel = (rel: string): string =>
    moduleRel === "." ? rel : `${moduleRel}/${rel}`;

  // High-stakes globs: any path segment that matches a fallback keyword
  // contributes a glob covering its parent directory.
  const highStakesGlobs = new Set<string>();
  for (const path of treePaths) {
    const segs = path.split("/");
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg === undefined) continue;
      if (!FALLBACK_HIGH_STAKES_PATTERNS.some((re) => re.test(seg))) continue;
      // Glob the matched directory if the keyword names a directory in the
      // path (i.e., not the leaf filename). Keyword on a leaf file → glob
      // its parent directory.
      const isLeaf = i === segs.length - 1;
      const dirPath = isLeaf
        ? segs.slice(0, i).join("/")
        : segs.slice(0, i + 1).join("/");
      const repoDir = dirPath === "" ? moduleRel : repoRel(dirPath);
      if (repoDir === "" || repoDir === ".") {
        highStakesGlobs.add(`${seg}/**`);
      } else {
        highStakesGlobs.add(`${repoDir}/**`);
      }
      break; // one glob per path is enough
    }
  }

  // Scope index: every file in the slice → unscoped: true so the GC's
  // scope-coverage pass doesn't re-flag them while the partial proposal
  // stands.
  const scopeIndex: {
    files: Record<string, MapperScopeIndex["files"][string]>;
  } = {
    files: {},
  };
  for (const path of treePaths) {
    if (path.length === 0) continue;
    const repoPath = repoRel(path);
    scopeIndex.files[repoPath] = {
      decisions: [],
      invariants: [],
      unscoped: true,
    };
  }

  return {
    moduleName: slice.moduleSlug,
    moduleSlug: slice.moduleSlug,
    modulePath: slice.modulePath,
    moduleRel,
    domain: `${slice.moduleSlug} module (analysis timed out — run cairn scope rebuild)`,
    confidence: 0.1,
    routeHandlerGlobs: [],
    dtoGlobs: [],
    generatorSourceGlobs: [],
    highStakesGlobs: [...highStakesGlobs],
    offLimitsGlobs: [],
    scopeIndex,
    notes: `module mapper call failed: ${reason}; partial fallback used`,
    failed: true,
    durationMs: 0,
  };
}

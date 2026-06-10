/**
 * Headerless component re-confirm — the deferred reclassify tier (§3.8.1).
 *
 * The freshness gate (`freshness.ts`) runs on every edit and, when a registered
 * component's identity changes, latches `needs_reconfirm` — deterministically,
 * NO LLM. This module is the *other half*: the narrow, quota-gated pass that
 * actually decides whether the stored classification still holds and clears the
 * flag. It runs ONLY in a quota-expected context (an explicit
 * `cairn_component_reconfirm`, a `components audit` refresh, or the operator
 * acting on the surfaced "N components changed" offer) — never on the hot edit
 * path.
 *
 * Tier split (§3.8.2): *initial* classification ("what IS this component —
 * category, purpose") is a rich judgment → Sonnet (the adoption annotator). A
 * *re-confirm* on a changed body ("does the EXISTING category still fit?") is a
 * narrow yes/no → **Haiku**. That keeps the recurring, higher-frequency path the
 * cheapest one.
 *
 * Cost controls, mirroring sot-align:
 *   - **Hard per-run cap** on Haiku calls; entries past it stay flagged
 *     (deferred), logged via the returned counts — never silently dropped.
 *   - **Verdict cached on the body fingerprint** — re-running over a still-flagged
 *     component whose body hasn't changed is a free cache hit, so repeated sweeps
 *     don't re-burn quota on a stuck-stale entry.
 *
 * A "fits" verdict clears the flag. A "stale"/"ambiguous" verdict leaves it
 * flagged; the operator resolves it by re-registering (`cairn_component_register`
 * overwrites the entry — and, building it fresh, drops the flag). Every path is
 * `isGhost`-gated.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bodyContentHash,
  cairnDir,
  isGhost,
  readComponentRegistry,
  registerComponentEntry,
  writeFileSafe,
  type ComponentRegistryEntry,
} from "@isaacriehm/cairn-state";
import { runClaude } from "../claude/index.js";
import { logger } from "../logger.js";

const log = logger("components.reconfirm");

const DEFAULT_CAP = 10;
const BODY_CAP = 2_000;
const PER_HAIKU_TIMEOUT_MS = 30_000;

export type ReconfirmVerdict = "fits" | "stale" | "ambiguous";

export interface ReconfirmArgs {
  repoRoot: string;
  /** Hard cap on fresh Haiku calls per run. Rest stay flagged (deferred). */
  cap?: number;
  /** Reconfirm a single file (operator acting on one offer). Omit = sweep all. */
  onlyFile?: string;
  /** Mock judge for smokes — default is the real Haiku judge. */
  mockJudge?: (args: {
    name: string;
    category: string;
    purpose: string;
    body: string;
  }) => Promise<ReconfirmVerdict>;
}

export interface ReconfirmResult {
  /** Flagged entries in scope this run. */
  considered: number;
  /** Verdict "fits" → flag cleared. */
  cleared: number;
  /** Verdict "stale"/"ambiguous" (or unreadable source) → left flagged. */
  stillStale: number;
  /** Past the Haiku cap → untouched, still flagged. */
  deferred: number;
  /** Fresh Haiku calls made. */
  haikuCalls: number;
  /** Verdicts served from the fingerprint cache (free). */
  cacheHits: number;
}

/**
 * Re-confirm flagged components. No-op (zeros) outside ghost. NEVER called from
 * the hot edit path — this is the quota-expected reclassify pass.
 */
export async function runComponentReconfirm(args: ReconfirmArgs): Promise<ReconfirmResult> {
  const { repoRoot } = args;
  const result: ReconfirmResult = {
    considered: 0,
    cleared: 0,
    stillStale: 0,
    deferred: 0,
    haikuCalls: 0,
    cacheHits: 0,
  };
  if (!isGhost(repoRoot)) return result;

  const reg = readComponentRegistry(repoRoot);
  let flagged = reg.entries.filter((e) => e.needs_reconfirm === true);
  if (args.onlyFile !== undefined) flagged = flagged.filter((e) => e.file === args.onlyFile);
  result.considered = flagged.length;
  if (flagged.length === 0) return result;

  const cap = args.cap ?? DEFAULT_CAP;

  for (const entry of flagged) {
    const abs = join(repoRoot, entry.file);
    if (!existsSync(abs)) {
      // A vanished file is GC/orphan territory — leave the flag, count stale.
      result.stillStale += 1;
      continue;
    }
    let source: string;
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      result.stillStale += 1;
      continue;
    }

    const fingerprint = bodyContentHash(source);
    let verdict = readVerdictCache(repoRoot, entry, fingerprint);
    if (verdict !== null) {
      result.cacheHits += 1;
    } else {
      // Cap fires only on a fresh call — a cache hit at cap is still free.
      if (result.haikuCalls >= cap) {
        result.deferred += 1;
        continue;
      }
      result.haikuCalls += 1;
      verdict = await judge({
        name: entry.name,
        category: entry.category,
        purpose: entry.purpose,
        body: source,
        mock: args.mockJudge,
      });
      writeVerdictCache(repoRoot, entry, fingerprint, verdict);
    }

    if (verdict === "fits") {
      clearFlag(repoRoot, entry);
      result.cleared += 1;
    } else {
      result.stillStale += 1;
    }
  }

  return result;
}

/** Upsert the entry with `needs_reconfirm` dropped. */
function clearFlag(repoRoot: string, entry: ComponentRegistryEntry): void {
  const { needs_reconfirm: _drop, ...rest } = entry;
  registerComponentEntry(repoRoot, rest as ComponentRegistryEntry);
}

/* -------------------------------------------------------------------------- */
/* Haiku judge                                                                */
/* -------------------------------------------------------------------------- */

const RECONFIRM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["fits", "stale", "ambiguous"] },
  },
} as const;

const RECONFIRM_SYSTEM = `You re-confirm whether a UI component's stored classification still fits its current code.

Reply ONLY JSON: { "verdict": "fits" | "stale" | "ambiguous" }.
  - "fits"      the stored category AND purpose still accurately describe the component.
  - "stale"     the category no longer fits, or the purpose now misdescribes it.
  - "ambiguous" cannot tell from the code.

The component body changed since it was classified. Your job is only to decide
whether the EXISTING category/purpose still hold — not to invent a new one.
Default to "fits" unless the code clearly diverged from the stored classification.`;

async function judge(args: {
  name: string;
  category: string;
  purpose: string;
  body: string;
  mock?: ReconfirmArgs["mockJudge"];
}): Promise<ReconfirmVerdict> {
  if (args.mock !== undefined) {
    return args.mock({
      name: args.name,
      category: args.category,
      purpose: args.purpose,
      body: args.body,
    });
  }
  const body =
    args.body.length > BODY_CAP ? `${args.body.slice(0, BODY_CAP)}\n…[truncated]` : args.body;
  const prompt = [
    `Component: ${args.name}`,
    `Stored category: ${args.category}`,
    `Stored purpose: ${args.purpose}`,
    "",
    "---current source---",
    body,
    "",
    "Does the stored category + purpose still fit?",
  ].join("\n");
  try {
    const res = await runClaude({
      tier: "haiku",
      system: RECONFIRM_SYSTEM,
      prompt,
      jsonSchema: RECONFIRM_SCHEMA,
      timeoutMs: PER_HAIKU_TIMEOUT_MS,
      isolateAmbientContext: true,
    });
    const v = (res.parsed as { verdict?: unknown } | undefined)?.verdict;
    if (v === "fits" || v === "stale" || v === "ambiguous") return v;
    return "fits"; // conservative — a parse miss must not nag the operator
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), name: args.name },
      "reconfirm judge failed; defaulting to fits",
    );
    return "fits";
  }
}

/* -------------------------------------------------------------------------- */
/* Verdict cache — keyed on (entry identity, body fingerprint)                */
/* -------------------------------------------------------------------------- */

function verdictCachePath(
  repoRoot: string,
  entry: ComponentRegistryEntry,
  fingerprint: string,
): string {
  const keyHash = bodyContentHash(`${entry.workspace} ${entry.file} ${entry.export}`).slice(0, 12);
  return cairnDir(
    repoRoot,
    "cache",
    "haiku",
    "component-reconfirm",
    `${fingerprint.slice(0, 12)}-${keyHash}.json`,
  );
}

function readVerdictCache(
  repoRoot: string,
  entry: ComponentRegistryEntry,
  fingerprint: string,
): ReconfirmVerdict | null {
  const p = verdictCachePath(repoRoot, entry, fingerprint);
  if (!existsSync(p)) return null;
  try {
    const v = (JSON.parse(readFileSync(p, "utf8")) as { verdict?: unknown }).verdict;
    if (v === "fits" || v === "stale" || v === "ambiguous") return v;
    return null;
  } catch {
    return null;
  }
}

function writeVerdictCache(
  repoRoot: string,
  entry: ComponentRegistryEntry,
  fingerprint: string,
  verdict: ReconfirmVerdict,
): void {
  try {
    writeFileSafe(
      verdictCachePath(repoRoot, entry, fingerprint),
      JSON.stringify({ verdict, ts: new Date().toISOString() }, null, 2),
    );
  } catch {
    /* best-effort */
  }
}

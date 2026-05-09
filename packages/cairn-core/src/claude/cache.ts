/**
 * Claude response cache.
 *
 * Adoption re-runs are common — operators bail out, restart, or
 * `cairn init --force` on the same repo before drift catches up. Each
 * re-run otherwise burns the operator's coding-plan quota on
 * identical Haiku classification calls.
 *
 * This module provides a simple on-disk response cache keyed by
 * `{tier, system, prompt, jsonSchema}`. Entries expire after 30 days.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { logger } from "../logger.js";
import { haikuCacheDir } from "@isaacriehm/cairn-state";
import type { RunClaudeOptions, RunClaudeResult } from "./runner.js";

const log = logger("claude.cache");

/** 30-day cache window. */
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CachedEntrySchema = z.object({
  v: z.literal(1),
  createdAt: z.number(),
  ttlMs: z.number(),
  key: z.string(),
  result: z.object({
    text: z.string(),
    parsed: z.unknown().optional(),
    durationMs: z.number(),
    tier: z.enum(["haiku", "sonnet", "opus"]),
    model: z.string(),
    envelope: z.record(z.string(), z.unknown()).optional(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    }).optional(),
  }),
});

type CachedEntry = z.infer<typeof CachedEntrySchema>;

/** Compute the cache key for a given runClaude invocation. */
function computeCacheKey(opts: RunClaudeOptions): string {
  const parts = [
    opts.tier,
    opts.system ?? "",
    opts.prompt,
    opts.jsonSchema ? JSON.stringify(opts.jsonSchema) : "",
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function cachePath(repoRoot: string, tier: string, key: string): string {
  const dir = haikuCacheDir(repoRoot);
  return join(dir, tier, `${key}.json`);
}

/**
 * Check if a Claude call has a valid on-disk response. Returns null on
 * miss or corruption.
 */
export function cacheLookup(
  repoRoot: string,
  opts: RunClaudeOptions,
): RunClaudeResult | null {
  const key = computeCacheKey(opts);
  const path = cachePath(repoRoot, opts.tier, key);
  if (!existsSync(path)) return null;
  
  try {
    const raw = readFileSync(path, "utf8");
    const parsedRaw: unknown = JSON.parse(raw);
    const result = CachedEntrySchema.safeParse(parsedRaw);
    if (!result.success) return null;
    
    const parsed = result.data;
    const ageMs = Date.now() - parsed.createdAt;
    if (ageMs > parsed.ttlMs) {
      // Best-effort eviction
      try {
        unlinkSync(path);
      } catch {
        /* best-effort */
      }
      return null;
    }
    log.info({ key, ageMs, tier: opts.tier }, "cache hit");
    
    // Convert zod tier back to RunClaudeResult tier
    const tier = parsed.result.tier as RunClaudeResult["tier"];
    
    const u = parsed.result.usage;
    return {
      text: parsed.result.text,
      ...(parsed.result.parsed !== undefined ? { parsed: parsed.result.parsed } : {}),
      durationMs: parsed.result.durationMs,
      tier,
      model: parsed.result.model,
      ...(parsed.result.envelope !== undefined ? { envelope: parsed.result.envelope as Record<string, unknown> } : {}),
      ...(u !== undefined ? {
        usage: {
          input_tokens: u.input_tokens,
          output_tokens: u.output_tokens,
          ...(u.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: u.cache_read_input_tokens } : {}),
          ...(u.cache_creation_input_tokens !== undefined ? { cache_creation_input_tokens: u.cache_creation_input_tokens } : {}),
        }
      } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Persist the result of a Claude call so the next identical input hits
 * the cache instead of re-issuing.
 */
export function cacheStore(
  repoRoot: string,
  opts: RunClaudeOptions,
  result: RunClaudeResult,
): void {
  const key = computeCacheKey(opts);
  const path = cachePath(repoRoot, opts.tier, key);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const entry: CachedEntry = {
      v: 1,
      createdAt: Date.now(),
      ttlMs: DEFAULT_TTL_MS,
      key,
      result: {
        text: result.text,
        ...(result.parsed !== undefined ? { parsed: result.parsed } : {}),
        durationMs: result.durationMs,
        tier: result.tier,
        model: result.model,
        ...(result.envelope !== undefined ? { envelope: result.envelope } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
      },
    };
    writeFileSync(path, JSON.stringify(entry), "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { err: message },
      "cache write failed",
    );
  }
}

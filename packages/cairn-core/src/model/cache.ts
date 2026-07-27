import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { cairnDir } from "@isaacriehm/cairn-state";
import { z } from "zod";
import { logger } from "../logger.js";
import type {
  ModelProvider,
  RunModelOptions,
  RunModelResult,
} from "./types.js";

const log = logger("model.cache");
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CachedEntrySchema = z.object({
  v: z.literal(2),
  createdAt: z.number(),
  ttlMs: z.number(),
  key: z.string(),
  result: z.object({
    text: z.string(),
    parsed: z.unknown().optional(),
    durationMs: z.number(),
    provider: z.enum(["claude", "codex", "cursor"]),
    tier: z.enum(["fast", "capable"]),
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

function computeCacheKey(
  provider: ModelProvider,
  options: RunModelOptions,
): string {
  const parts = [
    provider,
    options.tier,
    options.system ?? "",
    options.prompt,
    options.jsonSchema === undefined ? "" : JSON.stringify(options.jsonSchema),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function cachePath(
  repoRoot: string,
  provider: ModelProvider,
  options: RunModelOptions,
): string {
  const key = computeCacheKey(provider, options);
  return join(
    cairnDir(repoRoot, "cache", "model"),
    provider,
    options.tier,
    `${key}.json`,
  );
}

export function cacheLookup(
  repoRoot: string,
  provider: ModelProvider,
  options: RunModelOptions,
): RunModelResult | null {
  const path = cachePath(repoRoot, provider, options);
  if (!existsSync(path)) return null;
  try {
    const parsed = CachedEntrySchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
    if (!parsed.success) return null;
    const ageMs = Date.now() - parsed.data.createdAt;
    if (ageMs > parsed.data.ttlMs) {
      try {
        unlinkSync(path);
      } catch {
        // Best-effort eviction.
      }
      return null;
    }
    log.info(
      { provider, tier: options.tier, ageMs },
      "model response cache hit",
    );
    const result = parsed.data.result;
    const usage =
      result.usage === undefined
        ? undefined
        : {
            input_tokens: result.usage.input_tokens,
            output_tokens: result.usage.output_tokens,
            ...(result.usage.cache_read_input_tokens === undefined
              ? {}
              : {
                  cache_read_input_tokens:
                    result.usage.cache_read_input_tokens,
                }),
            ...(result.usage.cache_creation_input_tokens === undefined
              ? {}
              : {
                  cache_creation_input_tokens:
                    result.usage.cache_creation_input_tokens,
                }),
          };
    return {
      text: result.text,
      ...(result.parsed === undefined ? {} : { parsed: result.parsed }),
      durationMs: result.durationMs,
      provider: result.provider,
      tier: result.tier,
      model: result.model,
      ...(result.envelope === undefined
        ? {}
        : { envelope: result.envelope as Record<string, unknown> }),
      ...(usage === undefined ? {} : { usage }),
      cached: true,
    };
  } catch {
    return null;
  }
}

export function cacheStore(
  repoRoot: string,
  provider: ModelProvider,
  options: RunModelOptions,
  result: RunModelResult,
): void {
  const path = cachePath(repoRoot, provider, options);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        v: 2,
        createdAt: Date.now(),
        ttlMs: DEFAULT_TTL_MS,
        key: computeCacheKey(provider, options),
        result: {
          text: result.text,
          ...(result.parsed === undefined ? {} : { parsed: result.parsed }),
          durationMs: result.durationMs,
          provider: result.provider,
          tier: result.tier,
          model: result.model,
          ...(result.envelope === undefined ? {} : { envelope: result.envelope }),
          ...(result.usage === undefined ? {} : { usage: result.usage }),
        },
      }),
      { encoding: "utf8", mode: 0o600 },
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "model response cache write failed",
    );
  }
}

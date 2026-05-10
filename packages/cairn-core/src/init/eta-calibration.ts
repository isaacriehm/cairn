/**
 * ETA calibration cache for the init pipeline's long Haiku phases.
 *
 * Lives at `~/.cairn/cache/eta-calibration.json`, shared across every
 * project the operator adopts on this machine. Each entry is a rolling
 * `secondsPerUnit` average for one of the long phases — pre-flight
 * uses these to convert unit counts (paragraphs, comment blocks, etc.)
 * into a wall-clock estimate before the operator commits, then each
 * completed phase writes its measured rate back via EWMA so the cache
 * compounds accuracy across runs and as the underlying model speeds
 * up.
 *
 * Defaults shipped here are calibrated against Haiku at the time of
 * writing; first-run estimates use them, subsequent runs use the
 * operator's own measurements.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../logger.js";

const log = logger("init.eta-calibration");

export type EtaPhase =
  | "7-topic-index"
  | "8-docs-ingest"
  | "9-source-comments"
  | "10-rules-merge";

export interface PhaseCalibration {
  /** Wall-clock seconds per unit, averaged across recent runs. */
  secondsPerUnit: number;
  /** Total samples folded into the EWMA so far. */
  samples: number;
}

export interface CalibrationCache {
  version: 1;
  phases: Record<EtaPhase, PhaseCalibration>;
}

/**
 * Shipped defaults. Each `secondsPerUnit` is the time it takes to
 * process one "primary unit" of the phase, with the phase's internal
 * concurrency already baked in (so callers multiply units × rate
 * without re-applying the parallelism factor).
 *
 * Units per phase:
 *   - 7-topic-index    → Jaccard-filtered pair-judge calls
 *   - 8-docs-ingest    → markdown paragraphs scanned
 *   - 9-source-comments → essay-class comment blocks classified
 *   - 10-rules-merge   → H2/H3 sections across rule files
 */
const DEFAULT_SECONDS_PER_UNIT: Record<EtaPhase, number> = {
  "7-topic-index": 0.6,
  "8-docs-ingest": 0.1,
  "9-source-comments": 0.75,
  "10-rules-merge": 0.6,
};

/** Minimum-sample EWMA — heavier weight on recent samples until the cache warms. */
const ALPHA_WARMUP = 0.3;
const ALPHA_STEADY = 0.1;
const WARMUP_SAMPLES = 5;

function calibrationDir(): string {
  return join(homedir(), ".cairn", "cache");
}

function calibrationPath(): string {
  return join(calibrationDir(), "eta-calibration.json");
}

export function defaultCache(): CalibrationCache {
  return {
    version: 1,
    phases: {
      "7-topic-index": {
        secondsPerUnit: DEFAULT_SECONDS_PER_UNIT["7-topic-index"],
        samples: 0,
      },
      "8-docs-ingest": {
        secondsPerUnit: DEFAULT_SECONDS_PER_UNIT["8-docs-ingest"],
        samples: 0,
      },
      "9-source-comments": {
        secondsPerUnit: DEFAULT_SECONDS_PER_UNIT["9-source-comments"],
        samples: 0,
      },
      "10-rules-merge": {
        secondsPerUnit: DEFAULT_SECONDS_PER_UNIT["10-rules-merge"],
        samples: 0,
      },
    },
  };
}

export function readCalibration(): CalibrationCache {
  const path = calibrationPath();
  if (!existsSync(path)) return defaultCache();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Record<string, unknown>)["version"] !== 1
    ) {
      return defaultCache();
    }
    const fresh = defaultCache();
    const phases = (parsed as { phases?: Record<string, unknown> }).phases ?? {};
    for (const id of Object.keys(fresh.phases) as EtaPhase[]) {
      const raw = phases[id];
      if (
        typeof raw === "object" &&
        raw !== null &&
        typeof (raw as PhaseCalibration).secondsPerUnit === "number" &&
        typeof (raw as PhaseCalibration).samples === "number" &&
        (raw as PhaseCalibration).secondsPerUnit > 0
      ) {
        fresh.phases[id] = {
          secondsPerUnit: (raw as PhaseCalibration).secondsPerUnit,
          samples: Math.max(0, Math.floor((raw as PhaseCalibration).samples)),
        };
      }
    }
    return fresh;
  } catch (err) {
    log.warn({ err: String(err) }, "calibration cache unreadable; using defaults");
    return defaultCache();
  }
}

function writeCalibration(cache: CalibrationCache): void {
  const path = calibrationPath();
  mkdirSync(calibrationDir(), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
  renameSync(tmp, path);
}

/**
 * Fold a measured `seconds / units` rate back into the calibration
 * cache for `phase`. Uses an EWMA with a warm-up alpha for the first
 * few samples so a fresh cache converges fast.
 */
export function recordSample(args: {
  phase: EtaPhase;
  units: number;
  durationMs: number;
}): void {
  if (args.units <= 0 || args.durationMs <= 0) return;
  const sample = args.durationMs / 1000 / args.units;
  // Guard against extreme outliers (cold cache, network blip). Cap the
  // sample at 10× the prior rate so a single bad run can't poison the
  // estimate.
  const cache = readCalibration();
  const prior = cache.phases[args.phase];
  const cappedSample = Math.min(sample, prior.secondsPerUnit * 10);
  const alpha = prior.samples < WARMUP_SAMPLES ? ALPHA_WARMUP : ALPHA_STEADY;
  const updated: PhaseCalibration = {
    secondsPerUnit:
      prior.samples === 0
        ? cappedSample
        : prior.secondsPerUnit * (1 - alpha) + cappedSample * alpha,
    samples: prior.samples + 1,
  };
  cache.phases[args.phase] = updated;
  try {
    writeCalibration(cache);
  } catch (err) {
    log.warn({ err: String(err) }, "calibration cache write failed");
  }
}

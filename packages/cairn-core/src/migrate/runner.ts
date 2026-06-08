/**
 * Migration runner — select, apply, stamp.
 *
 * Selection: migrations whose `introducedIn` is in `(pin, current]` and whose
 * `detect()` still reports the repo needs them. `safe` migrations auto-apply;
 * `review` migrations are queued for the operator unless `includeReview`.
 *
 * The `cairn_version` pin is an optimization, not the source of truth —
 * `detect()` carries correctness, so a wrong/absent pin never causes a
 * re-mutation. On success the pin advances to the highest fully-applied
 * version (and all the way to `current` when nothing is left pending), which
 * is what turns the frozen `cairn_version` pin into a live one.
 *
 * Concurrency: the apply phase holds `.migrate-lock`; a second session bails
 * cleanly (`ran: false`) rather than racing.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../index.js";
import { logger } from "../logger.js";
import { acquireOperationLock, OperationLockHeldError } from "../lock.js";
import { readConfigPin, writeConfigPin } from "./config-io.js";
import { MIGRATIONS } from "./registry.js";
import { semverCmp, semverGt, semverLte } from "./semver.js";
import type { Migration, MigrationClass } from "./types.js";

const log = logger("migrate.runner");

export type MigrationStatus =
  | "applied"
  | "noop"
  | "queued"
  | "failed"
  | "would-apply"
  | "would-queue";

export interface MigrationOutcome {
  id: string;
  class: MigrationClass;
  status: MigrationStatus;
  detail: string;
}

export interface RunMigrationsArgs {
  repoRoot: string;
  /** Report what would run; apply nothing, write nothing. */
  dryRun?: boolean;
  /** Auto-apply `review`-class too (operator-confirmed `cairn migrate --all`). */
  includeReview?: boolean;
}

export interface RunMigrationsResult {
  /** False only when another process held the migrate lock. */
  ran: boolean;
  /** Pin before the run (`0.0.0` when absent). */
  pin: string;
  /** Current CLI version. */
  current: string;
  /** Pin after the run, or null when unchanged / not written. */
  newPin: string | null;
  outcomes: MigrationOutcome[];
  /** `review`-class migration ids that still need the operator. */
  pendingReview: string[];
}

function needs(m: Migration, repoRoot: string): boolean {
  try {
    return m.detect(repoRoot);
  } catch (err) {
    log.warn(
      { migration: m.id, err: err instanceof Error ? err.message : String(err) },
      "migration detect() threw — skipping",
    );
    return false;
  }
}

/** Migrations introduced in `(pin, current]` that still report needed. */
function selectCandidates(repoRoot: string, pin: string, current: string): Migration[] {
  return MIGRATIONS.filter(
    (m) => semverGt(m.introducedIn, pin) && semverLte(m.introducedIn, current),
  )
    .filter((m) => needs(m, repoRoot))
    .slice()
    .sort(
      (a, b) =>
        semverCmp(a.introducedIn, b.introducedIn) || a.id.localeCompare(b.id),
    );
}

export async function runMigrations(
  args: RunMigrationsArgs,
): Promise<RunMigrationsResult> {
  const { repoRoot } = args;
  const current = VERSION;
  const dryRun = args.dryRun === true;
  const includeReview = args.includeReview === true;

  // Never act on an unadopted repo — guards against any caller (notably the
  // defensive MCP-boot run) creating `.cairn/` via the lock's mkdir.
  if (!existsSync(join(repoRoot, ".cairn", "config.yaml"))) {
    return { ran: true, pin: "0.0.0", current, newPin: null, outcomes: [], pendingReview: [] };
  }

  const pin = readConfigPin(repoRoot) ?? "0.0.0";

  const candidates = selectCandidates(repoRoot, pin, current);

  // Nothing pending: make the pin live if it's merely stale, else no-op.
  if (candidates.length === 0) {
    if (semverCmp(pin, current) >= 0) {
      return { ran: true, pin, current, newPin: null, outcomes: [], pendingReview: [] };
    }
    if (dryRun) {
      return { ran: true, pin, current, newPin: current, outcomes: [], pendingReview: [] };
    }
    try {
      const wrote = await acquireOperationLock(repoRoot, ".migrate-lock", () =>
        writeConfigPin(repoRoot, current),
      );
      return {
        ran: true,
        pin,
        current,
        newPin: wrote ? current : null,
        outcomes: [],
        pendingReview: [],
      };
    } catch (err) {
      if (err instanceof OperationLockHeldError) {
        return { ran: false, pin, current, newPin: null, outcomes: [], pendingReview: [] };
      }
      throw err;
    }
  }

  if (dryRun) {
    const outcomes: MigrationOutcome[] = candidates.map((m) => ({
      id: m.id,
      class: m.class,
      status:
        m.class === "review" && !includeReview ? "would-queue" : "would-apply",
      detail: m.describe,
    }));
    const pendingReview = candidates
      .filter((m) => m.class === "review" && !includeReview)
      .map((m) => m.id);
    return { ran: true, pin, current, newPin: null, outcomes, pendingReview };
  }

  try {
    return await acquireOperationLock(repoRoot, ".migrate-lock", () =>
      applyCandidates({ repoRoot, pin, current, candidates, includeReview }),
    );
  } catch (err) {
    if (err instanceof OperationLockHeldError) {
      return { ran: false, pin, current, newPin: null, outcomes: [], pendingReview: [] };
    }
    throw err;
  }
}

function applyCandidates(args: {
  repoRoot: string;
  pin: string;
  current: string;
  candidates: Migration[];
  includeReview: boolean;
}): RunMigrationsResult {
  const { repoRoot, pin, current, candidates, includeReview } = args;
  const outcomes: MigrationOutcome[] = [];
  const pendingReview: string[] = [];
  let firstUnresolved = -1;

  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    if (m === undefined) continue;
    // Re-check under the lock for idempotency under concurrency.
    if (!needs(m, repoRoot)) {
      outcomes.push({ id: m.id, class: m.class, status: "noop", detail: "already satisfied" });
      continue;
    }
    if (m.class === "review" && !includeReview) {
      outcomes.push({ id: m.id, class: m.class, status: "queued", detail: m.describe });
      pendingReview.push(m.id);
      if (firstUnresolved === -1) firstUnresolved = i;
      continue;
    }
    try {
      const r = m.apply(repoRoot);
      outcomes.push({
        id: m.id,
        class: m.class,
        status: r.changed ? "applied" : "noop",
        detail: r.detail,
      });
    } catch (err) {
      outcomes.push({
        id: m.id,
        class: m.class,
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      if (firstUnresolved === -1) firstUnresolved = i;
    }
  }

  // Advance the pin to the highest version with no unresolved predecessor.
  let target = pin;
  if (firstUnresolved === -1) {
    target = current;
  } else {
    for (let i = 0; i < firstUnresolved; i++) {
      const m = candidates[i];
      if (m !== undefined && semverGt(m.introducedIn, target)) target = m.introducedIn;
    }
  }

  let newPin: string | null = null;
  if (semverCmp(target, pin) > 0) {
    if (writeConfigPin(repoRoot, target)) newPin = target;
  }

  log.info(
    {
      pin,
      current,
      new_pin: newPin,
      applied: outcomes.filter((o) => o.status === "applied").length,
      queued: pendingReview.length,
      failed: outcomes.filter((o) => o.status === "failed").length,
    },
    "migrations run",
  );

  return { ran: true, pin, current, newPin, outcomes, pendingReview };
}

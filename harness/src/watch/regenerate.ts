import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../logger.js";
import {
  matchAnyGlob,
  writeDecisionsLedger,
  writeInvariantsLedger,
  writeManifest,
  writeQualityGrades,
} from "../ground/index.js";
import type { Profile } from "../profiles/index.js";
import { selectProfile } from "../profiles/index.js";

const log = logger("watch.regenerate");

export interface RegenerateOptions {
  repoRoot: string;
  /** Override profile selection (used by tests). */
  profile?: Profile;
  /** Optional list of changed file paths (relative to repoRoot). When given,
   *  profile extractors only fire if their watch globs match a change.
   *  When undefined, every extractor fires (full sweep). */
  changedFiles?: string[];
}

export interface RegenerateResult {
  manifestPath: string;
  decisionsLedgerPath: string;
  invariantsLedgerPath: string;
  qualityGradesPath: string;
  extractorsRan: string[];
}

/**
 * Idempotent full regeneration of `.harness/ground/*` for the given repo.
 *
 * Generic outputs (manifest, ledgers, quality grades) are always written.
 * Profile-specific extractors fire only when their watch globs intersect
 * `changedFiles`, or always when `changedFiles` is undefined.
 */
export async function regenerateAll(opts: RegenerateOptions): Promise<RegenerateResult> {
  const { repoRoot } = opts;
  const profile = opts.profile ?? selectProfile(repoRoot);
  log.info({ repoRoot, profile: profile.id }, "regenerate start");

  const manifest = writeManifest({ repoRoot, generator: "harness-watch" });
  const decisions = writeDecisionsLedger({ repoRoot });
  const invariants = writeInvariantsLedger({ repoRoot });
  const quality = writeQualityGrades({ repoRoot });

  const extractorsRan: string[] = [];
  for (const extractor of profile.extractors) {
    const triggered =
      opts.changedFiles === undefined ||
      opts.changedFiles.some((p) => matchAnyGlob(p, extractor.watch));
    if (!triggered) continue;
    try {
      const content = await extractor.run({ repoRoot });
      if (content === null) continue;
      const out = join(repoRoot, extractor.outputRelPath);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, content, "utf8");
      extractorsRan.push(extractor.id);
      log.debug({ extractor: extractor.id, out }, "extractor wrote artifact");
    } catch (err) {
      log.warn({ extractor: extractor.id, err: String(err) }, "extractor failed");
    }
  }

  log.info(
    { repoRoot, profile: profile.id, files: manifest.manifest.files.length, extractorsRan },
    "regenerate complete",
  );

  return {
    manifestPath: manifest.path,
    decisionsLedgerPath: decisions.path,
    invariantsLedgerPath: invariants.path,
    qualityGradesPath: quality.path,
    extractorsRan,
  };
}

/**
 * GC pass 2 — generator drift.
 *
 * Iterates every `Profile.extractors` and re-runs them. For each extractor:
 *   - run(ctx) → newContent | null
 *   - read existing file at outputRelPath → currentContent
 *   - if differ → emit a finding + a safe-class commit proposal that
 *     overwrites outputRelPath with newContent.
 *
 * Per spec: "auto-regenerate; commit `chore(gc): regenerate <artifact>` if no
 * source change required". A regenerated artifact whose deterministic output
 * matches the spec but doesn't match disk is exactly drift — replace it.
 *
 * The unknown profile has zero extractors, so on a vanilla repo this pass is
 * a no-op. Future profiles (typescript-next-nest, etc.) wire their extractors
 * via `registerProfile()` and they show up here automatically.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Profile } from "../profiles/types.js";
import type { GcCommitProposal, GcFinding } from "./types.js";

const PASS_ID = "generator-drift" as const;

export interface GeneratorDriftOptions {
  repoRoot: string;
  profile: Profile;
}

export interface GeneratorDriftResult {
  findings: GcFinding[];
  proposals: GcCommitProposal[];
}

export async function runGeneratorDrift(
  opts: GeneratorDriftOptions,
): Promise<GeneratorDriftResult> {
  const findings: GcFinding[] = [];
  const proposals: GcCommitProposal[] = [];

  for (const extractor of opts.profile.extractors) {
    const newContent = await extractor.run({ repoRoot: opts.repoRoot });
    if (newContent === null) continue; // extractor opted to skip

    const outAbs = resolve(opts.repoRoot, extractor.outputRelPath);
    const currentContent = existsSync(outAbs) ? readFileSync(outAbs, "utf8") : "";

    if (currentContent === newContent) continue;

    const finding: GcFinding = {
      pass: PASS_ID,
      kind: "generator_drift",
      path: extractor.outputRelPath,
      detail: `extractor \`${extractor.id}\` produces output that differs from on-disk content (${
        currentContent.length === 0 ? "missing" : "stale"
      }) — regenerating`,
      severity: "warn",
    };
    findings.push(finding);

    proposals.push({
      pass: PASS_ID,
      class: "safe",
      paths: [extractor.outputRelPath],
      patch: { [extractor.outputRelPath]: newContent },
      commit_message:
        `chore(gc): regenerate ${extractor.outputRelPath}\n\n` +
        `GC generator-drift pass — extractor \`${extractor.id}\` produces output that differs from on-disk.\n` +
        `Auto-applied as safe-class per PRIMER §12.2.\n`,
      findings: [finding],
    });
  }

  return { findings, proposals };
}

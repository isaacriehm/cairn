/**
 * UAT bundle + evidence-file gate.
 *
 * The bundle is the canonical artifact set under
 * `.harness/runs/active/<run_id>/uat/`. The evidence file (`.uat-passed`)
 * carries the SHA256 of every artifact + a bundle-level SHA256 over the
 * sorted file:hash list.
 *
 * Pre-push gate refuses commit unless:
 *   1. evidence file exists at the run's UAT directory
 *   2. recompute the bundle SHA256 — must match the file's claim
 *   3. recompute every per-file SHA256 — each must match the file's claim
 *   4. operator_decision === "approve"
 *
 * Bare `touch .uat-passed` fails check 2 (missing fields). Modifying any
 * artifact after the fact fails check 3.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { logger } from "../logger.js";
import type { EvidenceFile, EvidenceFileEntry, UatDecision, UatSummary } from "./types.js";

const log = logger("uat.bundle");

export const EVIDENCE_FILE_NAME = ".uat-passed";
const SUMMARY_FILE_NAME = "summary.yaml";

/** Returns the absolute UAT directory for a run. */
export function uatDirFor(repoRoot: string, runId: string): string {
  return join(repoRoot, ".harness", "runs", "active", runId, "uat");
}

/** Compute SHA256 of a file's bytes; returns lowercase hex. */
export function fileSha256(absPath: string): string {
  const buf = readFileSync(absPath);
  return createHash("sha256").update(buf).digest("hex");
}

/** SHA256 of the canonical `path<tab>sha256<newline>` manifest. */
export function bundleSha256(entries: readonly EvidenceFileEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const manifest = sorted.map((e) => `${e.path}\t${e.sha256}`).join("\n");
  return createHash("sha256").update(manifest, "utf8").digest("hex");
}

/** Walk the UAT dir and return every artifact (excluding the evidence file itself). */
export function collectArtifactPaths(uatDir: string): string[] {
  const out: string[] = [];
  walk(uatDir, (abs) => {
    const rel = relative(uatDir, abs);
    if (rel === EVIDENCE_FILE_NAME) return;
    out.push(rel);
  });
  out.sort();
  return out;
}

function walk(dir: string, visit: (abs: string) => void): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, visit);
    else if (st.isFile()) visit(abs);
  }
}

export interface WriteSummaryArgs {
  repoRoot: string;
  runId: string;
  summary: UatSummary;
}

/** Write the summary.yaml that adapters consume. */
export async function writeSummary(args: WriteSummaryArgs): Promise<string> {
  const path = join(uatDirFor(args.repoRoot, args.runId), SUMMARY_FILE_NAME);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyYaml(args.summary), "utf8");
  return path;
}

export interface WriteEvidenceFileArgs {
  repoRoot: string;
  runId: string;
  /** Decision recorded with the evidence — only `approve` allows the commit gate to pass. */
  operatorDecision: UatDecision;
}

/** Walk the UAT dir, hash each file, write the .uat-passed manifest. */
export async function writeEvidenceFile(
  args: WriteEvidenceFileArgs,
): Promise<{ path: string; bundleSha: string; entries: EvidenceFileEntry[] }> {
  const uatDir = uatDirFor(args.repoRoot, args.runId);
  const relPaths = collectArtifactPaths(uatDir);
  const entries: EvidenceFileEntry[] = relPaths.map((rel) => ({
    path: rel,
    sha256: fileSha256(join(uatDir, rel)),
  }));
  const bundleSha = bundleSha256(entries);
  const evidence: EvidenceFile = {
    run_id: args.runId,
    generated_at: new Date().toISOString(),
    bundle_sha256: bundleSha,
    files: entries,
    operator_decision: args.operatorDecision,
  };
  const path = join(uatDir, EVIDENCE_FILE_NAME);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyYaml(evidence), "utf8");
  log.info(
    { run_id: args.runId, file_count: entries.length, bundle_sha256: bundleSha },
    "evidence file written",
  );
  return { path, bundleSha, entries };
}

export interface VerifyEvidenceArgs {
  repoRoot: string;
  runId: string;
  /** When set, must match the evidence's recorded operator_decision. Default: "approve". */
  requireDecision?: UatDecision;
}

export interface VerifyEvidenceResult {
  ok: boolean;
  /** First failure reason; undefined on ok. */
  reason?: string;
  /** Parsed evidence file when present. */
  evidence?: EvidenceFile;
}

/**
 * Re-walk the UAT directory and recompute every per-file SHA + the bundle
 * SHA. Compare against the file's claim. Reject when:
 *   - evidence file missing or unparseable
 *   - any artifact missing or modified after the evidence file was written
 *   - bundle hash doesn't match the recomputed hash
 *   - operator_decision != requireDecision
 */
export function verifyEvidenceFile(args: VerifyEvidenceArgs): VerifyEvidenceResult {
  const uatDir = uatDirFor(args.repoRoot, args.runId);
  const evidencePath = join(uatDir, EVIDENCE_FILE_NAME);
  if (!existsSync(evidencePath)) {
    return { ok: false, reason: `evidence file missing: ${evidencePath}` };
  }
  let parsed: EvidenceFile;
  try {
    const raw = readFileSync(evidencePath, "utf8");
    parsed = parseYaml(raw) as EvidenceFile;
    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, reason: "evidence file is not an object (bare touch?)" };
    }
    if (typeof parsed.bundle_sha256 !== "string" || !Array.isArray(parsed.files)) {
      return { ok: false, reason: "evidence file missing required fields (bare touch?)" };
    }
  } catch (err) {
    return { ok: false, reason: `evidence file unparseable: ${String(err)}` };
  }

  const requireDecision = args.requireDecision ?? "approve";
  if (parsed.operator_decision !== requireDecision) {
    return {
      ok: false,
      reason: `operator_decision is "${parsed.operator_decision ?? "pending"}"; needs "${requireDecision}"`,
      evidence: parsed,
    };
  }

  // Per-file hash check.
  for (const entry of parsed.files) {
    const abs = join(uatDir, entry.path);
    if (!existsSync(abs)) {
      return { ok: false, reason: `artifact missing: ${entry.path}`, evidence: parsed };
    }
    const recomputed = fileSha256(abs);
    if (recomputed !== entry.sha256) {
      return {
        ok: false,
        reason: `artifact modified after evidence written: ${entry.path}`,
        evidence: parsed,
      };
    }
  }

  // Bundle hash check.
  const recomputedBundle = bundleSha256(parsed.files);
  if (recomputedBundle !== parsed.bundle_sha256) {
    return {
      ok: false,
      reason: `bundle hash mismatch: claim ${parsed.bundle_sha256.slice(0, 12)}, recomputed ${recomputedBundle.slice(0, 12)}`,
      evidence: parsed,
    };
  }

  // Reject extra files not in the manifest (post-hoc additions).
  const claimed = new Set(parsed.files.map((f) => f.path));
  for (const rel of collectArtifactPaths(uatDir)) {
    if (!claimed.has(rel)) {
      return {
        ok: false,
        reason: `artifact added after evidence written: ${rel}`,
        evidence: parsed,
      };
    }
  }

  return { ok: true, evidence: parsed };
}

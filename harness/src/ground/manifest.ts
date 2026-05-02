import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { logger } from "../logger.js";
import { readFrontmatter } from "./frontmatter.js";
import { groundDir, manifestPath } from "./paths.js";
import type { Manifest, ManifestEntry } from "./schemas.js";
import { walkCanonical } from "./walk.js";

const log = logger("ground.manifest");

export interface BuildManifestOptions {
  repoRoot: string;
  generator?: string;
}

export function buildManifest(opts: BuildManifestOptions): Manifest {
  const { repoRoot } = opts;
  const files = walkCanonical(repoRoot);
  const entries: ManifestEntry[] = files.map((rel) => makeEntry(repoRoot, rel));
  return {
    version: 1,
    generated: new Date().toISOString(),
    ...(opts.generator !== undefined ? { generator: opts.generator } : {}),
    files: entries,
  };
}

export function writeManifest(opts: BuildManifestOptions): { manifest: Manifest; path: string } {
  const manifest = buildManifest(opts);
  const path = manifestPath(opts.repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(groundDir(opts.repoRoot), { recursive: true });
  writeFileSync(path, stringifyYaml(manifest), "utf8");
  log.debug({ path, count: manifest.files.length }, "wrote manifest");
  return { manifest, path };
}

function makeEntry(repoRoot: string, rel: string): ManifestEntry {
  const abs = resolve(repoRoot, rel);
  const buf = readFileSync(abs);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const classification = classify(rel);

  // For markdown, lift audience + verified_at + generator from frontmatter.
  let audience: string | undefined;
  let verifiedAt: string | undefined;
  let generator: string | undefined;
  let source: string | undefined;
  if (rel.endsWith(".md")) {
    const fm = readFrontmatter(abs).frontmatter;
    if (fm) {
      audience = fm.audience;
      verifiedAt = fm["verified-at"];
      const generatorValue = (fm as Record<string, unknown>)["generator"];
      generator = typeof generatorValue === "string" ? generatorValue : undefined;
      const sourceValue = (fm as Record<string, unknown>)["source"];
      source = typeof sourceValue === "string" ? sourceValue : undefined;
    }
  }

  return {
    path: rel,
    sha256,
    classification,
    ...(audience !== undefined ? { audience } : {}),
    ...(verifiedAt !== undefined ? { verified_at: verifiedAt } : {}),
    ...(generator !== undefined ? { generator } : {}),
    ...(source !== undefined ? { source } : {}),
  };
}

function classify(rel: string): string {
  if (rel === "AGENTS.md" || rel === "CLAUDE.md") return "orientation";
  if (rel.startsWith(".claude/rules/")) return "rule";
  if (rel.startsWith(".claude/agents/")) return "agent-def";
  if (rel.startsWith(".claude/skills/")) return "skill";
  if (rel === ".claude/settings.json") return "config";
  if (rel.startsWith(".harness/ground/decisions/")) return "decision";
  if (rel.startsWith(".harness/ground/invariants/")) return "invariant";
  if (rel.startsWith(".harness/config/")) return "harness-config";
  if (rel.startsWith(".harness/ground/")) return "ground";
  if (rel.startsWith(".harness/tasks/")) return "task";
  if (rel.startsWith("docs/decisions/")) return "decision";
  if (rel.startsWith("docs/")) return "doc";
  return "other";
}

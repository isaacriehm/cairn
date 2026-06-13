#!/usr/bin/env tsx
/**
 * smoke-resync — Stage 3 deterministic config-resync (0.30.0).
 *
 * Drives `runResync` against a repo whose config has drifted from the tree
 * (the four config-drift kinds), and asserts:
 *   - dry-run (default) proposes the right config.yaml edits and mutates nothing;
 *   - `--area` scopes the proposals;
 *   - apply archives the pre-resync config, writes the edits, and resolves the
 *     drift (re-running config-drift finds nothing — idempotent);
 *   - a second resync proposes nothing.
 * Fixtures use neutral placeholder names.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  runConfigDrift,
  runCuratorEmit,
  runCuratorWalker,
  runResync,
  runResyncRecluster,
  type ProseBlock,
  type SemanticJudge,
} from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    cleanup();
    process.exit(1);
  }
}

function cleanup(): void {
  for (const p of cleanups.reverse()) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function mkRepo(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cairn-smoke-resync-${tag}-`));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn"), { recursive: true });
  return dir;
}

function write(repo: string, rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

const DRIFTED = [
  "version: 1",
  "slug: smoke",
  "off_limits:",
  "  - node_modules/",
  "  - dist/",
  "components:",
  "  componentDirs:",
  "    - src/components",
  "    - src/gone", // orphan (never created)
  "  extensions:",
  "    - .tsx",
  "  categories:",
  "    - forms",
  "",
].join("\n");

const unit = (name: string): string =>
  `export function ${name}() {\n  return <div>${name}</div>;\n}\n`;

function buildDriftedRepo(tag: string): string {
  const repo = mkRepo(tag);
  write(repo, ".cairn/config.yaml", DRIFTED);
  write(repo, ".gitignore", "node_modules/\ndist/\nbuild/\n"); // build/ not in off_limits
  write(repo, "src/components/Button.tsx", unit("Button"));
  write(repo, "src/components/Modal.vue", "<template></template>\n"); // uncovered ext
  write(repo, "src/widgets/A.tsx", unit("A")); // uncovered dir (3 files)
  write(repo, "src/widgets/B.tsx", unit("B"));
  write(repo, "src/widgets/C.tsx", unit("C"));
  return repo;
}

function kinds(proposals: { kind: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of proposals) out[p.kind] = (out[p.kind] ?? 0) + 1;
  return out;
}

async function main(): Promise<void> {
  console.log("smoke-resync — start");

  // ── Dry-run — proposes all four edits, mutates nothing ──────────────
  const repo = buildDriftedRepo("dry");
  const configBefore = readFileSync(join(repo, ".cairn/config.yaml"), "utf8");
  const dry = runResync({ repoRoot: repo });
  assert(dry.dryRun === true && dry.applied === false, "default run is dry (no apply)");
  const k = kinds(dry.proposals);
  assert(k["add_component_dir"] === 1, "proposes adding the grown dir to componentDirs");
  assert(dry.proposals.some((p) => p.kind === "add_component_dir" && p.value === "src/widgets"), "names src/widgets");
  assert(k["add_extension"] === 1, "proposes adding the new file type to extensions");
  assert(dry.proposals.some((p) => p.kind === "add_extension" && p.value === ".vue"), "names .vue");
  assert(k["add_off_limits"] === 1, "proposes adding the gitignore entry to off_limits");
  assert(dry.proposals.some((p) => p.kind === "add_off_limits" && p.value === "build/"), "names build/");
  assert(k["drop_component_dir"] === 1, "proposes dropping the dead componentDir");
  assert(dry.proposals.some((p) => p.kind === "drop_component_dir" && p.value === "src/gone"), "names src/gone");
  assert(dry.proposals.length === 4, "exactly four proposals");
  assert(readFileSync(join(repo, ".cairn/config.yaml"), "utf8") === configBefore, "dry-run mutated nothing");
  assert(dry.archivedConfig === null, "dry-run wrote no archive");
  console.log("  ✓ dry-run proposes the four config edits and mutates nothing");

  // ── --area scopes the proposals ─────────────────────────────────────
  const scoped = runResync({ repoRoot: repo, area: "src/widgets" });
  assert(
    scoped.proposals.length === 1 && scoped.proposals[0]?.value === "src/widgets",
    "--area scopes to findings under that dir",
  );
  console.log("  ✓ --area scopes the proposals");

  // ── Apply — archives, writes, resolves the drift ────────────────────
  const applied = runResync({ repoRoot: repo, dryRun: false, nowIso: "2026-06-13T00:00:00.000Z" });
  assert(applied.applied === true && applied.dryRun === false, "apply mutates");
  assert(applied.archivedConfig !== null, "apply archived the pre-resync config");
  const archiveListing = readdirSync(join(repo, ".cairn/ground/.archive"));
  assert(
    archiveListing.some((f) => f.startsWith("config.yaml.pre-resync.")),
    "pre-resync config backup landed in .archive",
  );
  const cfg = parseYaml(readFileSync(join(repo, ".cairn/config.yaml"), "utf8")) as {
    off_limits: string[];
    components: { componentDirs: string[]; extensions: string[] };
  };
  assert(cfg.components.componentDirs.includes("src/widgets"), "src/widgets added to componentDirs");
  assert(!cfg.components.componentDirs.includes("src/gone"), "src/gone dropped from componentDirs");
  assert(cfg.components.extensions.includes(".vue"), ".vue added to extensions");
  assert(cfg.off_limits.includes("build/"), "build/ added to off_limits");
  console.log("  ✓ apply archives, edits config.yaml, drops the orphan");

  // ── Idempotent — drift resolved, second resync proposes nothing ─────
  assert(runConfigDrift({ repoRoot: repo }).findings.length === 0, "config-drift is resolved after apply");
  const again = runResync({ repoRoot: repo });
  assert(again.proposals.length === 0, "a second resync proposes nothing (idempotent on a clean delta)");
  console.log("  ✓ drift resolved; re-run is idempotent");

  // ── Source rematch — re-point a moved entity's stale source_file ────
  const rem = mkRepo("rematch");
  write(rem, ".cairn/config.yaml", "version: 1\nslug: smoke\noff_limits:\n  - node_modules/\n");
  const entity = (id: string, src: string): string =>
    [`---`, `id: ${id}`, `title: ${id}`, `status: accepted`, `sot_kind: ledger`, `source_file: ${src}`, `---`, ``, `Body.`, ``].join("\n");
  // Moved: source_file gone, the §cite now lives in exactly one new file.
  write(rem, ".cairn/ground/decisions/DEC-abc1234.md", entity("DEC-abc1234", "src/old.ts"));
  write(rem, "src/new.ts", "// §DEC-abc1234\nexport const x = 1;\n");
  // Ambiguous: source gone, cited in TWO files → left for the orphan pass.
  write(rem, ".cairn/ground/invariants/INV-bbbbbbb.md", entity("INV-bbbbbbb", "src/goneB.ts"));
  write(rem, "src/a.ts", "// §INV-bbbbbbb\n");
  write(rem, "src/b.ts", "// §INV-bbbbbbb\n");
  // Valid: source_file still exists → never touched.
  write(rem, ".cairn/ground/decisions/DEC-ccccccc.md", entity("DEC-ccccccc", "src/present.ts"));
  write(rem, "src/present.ts", "// §DEC-ccccccc\n");

  const rdry = runResync({ repoRoot: rem });
  const repoints = rdry.proposals.filter((p) => p.kind === "repoint_source");
  assert(repoints.length === 1, "exactly one repoint proposal (ambiguous + valid excluded)");
  assert(
    repoints[0]?.entityId === "DEC-abc1234" && repoints[0]?.value === "src/new.ts",
    "re-points DEC-abc1234 to the file that now carries its cite",
  );
  console.log("  ✓ rematch proposes re-pointing the moved entity (ambiguous/valid skipped)");

  const rapplied = runResync({ repoRoot: rem, dryRun: false, nowIso: "2026-06-13T00:00:00.000Z" });
  assert(rapplied.applied && rapplied.archivedConfig === null, "rematch-only apply archives no config");
  assert(rapplied.archivedEntities.length === 1, "the re-pointed entity is archived first");
  const decBody = readFileSync(join(rem, ".cairn/ground/decisions/DEC-abc1234.md"), "utf8");
  assert(/^source_file:\s*src\/new\.ts$/m.test(decBody), "DEC-abc1234 source_file rewritten to src/new.ts");
  const invBody = readFileSync(join(rem, ".cairn/ground/invariants/INV-bbbbbbb.md"), "utf8");
  assert(/^source_file:\s*src\/goneB\.ts$/m.test(invBody), "ambiguous INV left untouched");
  assert(runResync({ repoRoot: rem }).proposals.length === 0, "rematch is idempotent after apply");
  console.log("  ✓ rematch applies, archives, and is idempotent");

  await reclusterSection();
  await recurateSection();

  cleanup();
  console.log("smoke-resync — pass");
}

/* ── Stage 3b — re-curation: area-scoped walk + draft emit ─────────────── */

const DEC_ENTRY = JSON.stringify({
  kind: "DEC",
  title: "Adopt the shared widget rendering pipeline",
  body: "## Context\n\nThe project grew a new widget area.\n\n## Decision\n\nRender every widget through the shared pipeline.\n\n## Why\n\nKeeps output consistent across surfaces.",
  scope_globs: ["src/widgets/**"],
  evidence_files: [],
  topic_tags: ["widgets"],
});

const INV_ENTRY = JSON.stringify({
  kind: "INV",
  title: "Widgets must never bypass the pipeline",
  body: "## Context\n\nNew widget area added.\n\n## Invariant\n\nAll widget output flows through the pipeline.\n\n## Why\n\nPrevents rendering drift.",
  scope_globs: ["src/widgets/**"],
  evidence_files: [],
  topic_tags: ["widgets"],
});

async function recurateSection(): Promise<void> {
  // ── Draft emit — DEC + INV land in _inbox/, ground + ledgers untouched ─
  const repo = mkRepo("recurate");
  write(repo, ".cairn/init/curator/final.jsonl", `${DEC_ENTRY}\n${INV_ENTRY}\n`);
  const emit = await runCuratorEmit({ repoRoot: repo, draft: true, captureSource: "resync-curator" });
  assert(emit.decsWritten.length === 1 && emit.invsWritten.length === 1, "one DEC + one INV draft emitted");

  const decDraft = emit.decsWritten[0]!;
  const invDraft = emit.invsWritten[0]!;
  assert(decDraft.path.startsWith(".cairn/ground/decisions/_inbox/") && decDraft.path.endsWith(".draft.md"), "DEC → decisions/_inbox/*.draft.md");
  assert(invDraft.path.startsWith(".cairn/ground/invariants/_inbox/") && invDraft.path.endsWith(".draft.md"), "INV → invariants/_inbox/*.draft.md");

  const decBody = readFileSync(join(repo, decDraft.path), "utf8");
  const invBody = readFileSync(join(repo, invDraft.path), "utf8");
  assert(/^status:\s*draft$/m.test(decBody), "DEC draft carries status: draft");
  assert(/^status:\s*draft$/m.test(invBody), "INV draft carries status: draft");
  assert(/^capture_source:\s*resync-curator$/m.test(decBody), "capture_source threaded through");

  // Ground (graduated) dirs + ledgers stay empty — drafts never auto-graduate.
  assert(!existsSync(join(repo, ".cairn/ground/decisions", `${decDraft.id}.md`)), "no graduated DEC in ground");
  assert(!existsSync(join(repo, ".cairn/ground/invariants", `${invDraft.id}.md`)), "no graduated INV in ground");
  assert(!existsSync(join(repo, ".cairn/ground/decisions/decisions.ledger.yaml")), "draft emit rebuilt no DEC ledger");
  assert(!existsSync(join(repo, ".cairn/ground/invariants/invariants.ledger.yaml")), "draft emit rebuilt no INV ledger");
  console.log("  ✓ re-curation draft emit lands DEC/INV in _inbox/ — ground + ledgers untouched");

  // ── Area-scoped walk — corpus restricted to the requested subtree ──────
  const wrepo = mkRepo("recurate-area");
  write(wrepo, ".cairn/config.yaml", "version: 1\nslug: smoke\n");
  const para = (topic: string): string =>
    `# ${topic}\n\nThis is a substantial prose paragraph about ${topic} that comfortably clears the eighty character minimum the curator walker enforces, so it survives the regex pre-filter as a real corpus record.\n`;
  write(wrepo, "docs/area-keep/topic.md", para("the kept area"));
  write(wrepo, "docs/area-skip/topic.md", para("the skipped area"));

  const scoped = await runCuratorWalker({ repoRoot: wrepo, area: "docs/area-keep" });
  const corpus = readFileSync(join(wrepo, scoped.corpus_path), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { file: string });
  assert(corpus.length > 0, "area walk produced at least one record");
  assert(corpus.every((r) => r.file.startsWith("docs/area-keep/")), "every record is under the requested area");
  assert(!corpus.some((r) => r.file.startsWith("docs/area-skip/")), "the out-of-area subtree is excluded");

  const full = await runCuratorWalker({ repoRoot: wrepo });
  const fullFiles = readFileSync(join(wrepo, full.corpus_path), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => (JSON.parse(l) as { file: string }).file);
  assert(fullFiles.some((f) => f.startsWith("docs/area-skip/")), "a full walk (no area) includes the skipped subtree");
  console.log("  ✓ area-scoped curator walk restricts the corpus to the requested subtree");
}

/* ── Stage 3b — LLM re-cluster (mock-judge runner seam, zero Haiku) ────── */

function block(file: string, slug: string, body: string): ProseBlock {
  return {
    file,
    kind: "doc",
    title: file,
    line_range: [1, 3],
    body,
    // TopicIndexEntry.content_hash is a length-64 string (sha256). Pad the
    // slug to a distinct, valid 64-char value so readTopicIndex re-parses it.
    content_hash: slug.padEnd(64, "0"),
    slug,
  };
}

// Two distinct slugs whose bodies share 6/8 tokens → jaccard 0.75 ≥ 0.6 →
// exactly one semantic-collision pair → exactly one judge call. The verdict
// drives the clustering: "same" collapses them to one topic, "different" keeps
// two. No real prose, no walker, no Haiku.
const REC_A = block("docs/a.md", "topicaaaaaa1", "alpha beta gamma delta epsilon zeta theta");
const REC_B = block("docs/b.md", "topicbbbbbb2", "alpha beta gamma delta epsilon zeta omega");
const NOW = "2026-06-13T00:00:00.000Z";

async function recluster(
  repo: string,
  verdict: "same" | "different",
  dryRun: boolean,
  calls: { n: number },
) {
  const judge: SemanticJudge = async () => {
    calls.n += 1;
    return verdict;
  };
  return runResyncRecluster({
    repoRoot: repo,
    dryRun,
    judge,
    blocks: [REC_A, REC_B],
    nowIso: NOW,
  });
}

function topicCount(repo: string): number {
  const raw = readFileSync(join(repo, ".cairn/ground/topic-index.yaml"), "utf8");
  const idx = parseYaml(raw) as { topics: Record<string, unknown> };
  return Object.keys(idx.topics ?? {}).length;
}

async function reclusterSection(): Promise<void> {
  const calls = { n: 0 };

  // ── apply #1 (fresh) — "same" collapses the pair to one topic ───────
  const repo = mkRepo("recluster");
  const a1 = await recluster(repo, "same", false, calls);
  assert(a1.applied && !a1.dryRun, "recluster apply mutates");
  assert(a1.blockCount === 2 && a1.judgeCalls === 1, "two blocks, one semantic-collision judge call");
  assert(a1.topicsBefore === 0 && a1.topicsAfter === 1, "fresh → 1 topic after a 'same' verdict");
  assert(a1.archivedMaps.length === 0, "first apply archives nothing (no prior maps)");
  assert(existsSync(join(repo, ".cairn/ground/topic-index.yaml")), "topic-index.yaml written");
  assert(topicCount(repo) === 1, "on-disk index carries the single collapsed topic");
  console.log("  ✓ recluster apply (mock judge) rebuilds the topic-index — one topic from a 'same' verdict");

  // ── dry-run — re-walks + judges but overwrites nothing ──────────────
  const before = readFileSync(join(repo, ".cairn/ground/topic-index.yaml"), "utf8");
  const dry = await recluster(repo, "same", true, calls);
  assert(dry.dryRun && !dry.applied, "dry-run does not apply");
  assert(dry.judgeCalls === 1, "dry-run still runs the judge (it IS the discovery)");
  assert(dry.topicsBefore === 1 && dry.topicsAfter === 1, "dry-run reports before/after counts");
  assert(dry.archivedMaps.length === 0, "dry-run archives nothing");
  assert(
    readFileSync(join(repo, ".cairn/ground/topic-index.yaml"), "utf8") === before,
    "dry-run mutated no map on disk",
  );
  console.log("  ✓ recluster dry-run reports counts but overwrites no map");

  // ── apply #2 — archives the pre-resync maps before overwriting ──────
  const a2 = await recluster(repo, "same", false, calls);
  assert(a2.archivedMaps.length === 2, "second apply archives the prior topic-index + anchor-map");
  const archives = readdirSync(join(repo, ".cairn/ground/.archive"));
  assert(
    archives.some((f) => f.startsWith("topic-index.yaml.pre-resync.")) &&
      archives.some((f) => f.startsWith("anchor-map.yaml.pre-resync.")),
    "both pre-resync maps landed in .archive",
  );
  console.log("  ✓ recluster apply archives the prior maps before overwrite (recoverable)");

  // ── verdict drives clustering — "different" keeps two topics ────────
  const repo2 = mkRepo("recluster-diff");
  const diff = await recluster(repo2, "different", false, calls);
  assert(diff.topicsAfter === 2, "a 'different' verdict keeps the two topics distinct");
  assert(topicCount(repo2) === 2, "on-disk index carries both topics");
  console.log("  ✓ judge verdict drives clustering ('different' → two topics)");

  assert(calls.n >= 4, "mock judge was the runner seam for every pass (zero Haiku)");
}

main().catch((err) => {
  console.error(`✗ smoke-resync threw: ${err instanceof Error ? err.stack : String(err)}`);
  cleanup();
  process.exit(1);
});

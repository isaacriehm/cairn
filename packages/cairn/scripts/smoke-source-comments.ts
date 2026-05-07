#!/usr/bin/env tsx
/**
 * smoke-source-comments — Phase 7b walker + classifier mock + ingest
 * persistence + Phase 10 strip-replace primitives.
 *
 * No real Haiku calls — `mockClassify` returns deterministic outputs.
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
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  SOURCE_COMMENT_HEURISTIC,
  applyStripReplace,
  detectSourceCommentLang,
  previewStripReplace,
  runSourceCommentsIngestion,
  walkSourceComments,
  type CommentBlock,
  type CommentClassification,
  type CommentLang,
  type ReplaceItem,
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
  for (const path of cleanups.reverse()) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function mkRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-srccomm-"));
  cleanups.push(dir);
  return dir;
}

function writeFile(repoRoot: string, rel: string, body: string): string {
  const abs = join(repoRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
  return abs;
}

function step(label: string): void {
  console.log(`── ${label}`);
}

async function main(): Promise<void> {
  step("Step 1 — language detection");
  assert(detectSourceCommentLang("a/b.ts") === "js", "ts → js");
  assert(detectSourceCommentLang("a/b.tsx") === "js", "tsx → js");
  assert(detectSourceCommentLang("svc.py") === "py", "py → py");
  assert(detectSourceCommentLang("lib.rs") === "rs", "rs → rs");
  assert(detectSourceCommentLang("main.go") === "go", "go → go");
  assert(detectSourceCommentLang("foo.txt") === "unknown", "txt → unknown");
  console.log("  ✓ Step 1 — language detection");

  step("Step 2 — heuristic boundaries");
  const repoRoot = mkRepoRoot();
  // Short block — must NOT trigger
  writeFile(
    repoRoot,
    "src/short.ts",
    `// only one line\nconst x = 1;\n`,
  );
  // Multi-line block (>3 lines) — must trigger
  writeFile(
    repoRoot,
    "src/long.ts",
    [
      "/* line 1 of comment",
      " * line 2 of comment",
      " * line 3 of comment",
      " * line 4 of comment",
      " */",
      "const y = 2;",
    ].join("\n") + "\n",
  );
  // JSDoc with > 30 words of prose — must trigger
  const jsdocBody = Array.from({ length: 4 }, (_, i) => ` * sentence ${i} word word word word word word word word`).join("\n");
  writeFile(
    repoRoot,
    "src/doc.ts",
    `/**\n${jsdocBody}\n */\nexport function f() {}\n`,
  );
  // Python docstring — long enough by chars
  writeFile(
    repoRoot,
    "src/svc.py",
    `def foo():\n    """\n    ${"word ".repeat(60)}\n    """\n    return 1\n`,
  );
  // License header — captured but with kind=license
  writeFile(
    repoRoot,
    "src/lic.ts",
    `/**\n * Copyright 2026 Acme.\n * Licensed under MIT.\n * SPDX-License-Identifier: MIT\n */\nexport const a = 1;\n`,
  );

  const walk = walkSourceComments({ repoRoot });
  const byFile: Record<string, CommentBlock[]> = {};
  for (const b of walk.blocks) {
    (byFile[b.file] ??= []).push(b);
  }

  assert(byFile["src/short.ts"] === undefined, "short.ts should produce zero blocks");
  assert((byFile["src/long.ts"] ?? []).length === 1, "long.ts should produce exactly one block");
  const longBlock = byFile["src/long.ts"]?.[0];
  assert(longBlock !== undefined && longBlock.kind === "block", "long.ts kind = block");
  assert(longBlock !== undefined && longBlock.lineCount >= SOURCE_COMMENT_HEURISTIC.MIN_LINES, "long.ts ≥4 lines");

  const docBlock = (byFile["src/doc.ts"] ?? [])[0];
  assert(docBlock !== undefined, "doc.ts should produce block");
  assert(docBlock.kind === "jsdoc", "doc.ts kind = jsdoc");
  assert(docBlock.wordCount > SOURCE_COMMENT_HEURISTIC.MIN_JSDOC_WORDS, "doc.ts > 30 words");

  const pyBlock = (byFile["src/svc.py"] ?? [])[0];
  assert(pyBlock !== undefined, "svc.py should produce block");
  assert(pyBlock.lang === "py", "svc.py lang=py");

  const licBlock = (byFile["src/lic.ts"] ?? [])[0];
  assert(licBlock !== undefined && licBlock.kind === "license", "license header kind=license");
  console.log("  ✓ Step 2 — heuristic boundaries (block, jsdoc, py-docstring, license)");

  step("Step 3 — multi-language coverage");
  const repoRoot2 = mkRepoRoot();
  // Rust /// doc comment cluster
  writeFile(
    repoRoot2,
    "lib.rs",
    `/// First line of a doc comment about rust function\n/// Second line continuing the explanation across lines\n/// Third line keeps going to make this a multi-line cluster\n/// Fourth line so we trip the heuristic\nfn foo() {}\n`,
  );
  // Go // cluster
  writeFile(
    repoRoot2,
    "main.go",
    `// First line about go\n// Second line about go\n// Third line about go\n// Fourth line about go\nfunc main() {}\n`,
  );
  // Shell # cluster with shebang
  writeFile(
    repoRoot2,
    "deploy.sh",
    `#!/bin/bash\n# Deploy step one\n# Deploy step two\n# Deploy step three\n# Deploy step four\necho hi\n`,
  );
  // Ruby =begin/=end
  writeFile(
    repoRoot2,
    "x.rb",
    `=begin\nThis is a ruby block comment\nwith multiple lines\nworth capturing here\n=end\nputs 'hi'\n`,
  );
  const walk2 = walkSourceComments({ repoRoot: repoRoot2 });
  const langs = new Set(walk2.blocks.map((b) => b.lang as CommentLang));
  assert(langs.has("rs"), "Rust block detected");
  assert(langs.has("go"), "Go block detected");
  assert(langs.has("sh"), "Shell block detected");
  assert(langs.has("rb"), "Ruby block detected");
  console.log("  ✓ Step 3 — multi-language coverage (rs/go/sh/rb)");

  step("Step 4 — ingest emits verbatim ledger DEC + strip-replaces source");
  const ingestRoot = mkRepoRoot();
  // git init so strip-replace's dirty-check can read porcelain output.
  const childProcess = await import("node:child_process");
  const execFileSync = childProcess.execFileSync;
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: ingestRoot });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: ingestRoot });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: ingestRoot });
  writeFile(
    ingestRoot,
    "src/auth.ts",
    [
      "/**",
      " * We MUST sign JWTs with HS512 not RS256 because the deployment topology",
      " * does not include a key rotation surface yet, and the token TTL is",
      " * 15 minutes which keeps replay risk low. Revisit when KMS arrives.",
      " * @returns string",
      " */",
      "export function sign() {}",
    ].join("\n") + "\n",
  );
  execFileSync("git", ["add", "."], { cwd: ingestRoot });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: ingestRoot });

  const mock = (b: CommentBlock): CommentClassification => ({
    blockId: b.id,
    kind: "rationale",
    failed: false,
  });
  const result = await runSourceCommentsIngestion({
    repoRoot: ingestRoot,
    mockClassify: mock,
  });
  assert(result.walk.blocks.length === 1, "one block detected");
  assert(result.kindCounts["rationale"] === 1, "one rationale classification");
  assert(result.decsWritten.length === 1, "one DEC emitted");
  assert(result.invsWritten.length === 0, "no INV emitted from rationale path");
  assert(result.citesEmitted.length === 0, "no cite-existing — fresh slug");
  const decId = result.decsWritten[0]?.id;
  assert(typeof decId === "string" && /^DEC-[0-9a-f]{7,}$/.test(decId), "DEC id is hash form");
  assert(result.decsWritten[0]?.status === "accepted", "auto-promoted to accepted");
  const decPath = join(ingestRoot, result.decsWritten[0]?.path ?? "");
  assert(existsSync(decPath), "DEC ground file exists");
  const dec = readFileSync(decPath, "utf8");
  assert(dec.includes("HS512"), "DEC body cites HS512 verbatim");
  assert(dec.includes("status: accepted"), "frontmatter status: accepted");
  assert(dec.includes("sot_kind: ledger"), "frontmatter sot_kind: ledger");
  assert(dec.includes("sot_path: ledger"), "frontmatter sot_path: ledger");
  assert(dec.includes("capture_source: init-source-comments"), "capture_source stamped");
  // Source file should now carry `// §DEC-<hash>` instead of the original prose.
  const stripped = readFileSync(join(ingestRoot, "src/auth.ts"), "utf8");
  assert(stripped.includes(`// §${decId}`), `source file now cites §${decId}`);
  assert(!stripped.includes("HS512"), "original comment prose stripped from source");
  // sot-bindings.yaml records DEC → "ledger" for read-side resolution.
  const bindings = parseYaml(
    readFileSync(join(ingestRoot, ".cairn/ground/sot-bindings.yaml"), "utf8"),
  ) as Record<string, unknown>;
  const forward = bindings["forward"] as Record<string, string>;
  assert(forward[decId] === "ledger", "sot-bindings.forward points DEC → ledger");
  // topic-index.yaml carries the new source-comment entry with dec_id.
  const ti = parseYaml(
    readFileSync(join(ingestRoot, ".cairn/ground/topic-index.yaml"), "utf8"),
  ) as Record<string, unknown>;
  const topics = ti["topics"] as Record<string, Record<string, unknown>>;
  const tiSlugs = Object.keys(topics);
  assert(tiSlugs.length === 1, "one topic-index entry written");
  const tiEntry = topics[tiSlugs[0]!]!;
  assert(tiEntry["dec_id"] === decId, "topic-index entry stamped with dec_id");
  assert(tiEntry["sot_source"] === "src/auth.ts", "sot_source = source file");
  // Audit yaml landed.
  const auditAbs = join(ingestRoot, result.auditRelPath);
  assert(existsSync(auditAbs), "audit yaml written");
  const audit = parseYaml(readFileSync(auditAbs, "utf8")) as Record<string, unknown>;
  assert(typeof audit["files_scanned"] === "number", "audit has files_scanned");
  assert(Array.isArray(audit["blocks"]), "audit blocks array");
  console.log("  ✓ Step 4 — verbatim ledger DEC + strip-replace + bindings/topic-index updated");

  step("Step 4b — topic-index lookup short-circuits to cite-existing");
  const citeRoot = mkRepoRoot();
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: citeRoot });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: citeRoot });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: citeRoot });
  // Source comment whose prose mirrors a paragraph already owned by docs/.
  const sharedProse = [
    "We MUST sign JWTs with HS512 not RS256 because the deployment topology",
    "does not include a key rotation surface yet, and the token TTL is",
    "15 minutes which keeps replay risk low. Revisit when KMS arrives.",
  ].join("\n");
  writeFile(
    citeRoot,
    "src/auth.ts",
    [
      "/**",
      ` * ${sharedProse.split("\n").join("\n * ")}`,
      " */",
      "export function sign() {}",
    ].join("\n") + "\n",
  );
  // Pre-seed topic-index so the lookup fires. Compute slug deterministically
  // from `topicSlug(prose)`; mirror the production import path here.
  const { topicSlug, emptyTopicIndex, setTopic, writeTopicIndex } = await import(
    "@isaacriehm/cairn-core"
  );
  // The walker strips comment markers + leading whitespace from each line
  // before yielding `block.prose`. Mirror the same trimming for the
  // pre-seed slug so it matches the slug ingest computes from the walker
  // output.
  const proseAsWalkerWillSee = sharedProse;
  const seededSlug = topicSlug(proseAsWalkerWillSee);
  const seededDecId = "DEC-1234567";
  let seededTi = emptyTopicIndex();
  seededTi = setTopic(seededTi, seededSlug, {
    slug: seededSlug,
    dec_id: seededDecId,
    sot_source: "docs/auth.md",
    candidates: [
      { file: "docs/auth.md", kind: "doc", line_range: [1, 3], anchor: "jwt-signing" },
    ],
    created_at: new Date().toISOString(),
  });
  writeTopicIndex(citeRoot, seededTi);
  execFileSync("git", ["add", "."], { cwd: citeRoot });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: citeRoot });

  const citeResult = await runSourceCommentsIngestion({
    repoRoot: citeRoot,
    mockClassify: mock,
  });
  assert(citeResult.decsWritten.length === 0, "no new DEC — short-circuited to existing");
  assert(citeResult.citesEmitted.length === 1, "one cite emitted to existing DEC");
  assert(
    citeResult.citesEmitted[0]?.id === seededDecId,
    `cite resolves to seeded DEC (got ${citeResult.citesEmitted[0]?.id})`,
  );
  // Source file now carries §DEC-1234567.
  const citedSource = readFileSync(join(citeRoot, "src/auth.ts"), "utf8");
  assert(citedSource.includes(`// §${seededDecId}`), "source cites seeded DEC");
  assert(!citedSource.includes("HS512"), "original prose stripped");
  console.log("  ✓ Step 4b — topic-index lookup → cite existing DEC, no new DEC emitted");

  step("Step 4c — phase 7b regex pre-filter: narrative essay → topic-index candidate only");
  {
    const narrativeRoot = mkRepoRoot();
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: narrativeRoot });
    execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: narrativeRoot });
    execFileSync("git", ["config", "user.name", "Smoke"], { cwd: narrativeRoot });
    // Pure narrative — explains what the class does, no MUST/SHALL/INVARIANT/marker.
    writeFile(
      narrativeRoot,
      "src/svc.ts",
      [
        "/**",
        " * This class handles the auth flow end to end.",
        " * It coordinates token issuance with the upstream IDP",
        " * and persists session metadata to Redis for fast revocation.",
        " * Most consumers do not touch it directly.",
        " */",
        "export class AuthService {}",
      ].join("\n") + "\n",
    );
    execFileSync("git", ["add", "."], { cwd: narrativeRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: narrativeRoot });

    let mockCalls = 0;
    const failingMock = (b: CommentBlock): CommentClassification => {
      mockCalls += 1;
      // If the regex pre-filter is broken, the classifier would see this
      // narrative block — fail loudly so the smoke catches the regression.
      throw new Error(`mockClassify must not be called on narrative blocks (block_id=${b.id})`);
    };
    const narrativeResult = await runSourceCommentsIngestion({
      repoRoot: narrativeRoot,
      mockClassify: failingMock,
    });
    assert(mockCalls === 0, `classifier must be skipped on narrative blocks (mockCalls=${mockCalls})`);
    assert(narrativeResult.walk.blocks.length === 1, "one block detected by walker");
    assert(narrativeResult.decsWritten.length === 0, "no DEC emitted from narrative");
    assert(narrativeResult.invsWritten.length === 0, "no INV emitted from narrative");
    assert(narrativeResult.citesEmitted.length === 0, "no cite emitted");
    // Topic-index candidate IS registered so cairn_propose_decision can find it later.
    const narrativeTi = parseYaml(
      readFileSync(join(narrativeRoot, ".cairn/ground/topic-index.yaml"), "utf8"),
    ) as Record<string, unknown>;
    const narrativeTopics = narrativeTi["topics"] as Record<string, Record<string, unknown>>;
    const narrativeSlugs = Object.keys(narrativeTopics);
    assert(
      narrativeSlugs.length === 1,
      `expected exactly one topic-index candidate, got ${narrativeSlugs.length}`,
    );
    const narrativeEntry = narrativeTopics[narrativeSlugs[0]!]!;
    assert(narrativeEntry["dec_id"] === undefined, "candidate has no dec_id (unpromoted)");
    assert(
      narrativeEntry["sot_source"] === "src/svc.ts",
      `candidate sot_source = src/svc.ts (got ${String(narrativeEntry["sot_source"])})`,
    );
    // Source file untouched — strip-replace must not fire on candidate-only blocks.
    const narrativeSrc = readFileSync(join(narrativeRoot, "src/svc.ts"), "utf8");
    assert(narrativeSrc.includes("This class handles"), "narrative prose still in source");
    assert(!narrativeSrc.includes("§DEC-"), "no DEC citation injected");
  }
  console.log("  ✓ Step 4c — narrative essay → no Haiku call, no DEC, topic-index candidate registered");

  step("Step 4d — phase 7b marker override: @cairn:decision always emits, classifier bypassed");
  {
    const markerRoot = mkRepoRoot();
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: markerRoot });
    execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: markerRoot });
    execFileSync("git", ["config", "user.name", "Smoke"], { cwd: markerRoot });
    // Narrative prose, but with @cairn:decision marker — must always emit.
    writeFile(
      markerRoot,
      "src/billing.ts",
      [
        "/**",
        " * @cairn:decision",
        " * Pricing rounds half-up to the nearest cent at invoice time.",
        " * Stripe truncates by default which under-bills micro-charges.",
        " * Keep the rounding inside the billing layer until the new",
        " * pricing engine ships.",
        " */",
        "export function priceInvoice() {}",
      ].join("\n") + "\n",
    );
    execFileSync("git", ["add", "."], { cwd: markerRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: markerRoot });

    let markerMockCalls = 0;
    const refusingMock = (b: CommentBlock): CommentClassification => {
      markerMockCalls += 1;
      throw new Error(`mockClassify must not be called on marker-tagged blocks (block_id=${b.id})`);
    };
    const markerResult = await runSourceCommentsIngestion({
      repoRoot: markerRoot,
      mockClassify: refusingMock,
    });
    assert(markerMockCalls === 0, `marker override must skip the classifier (markerMockCalls=${markerMockCalls})`);
    assert(markerResult.decsWritten.length === 1, "marker-tagged block emits one DEC");
    const markerDecId = markerResult.decsWritten[0]?.id;
    assert(typeof markerDecId === "string" && /^DEC-[0-9a-f]{7,}$/.test(markerDecId ?? ""), "marker DEC id is hash form");
    const markerSrc = readFileSync(join(markerRoot, "src/billing.ts"), "utf8");
    assert(markerSrc.includes(`// §${markerDecId}`), "marker source now cites the new DEC");
    assert(!markerSrc.includes("Pricing rounds"), "marker source had its prose stripped");
  }
  console.log("  ✓ Step 4d — @cairn:decision marker forces emit even without imperative keywords");

  step("Step 5 — strip-replace mechanical edit + backup");
  const repoRoot3 = mkRepoRoot();
  // Init a git repo so dirty-check works.
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: repoRoot3 });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: repoRoot3 });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: repoRoot3 });
  writeFile(
    repoRoot3,
    "src/db.ts",
    [
      "    /* one",
      "     * two",
      "     * three",
      "     */",
      "    return 42;",
    ].join("\n") + "\n",
  );
  execFileSync("git", ["add", "."], { cwd: repoRoot3 });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot3 });

  const walk3 = walkSourceComments({ repoRoot: repoRoot3 });
  const block = walk3.blocks[0];
  assert(block !== undefined, "block found in db.ts");
  const item: ReplaceItem = {
    blockId: block.id,
    file: block.file,
    startOffset: block.startOffset,
    endOffset: block.endOffset,
    replacement: "// §INV-4242424",
  };

  const preview = previewStripReplace({ repoRoot: repoRoot3, items: [item] });
  assert(preview.length === 1, "preview returns one file entry");
  assert(preview[0]?.before !== preview[0]?.after, "preview before/after differ");
  assert(preview[0]?.after.includes("// §INV-4242424"), "preview shows §INV-4242424");

  const apply = applyStripReplace({ repoRoot: repoRoot3, items: [item] });
  assert(apply.filesModified === 1, "one file modified");
  assert(apply.itemsApplied === 1, "one item applied");
  const newContent = readFileSync(join(repoRoot3, "src/db.ts"), "utf8");
  assert(newContent.includes("// §INV-4242424"), "file now contains §INV-4242424");
  assert(!newContent.includes("/* one"), "original block removed");
  // Indentation preserved (4 spaces leading)
  assert(/^ {4}\/\/ §INV-4242424$/m.test(newContent), "leading indent preserved");
  // Backup written
  const backup = join(repoRoot3, ".cairn/backups/source/src/db.ts.original");
  assert(existsSync(backup), "backup .original written");
  const backupContent = readFileSync(backup, "utf8");
  assert(backupContent.includes("/* one"), "backup retains original block");
  console.log("  ✓ Step 5 — strip-replace mechanical edit + backup");

  step("Step 6 — strip-replace indented line-cluster preserves indent");
  // Indented // line-cluster — the startOffset must point at the marker, not
  // the line start, so leadingIndent in strip-replace finds the 2-space indent.
  const lcRoot = mkRepoRoot();
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: lcRoot });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: lcRoot });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: lcRoot });
  writeFile(
    lcRoot,
    "src/svc.ts",
    [
      "function foo() {",
      "  // first line of cluster explaining something",
      "  // second line keeps going with more detail",
      "  // third line to exceed the min-lines heuristic",
      "  // fourth line to pass the four-line threshold",
      "  return 1;",
      "}",
    ].join("\n") + "\n",
  );
  execFileSync("git", ["add", "."], { cwd: lcRoot });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: lcRoot });
  const walkLc = walkSourceComments({ repoRoot: lcRoot });
  const lcBlock = walkLc.blocks[0];
  assert(lcBlock !== undefined, "indented // cluster found");
  assert(lcBlock.kind === "line-cluster", "line-cluster kind");
  // startOffset must point at the first '/' not the line start.
  const lcFileBody = readFileSync(join(lcRoot, "src/svc.ts"), "utf8");
  assert(
    lcFileBody[lcBlock.startOffset] === "/" && lcFileBody[lcBlock.startOffset + 1] === "/",
    "startOffset at comment marker not line-start",
  );
  const lcItem: ReplaceItem = {
    blockId: lcBlock.id,
    file: lcBlock.file,
    startOffset: lcBlock.startOffset,
    endOffset: lcBlock.endOffset,
    replacement: "// §INV-9999999",
    expectedRaw: lcBlock.raw,
  };
  const lcApply = applyStripReplace({ repoRoot: lcRoot, items: [lcItem] });
  assert(lcApply.filesModified === 1, "lc: file modified");
  assert(lcApply.itemsApplied === 1, "lc: item applied");
  const lcContent = readFileSync(join(lcRoot, "src/svc.ts"), "utf8");
  assert(lcContent.includes("// §INV-9999999"), "lc: citation present");
  assert(/^ {2}\/\/ §INV-9999999$/m.test(lcContent), "lc: 2-space indent preserved");
  console.log("  ✓ Step 6 — strip-replace indented line-cluster preserves indent");

  step("Step 7 — strip-replace honors dirty-check");
  // Modify file uncommitted.
  writeFileSync(join(repoRoot3, "src/db.ts"), `${newContent}\n// hand-edit\n`, "utf8");
  // Re-walk to get current block layout (none expected since stripped).
  // Trigger a "dirty + no decision → skip" path by reusing the now-applied (stale) item:
  const item2: ReplaceItem = {
    blockId: "stale",
    file: "src/db.ts",
    startOffset: 0,
    endOffset: 5,
    replacement: "// §INV-9999999",
  };
  const apply2 = applyStripReplace({ repoRoot: repoRoot3, items: [item2] });
  assert(apply2.filesSkipped === 1, "dirty file skipped without decision");
  assert(apply2.files[0]?.fileSkipReason === "dirty-no-decision", "skip reason recorded");
  console.log("  ✓ Step 7 — strip-replace honors dirty-check");

  step("Cleanup");
  cleanup();
  console.log("\nsmoke-source-comments — pass");
}

main().catch((err) => {
  console.error("smoke-source-comments — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});

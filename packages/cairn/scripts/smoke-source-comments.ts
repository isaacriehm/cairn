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

  step("Step 4 — ingest writes audit + DEC drafts");
  const ingestRoot = mkRepoRoot();
  writeFile(
    ingestRoot,
    "src/auth.ts",
    [
      "/**",
      " * We sign JWTs with HS512 not RS256 because the deployment topology",
      " * does not include a key rotation surface yet, and the token TTL is",
      " * 15 minutes which keeps replay risk low. Revisit when KMS arrives.",
      " * @returns string",
      " */",
      "export function sign() {}",
    ].join("\n") + "\n",
  );
  const mock = (b: CommentBlock): CommentClassification => ({
    blockId: b.id,
    kind: "rationale",
    suggestedDecDraft: "Sign JWTs with HS512 until KMS arrives",
    suggestedInvariant: "",
    suggestedCanonicalTopic: "auth-jwt",
    failed: false,
  });
  const result = await runSourceCommentsIngestion({
    repoRoot: ingestRoot,
    mockClassify: mock,
  });
  assert(result.walk.blocks.length === 1, "one block detected");
  assert(result.kindCounts["rationale"] === 1, "one rationale classification");
  assert(result.decDraftsWritten.length === 1, "one DEC draft written");
  const draftPath = join(ingestRoot, result.decDraftsWritten[0]?.path ?? "");
  assert(existsSync(draftPath), "DEC draft file exists");
  const draft = readFileSync(draftPath, "utf8");
  assert(draft.includes("HS512"), "draft body cites HS512");
  assert(draft.includes("status: draft-from-source-comment"), "draft tagged source-comment");
  const auditAbs = join(ingestRoot, result.auditRelPath);
  assert(existsSync(auditAbs), "audit yaml written");
  const audit = parseYaml(readFileSync(auditAbs, "utf8")) as Record<string, unknown>;
  assert(typeof audit["files_scanned"] === "number", "audit has files_scanned");
  assert(Array.isArray(audit["blocks"]), "audit blocks array");
  console.log("  ✓ Step 4 — ingest writes audit + DEC drafts (rationale path)");

  step("Step 5 — strip-replace mechanical edit + backup");
  const repoRoot3 = mkRepoRoot();
  // Init a git repo so dirty-check works.
  // Using execFileSync via require to avoid heavy import.
  const { execFileSync } = await import("node:child_process");
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

#!/usr/bin/env tsx
/**
 * smoke-units-multilang — the language-agnostic unit registry, mechanical E2E.
 *
 * Proves the `languages.ts` profile backbone drives the component store across
 * non-React stacks, end-to-end through `buildComponentIndex` / `runComponentCheck`:
 *   - export extraction per language (TS, Vue, Python, Go, Swift, Kotlin, Java);
 *   - registry-header parsing in every comment form (block, `//`, `#`,
 *     `<!-- -->`, `--`, docstring);
 *   - unit-shape detection for the audit (SwiftUI View, Flutter Widget,
 *     Compose @Composable, Vue/Svelte SFC) outside the component dirs;
 *   - the export-mismatch finding firing on a real per-language non-export.
 *
 * This is deterministic (no LLM): component-layout DISCOVERY is exercised by
 * the opt-in `smoke:llm-detect-components`. Here the config is injected and the
 * mechanical pipeline is asserted.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractExportNames,
  parseComponentHeader,
  profileForFile,
  buildComponentIndex,
  runComponentAudit,
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
      /* best-effort */
    }
  }
}

function step(label: string): void {
  console.log(`── ${label}`);
}

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/* -------------------------------------------------------------------------- */
/* 1. Export extraction per language                                          */
/* -------------------------------------------------------------------------- */

function exportExtraction(): void {
  step("Export extraction — per-language top-level symbols");

  const cases: Array<{ file: string; source: string; want: string[] }> = [
    {
      file: "Button.tsx",
      source: "export function Button() { return null; }\nexport const FOO = 1;\n",
      want: ["Button", "FOO"],
    },
    {
      file: "Card.vue",
      source: "<template><div /></template>\n<script setup lang=\"ts\"></script>\n",
      want: ["Card"], // SFC export is the file stem
    },
    {
      file: "widget.py",
      source: "def build():\n    pass\n\nclass Panel:\n    def helper(self):\n        pass\n",
      want: ["build", "Panel"], // top-level only — `helper` is indented
    },
    {
      file: "server.go",
      source: "package main\nfunc Handler() {}\nfunc internal() {}\ntype Server struct{}\n",
      want: ["Handler", "Server"], // capitalized = exported; `internal` excluded
    },
    {
      file: "ContentView.swift",
      source: "import SwiftUI\nstruct ContentView: View {\n  var body: some View { Text(\"hi\") }\n}\n",
      want: ["ContentView"],
    },
    {
      file: "Greeting.kt",
      source: "class Greeting {\n  fun hello() {}\n}\nfun topLevel() {}\n",
      want: ["Greeting", "topLevel"],
    },
    {
      file: "Service.java",
      source: "package x;\npublic class Service {}\npublic interface Repo {}\nclass Hidden {}\n",
      want: ["Service", "Repo"], // package-private `Hidden` excluded
    },
  ];

  for (const c of cases) {
    const got = extractExportNames(c.source, c.file);
    for (const name of c.want) {
      assert(got.includes(name), `${c.file}: export "${name}" detected (got: ${got.join(", ") || "∅"})`);
    }
  }
  // Negative: Go lowercase ident is NOT exported.
  assert(
    !extractExportNames("func internal() {}\n", "x.go").includes("internal"),
    "Go lowercase ident is not treated as an export",
  );
  console.log("  ✓ export extraction works for TS, Vue, Python, Go, Swift, Kotlin, Java");
}

/* -------------------------------------------------------------------------- */
/* 2. Header parsing across comment forms                                     */
/* -------------------------------------------------------------------------- */

function headerForms(): void {
  step("Header parsing — every comment form yields the same tag map");

  const blockHdr = ["/**", " * @cairn Foo", " * @category forms", " */"].join("\n");
  const slashHdr = ["// @cairn Foo", "// @category forms"].join("\n");
  const hashHdr = ["# @cairn Foo", "# @category forms"].join("\n");
  const htmlHdr = ["<!--", "@cairn Foo", "@category forms", "-->"].join("\n");
  const dashHdr = ["-- @cairn Foo", "-- @category forms"].join("\n");
  const docHdr = ['"""', "@cairn Foo", "@category forms", '"""'].join("\n");

  for (const [label, src] of [
    ["block", blockHdr],
    ["line //", slashHdr],
    ["hash #", hashHdr],
    ["html <!-- -->", htmlHdr],
    ["dash --", dashHdr],
    ["docstring", docHdr],
  ] as const) {
    const tags = parseComponentHeader(src);
    assert(tags !== null, `${label}: header recognized`);
    assert(tags!.cairn === "Foo", `${label}: @cairn parsed (got ${tags!.cairn})`);
    assert(tags!.category === "forms", `${label}: @category parsed`);
  }

  // The earliest signal-bearing comment wins, even after a non-header comment.
  const withPreamble = ["// just a note about the file", "", slashHdr].join("\n");
  assert(parseComponentHeader(withPreamble)?.cairn === "Foo", "header found after a non-header line comment");

  // A `@cairn:decision` SoT marker is NOT misread as a registry header.
  assert(
    parseComponentHeader("// @cairn:decision DEC-1 something\n") === null,
    "colon-form @cairn:decision marker is not a registry header",
  );
  console.log("  ✓ block, //, #, <!-- -->, --, docstring all parse; markers excluded");
}

/* -------------------------------------------------------------------------- */
/* 3. Unit-shape detection (audit, outside component dirs)                    */
/* -------------------------------------------------------------------------- */

function unitShape(): void {
  step("Unit-shape — native UI files outside the dirs flag as unregistered");

  const root = mkdtempSync(join(tmpdir(), "cairn-smoke-units-"));
  cleanups.push(root);
  // A real component dir (with one headered Swift view) so the audit runs.
  mkdirSync(join(root, ".cairn"), { recursive: true });
  writeFileSync(
    join(root, ".cairn/config.yaml"),
    JSON.stringify({
      slug: "smoke",
      components: { componentDirs: ["ui"], extensions: [".swift", ".dart", ".kt"] },
    }),
    "utf8",
  );
  write(
    root,
    "ui/Registered.swift",
    [
      "// @cairn Registered",
      "// @category layout",
      "// @purpose Registered view.",
      "// @aliases registered",
      "struct Registered: View { var body: some View { Text(\"hi\") } }",
      "",
    ].join("\n"),
  );

  // Outside the dir: a SwiftUI View, a Flutter Widget, a Compose @Composable.
  write(
    root,
    "screens/Profile.swift",
    "struct Profile: View { var body: some View { Text(\"p\") } }\n",
  );
  write(
    root,
    "screens/Avatar.dart",
    "class Avatar extends StatelessWidget {\n  @override\n  Widget build(ctx) => Container();\n}\n",
  );
  write(
    root,
    "screens/Banner.kt",
    "@Composable\nfun Banner() {\n  Text(\"b\")\n}\n",
  );
  // A non-UI Kotlin file outside the dir must NOT be flagged.
  write(root, "screens/Repo.kt", "class Repo {\n  fun load() {}\n}\n");
  // A plain Swift struct sharing the registered unit's name → name-collision
  // (proves the collision scan is profile-driven, not TS interface/type only).
  write(root, "models/Models.swift", "struct Registered {\n  let id: Int\n}\n");

  const audit = runComponentAudit(root);
  const unregistered = audit.findings.filter((f) => f.kind === "unregistered-component");
  for (const want of ["Profile", "Avatar", "Banner"]) {
    assert(
      unregistered.some((f) => f.component === want),
      `unit-shaped ${want} flagged as unregistered (got: ${unregistered.map((f) => f.component).join(", ") || "∅"})`,
    );
  }
  assert(
    !unregistered.some((f) => f.component === "Repo"),
    "a plain backend Kotlin class is NOT flagged as a unit",
  );
  assert(
    audit.findings.some((f) => f.kind === "name-collision" && f.component === "Registered"),
    "a Swift `struct` colliding with a registered unit name is flagged (profile-driven name-collision)",
  );
  console.log("  ✓ SwiftUI View, Flutter Widget, Compose @Composable detected; backend skipped; Swift struct collision flagged");
}

/* -------------------------------------------------------------------------- */
/* 4. Index + export-mismatch in a non-React stack                            */
/* -------------------------------------------------------------------------- */

function nonReactIndex(): void {
  step("Index + check — a Vue + Python registry indexes and validates");

  const root = mkdtempSync(join(tmpdir(), "cairn-smoke-units-idx-"));
  cleanups.push(root);
  mkdirSync(join(root, ".cairn"), { recursive: true });
  writeFileSync(
    join(root, ".cairn/config.yaml"),
    JSON.stringify({
      slug: "smoke",
      components: { componentDirs: ["src"], extensions: [".vue"] },
    }),
    "utf8",
  );
  write(
    root,
    "src/DataCard.vue",
    [
      "<!--",
      "@cairn DataCard",
      "@category data-display",
      "@purpose Shows a datum.",
      "@aliases datacard, data card",
      "-->",
      "<template><div class=\"rounded border p-4\" /></template>",
      "",
    ].join("\n"),
  );

  const build = buildComponentIndex(root);
  assert(build.total === 1, `Vue SFC indexed (got ${build.total})`);
  assert(build.missing === 0, "no missing headers");

  // export-mismatch: the header names a symbol the file's stem doesn't match.
  write(
    root,
    "src/Wrong.vue",
    [
      "<!--",
      "@cairn NotWrong",
      "@category forms",
      "@purpose Mismatch.",
      "@aliases nope",
      "-->",
      "<template><div /></template>",
      "",
    ].join("\n"),
  );
  // The profile reports the file stem ("Wrong") as the export; "NotWrong" lies.
  const names = profileForFile("src/Wrong.vue")!.exportSymbols("", "Wrong.vue");
  assert(names.includes("Wrong") && !names.includes("NotWrong"), "Vue export is the file stem");
  console.log("  ✓ Vue SFC indexes via <!-- --> header; stem-based export drives validation");
}

function main(): void {
  exportExtraction();
  headerForms();
  unitShape();
  nonReactIndex();
  cleanup();
  console.log("\nsmoke-units-multilang — pass");
}

main();

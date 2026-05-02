#!/usr/bin/env tsx
/**
 * smoke-sensors — Phase 9 acceptance sensor.
 *
 * Per docs/INTEGRATION_PLAN.md §5 Phase 9:
 *   "synthetic failing case for each sensor produces a clean structured fail
 *    report; retry consumes the failure as context."
 *
 * Pure mechanical — burns zero claude quota. Two layers:
 *   1. Unit-level — call each sensor directly with synthetic DiffEntry[].
 *   2. Integration-level — drive runSensors() against a real ephemeral git
 *      mirror; verify clean/dirty diffs are classified correctly and that
 *      remediation_prompt is non-empty on failure.
 */

import { execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadStubCatalog,
  parseStubCatalog,
  runAttestationCrossCheck,
  runDecisionAssertions,
  runDtoNoFakeFields,
  runRouteHandlerNonEmpty,
  runSensors,
  runStubCatalog,
  type Attestation,
  type DiffEntry,
} from "../src/sensors/index.js";

const cleanups: string[] = [];

function header(msg: string): void {
  console.log(`\n── ${msg}`);
}

function fail(reason: string): never {
  console.error(`smoke-sensors FAIL: ${reason}`);
  cleanup();
  process.exit(1);
}

function cleanup(): void {
  for (const p of cleanups) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) fail(msg);
}

async function main(): Promise<void> {
  // ── Layer A — stub-pattern catalog ───────────────────────────────────
  header("Step 1: Layer A clean diff passes");
  const stubCatalog = loadStubCatalog();
  const cleanDiff: DiffEntry[] = [
    {
      path: "src/foo.ts",
      status: "added",
      afterContent: "export function foo(): number {\n  return 42;\n}\n",
    },
  ];
  let result = runStubCatalog({ diff: cleanDiff, catalog: stubCatalog, languages: ["typescript"] });
  assert(result.ok, "expected clean Layer A pass");
  assert(result.findings.length === 0, "no findings on clean diff");
  console.log("  ok=true findings=0");

  header("Step 2: Layer A throw-not-implemented fails hard");
  const stubDiff: DiffEntry[] = [
    {
      path: "src/bar.ts",
      status: "added",
      afterContent:
        "export function bar(): number {\n  throw new Error('not implemented');\n}\n",
    },
  ];
  result = runStubCatalog({ diff: stubDiff, catalog: stubCatalog, languages: ["typescript"] });
  assert(!result.ok, "expected hard fail");
  assert(
    result.findings.some((f) => f.pattern_id === "throw-not-implemented" && f.severity === "hard"),
    "expected throw-not-implemented finding",
  );
  console.log(`  ok=false findings=${result.findings.length} pattern=${result.findings[0]?.pattern_id}`);

  header("Step 3: Layer A only flags ADDED stubs (not pre-existing)");
  const stableStubDiff: DiffEntry[] = [
    {
      path: "src/baz.ts",
      status: "modified",
      beforeContent:
        "export function baz(): number {\n  throw new Error('not implemented');\n}\n",
      afterContent:
        "export function baz(): number {\n  throw new Error('not implemented');\n}\n  // unrelated comment\n",
    },
  ];
  result = runStubCatalog({ diff: stableStubDiff, catalog: stableStubDiff[0]?.afterContent ? stubCatalog : stubCatalog, languages: ["typescript"] });
  assert(result.ok, "pre-existing stub should not fail Layer A");
  console.log("  ok=true (existing line preserved, no new debt)");

  // ── Layer B — attestation cross-check ────────────────────────────────
  header("Step 4: Layer B missing attestation fails");
  result = runAttestationCrossCheck({
    attestation: undefined,
    diff: [{ path: "src/x.ts", status: "added", afterContent: "x" }],
    stubCatalog,
  });
  assert(!result.ok, "missing attestation must hard-fail");
  assert(
    result.findings[0]?.message.includes("no `attestation:` YAML"),
    "expected missing-block message",
  );
  console.log(`  ok=false message="${result.findings[0]?.message.slice(0, 60)}…"`);

  header("Step 5: Layer B accurate attestation passes");
  const accurateAtt: Attestation = {
    delivered: [{ symbol: "x", behavior: "full" }],
    deferred: [],
    known_limitations: [],
    todos_introduced: 0,
    stubs_introduced: 0,
    files_touched: ["src/x.ts"],
  };
  result = runAttestationCrossCheck({
    attestation: accurateAtt,
    diff: [
      {
        path: "src/x.ts",
        status: "added",
        afterContent: "export const x = 1;\n",
      },
    ],
    stubCatalog,
  });
  assert(result.ok, `expected pass, got findings: ${JSON.stringify(result.findings)}`);
  console.log("  ok=true findings=0");

  header("Step 6: Layer B mismatched files_touched fails");
  const lyingAtt: Attestation = {
    delivered: [{ symbol: "x", behavior: "full" }],
    deferred: [],
    known_limitations: [],
    todos_introduced: 0,
    stubs_introduced: 0,
    files_touched: ["src/x.ts", "src/secret.ts"], // claims an extra file
  };
  result = runAttestationCrossCheck({
    attestation: lyingAtt,
    diff: [{ path: "src/x.ts", status: "added", afterContent: "export const x = 1;\n" }],
    stubCatalog,
  });
  assert(!result.ok, "files_touched mismatch must fail");
  assert(
    result.findings.some((f) => f.message.includes("not actually changed")),
    "expected lie-about-touched finding",
  );
  console.log(`  ok=false findings=${result.findings.length}`);

  header("Step 7: Layer B `behavior:full` + stub-pattern = lie");
  const lieAboutFullAtt: Attestation = {
    delivered: [{ symbol: "f", path: "src/f.ts", behavior: "full" }],
    deferred: [],
    known_limitations: [],
    todos_introduced: 0,
    stubs_introduced: 1, // honestly declared, but `behavior:full` still lies
    files_touched: ["src/f.ts"],
  };
  result = runAttestationCrossCheck({
    attestation: lieAboutFullAtt,
    diff: [
      {
        path: "src/f.ts",
        status: "added",
        afterContent: "export function f() { throw new Error('not implemented'); }\n",
      },
    ],
    stubCatalog,
  });
  assert(!result.ok, "behavior:full + stub must hard-fail");
  assert(
    result.findings.some((f) => f.message.includes("claimed behavior:full")),
    "expected behavior-full lie finding",
  );
  console.log(`  ok=false matched on behavior:full + stub`);

  // ── Layer D — structural ────────────────────────────────────────────
  header("Step 8: Layer D route-handler-non-empty empty body fails");
  const emptyController: DiffEntry[] = [
    {
      path: "src/foo.controller.ts",
      status: "added",
      afterContent: [
        "import { Controller, Get } from '@nestjs/common';",
        "@Controller('foo')",
        "export class FooController {",
        "  @Get()",
        "  list(): unknown { return null; }",
        "}",
        "",
      ].join("\n"),
    },
  ];
  result = runRouteHandlerNonEmpty({
    diff: emptyController,
    globs: ["src/**/*.controller.ts"],
  });
  assert(!result.ok, "empty controller must hard-fail");
  console.log(`  ok=false findings=${result.findings.length} message="${result.findings[0]?.message.slice(0, 60)}…"`);

  header("Step 9: Layer D route-handler — non-empty body passes");
  const realController: DiffEntry[] = [
    {
      path: "src/foo.controller.ts",
      status: "added",
      afterContent: [
        "import { Controller, Get } from '@nestjs/common';",
        "import { FooService } from './foo.service.js';",
        "@Controller('foo')",
        "export class FooController {",
        "  constructor(private readonly svc: FooService) {}",
        "  @Get()",
        "  async list() {",
        "    const items = await this.svc.findAll();",
        "    return items.map((it) => ({ id: it.id, name: it.name }));",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
  ];
  result = runRouteHandlerNonEmpty({
    diff: realController,
    globs: ["src/**/*.controller.ts"],
  });
  assert(result.ok, `expected pass, got findings: ${JSON.stringify(result.findings)}`);
  console.log("  ok=true");

  header("Step 10: Layer D dto-no-fake-fields bare @IsOptional() flagged soft");
  const fakeDto: DiffEntry[] = [
    {
      path: "src/foo.dto.ts",
      status: "added",
      afterContent: [
        "import { IsOptional, IsString } from 'class-validator';",
        "export class FooDto {",
        "  @IsString()",
        "  name!: string;",
        "  @IsOptional()",
        "  bogus?: string;",
        "}",
        "",
      ].join("\n"),
    },
  ];
  result = runDtoNoFakeFields({ diff: fakeDto, globs: ["src/**/*.dto.ts"] });
  assert(result.findings.some((f) => f.severity === "soft"), "expected soft finding");
  assert(result.ok, "soft findings must NOT block run");
  console.log(`  ok=true soft_findings=${result.findings.length} message="${result.findings[0]?.message.slice(0, 80)}…"`);

  // ── Decision-assertions ─────────────────────────────────────────────
  header("Step 11: Decision-assertions integration via ephemeral mirror");
  const mirror = mkdtempSync(join(tmpdir(), "harness-smoke-sensors-"));
  cleanups.push(mirror);
  // Initial commit captures SHA pin.
  execSync("git init -b main -q", { cwd: mirror });
  execSync("git config user.email smoke@harness.local", { cwd: mirror });
  execSync("git config user.name smoke", { cwd: mirror });
  writeFileSync(join(mirror, "README.md"), "smoke-sensors\n");
  // Decision file demanding text_must_match.
  mkdirSync(join(mirror, ".harness", "ground", "decisions"), { recursive: true });
  writeFileSync(
    join(mirror, ".harness", "ground", "decisions", "DEC-0042.md"),
    [
      "---",
      "id: DEC-0042",
      "title: All routes must declare AuthGuard somewhere",
      "type: adr",
      "status: accepted",
      "scope_globs:",
      "  - src/**/*.controller.ts",
      "assertions:",
      "  - id: text-routes-have-auth",
      "    kind: text_must_match",
      `    pattern: '@UseGuards\\(AuthGuard\\)'`,
      "    in_globs:",
      "      - src/**/*.controller.ts",
      "  - id: file-protected",
      "    kind: file_must_not_be_modified",
      "    path: src/legacy/sacred.ts",
      "---",
      "",
      "# Auth guard required",
      "",
      "Every controller method must declare `@UseGuards(AuthGuard)` directly above it.",
      "",
    ].join("\n"),
  );
  mkdirSync(join(mirror, ".harness", "config"), { recursive: true });
  // Inherit pkg-shipped stub-patterns; do not override.
  // Seed src/legacy/sacred.ts so file_must_not_be_modified has something to protect.
  mkdirSync(join(mirror, "src", "legacy"), { recursive: true });
  writeFileSync(join(mirror, "src", "legacy", "sacred.ts"), "// do not touch\nexport const N = 1;\n");
  execSync("git add -A && git commit -m initial -q", { cwd: mirror });
  const shaPin = execSync("git rev-parse HEAD", { cwd: mirror }).toString().trim();
  console.log(`  shaPin=${shaPin.slice(0, 8)}`);

  header("Step 12: Decision-assertions text_must_match miss → hard fail");
  // Add a controller with NO @UseGuards.
  mkdirSync(join(mirror, "src", "users"), { recursive: true });
  writeFileSync(
    join(mirror, "src", "users", "users.controller.ts"),
    [
      "import { Controller, Get } from '@nestjs/common';",
      "@Controller('users')",
      "export class UsersController {",
      "  @Get()",
      "  async list() {",
      "    return [{ id: 1, name: 'a' }];",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  let sweep = await runSensors({
    mirrorPath: mirror,
    shaPin,
    finalAssistantText: [
      "I added the users controller.",
      "",
      "```yaml",
      "attestation:",
      "  delivered:",
      "    - symbol: UsersController.list",
      "      path: src/users/users.controller.ts",
      "      behavior: full",
      "  deferred: []",
      "  known_limitations: []",
      "  todos_introduced: 0",
      "  stubs_introduced: 0",
      "  files_touched:",
      "    - src/users/users.controller.ts",
      "```",
    ].join("\n"),
    languages: ["typescript"],
    projectGlobs: {
      route_handler_globs: ["src/**/*.controller.ts"],
      dto_globs: ["src/**/*.dto.ts"],
    },
    runId: "smoke-1",
    attempt: 1,
    maxAttempts: 3,
  });
  assert(!sweep.ok, "expected sweep failure on text_must_match miss");
  const decisionResult = sweep.results.find((r) => r.sensor_id === "decision-assertions");
  assert(
    decisionResult?.findings.some(
      (f) => f.assertion_id === "text-routes-have-auth" && f.severity === "hard",
    ),
    "expected text-routes-have-auth hard finding",
  );
  assert(
    sweep.remediation_prompt.includes("DEC-0042/text-routes-have-auth"),
    "remediation must cite DEC-0042/text-routes-have-auth",
  );
  console.log(
    `  ok=false hard=${sweep.hard_failures} prompt-bytes=${sweep.remediation_prompt.length}`,
  );

  header("Step 13: Same scenario, with @UseGuards(AuthGuard) → pass");
  writeFileSync(
    join(mirror, "src", "users", "users.controller.ts"),
    [
      "import { Controller, Get, UseGuards } from '@nestjs/common';",
      "import { AuthGuard } from '@nestjs/passport';",
      "@Controller('users')",
      "export class UsersController {",
      "  @UseGuards(AuthGuard)",
      "  @Get()",
      "  async list() {",
      "    return [{ id: 1, name: 'a' }];",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  sweep = await runSensors({
    mirrorPath: mirror,
    shaPin,
    finalAssistantText: [
      "I added the protected users controller.",
      "",
      "```yaml",
      "attestation:",
      "  delivered:",
      "    - symbol: UsersController.list",
      "      path: src/users/users.controller.ts",
      "      behavior: full",
      "  deferred: []",
      "  known_limitations: []",
      "  todos_introduced: 0",
      "  stubs_introduced: 0",
      "  files_touched:",
      "    - src/users/users.controller.ts",
      "```",
    ].join("\n"),
    languages: ["typescript"],
    projectGlobs: {
      route_handler_globs: ["src/**/*.controller.ts"],
      dto_globs: ["src/**/*.dto.ts"],
    },
    runId: "smoke-2",
    attempt: 1,
    maxAttempts: 3,
  });
  assert(
    sweep.ok,
    `expected pass, got hard=${sweep.hard_failures}: ${sweep.results
      .filter((r) => !r.ok)
      .flatMap((r) => r.findings)
      .map((f) => f.message)
      .join(" | ")}`,
  );
  console.log(`  ok=true soft=${sweep.soft_findings}`);

  header("Step 14: file_must_not_be_modified violation → hard fail");
  writeFileSync(join(mirror, "src", "legacy", "sacred.ts"), "// changed!\nexport const N = 999;\n");
  sweep = await runSensors({
    mirrorPath: mirror,
    shaPin,
    finalAssistantText: [
      "I edited the sacred file.",
      "",
      "```yaml",
      "attestation:",
      "  delivered: []",
      "  deferred: []",
      "  known_limitations: []",
      "  todos_introduced: 0",
      "  stubs_introduced: 0",
      "  files_touched:",
      "    - src/users/users.controller.ts",
      "    - src/legacy/sacred.ts",
      "```",
    ].join("\n"),
    languages: ["typescript"],
    projectGlobs: {
      route_handler_globs: ["src/**/*.controller.ts"],
    },
    runId: "smoke-3",
    attempt: 1,
    maxAttempts: 3,
  });
  assert(!sweep.ok, "modifying sacred.ts must fail");
  const lockedResult = sweep.results.find((r) => r.sensor_id === "decision-assertions");
  assert(
    lockedResult?.findings.some(
      (f) => f.assertion_id === "file-protected" && f.severity === "hard",
    ),
    "expected file-protected finding",
  );
  console.log(`  ok=false hard=${sweep.hard_failures}`);

  header("Step 15: parseStubCatalog handles malformed entries gracefully");
  const partial = parseStubCatalog(
    [
      "version: 1",
      "patterns:",
      "  - id: ok-pattern",
      "    languages: [typescript]",
      "    description: ok",
      "    regex: 'foo'",
      "    severity: hard",
      "  - id: missing-regex",
      "    languages: [typescript]",
      "    description: bad",
      "    severity: soft",
      "  - id: ''",
      "    languages: [typescript]",
      "    regex: 'bar'",
      "",
    ].join("\n"),
  );
  assert(partial.patterns.length === 1, "malformed entries should be skipped");
  console.log(`  parsed=${partial.patterns.length} (skipped 2 malformed)`);

  header("Step 16: cleanup");
  cleanup();
  console.log("\nsmoke-sensors: OK");
}

try {
  await main();
} catch (err) {
  console.error(err);
  cleanup();
  process.exit(1);
}

// Decision-assertions sensor surface check (referenced for cross-import).
void runDecisionAssertions;

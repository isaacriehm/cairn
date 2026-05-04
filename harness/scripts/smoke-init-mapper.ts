#!/usr/bin/env tsx
/**
 * smoke-init-mapper — §3.1 acceptance.
 *
 * Validates the init-mapper plumbing end-to-end without burning Sonnet
 * tokens. Six steps:
 *
 *   1. Walker on a synthetic TS+NestJS-ish repo (with .git) — uses
 *      `git ls-files`, surfaces top-level dirs, manifest previews,
 *      framework signals, notable dirs.
 *
 *   2. Walker on an empty no-git dir — falls back to filesystem walk,
 *      returns sane empty summary.
 *
 *   3. Walker depth + file caps — synthetic deep + wide tree triggers
 *      `truncated_at_depth_cap` and `truncated_at_file_cap`.
 *
 *   4. updateWorkflowSlugBlock — patches the `<slug>:` block in a copy
 *      of the shipped workflow.md template, asserts new keys land,
 *      off_limits dedupes, sibling keys + body preserved.
 *
 *   5. Mock-mapper integration — runInit with a canned MapperOutput
 *      injected; asserts config.yaml has project_globs filled, workflow.md
 *      slug block has all four glob keys, mapper_applied_to_* flags true.
 *
 *   6. Live mapper (opt-in via HARNESS_SMOKE_INIT_MAPPER_LIVE=1) —
 *      walks the harness repo itself, dispatches Sonnet, asserts shape.
 *      Skipped by default to avoid token burn in CI.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  buildRepoSummary,
  runInit,
  runMapper,
  updateWorkflowSlugBlock,
  type MapperOutput,
} from "../src/init/index.js";
import { templatesRoot } from "../src/init/seed.js";
import { detectAll } from "../src/init/detect.js";
import { claudeIsAvailable } from "../src/claude/runner.js";

const cleanups: string[] = [];

function header(msg: string): void {
  console.log(`\n── ${msg}`);
}

function fail(reason: string): never {
  console.error(`smoke-init-mapper FAIL: ${reason}`);
  cleanup();
  process.exit(1);
}

function cleanup(): void {
  for (const p of cleanups) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) fail(msg);
}

function makeNestRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-smoke-mapper-nest-"));
  cleanups.push(root);
  execSync("git init -q", { cwd: root });
  execSync('git config user.email smoke@example.com', { cwd: root });
  execSync('git config user.name "smoke"', { cwd: root });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "demo_nest_app",
        version: "0.0.0",
        scripts: { dev: "nest start --watch" },
        dependencies: {
          "@nestjs/core": "^10.0.0",
          "@nestjs/common": "^10.0.0",
          "drizzle-orm": "^0.30.0",
          zod: "^3.22.0",
        },
        devDependencies: { typescript: "^5.0.0" },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
  writeFileSync(
    join(root, "README.md"),
    "# demo_nest_app\n\nNestJS API for an example project.\n",
  );
  // Layout: core/src/contacts/{controllers,services,dto}, plus integrations.
  for (const sub of [
    "core/src/contacts/controllers",
    "core/src/contacts/services",
    "core/src/contacts/dto",
    "core/src/integrations/oauth",
    "core/src/integrations/dto",
    "core/db/schema",
    "apps/web/pages",
    "docs",
  ]) {
    mkdirSync(join(root, sub), { recursive: true });
  }
  writeFileSync(
    join(root, "core/src/contacts/controllers/contacts.controller.ts"),
    "// stub\nexport class ContactsController {}\n",
  );
  writeFileSync(
    join(root, "core/src/contacts/services/contacts.service.ts"),
    "// stub\nexport class ContactsService {}\n",
  );
  writeFileSync(
    join(root, "core/src/contacts/dto/create-contact.dto.ts"),
    "// stub\nexport class CreateContactDto {}\n",
  );
  writeFileSync(
    join(root, "core/src/integrations/oauth/oauth.controller.ts"),
    "export class OauthController {}\n",
  );
  writeFileSync(
    join(root, "core/db/schema/contacts.schema.ts"),
    "// drizzle\nexport const contacts = {};\n",
  );
  writeFileSync(
    join(root, "apps/web/pages/index.tsx"),
    "export default function Page() { return null; }\n",
  );
  writeFileSync(join(root, "docs/architecture.md"), "# arch\n");
  // Stage everything so git ls-files picks them up.
  execSync("git add -A", { cwd: root });
  return root;
}

function makeEmptyDir(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-smoke-mapper-empty-"));
  cleanups.push(root);
  return root;
}

function makeDeepRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-smoke-mapper-deep-"));
  cleanups.push(root);
  // Don't git init — exercise the fallback walker which honors caps directly.
  const deep = "a/b/c/d/e/f/g/h";
  mkdirSync(join(root, deep), { recursive: true });
  writeFileSync(join(root, deep, "deep.txt"), "deep");
  return root;
}

function makeWideRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-smoke-mapper-wide-"));
  cleanups.push(root);
  for (let i = 0; i < 20; i++) {
    writeFileSync(join(root, `${i}.txt`), "x");
  }
  return root;
}

function makeWorkflowMdCopy(): { path: string; root: string; original: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-smoke-mapper-wf-"));
  cleanups.push(root);
  const wfTemplate = readFileSync(
    join(templatesRoot(), ".harness/config/workflow.md"),
    "utf8",
  );
  // Apply the same placeholder substitution seed.ts performs.
  const wfText = wfTemplate
    .replace(/<project_name>:/g, "demo_app:")
    .replace(/`<project_name>`/g, "`demo_app`")
    .replace(/<project_name>/g, "demo_app");
  const wfPath = join(root, "workflow.md");
  writeFileSync(wfPath, wfText, "utf8");
  return { path: wfPath, root, original: wfText };
}

function cannedMapperOutput(): MapperOutput {
  return {
    pilot_module: "core/src/integrations/**",
    domain_summary:
      "demo_nest_app is a NestJS-based API with Drizzle ORM, Zod validation, and a thin web shell under apps/web. Two main domain areas: contacts and integrations.",
    key_modules: [
      {
        name: "contacts",
        path: "core/src/contacts",
        purpose: "CRUD and merge logic for contact records.",
      },
      {
        name: "integrations",
        path: "core/src/integrations",
        purpose: "OAuth integrations + token storage.",
      },
      {
        name: "schema",
        path: "core/db/schema",
        purpose: "Drizzle schema definitions for the operational DB.",
      },
    ],
    route_handler_globs: ["core/src/**/*.controller.ts"],
    dto_globs: ["core/src/**/*.dto.ts"],
    generator_source_globs: ["core/db/schema/**/*.ts"],
    high_stakes_globs: [
      "core/src/integrations/**",
      "core/src/contacts/**",
    ],
    off_limits_globs: ["core/db/migrations/**", "apps/web/pages/api/_generated/**"],
    proposed_sensors: [
      {
        id: "controller-needs-guard",
        description:
          "Every NestJS controller method must have an authorization guard decorator.",
        applies_to_globs: ["core/src/**/*.controller.ts"],
      },
    ],
    notes: "small monorepo; pilot scope kept narrow.",
  };
}

async function main(): Promise<void> {
  // ── Step 1: walker on synthetic NestJS-ish repo.
  header("Step 1: walker on git-initialized NestJS-ish repo");
  const nestRoot = makeNestRepo();
  const summary1 = buildRepoSummary({ repoRoot: nestRoot });
  console.log(
    `  files=${summary1.total_files} dirs=${summary1.total_dirs} top=[${summary1.top_level.join(", ")}] used_git=${summary1.used_git_ls_files}`,
  );
  console.log(
    `  manifests=${summary1.package_manifests.map((m) => m.path).join(", ")}`,
  );
  console.log(`  framework_signals=[${summary1.framework_signals.join(", ")}]`);
  console.log(`  notable_dirs=${summary1.notable_dir_paths.join(", ")}`);
  assert(summary1.used_git_ls_files === true, "expected git ls-files path");
  assert(summary1.total_files >= 7, `expected ≥7 files, got ${summary1.total_files}`);
  assert(
    summary1.top_level.includes("core") &&
      summary1.top_level.includes("apps") &&
      summary1.top_level.includes("docs"),
    `top_level missing expected entries: ${summary1.top_level.join(", ")}`,
  );
  assert(
    summary1.package_manifests.some((m) => m.path === "package.json"),
    "package.json manifest missing",
  );
  assert(
    summary1.framework_signals.includes("@nestjs/core"),
    `@nestjs/core not detected: ${summary1.framework_signals.join(",")}`,
  );
  assert(
    summary1.framework_signals.includes("drizzle-orm"),
    `drizzle-orm not detected: ${summary1.framework_signals.join(",")}`,
  );
  assert(
    summary1.framework_signals.includes("zod"),
    `zod not detected: ${summary1.framework_signals.join(",")}`,
  );
  assert(
    summary1.notable_dir_paths.some((d) => d === "core/src/contacts/controllers"),
    `controllers dir not flagged notable: ${summary1.notable_dir_paths.join(",")}`,
  );
  assert(
    summary1.notable_dir_paths.some((d) => d.endsWith("dto")),
    "dto dir not flagged notable",
  );
  assert(
    summary1.notable_files.includes("README.md"),
    "README.md not flagged notable",
  );
  assert(
    summary1.notable_files.includes("tsconfig.json"),
    "tsconfig.json not flagged notable",
  );

  // ── Step 2: walker on empty no-git dir.
  header("Step 2: walker on empty no-git directory");
  const emptyRoot = makeEmptyDir();
  const summary2 = buildRepoSummary({ repoRoot: emptyRoot });
  console.log(
    `  files=${summary2.total_files} dirs=${summary2.total_dirs} used_git=${summary2.used_git_ls_files}`,
  );
  assert(summary2.used_git_ls_files === false, "expected fallback walker on no-git dir");
  assert(summary2.total_files === 0, `expected 0 files, got ${summary2.total_files}`);

  // ── Step 3a: depth-cap trigger on deep tree.
  header("Step 3a: depth-cap triggers truncated_at_depth_cap");
  const deepRoot = makeDeepRepo();
  const summary3a = buildRepoSummary({
    repoRoot: deepRoot,
    depthCap: 3,
    fileCap: 100,
  });
  console.log(
    `  files=${summary3a.total_files} truncated_depth=${summary3a.truncated_at_depth_cap}`,
  );
  assert(
    summary3a.truncated_at_depth_cap === true,
    "expected truncated_at_depth_cap=true on deep tree",
  );

  // ── Step 3b: file-cap trigger on wide tree.
  header("Step 3b: file-cap triggers truncated_at_file_cap");
  const wideRoot = makeWideRepo();
  const summary3b = buildRepoSummary({
    repoRoot: wideRoot,
    depthCap: 5,
    fileCap: 5,
  });
  console.log(
    `  files=${summary3b.total_files} truncated_file=${summary3b.truncated_at_file_cap}`,
  );
  assert(
    summary3b.truncated_at_file_cap === true,
    "expected truncated_at_file_cap=true on wide tree",
  );
  assert(
    summary3b.total_files <= 5,
    `file cap not enforced (got ${summary3b.total_files})`,
  );

  // ── Step 4: workflow-block writer.
  header("Step 4: updateWorkflowSlugBlock patches `demo_app:` block");
  const wf = makeWorkflowMdCopy();
  const result4 = updateWorkflowSlugBlock({
    workflowMdPath: wf.path,
    slug: "demo_app",
    update: {
      pilot_module: "core/src/integrations/**",
      route_handler_globs: ["core/src/**/*.controller.ts"],
      dto_globs: ["core/src/**/*.dto.ts"],
      generator_source_globs: ["core/db/schema/**/*.ts"],
      high_stakes_globs: ["core/src/integrations/**"],
      off_limits_append: [
        ".git/**", // duplicate (already in template)
        "core/db/migrations/**", // new
        "core/db/migrations/**", // dupe within batch
      ],
    },
  });
  console.log(
    `  applied=[${result4.applied_keys.join(", ")}] off_limits_added=[${result4.off_limits_added.join(", ")}]`,
  );
  assert(
    result4.applied_keys.includes("pilot_module") &&
      result4.applied_keys.includes("route_handler_globs") &&
      result4.applied_keys.includes("dto_globs") &&
      result4.applied_keys.includes("generator_source_globs") &&
      result4.applied_keys.includes("high_stakes_globs") &&
      result4.applied_keys.includes("off_limits"),
    `applied_keys missing entries: ${result4.applied_keys.join(",")}`,
  );
  assert(
    result4.off_limits_added.length === 1 &&
      result4.off_limits_added[0] === "core/db/migrations/**",
    `off_limits_added expected exactly the new entry, got: ${JSON.stringify(result4.off_limits_added)}`,
  );
  const patched = readFileSync(wf.path, "utf8");
  // Body preserved.
  assert(
    patched.includes("# Per-task prompt template"),
    "markdown body lost after slug-block update",
  );
  // Top-level keys preserved.
  assert(
    /^collaboration_mode: solo\b/m.test(patched),
    "collaboration_mode key lost from frontmatter",
  );
  // Frontmatter parses cleanly + slug block has the new shape.
  const fmEnd = patched.indexOf("\n---", 4);
  assert(fmEnd > 0, "missing closing --- after frontmatter");
  const fmText = patched.slice(4, fmEnd);
  const fm = parseYaml(fmText) as Record<string, unknown>;
  const slugBlock = fm["demo_app"] as Record<string, unknown>;
  assert(slugBlock !== undefined, "demo_app: block missing after patch");
  assert(
    slugBlock["pilot_module"] === "core/src/integrations/**",
    `pilot_module mismatch: ${JSON.stringify(slugBlock["pilot_module"])}`,
  );
  assert(
    Array.isArray(slugBlock["route_handler_globs"]) &&
      (slugBlock["route_handler_globs"] as string[])[0] ===
        "core/src/**/*.controller.ts",
    `route_handler_globs mismatch: ${JSON.stringify(slugBlock["route_handler_globs"])}`,
  );
  const offLimits = slugBlock["off_limits"] as string[];
  assert(Array.isArray(offLimits), "off_limits not an array");
  assert(
    offLimits.includes(".git/**") && offLimits.includes("core/db/migrations/**"),
    `off_limits missing expected entries: ${offLimits.join(",")}`,
  );
  // Original entries preserved.
  assert(
    offLimits.includes("node_modules/**"),
    "off_limits dropped pre-existing node_modules/** entry",
  );

  // ── Step 5: mock-mapper integration via runInit.
  header("Step 5: runInit with mockMapperOutput → config.yaml + workflow.md filled");
  const intRoot = makeNestRepo();
  const mockOutput = cannedMapperOutput();
  const initResult = await runInit({
    repoRoot: intRoot,
    mode: "auto",
    skipMirror: true,
    skipGuidedSetup: true,
    autoProceed: "a",
    autoE2e: "skip",
    mockMapperOutput: mockOutput,
  });
  console.log(
    `  proceed=${initResult.proceed} mapper_applied_workflow=${initResult.mapper_applied_to_workflow} mapper_applied_config=${initResult.mapper_applied_to_config}`,
  );
  assert(initResult.proceed === true, "expected proceed=true");
  assert(
    initResult.mapper_output !== null,
    "mapper_output null in result",
  );
  assert(
    initResult.mapper_applied_to_workflow === true,
    "mapper_applied_to_workflow expected true",
  );
  assert(
    initResult.mapper_applied_to_config === true,
    "mapper_applied_to_config expected true",
  );
  // config.yaml has project_globs filled from mapper.
  const configText = readFileSync(join(intRoot, ".harness/config.yaml"), "utf8");
  const config = parseYaml(configText) as Record<string, unknown>;
  const projectGlobs = config["project_globs"] as Record<string, string[]>;
  assert(
    projectGlobs["route_handler_globs"][0] === "core/src/**/*.controller.ts",
    `config.project_globs.route_handler_globs mismatch: ${JSON.stringify(projectGlobs["route_handler_globs"])}`,
  );
  assert(
    (config["high_stakes_globs"] as string[]).includes("core/src/integrations/**"),
    "config.high_stakes_globs missing mapper entry",
  );
  assert(
    config["pilot_module"] === "core/src/integrations/**",
    `config.pilot_module mismatch: ${JSON.stringify(config["pilot_module"])}`,
  );
  assert(
    Array.isArray(config["key_modules"]) &&
      (config["key_modules"] as Array<{ name: string }>).length === 3,
    "config.key_modules not propagated",
  );
  assert(
    typeof config["domain_summary"] === "string",
    "config.domain_summary missing",
  );
  // workflow.md slug block has all four glob keys.
  const wfText = readFileSync(
    join(intRoot, ".harness/config/workflow.md"),
    "utf8",
  );
  const wfFmEnd = wfText.indexOf("\n---", 4);
  const wfFm = parseYaml(wfText.slice(4, wfFmEnd)) as Record<string, unknown>;
  const wfSlug = wfFm["demo_nest_app"] as Record<string, unknown>;
  assert(
    wfSlug !== undefined,
    `workflow.md missing demo_nest_app: block; keys=${Object.keys(wfFm).join(",")}`,
  );
  assert(
    wfSlug["pilot_module"] === "core/src/integrations/**",
    `wf slug pilot_module mismatch: ${JSON.stringify(wfSlug["pilot_module"])}`,
  );
  for (const k of [
    "route_handler_globs",
    "dto_globs",
    "generator_source_globs",
    "high_stakes_globs",
  ]) {
    assert(
      Array.isArray(wfSlug[k]) && (wfSlug[k] as string[]).length > 0,
      `wf slug ${k} missing or empty`,
    );
  }
  // off_limits in wf slug includes both template entries and mapper additions.
  const wfOffLimits = wfSlug["off_limits"] as string[];
  assert(
    wfOffLimits.includes("node_modules/**") &&
      wfOffLimits.includes("core/db/migrations/**"),
    `wf off_limits missing expected entries: ${wfOffLimits.join(",")}`,
  );

  // ── Step 6: live mapper (opt-in).
  if (process.env["HARNESS_SMOKE_INIT_MAPPER_LIVE"] === "1") {
    header("Step 6: live mapper dispatch (HARNESS_SMOKE_INIT_MAPPER_LIVE=1)");
    if (!claudeIsAvailable()) {
      console.log("  skipped — claude CLI not available");
    } else {
      const repoRoot = join(import.meta.dirname, "..");
      const detection = await detectAll(repoRoot);
      const summary = buildRepoSummary({ repoRoot });
      console.log(
        `  walked harness repo: ${summary.total_files} files, ${summary.framework_signals.length} framework signals`,
      );
      const r = await runMapper({ detection, summary });
      console.log(
        `  mapper returned: pilot=${r.output.pilot_module} | route_globs=${r.output.route_handler_globs.length} | dto_globs=${r.output.dto_globs.length}`,
      );
      console.log(
        `  duration=${(r.duration_ms / 1000).toFixed(1)}s tokens in=${r.usage?.input_tokens} out=${r.usage?.output_tokens}`,
      );
      assert(r.output.pilot_module.length > 0, "live mapper returned empty pilot_module");
      assert(typeof r.output.domain_summary === "string", "live mapper missing domain_summary");
    }
  } else {
    console.log("\n(step 6 live mapper skipped — set HARNESS_SMOKE_INIT_MAPPER_LIVE=1 to enable)");
  }

  header("Cleanup");
  cleanup();
  console.log("\nsmoke-init-mapper: OK");
}

main().catch((err) => {
  console.error("smoke-init-mapper threw:", err);
  cleanup();
  process.exit(1);
});

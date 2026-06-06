#!/usr/bin/env tsx
/**
 * smoke-init — Phase 16 acceptance.
 *
 * Synthetic project tree (git init + minimal package.json + tsconfig +
 * .eslintrc) → run `runInit` in auto mode → assert .cairn/ seeded
 * with project_name placeholder substituted, .cairn/config.yaml
 * carries detected stack + sensors, mirror init skipped (no remote in
 * smoke). Pure mechanical, no claude burn.
 *
 * Steps:
 *   1. Detection on a TS+ESLint repo flags both sensors.
 *   2. Detection on an empty repo returns stack=[unknown] + 0 sensors.
 *   3. runInit with --no-prompt + --skip-mirror seeds templates,
 *      writes config.yaml, picks defer for E2E, exits proceed=true.
 *   4. workflow.md placeholder substitution: `<project_name>:` →
 *      `<slug>:`. config.yaml has e2e_setup: defer.
 *   5. Re-running without --force preserves existing files (collisions
 *      reported, no overwrite).
 *   6. Slug override flag wins over auto-derived slug.
 *   7. PHASE_6_REDESIGN §4.9 cold-start CLI summary lands a 4-line
 *      terse block — `Adopted <slug> in <duration>.`, three counter
 *      bullets, and the `cairn attention` follow-up — and never the
 *      legacy verbose discovery dump (no "Mirror init", "Adoption
 *      audit", or per-section breakdown lines).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import {
  detectAll,
  detectAvailableSensors,
  detectStackSignatures,
  runInit,
} from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function header(msg: string): void {
  console.log(`\n── ${msg}`);
}

function fail(reason: string): never {
  console.error(`smoke-init FAIL: ${reason}`);
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

function makeTsRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cairn-smoke-init-"));
  cleanups.push(root);
  execSync("git init -q", { cwd: root });
  execSync('git config user.email smoke@example.com', { cwd: root });
  execSync('git config user.name "smoke"', { cwd: root });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      { name: "demo_app", version: "0.0.0", scripts: { dev: "vite" } },
      null,
      2,
    ),
  );
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
  writeFileSync(join(root, ".eslintrc.json"), JSON.stringify({ root: true }));
  return root;
}

async function main(): Promise<void> {
  // ── Step 1: detection on TS+ESLint repo.
  header("Step 1: detect TS + ESLint signals");
  const root1 = makeTsRepo();
  const det1 = detectAll({ repoRoot: root1 });
  console.log(
    `  slug=${det1.project_slug} stacks=[${det1.stack_signatures.map((s) => s.kind).join(", ")}] sensors=[${det1.proposed_sensors.map((s) => s.id).join(", ")}]`,
  );
  assert(det1.project_slug === "demo_app", `expected demo_app slug, got ${det1.project_slug}`);
  assert(
    det1.stack_signatures.find((s) => s.kind === "typescript") !== undefined,
    "typescript signature missing",
  );
  const sensorIds1 = det1.proposed_sensors.map((s) => s.id);
  assert(sensorIds1.includes("tsc"), `tsc not proposed: ${sensorIds1.join(",")}`);
  assert(sensorIds1.includes("eslint"), `eslint not proposed: ${sensorIds1.join(",")}`);
  assert(det1.start_command !== null, "start_command not detected on package.json scripts.dev");
  assert(
    det1.start_command!.command === "pnpm",
    `start_command should use pnpm, got ${det1.start_command!.command}`,
  );

  // ── Step 2: empty repo flags unknown stack.
  header("Step 2: empty repo → stack=[unknown], 0 sensors");
  const root2 = mkdtempSync(join(tmpdir(), "cairn-smoke-init-empty-"));
  cleanups.push(root2);
  execSync("git init -q", { cwd: root2 });
  const sigs2 = detectStackSignatures(root2);
  const sensors2 = detectAvailableSensors({ repoRoot: root2, signatures: sigs2 });
  console.log(
    `  stacks=[${sigs2.map((s) => s.kind).join(", ")}] sensors=${sensors2.length}`,
  );
  assert(
    sigs2.length === 1 && sigs2[0]!.kind === "unknown",
    `expected unknown stack, got ${sigs2.map((s) => s.kind).join(",")}`,
  );
  assert(sensors2.length === 0, `expected 0 sensors on empty repo, got ${sensors2.length}`);

  // ── Step 3: runInit auto-mode seeds layout.
  header("Step 3: runInit --no-prompt seeds .cairn/");
  const result3 = await runInit({
    repoRoot: root1,
    mode: "auto",
    autoProceed: "a",
  });
  assert(result3.proceed === true, "expected proceed=true");
  assert(result3.seeded_files.length > 0, "no files seeded");
  for (const p of [
    ".cairn/config/workflow.md",
    ".cairn/config/sensors.yaml",
    ".cairn/config/stub-patterns.yaml",
    ".cairn/config/trust-policy.yaml",
    ".cairn/ground/manifest.yaml",
    ".cairn/ground/canonical-map/topics.yaml",
    ".cairn/config.yaml",
  ]) {
    assert(existsSync(join(root1, p)), `expected file ${p}`);
  }
  console.log(`  seeded ${result3.seeded_files.length} files; collisions=${result3.collisions.length}`);

  // ── Step 4: placeholder substitution + cairn_version pinned.
  header("Step 4: workflow.md `<project_name>:` → `demo_app:`; config.yaml has cairn_version");
  const wfText = readFileSync(join(root1, ".cairn/config/workflow.md"), "utf8");
  assert(
    wfText.includes("demo_app:"),
    "workflow.md should contain demo_app: extension block key",
  );
  assert(
    !/<project_name>:/.test(wfText),
    "workflow.md should not contain unresolved <project_name>: placeholder",
  );
  const configText = readFileSync(join(root1, ".cairn/config.yaml"), "utf8");
  const configParsed = parseYaml(configText) as Record<string, unknown>;
  assert(configParsed["slug"] === "demo_app", `config.slug mismatch: ${JSON.stringify(configParsed["slug"])}`);
  assert(
    typeof configParsed["cairn_version"] === "string" && (configParsed["cairn_version"] as string).length > 0,
    `config.cairn_version missing or empty: ${JSON.stringify(configParsed["cairn_version"])}`,
  );
  assert(
    Array.isArray(configParsed["stack_signatures"]) &&
      (configParsed["stack_signatures"] as string[]).includes("typescript"),
    "config.stack_signatures missing typescript",
  );
  assert(
    Array.isArray(configParsed["detected_sensor_commands"]) &&
      (configParsed["detected_sensor_commands"] as Array<{ id: string }>).some(
        (s) => s.id === "tsc",
      ),
    "config.detected_sensor_commands missing tsc",
  );
  console.log(`  slug=${configParsed["slug"]}, cairn_version=${configParsed["cairn_version"]}, stack=[${(configParsed["stack_signatures"] as string[]).join(", ")}]`);

  // ── Step 5: re-run without --force preserves existing.
  header("Step 5: re-run without --force → collisions, no overwrite");
  const before = readFileSync(join(root1, ".cairn/config/workflow.md"), "utf8");
  const result5 = await runInit({
    repoRoot: root1,
    mode: "auto",
    autoProceed: "a",
  });
  const after = readFileSync(join(root1, ".cairn/config/workflow.md"), "utf8");
  assert(before === after, "workflow.md should be unchanged on re-run without --force");
  assert(result5.collisions.length > 0, "expected collisions on re-run");
  console.log(`  collisions=${result5.collisions.length}`);

  // ── Step 6: slug override.
  header("Step 6: --slug override wins over package.json name");
  const root6 = makeTsRepo();
  const result6 = await runInit({
    repoRoot: root6,
    mode: "auto",
    slugOverride: "custom-slug",
    autoProceed: "a",
  });
  assert(result6.decided_slug === "custom_slug", `decided_slug mismatch: ${result6.decided_slug}`);
  const wf6 = readFileSync(join(root6, ".cairn/config/workflow.md"), "utf8");
  assert(wf6.includes("custom_slug:"), "workflow.md should reflect override slug");
  console.log(`  slug override propagated to workflow.md`);

  // ── Step 7: cold-start CLI summary (PHASE_6_REDESIGN §4.9).
  header("Step 7: cold-start summary is the locked 4-line block");
  const root7 = makeTsRepo();
  const captured: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === "string") captured.push(chunk);
    else if (chunk instanceof Uint8Array) captured.push(Buffer.from(chunk).toString("utf8"));
    return origWrite(chunk as never, ...(rest as never[]));
  }) as typeof process.stdout.write;
  try {
    await runInit({ repoRoot: root7, mode: "auto", autoProceed: "a" });
  } finally {
    process.stdout.write = origWrite;
  }
  const stdout = captured.join("");

  assert(
    /Adopted demo_app in \d+(?:\.\d+)?(?:ms|s)\b/.test(stdout) ||
      /Adopted demo_app in \d+m \d+s\b/.test(stdout),
    `Step 7: missing "Adopted <slug> in <duration>." — got:\n${stdout}`,
  );
  assert(
    /- \d+ active rules baseline verified\./.test(stdout),
    `Step 7: missing "<N> active rules baseline verified." line`,
  );
  assert(
    /- \d+ new decision drafts found\./.test(stdout),
    `Step 7: missing "<M> new decision drafts found." line`,
  );
  assert(
    /- \d+ unpromoted candidates indexed\./.test(stdout),
    `Step 7: missing "<K> unpromoted candidates indexed." line`,
  );
  assert(
    /Run `cairn attention` to review drafts and commit them to the ledger\./.test(stdout),
    `Step 7: missing follow-up "Run \`cairn attention\`…" line`,
  );

  // Negative checks — none of the legacy verbose-completion artifacts
  // should leak through. These were the headers / labels the old
  // printCompletionSummary emitted; the new locked format strips them.
  for (const phrase of [
    "Adoption audit",
    "Discovery summary",
    "Ground state seeded",
    "Sensors registered",
    "Canonical map",
    "First-session onboarding",
  ]) {
    assert(
      !stdout.includes(phrase),
      `Step 7: legacy summary phrase "${phrase}" leaked into cold-start output`,
    );
  }
  console.log("  ✓ cold-start summary matches §4.9 4-line contract");

  header("Cleanup");
  cleanup();
  console.log("\nsmoke-init: OK");
}

main().catch((err) => {
  console.error("smoke-init threw:", err);
  cleanup();
  process.exit(1);
});

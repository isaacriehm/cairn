#!/usr/bin/env tsx
/** smoke-model-runner — real subprocess contract with fake provider CLIs */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  configureModelProvider,
  ModelRunnerError,
  modelRunnerIsAvailable,
  resolveModelProvider,
  runModel,
  type ModelProvider,
} from "@isaacriehm/cairn-core";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`✗ ${message}`);
    process.exit(1);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(actualJson === expectedJson, `${message}\n  expected: ${expectedJson}\n  actual:   ${actualJson}`);
}

interface InvocationLog {
  provider: ModelProvider;
  args: string[];
  stdin: string;
  schemaPath: string | null;
  schemaExisted: boolean;
  cwd: string;
  cursorPolicyExisted: boolean;
}

const root = mkdtempSync(join(tmpdir(), "cairn-model-runner-"));
const binDir = join(root, "bin");
const logPath = join(root, "invocations.jsonl");
const repoRoot = join(root, "repo");

const fakeCli = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const provider = basename(process.argv[1]).startsWith("cursor") ? "cursor" : basename(process.argv[1]);
const args = process.argv.slice(2);
if (args.includes("--version") || args[0] === "--version") {
  process.stdout.write(provider + "-fake 1.0.0\\n");
  process.exit(0);
}
const stdin = readFileSync(0, "utf8");
const schemaFlag = args.indexOf("--output-schema");
const schemaPath = schemaFlag >= 0 ? args[schemaFlag + 1] : null;
appendFileSync(process.env.FAKE_MODEL_LOG, JSON.stringify({
  provider,
  args,
  stdin,
  schemaPath,
  schemaExisted: schemaPath !== null && existsSync(schemaPath),
  cwd: process.cwd(),
  cursorPolicyExisted: existsSync(join(process.cwd(), ".cursor", "cli.json")),
}) + "\\n");
const delay = Number(process.env.FAKE_MODEL_SLEEP_MS || "0");
const emit = () => {
  const invalid = process.env.FAKE_MODEL_INVALID === "1";
  const value = invalid ? { label: 42 } : { label: provider };
  if (provider === "claude") {
    process.stdout.write(JSON.stringify({
      result: JSON.stringify(value),
      structured_output: value,
      usage: { input_tokens: 5, output_tokens: 2 },
    }) + "\\n");
  } else if (provider === "cursor") {
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 7,
      result: JSON.stringify(value),
      session_id: "fake-session",
    }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify(value) + "\\n");
  }
};
if (delay > 0) setTimeout(emit, delay);
else emit();
`;

function installFake(name: string, targetDir = binDir): void {
  const path = join(targetDir, name);
  writeFileSync(path, fakeCli, "utf8");
  chmodSync(path, 0o755);
}

function readLogs(): InvocationLog[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as InvocationLog);
}

const schema = {
  type: "object",
  required: ["label"],
  properties: { label: { type: "string" } },
  additionalProperties: false,
} as const;

const originalPath = process.env.PATH;
const originalLog = process.env.FAKE_MODEL_LOG;
const originalInvalid = process.env.FAKE_MODEL_INVALID;
const originalSleep = process.env.FAKE_MODEL_SLEEP_MS;

try {
  spawnSync("mkdir", ["-p", binDir, repoRoot], { stdio: "inherit" });
  installFake("claude");
  installFake("codex");
  installFake("cursor-agent");
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
  process.env.FAKE_MODEL_LOG = logPath;

  console.log("smoke-model-runner — start");

  for (const provider of ["claude", "codex", "cursor"] as const) {
    assert(modelRunnerIsAvailable(provider), `${provider} fake executable available`);
    assert(resolveModelProvider(provider) === provider, `${provider} explicit selection`);
  }
  configureModelProvider("codex");
  assert(resolveModelProvider() === "codex", "process provider override");
  configureModelProvider(null);
  console.log("  ✓ provider availability and explicit selection");

  const claudeOnlyBin = join(root, "claude-only-bin");
  spawnSync("mkdir", ["-p", claudeOnlyBin], { stdio: "inherit" });
  installFake("claude", claudeOnlyBin);
  symlinkSync(process.execPath, join(claudeOnlyBin, "node"));
  process.env.PATH = claudeOnlyBin;
  configureModelProvider("codex");
  assert(
    !modelRunnerIsAvailable(),
    "effective availability is false when configured provider is missing",
  );
  configureModelProvider(null);
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
  console.log("  ✓ configured provider controls effective availability");

  for (const provider of ["claude", "codex", "cursor"] as const) {
    const result = await runModel({
      provider,
      tier: provider === "claude" ? "fast" : "capable",
      prompt: "classify",
      system: "Return the label.",
      jsonSchema: schema,
      cwd: repoRoot,
      timeoutMs: 2_000,
      isolateAmbientContext: true,
    });
    assert(result.provider === provider, `${provider} result provider`);
    assertDeepEqual(result.parsed, { label: provider }, `${provider} structured output`);
  }

  await runModel({
    provider: "claude",
    tier: "capable",
    prompt: "map",
    jsonSchema: schema,
    cwd: repoRoot,
  });

  const invocationLogs = readLogs();
  const claudeLog = invocationLogs.find(
    (entry) => entry.provider === "claude" && entry.args.includes("haiku"),
  );
  const claudeCapableLog = invocationLogs.find(
    (entry) => entry.provider === "claude" && entry.args.includes("sonnet"),
  );
  const codexLog = invocationLogs.find((entry) => entry.provider === "codex");
  const cursorLog = invocationLogs.find((entry) => entry.provider === "cursor");
  assert(claudeLog?.args.includes("haiku"), "Claude fast tier maps to haiku");
  assert(claudeCapableLog?.args.includes("sonnet"), "Claude capable tier maps to sonnet");
  assert(claudeLog?.args.includes("--no-session-persistence"), "Claude session persistence disabled");

  assert(codexLog?.args[0] === "exec", "Codex uses exec");
  assert(codexLog.args.includes("--ephemeral"), "Codex session is ephemeral");
  assert(codexLog.args.includes("read-only"), "Codex sandbox is read-only");
  assert(codexLog.args.includes("--ignore-user-config"), "Codex user config ignored");
  assert(codexLog.args.includes("--output-schema"), "Codex receives output schema");
  assert(codexLog.args.includes("gpt-5.3-codex-spark"), "Codex pins Spark");
  assert(
    codexLog.args.some((arg) => arg.startsWith("developer_instructions=")),
    "Codex receives developer instructions",
  );
  assert(codexLog.schemaExisted, "Codex schema exists while subprocess runs");
  assert(codexLog.schemaPath !== null && !existsSync(codexLog.schemaPath), "Codex schema cleaned");

  assert(cursorLog?.args.includes("--print"), "Cursor uses print mode");
  assert(cursorLog?.args.includes("json"), "Cursor requests JSON envelope");
  assert(cursorLog?.args.includes("auto"), "Cursor uses auto model alias");
  assert(!cursorLog?.args.includes("--force"), "Cursor never receives --force");
  assert(cursorLog?.stdin.includes("Do not use tools"), "Cursor prompt prohibits tools");
  assert(cursorLog?.stdin.includes("Return the label."), "Cursor prompt carries system instructions");
  assert(cursorLog?.stdin.includes('"label"'), "Cursor prompt carries the output schema");
  assert(cursorLog?.cursorPolicyExisted, "Cursor receives a deny-all tool policy");
  assert(!existsSync(cursorLog?.cwd ?? ""), "Cursor isolated working directory is cleaned");

  await runModel({
    provider: "cursor",
    tier: "fast",
    prompt: "classify without caller isolation",
    jsonSchema: schema,
    cwd: repoRoot,
    timeoutMs: 2_000,
  });
  const implicitCursorLog = readLogs().at(-1);
  assert(implicitCursorLog?.provider === "cursor", "implicit isolation call uses Cursor");
  assert(
    implicitCursorLog.cursorPolicyExisted,
    "Cursor receives deny-all policy when caller omits isolation",
  );
  assert(
    implicitCursorLog.cwd !== repoRoot,
    "Cursor never runs directly in the caller's repository",
  );
  assert(
    !existsSync(implicitCursorLog.cwd),
    "implicitly isolated Cursor working directory is cleaned",
  );
  console.log("  ✓ native provider invocations and decoding");

  process.env.FAKE_MODEL_INVALID = "1";
  let invalidError: unknown;
  try {
    await runModel({
      provider: "cursor",
      tier: "fast",
      prompt: "invalid",
      jsonSchema: schema,
      cwd: repoRoot,
    });
  } catch (err) {
    invalidError = err;
  }
  assert(invalidError instanceof ModelRunnerError, "invalid schema raises ModelRunnerError");
  assert(invalidError.kind === "invalid_output", "invalid schema error kind");
  assert(invalidError.provider === "cursor", "invalid schema error provider");
  delete process.env.FAKE_MODEL_INVALID;
  console.log("  ✓ shared structured-output validation");

  const beforeCache = readLogs().length;
  const common = {
    tier: "fast" as const,
    prompt: "cache-isolation",
    jsonSchema: schema,
    repoRoot,
    cacheable: true,
  };
  await runModel({ ...common, provider: "claude" });
  await runModel({ ...common, provider: "codex" });
  const afterProviders = readLogs().length;
  await runModel({ ...common, provider: "claude" });
  const afterHit = readLogs().length;
  assert(afterProviders === beforeCache + 2, "providers do not share cache entries");
  assert(afterHit === afterProviders, "same provider reuses cache entry");
  console.log("  ✓ provider-isolated cache");

  process.env.FAKE_MODEL_SLEEP_MS = "250";
  let timeoutError: unknown;
  try {
    await runModel({
      provider: "codex",
      tier: "fast",
      prompt: "timeout",
      timeoutMs: 20,
    });
  } catch (err) {
    timeoutError = err;
  }
  assert(timeoutError instanceof ModelRunnerError, "timeout raises ModelRunnerError");
  assert(timeoutError.kind === "timeout", "timeout error kind");
  assert(timeoutError.provider === "codex", "timeout error provider");
  console.log("  ✓ shared timeout path");

  console.log("smoke-model-runner — PASS");
} finally {
  configureModelProvider(null);
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalLog === undefined) delete process.env.FAKE_MODEL_LOG;
  else process.env.FAKE_MODEL_LOG = originalLog;
  if (originalInvalid === undefined) delete process.env.FAKE_MODEL_INVALID;
  else process.env.FAKE_MODEL_INVALID = originalInvalid;
  if (originalSleep === undefined) delete process.env.FAKE_MODEL_SLEEP_MS;
  else process.env.FAKE_MODEL_SLEEP_MS = originalSleep;
  rmSync(root, { recursive: true, force: true });
}

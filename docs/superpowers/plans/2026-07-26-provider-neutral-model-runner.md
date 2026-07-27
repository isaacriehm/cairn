# Provider-Neutral Model Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Cairn's Claude-only model subprocess with one shared runner
and native Claude, Codex, and Cursor CLI transports.

**Architecture:** Call sites depend on semantic model tiers and `runModel`.
One orchestrator owns selection, cache, subprocess lifecycle, validation,
errors, and tracing; three focused transport modules own only provider
arguments and envelopes.

**Tech Stack:** TypeScript 6, Node.js child processes, Zod 4, pnpm 10,
esbuild, smoke scripts.

## Global Constraints

- Codex calls use `gpt-5.3-codex-spark`.
- Cursor uses `cursor-agent --print --output-format json --model auto` without
  `--force`.
- Codex uses read-only sandboxing, ephemeral sessions, ignored user config,
  and output schemas written to private temporary files.
- No direct provider SDK, API-key configuration, provider environment
  variable, live model smoke, transition shim, or duplicated Cairn pipeline.
- Keep the follow-up as one integration commit on `pr-4-review`.

---

### Task 1: Lock the tri-provider subprocess contract with a failing smoke

**Files:**

- Create: `packages/cairn/scripts/smoke-model-runner.ts`
- Modify: `packages/cairn/package.json`

**Interfaces:**

- Consumes: the desired public exports from `@isaacriehm/cairn-core`.
- Produces: executable contract coverage for `resolveModelProvider`,
  `modelRunnerIsAvailable`, `runModel`, and `ModelRunnerError`.

- [x] **Step 1: Add a fake-executable smoke**

Create temporary `claude`, `codex`, and `cursor-agent` programs. Each program
must answer `--version`, capture argv/stdin to a temporary log, and return its
provider's real documented envelope shape. Exercise:

```ts
await runModel({
  provider: "codex",
  tier: "fast",
  prompt: "classify",
  system: "Return the label.",
  jsonSchema: {
    type: "object",
    required: ["label"],
    properties: { label: { type: "string" } },
    additionalProperties: false,
  },
});
```

Assert literal observable behavior:

- Claude receives `--model haiku`.
- Codex receives `exec`, `--sandbox read-only`, `--ephemeral`,
  `--output-schema`, and `gpt-5.3-codex-spark`.
- Cursor receives `--print`, JSON output, `--model auto`, and no `--force`.
- Every structured result equals `{label: "<provider>"}`.
- The provider appears in the result and cache key.
- Invalid schema output raises `ModelRunnerError`.

- [x] **Step 2: Register and run the smoke to verify RED**

Run:

```bash
pnpm --filter @isaacriehm/cairn smoke:model-runner
```

Expected: failure because the model-runner exports do not exist.

---

### Task 2: Implement shared orchestration and provider transports

**Files:**

- Create: `packages/cairn-core/src/model/types.ts`
- Create: `packages/cairn-core/src/model/error.ts`
- Create: `packages/cairn-core/src/model/provider.ts`
- Create: `packages/cairn-core/src/model/structured-output.ts`
- Create: `packages/cairn-core/src/model/cache.ts`
- Create: `packages/cairn-core/src/model/transports/types.ts`
- Create: `packages/cairn-core/src/model/transports/claude.ts`
- Create: `packages/cairn-core/src/model/transports/codex.ts`
- Create: `packages/cairn-core/src/model/transports/cursor.ts`
- Create: `packages/cairn-core/src/model/runner.ts`
- Create: `packages/cairn-core/src/model/index.ts`
- Delete: `packages/cairn-core/src/claude/cache.ts`
- Delete: `packages/cairn-core/src/claude/error.ts`
- Delete: `packages/cairn-core/src/claude/index.ts`
- Delete: `packages/cairn-core/src/claude/runner.ts`
- Delete: `packages/cairn-core/src/claude/types.ts`
- Modify: `packages/cairn-core/src/index.ts`

**Interfaces:**

- Produces:

```ts
type ModelProvider = "claude" | "codex" | "cursor";
type ModelTier = "fast" | "capable";

function configureModelProvider(provider: ModelProvider | null): void;
function resolveModelProvider(explicit?: ModelProvider): ModelProvider;
function modelRunnerIsAvailable(provider?: ModelProvider): boolean;
function runModel(options: RunModelOptions): Promise<RunModelResult>;

class ModelRunnerError extends Error {
  provider: ModelProvider | null;
  kind: "rate_limit" | "overloaded" | "auth" | "timeout" |
        "unavailable" | "invalid_output" | "other";
}
```

- [x] **Step 1: Implement provider-neutral types and errors**

Use semantic tiers. Error classification must retain existing rate-limit,
overload, authentication, and timeout patterns, while adding `unavailable`
and `invalid_output`.

- [x] **Step 2: Implement selection**

Use explicit provider, configured CLI override, native plugin-root preference,
then installed-provider fallback. Explicit unavailable providers must throw
instead of silently changing subscriptions.

- [x] **Step 3: Implement the three pure transport builders/decoders**

Each transport returns:

```ts
interface ModelInvocation {
  command: string;
  args: string[];
  stdin: string;
  cwd: string;
  cleanup(): void;
  decode(stdout: string): DecodedModelOutput;
}
```

Codex creates and removes its schema temp directory. Cursor embeds system and
schema instructions into stdin. Claude preserves its existing flags.

- [x] **Step 4: Implement shared schema parsing**

Use Zod 4's JSON-Schema converter to validate parsed output. Normalize only a single complete
```` ```json ```` fence; reject surrounding prose and schema violations.

- [x] **Step 5: Implement shared runner, cache, trace, and concurrency**

Resolve provider before cache lookup. Include provider in cache fingerprints
and results. Use one concurrency limit and one timeout implementation for all
transports. Always call transport cleanup.

- [x] **Step 6: Run the focused smoke to verify GREEN**

Run the Task 1 command. Expected: all provider cases pass without invoking a
real model.

---

### Task 3: Hard-cut Cairn call sites and operational naming

**Files:**

- Modify: all `packages/cairn-core/src/**/*.ts` imports/calls that reference
  `runClaude`, `ClaudeError`, `claudeIsAvailable`, or vendor tiers.
- Modify: `packages/cairn-state/src/paths.ts`
- Modify: affected `packages/cairn/src/cli/*.ts`
- Modify: affected `packages/cairn/scripts/smoke-*.ts`

**Interfaces:**

- Consumes: Task 2 `runModel`, semantic tiers, generic error and availability
  APIs.
- Produces: provider-neutral public results and diagnostics.

- [x] **Step 1: Add failing compile/smoke expectations for generic names**

Update focused smokes to expect `modelCalls`, `modelFallback`,
`modelPass1Calls`, `modelPass2Calls`, and `.cairn/cache/model`.

Run typecheck and the touched smokes. Expected: failures against the old
Claude/Haiku API.

- [x] **Step 2: Replace runner imports and tiers**

Replace `runClaude` with `runModel`, `haiku` with `fast`, and `sonnet` with
`capable`. Replace generic error handling and diagnostics with
`ModelRunnerError`.

- [x] **Step 3: Replace availability and detection**

`detectAll` must report:

```ts
environment: {
  model_provider: ModelProvider | null;
}
```

Init skips the mapper only when no model transport is available and prints a
provider-neutral remediation.

- [x] **Step 4: Replace counters, cache path, and trace source**

Hard-cut operational fields to `model*`, move disposable response caches to
`.cairn/cache/model`, and emit new trace events as source `model` with a
provider payload. Retain `claude` in the trace-source reader union for old
JSONL rows.

- [x] **Step 5: Run typecheck and all touched smokes to verify GREEN**

Run:

```bash
pnpm typecheck
pnpm --filter @isaacriehm/cairn smoke:model-runner
pnpm --filter @isaacriehm/cairn smoke:components
pnpm --filter @isaacriehm/cairn smoke:sot-align
pnpm --filter @isaacriehm/cairn smoke:layer-c-sessionstart-drain
```

Expected: zero failures.

---

### Task 4: Wire host selection, package the runner, and document behavior

**Files:**

- Modify: `packages/cairn/src/cli/index.ts`
- Modify: `packages/cairn/src/cli/hook.ts`
- Modify: `packages/cairn-plugin/.mcp.json`
- Modify: `packages/cairn-plugin/.mcp.codex.json`
- Modify: `packages/cairn-plugin/hooks/hooks.json`
- Modify: `packages/cairn-plugin/hooks/hooks.codex.json`
- Modify: `packages/cairn-plugin/hooks/hooks.cursor.json`
- Modify: `packages/cairn-plugin/skills/*/SKILL.md`
- Modify: `packages/cairn-plugin/scripts/check-layout.mjs`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/PLUGIN_ARCHITECTURE.md`
- Modify: `packages/cairn-plugin/README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: Task 2 `configureModelProvider`.
- Produces: global CLI `--model-provider auto|claude|codex|cursor`, explicit
  provider routing in plugin commands, and accurate operator documentation.

- [x] **Step 1: Add CLI provider parsing**

Extract one `--model-provider` flag from `process.argv` before command
dispatch, validate it, configure the core runner, and remove the pair so
subcommand parsers do not see it.

- [x] **Step 2: Add explicit provider arguments to plugin commands**

Claude hooks/MCP pass `claude`, Codex passes `codex`, and Cursor passes
`cursor`. Update layout validation to reject missing or mismatched routing.

- [x] **Step 3: Update documentation and skills**

Explain active-host selection, standalone override, authenticated CLI
requirements, Codex Spark, Cursor headless operation, read-only safety, and
fallback behavior. Keep historical changelog text unchanged.

- [x] **Step 4: Rebuild the plugin bundle**

Run:

```bash
pnpm build
```

Expected: layout check and esbuild bundle succeed.

- [x] **Step 5: Run the full verification gate**

Run typecheck, build, `version:check`, the complete `smokes` script,
`git diff --check`, JSON parsing, package dry-run, and private-path scan.
Do not run live LLM smokes.

- [x] **Step 6: Review, commit, and push**

Review the complete diff against the design, create one follow-up commit, push
`pr-4-review`, and verify the remote SHA.

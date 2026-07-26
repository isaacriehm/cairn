# Tri-Host Agent Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review the complete branch state and ship one shared Cairn plugin implementation with first-class Claude Code, Cursor, and Codex support.

**Architecture:** Keep `packages/cairn-plugin` as the single distribution package. Normalize each host's hook payloads into one internal model, run the existing Cairn behavior once, and serialize results through small native host adapters. Host-specific manifests and JSON declarations remain thin configuration; skills, MCP tools, runtime code, and generated bundle remain shared.

**Tech Stack:** TypeScript 6, Node.js 22+, pnpm, Zod, esbuild, stdio MCP, JSON plugin manifests, executable smoke tests.

## Global Constraints

- Preserve the contributor's six existing commits.
- Keep all intentional working-tree changes in scope for review.
- Produce one integration commit after every gate passes; do not create intermediate commits.
- Implement inline in the primary session.
- Do not use Codex Sol.
- If agent delegation is explicitly requested later, use Codex Terra at most.
- Maintain one runtime, one shared skills tree, one MCP implementation, and one generated bundle.
- Keep genuinely host-specific behavior accurately named; do not blindly replace `Claude Code`.
- Do not run the opt-in real-LLM smoke unless its documented trigger files change.

---

## File Structure

### Shared runtime

- Modify `packages/cairn-core/src/hooks/hook-platform.ts` — canonical host type, host resolution, and native response serialization.
- Modify `packages/cairn-core/src/hooks/runners/payload.ts` — shared hook payload and tool normalization.
- Modify `packages/cairn-core/src/hooks/runners/*.ts` — accept explicit host options and call shared serializers.
- Modify `packages/cairn-core/src/hooks/post-tool-use/*.ts` — consume normalized tool data without host-specific branching.
- Modify `packages/cairn/src/cli/hook.ts` — replace `--cursor` state with `--host <claude-code|cursor|codex>`.

### Plugin package

- Create `packages/cairn-plugin/.codex-plugin/plugin.json` — Codex plugin manifest.
- Create `packages/cairn-plugin/.mcp.codex.json` — Codex bundled stdio MCP declaration.
- Create `packages/cairn-plugin/hooks/hooks.codex.json` — Codex native lifecycle declaration.
- Create `.agents/plugins/marketplace.json` — Codex repository marketplace.
- Modify `packages/cairn-plugin/hooks/hooks.cursor.json` — current Cursor native hook format.
- Modify the existing Claude, Cursor, and MCP manifests only where shared host arguments or paths require it.
- Modify `packages/cairn-plugin/package.json`, `scripts/sync-version.mjs`, and `packages/cairn-plugin/scripts/check-layout.mjs` — package, version, and contract gates for all three hosts.

### Portable instructions and documentation

- Create `AGENTS.md` — canonical agent-neutral repository instructions.
- Modify `CLAUDE.md` — Claude Code import entrypoint for `AGENTS.md`.
- Modify all five `packages/cairn-plugin/skills/*/SKILL.md` files — capability-based shared instructions.
- Modify portable agent/command text where it incorrectly requires Claude-only tools.
- Modify README, architecture references, user guides, package README, and changelog for tri-host support and "Built with Claude Code and Codex."

### Verification

- Create `packages/cairn/scripts/smoke-agent-host-hooks.ts` — shared normalization/serialization contract.
- Create `packages/cairn/scripts/smoke-codex-plugin-layout.ts` — Codex manifest, marketplace, hooks, MCP, and isolated CLI-install contract.
- Strengthen `packages/cairn/scripts/smoke-cursor-hook-format.ts` and `smoke-cursor-plugin-layout.ts`.
- Modify `packages/cairn/package.json` — register new smoke gates.

---

### Task 1: Write the tri-host hook contract before refactoring

**Files:**

- Create: `packages/cairn/scripts/smoke-agent-host-hooks.ts`
- Modify: `packages/cairn/package.json`

**Interfaces:**

- Consumes: current exports from `@isaacriehm/cairn-core`.
- Produces: executable behavioral expectations for `AgentHost`, host resolution, payload normalization, and response serialization.

- [ ] **Step 1: Add the failing contract smoke**

Add fixtures equivalent to:

```ts
const cursor = normalizePostToolUse({
  tool_name: "Write",
  tool_input: { path: "src/a.ts", contents: "export const a = 1;" },
  tool_output: "{}",
});

const codex = normalizePostToolUse({
  hook_event_name: "PostToolUse",
  tool_name: "apply_patch",
  tool_input: {
    command: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch",
  },
});

assert(resolveAgentHost("cursor") === "cursor", "explicit Cursor host");
assert(resolveAgentHost("codex") === "codex", "explicit Codex host");
assert(cursor.tool_input?.file_path === "src/a.ts", "Cursor path normalization");
assert(codex.tool_name === "apply_patch", "Codex apply_patch normalization");

assertDeepEqual(
  serializePostToolUse("cursor", { kind: "continue", context: "ground" }),
  { additional_context: "ground" },
);
assertDeepEqual(
  serializePostToolUse("codex", { kind: "block", reason: "repair" }),
  { continue: false, stopReason: "repair" },
);
assertDeepEqual(
  serializeStop("cursor", { kind: "follow-up", prompt: "continue" }),
  { followup_message: "continue" },
);
assertDeepEqual(
  serializeStop("codex", { kind: "follow-up", prompt: "continue" }),
  { decision: "block", reason: "continue" },
);
```

Use exported pure serializer functions instead of spawning the bundle so
failures identify the exact contract.

- [ ] **Step 2: Register and run the smoke to verify failure**

Add:

```json
"smoke:agent-host-hooks": "tsx scripts/smoke-agent-host-hooks.ts"
```

Run:

```bash
pnpm --filter @isaacriehm/cairn smoke:agent-host-hooks
```

Expected: TypeScript fails because `resolveAgentHost`,
`serializePostToolUse`, and `serializeStop` do not exist.

- [ ] **Step 3: Keep the test red while defining exact output fixtures**

Cover:

- Claude Code SessionStart Shape-B;
- Codex SessionStart Shape-B;
- Cursor SessionStart native context;
- Claude Code PostToolUse block;
- Codex PostToolUse `continue: false` plus `stopReason`;
- Cursor PostToolUse advisory context;
- Claude Code and Codex Stop continuation;
- Cursor completed/error Stop behavior and loop limit.

- [ ] **Step 4: Re-run and record the expected failing symbols**

Run the same smoke. Expected: only the new host API is missing; fixture syntax
and imports otherwise typecheck.

---

### Task 2: Replace mutable Cursor mode with one shared host boundary

**Files:**

- Modify: `packages/cairn-core/src/hooks/hook-platform.ts`
- Modify: `packages/cairn-core/src/hooks/runners/payload.ts`
- Modify: `packages/cairn-core/src/hooks/runners/index.ts`
- Modify: `packages/cairn-core/src/hooks/runners/session-start.ts`
- Modify: `packages/cairn-core/src/hooks/runners/session-end.ts`
- Modify: `packages/cairn-core/src/hooks/runners/stop.ts`
- Modify: `packages/cairn-core/src/hooks/runners/user-prompt-submit.ts`
- Modify: `packages/cairn-core/src/hooks/post-tool-use/read-enricher.ts`
- Modify: `packages/cairn-core/src/hooks/post-tool-use/post-write.ts`
- Modify: `packages/cairn-core/src/hooks/post-tool-use/write-guardian.ts`
- Modify: `packages/cairn-core/src/hooks/post-tool-use/sot-align.ts`
- Modify: `packages/cairn-core/src/hooks/post-tool-use/ask-user-blocked.ts`
- Modify: `packages/cairn/src/cli/hook.ts`

**Interfaces:**

- Produces:

```ts
export type AgentHost = "claude-code" | "cursor" | "codex";
export interface HookRunOptions { host?: AgentHost }
export type HookResult =
  | { kind: "continue"; context?: string; message?: string }
  | { kind: "block"; reason: string }
  | { kind: "follow-up"; prompt: string }
  | { kind: "environment"; env: Record<string, string>; context?: string };
export interface StopInput {
  status?: "completed" | "aborted" | "error";
  continuationCount?: number;
  continuationLimit?: number | null;
}
export function resolveAgentHost(explicit?: string): AgentHost;
export function serializeSessionStart(host: AgentHost, result: HookResult): unknown;
export function serializePostToolUse(host: AgentHost, result: HookResult): unknown;
export function serializeStop(host: AgentHost, result: HookResult, input?: StopInput): unknown;
```

- Consumes: normalized payload helpers and existing runner decisions.

- [ ] **Step 1: Implement the minimal pure host API**

Replace `forceCursor`, `setCursorHookMode`, and implicit mutable state with:

```ts
export const AGENT_HOSTS = ["claude-code", "cursor", "codex"] as const;
export type AgentHost = (typeof AGENT_HOSTS)[number];

export function resolveAgentHost(explicit?: string): AgentHost {
  if (explicit === "cursor" || explicit === "codex" || explicit === "claude-code") {
    return explicit;
  }
  if (process.env["CURSOR_PLUGIN_ROOT"]) return "cursor";
  if (process.env["PLUGIN_ROOT"] && !process.env["CLAUDE_PLUGIN_ROOT"]) return "codex";
  return "claude-code";
}
```

Keep serialization pure. A separate `emitSerialized(payload)` writes JSON and
exits for CLI runners.

- [ ] **Step 2: Extend payload normalization for Codex**

Update the payload schema to retain:

```ts
turn_id: z.string().optional(),
stop_hook_active: z.boolean().optional(),
last_assistant_message: z.string().nullable().optional(),
tool_use_id: z.string().optional(),
tool_input: z.record(z.string(), z.unknown()).optional(),
tool_response: z.record(z.string(), z.unknown()).optional(),
tool_output: z.unknown().optional(),
```

Normalize canonical tool categories without discarding raw names. Preserve
Cursor `path`/`contents` aliases and parse stringified `tool_output`.

For Codex `apply_patch`, mark the event as a file mutation but do not pretend a
single `file_path` exists when one patch can touch multiple files. The shared
post-write runner must safely no-op where its file-specific behavior cannot be
derived.

- [ ] **Step 3: Thread `HookRunOptions` through runners**

Each public runner accepts an optional host:

```ts
export async function runStopHook(options: HookRunOptions = {}): Promise<void> {
  const host = resolveAgentHost(options.host);
  // existing state work
  emitSerialized(serializeStop(host, result, stopInput));
}
```

Do not add host branches inside mission, attention, GC, or state code.

- [ ] **Step 4: Replace CLI parsing**

Support:

```text
cairn hook session-start --host claude-code
cairn hook session-start --host cursor
cairn hook session-start --host codex
```

Parse `--host` once, validate against `AGENT_HOSTS`, remove `--cursor`, and pass
the host to every hook runner.

- [ ] **Step 5: Run focused hook smokes**

Run:

```bash
pnpm --filter @isaacriehm/cairn smoke:agent-host-hooks
pnpm --filter @isaacriehm/cairn smoke:cursor-hook-format
pnpm --filter @isaacriehm/cairn smoke:stop-hook
pnpm --filter @isaacriehm/cairn smoke:session-start
pnpm typecheck
```

Expected: the new host contract passes; existing Cursor smoke may still fail
because its hook command fixtures retain `--cursor`.

---

### Task 3: Correct Cursor to its current native plugin contract

**Files:**

- Modify: `packages/cairn-plugin/.cursor-plugin/plugin.json`
- Modify: `packages/cairn-plugin/hooks/hooks.cursor.json`
- Modify: `.cursor-plugin/marketplace.json`
- Modify: `packages/cairn-plugin/scripts/check-layout.mjs`
- Modify: `packages/cairn/scripts/smoke-cursor-plugin-layout.ts`
- Modify: `packages/cairn/scripts/smoke-cursor-hook-format.ts`

**Interfaces:**

- Consumes: Cursor native hook config `version: 1` and flat hook entries.
- Produces: current native Cursor declarations invoking the shared CLI with
  `--host cursor`.

- [ ] **Step 1: Strengthen the Cursor layout smoke before changing JSON**

Assert:

```ts
assert(hooks.version === 1, "Cursor hooks schema version must be 1");
for (const event of Object.values(hooks.hooks)) {
  for (const entry of event) {
    assert(typeof entry.command === "string", "Cursor hook entry requires command");
    assert(!("hooks" in entry), "Cursor native hooks cannot use Claude matcher groups");
    assert(entry.command.includes("--host cursor"), "Cursor hook must select Cursor host");
  }
}
```

Also require manifest component paths to start with `./`.

- [ ] **Step 2: Run the strengthened smoke to verify failure**

Run:

```bash
pnpm --filter @isaacriehm/cairn smoke:cursor-plugin-layout
```

Expected: failure on missing `version`, nested hook entries, and non-prefixed
manifest hook path.

- [ ] **Step 3: Rewrite only the Cursor declarations**

Use:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "command": "node \"${CURSOR_PLUGIN_ROOT}/dist/cli.mjs\" hook session-start --host cursor"
      }
    ],
    "postToolUse": [
      {
        "matcher": "Read",
        "command": "node \"${CURSOR_PLUGIN_ROOT}/dist/cli.mjs\" hook read-enrich --host cursor"
      },
      {
        "matcher": "Write",
        "command": "node \"${CURSOR_PLUGIN_ROOT}/dist/cli.mjs\" hook post-write --host cursor"
      }
    ]
  }
}
```

Retain SessionEnd and Stop. Remove `AskUserQuestion` from the native Cursor
file because current Cursor tool matchers do not expose that Claude-only tool.

- [ ] **Step 4: Update executable Cursor fixtures**

Spawn bundle commands with `--host cursor`. Assert native output does not
contain `hookSpecificOutput`, `decision`, or Claude nested configuration.

- [ ] **Step 5: Run Cursor-focused verification**

Run:

```bash
pnpm --filter @isaacriehm/cairn smoke:cursor-plugin-layout
pnpm --filter @isaacriehm/cairn smoke:cursor-hook-format
pnpm --filter @isaacriehm/cairn smoke:cursor-plugin-bundle
pnpm --filter @isaacriehm/cairn-plugin typecheck
```

Expected: all pass.

---

### Task 4: Add first-class Codex plugin packaging and installation tests

**Files:**

- Create: `packages/cairn-plugin/.codex-plugin/plugin.json`
- Create: `packages/cairn-plugin/.mcp.codex.json`
- Create: `packages/cairn-plugin/hooks/hooks.codex.json`
- Create: `.agents/plugins/marketplace.json`
- Create: `packages/cairn/scripts/smoke-codex-plugin-layout.ts`
- Modify: `packages/cairn-plugin/package.json`
- Modify: `packages/cairn-plugin/scripts/check-layout.mjs`
- Modify: `scripts/sync-version.mjs`
- Modify: `packages/cairn/package.json`

**Interfaces:**

- Codex manifest points to:

```json
{
  "skills": "./skills/",
  "mcpServers": "./.mcp.codex.json",
  "hooks": "./hooks/hooks.codex.json"
}
```

- Codex MCP command invokes:

```json
{
  "command": "node",
  "args": ["${PLUGIN_ROOT}/dist/cli.mjs", "mcp", "serve"]
}
```

- [ ] **Step 1: Add the failing Codex layout smoke**

The smoke must verify:

- manifest required metadata and in-tree `./` paths;
- marketplace `source.path === "./packages/cairn-plugin"`;
- marketplace policies include `installation` and `authentication`;
- hook event names and flat Codex matcher groups;
- every command selects `--host codex`;
- MCP uses `${PLUGIN_ROOT}`;
- package `files` includes Codex artifacts;
- version-sync targets include the Codex manifest.

- [ ] **Step 2: Run to verify missing-artifact failure**

Run:

```bash
pnpm --filter @isaacriehm/cairn smoke:codex-plugin-layout
```

Expected: failure because `.codex-plugin/plugin.json` is absent.

- [ ] **Step 3: Add Codex artifacts**

Use one marketplace:

```json
{
  "name": "isaacriehm-cairn",
  "interface": { "displayName": "Cairn" },
  "plugins": [
    {
      "name": "cairn",
      "source": {
        "source": "local",
        "path": "./packages/cairn-plugin"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Developer Tools"
    }
  ]
}
```

Codex hooks use documented event casing and Claude-compatible matcher groups
where Codex requires them, but commands explicitly select the Codex serializer.

- [ ] **Step 4: Add isolated Codex CLI validation**

Inside the smoke:

1. create a temporary directory;
2. set `CODEX_HOME` only for child processes;
3. run `codex plugin marketplace add <repo-root>`;
4. run `codex plugin list --available --json`;
5. assert `cairn` is available from `isaacriehm-cairn`;
6. run `codex plugin add cairn@isaacriehm-cairn`;
7. assert the cached plugin includes the manifest, skills, hooks, MCP config,
   and bundle.

Skip only when the `codex` binary is unavailable; print a visible skip reason.

- [ ] **Step 5: Run Codex-focused verification**

Run:

```bash
pnpm --filter @isaacriehm/cairn smoke:codex-plugin-layout
pnpm version:check
pnpm --filter @isaacriehm/cairn-plugin typecheck
```

Expected: all pass without modifying the real Codex configuration.

---

### Task 5: Make repository guidance and skills portable

**Files:**

- Create: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `packages/cairn-plugin/skills/cairn-adopt/SKILL.md`
- Modify: `packages/cairn-plugin/skills/cairn-adopt-components/SKILL.md`
- Modify: `packages/cairn-plugin/skills/cairn-attention/SKILL.md`
- Modify: `packages/cairn-plugin/skills/cairn-direction/SKILL.md`
- Modify: `packages/cairn-plugin/skills/cairn-resync/SKILL.md`
- Modify: `packages/cairn-plugin/agents/reviewer.md`
- Modify portable files under `packages/cairn-plugin/commands/`
- Modify: `packages/cairn/scripts/smoke-plugin-layout.ts`
- Modify: `packages/cairn/scripts/smoke-skill-budget.ts`

**Interfaces:**

- `AGENTS.md` is the canonical repository guidance.
- `CLAUDE.md` imports `@AGENTS.md`.
- Shared skills describe capabilities rather than requiring named
  Claude-specific tools.

- [ ] **Step 1: Add portability assertions**

Extend layout smokes to fail when shared skill bodies contain actor phrases
such as `main Claude`, or make unconditional use of `AskUserQuestion` and
Claude's `Task` tool.

Allow these strings only inside explicitly labeled Claude Code branches.

- [ ] **Step 2: Run the assertions to verify failure**

Run:

```bash
pnpm --filter @isaacriehm/cairn smoke:plugin-layout
```

Expected: failures identify the current Claude-only skill passages.

- [ ] **Step 3: Create canonical guidance**

Move the full project orientation into `AGENTS.md`, changing the opening and
general architecture text to cover Claude Code, Cursor, and Codex.

Replace `CLAUDE.md` with:

```md
# Claude Code entrypoint

@AGENTS.md
```

Keep Claude-specific hard rules accurately scoped inside `AGENTS.md`.

- [ ] **Step 4: Refactor shared skill language**

Use this capability mapping:

```text
Questioning:
  structured question tool when available
  otherwise one concise chat question

Delegation:
  host subagent mechanism when available and authorized
  otherwise inline execution

Review:
  bundled reviewer agent when the host loads agent definitions
  otherwise shared review instructions in the active skill
```

Do not create host-specific copies of any skill.

- [ ] **Step 5: Run instruction gates**

Run:

```bash
pnpm --filter @isaacriehm/cairn smoke:plugin-layout
pnpm --filter @isaacriehm/cairn smoke:shipped-voice
pnpm --filter @isaacriehm/cairn smoke:skill-budget
```

Expected: all pass.

---

### Task 6: Update public documentation and attribution

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/PLUGIN_ARCHITECTURE.md`
- Modify: `docs/SYSTEM_OVERVIEW.md`
- Modify: `docs/MCP_SURFACE.md`
- Modify: `docs/CONTEXT_ENGINE.md`
- Modify: `docs/FILESYSTEM_LAYOUT.md`
- Modify relevant files under `docs/guide/`
- Modify: `packages/cairn-plugin/README.md`
- Modify package descriptions in `packages/cairn-plugin/package.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `.cursor-plugin/marketplace.json`

**Interfaces:**

- Public attribution is exactly: `Built with Claude Code and Codex.`
- Everyday supported hosts are Claude Code, Cursor, and Codex.
- Host-specific features remain correctly scoped.

- [ ] **Step 1: Add or update doc-claim assertions**

Extend `smoke-doc-claims.ts` and plugin layout checks to require:

- README names all three hosts;
- README contains the exact attribution;
- package README documents installation for all three hosts;
- MCP docs no longer describe Codex as only a secondary MCP client;
- Cursor hook docs claim current native configuration.

- [ ] **Step 2: Run doc claims to verify failure**

Run:

```bash
pnpm --filter @isaacriehm/cairn smoke:doc-claims
```

Expected: current Claude/Cursor-only descriptions fail.

- [ ] **Step 3: Rewrite the top-level user path**

Document:

- Claude Code marketplace installation;
- Cursor marketplace or local installation;
- Codex CLI marketplace add/install;
- ChatGPT desktop app local marketplace installation;
- common adoption and daily-flow behavior;
- host-specific limitations such as Claude Code status line.

- [ ] **Step 4: Reconcile architecture documents**

Replace two-host diagrams and tables with tri-host equivalents. Keep historic
changelog entries unchanged; add one new unreleased entry describing the audit,
Cursor hook correction, Codex plugin, and shared host adapter.

- [ ] **Step 5: Run documentation verification**

Run:

```bash
pnpm --filter @isaacriehm/cairn smoke:doc-claims
pnpm --filter @isaacriehm/cairn smoke:doc-source-drift
pnpm --filter @isaacriehm/cairn smoke:plugin-layout
```

Expected: all pass.

---

### Task 7: Audit the complete combined diff and regenerate distribution output

**Files:**

- Review: every file in `git diff --name-only origin/main`
- Modify: only files with confirmed correctness, dead-code, privacy, or
  distribution defects
- Regenerate: `packages/cairn-plugin/dist/cli.mjs`
- Regenerate: plugin `dist/templates/` through the existing build

**Interfaces:**

- Consumes: contributor commits, intentional working changes, tri-host work.
- Produces: one coherent PR-ready diff with no generated/source skew.

- [ ] **Step 1: Run static review gates**

Run:

```bash
git diff --check origin/main
pnpm exec knip
pnpm version:check
```

Classify each finding as:

- introduced by contributor Cursor work;
- introduced by intentional working changes;
- introduced by tri-host integration;
- pre-existing on `origin/main`.

Fix only the first three categories.

- [ ] **Step 2: Inspect security and path boundaries**

Review hook commands, MCP commands, path interpolation, repo-root selection,
temp files, file writes, and user-controlled strings. Confirm:

- plugin paths are quoted;
- marketplace paths stay inside the repository;
- hook parse failures fail open where documented;
- Stop continuation cannot loop past host limits;
- Codex and Cursor payloads cannot redirect writes outside Cairn's existing
  safety boundaries.

- [ ] **Step 3: Build the workspace**

Run:

```bash
pnpm build
```

Expected: TypeScript packages compile, plugin layout passes, and
`packages/cairn-plugin/dist/cli.mjs` is regenerated from the reviewed source.

- [ ] **Step 4: Confirm generated parity**

Run:

```bash
git diff --check
pnpm --filter @isaacriehm/cairn smoke:plugin-bundle
pnpm --filter @isaacriehm/cairn smoke:cursor-plugin-bundle
pnpm --filter @isaacriehm/cairn smoke:codex-plugin-layout
```

Expected: all pass and the generated bundle is the only intended minified
runtime artifact.

---

### Task 8: Full verification, one integration commit, and push

**Files:**

- Stage: the complete intended branch diff
- Commit: one comprehensive integration commit
- Push: `pr-4-review` to `origin`

**Interfaces:**

- Produces: verified remote branch preserving all contributor commits.

- [ ] **Step 1: Run the complete verification matrix**

Run:

```bash
pnpm build
pnpm typecheck
pnpm smokes
pnpm smokes:all
pnpm version:check
git diff --check
```

Expected: every command exits `0`.

- [ ] **Step 2: Run isolated host validation**

Run the Claude Code plugin validator if the installed CLI exposes it.
Run the Codex isolated marketplace/install smoke. Run the Cursor official
schema and native fixture checks; note that no local Cursor binary is
available.

- [ ] **Step 3: Review the final diff and status**

Run:

```bash
git status --short
git diff --stat origin/main
git diff --name-status origin/main
git diff --check origin/main
```

Confirm no private paths, unrelated files, transient logs, temporary
directories, or local settings are staged.

- [ ] **Step 4: Stage and commit once**

Run:

```bash
git add --all
git commit -m "feat: ship unified Claude Cursor and Codex integration"
```

Expected: one new commit on top of the six contributor commits.

- [ ] **Step 5: Verify the commit**

Run:

```bash
git status --short --branch
git log --oneline --decorate main..HEAD
```

Expected: clean worktree; seven commits ahead of `main`.

- [ ] **Step 6: Push the reviewed branch**

Run:

```bash
git push -u origin pr-4-review
```

Expected: remote branch updated successfully.

- [ ] **Step 7: Report evidence**

Summarize:

- contributor defects corrected;
- intentional working changes reviewed;
- unified host architecture;
- Codex CLI/Desktop coverage;
- Cursor schema/native fixture coverage and missing local runtime;
- exact verification commands and results;
- final commit SHA and pushed branch.

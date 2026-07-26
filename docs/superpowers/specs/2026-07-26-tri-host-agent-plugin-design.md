# Tri-Host Agent Plugin Design

**Status:** Approved design
**Date:** 2026-07-26
**Scope:** Review the combined `pr-4-review` branch state and ship first-class Claude Code, Cursor, and Codex support from one shared implementation.

## 1. Objective

Cairn must provide the same core daily-flow capabilities in Claude Code,
Cursor, and Codex without maintaining three copies of the runtime, skills, or
plugin package.

This change also audits the contributor's six Cursor commits together with the
intentional uncommitted work already present on the branch. Contributor history
stays intact. The completed review and integration land as one additional
commit.

Implementation stays inline in the primary session. Do not use Codex Sol.
If agent delegation is explicitly requested later, use Codex Terra at most;
the available usage limits are intentionally kept small.

## 2. Current-State Findings

The combined branch typechecks and passes the existing smoke suite, but those
checks do not establish real host compatibility.

The highest-confidence defect found during design research is the Cursor hook
registration file. It uses Claude Code's nested matcher-group structure:

```json
{
  "hooks": {
    "sessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "..."
          }
        ]
      }
    ]
  }
}
```

Current native Cursor hooks require `version: 1` and flat hook definitions:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "command": "..."
      }
    ]
  }
}
```

The existing Cursor smokes reproduce and approve the repository's own shape
instead of checking the host contract. They therefore pass while the shipped
configuration is invalid for current native Cursor plugins.

Codex is currently described as an MCP client in a few documents, but Cairn
does not ship a Codex manifest, marketplace entry, native hook declaration,
Codex-aware payload normalization, or verified installation path.

## 3. Considered Approaches

### 3.1 Shared native host adapter — selected

Keep one plugin package and one runtime. Add a small host boundary that:

1. identifies the active host;
2. normalizes host payloads into shared internal events;
3. runs the existing Cairn behavior once; and
4. serializes results into each host's native response format.

The only host-specific files are declarative manifests and hook/MCP
configuration required by each product.

This is the selected approach because it provides native behavior without
duplicating business logic.

### 3.2 Claude compatibility format everywhere — rejected

Cursor and Codex both understand parts of Claude Code's hook protocol. Cairn
could exploit that compatibility and add only new manifests.

This is rejected because compatibility coverage is incomplete, native tool
names and payloads differ, Stop behavior differs, and compatibility layers can
change independently of native contracts. It would repeat the contributor
branch's central failure: configuration that looks plausible but is not tested
against the real host surface.

### 3.3 Separate frontend packages — rejected

Each host could receive its own package, copied skills, hook runners, and
bundle.

This is rejected because it creates three sources of truth and guarantees drift
in the most frequently changed parts of Cairn.

## 4. Architecture

### 4.1 Canonical host model

Introduce one shared host type:

```ts
type AgentHost = "claude-code" | "cursor" | "codex";
```

Host selection is explicit at plugin entrypoints. Declarative hook commands
pass the host to the bundled CLI. Environment and payload detection remain
available only where the host cannot be passed directly.

The host is threaded through a canonical hook context rather than stored as
mutable module-global state. This avoids cross-call leakage in tests and
long-lived processes.

### 4.2 Canonical hook events

Every supported hook is normalized into a focused internal value:

```ts
interface HookContext {
  host: AgentHost;
  event:
    | "session-start"
    | "session-end"
    | "user-prompt-submit"
    | "post-tool-use"
    | "stop";
  sessionId: string | null;
  cwd: string;
  tool?: {
    name: "read" | "write" | "edit" | "shell" | "apply-patch" | "other";
    input: unknown;
    output?: unknown;
  };
  stop?: {
    status?: string;
    continuationCount?: number;
    continuationActive?: boolean;
  };
  raw: unknown;
}
```

Existing Cairn runners consume normalized values. Host field aliases and
envelope differences do not leak into state, mission, attention, or ingestion
logic.

### 4.3 Native response serializers

Runner results are represented independently of any host:

```ts
type HookResult =
  | { kind: "continue"; context?: string; message?: string }
  | { kind: "block"; reason: string }
  | { kind: "follow-up"; prompt: string }
  | { kind: "environment"; env: Record<string, string>; context?: string };
```

Serializers produce:

- Claude Code's `hookSpecificOutput`, block, and Stop envelopes;
- Cursor's native `additional_context`, `followup_message`, and session `env`;
- Codex's documented hook envelopes, including Codex Stop continuation and
  PostToolUse feedback semantics.

No shared runner writes platform JSON directly.

### 4.4 Tool normalization

The normalizer must cover real tool names and payload fields:

- Claude Code: `Read`, `Write`, `Edit`, `Bash`;
- Cursor: `Read`, `Write`, `Shell`, native `tool_output`, and MCP names;
- Codex: `Bash`, `apply_patch`, MCP/local function names, and Codex
  `tool_input.command` payloads.

Read enrichment runs only when a readable path and content can be derived.
Post-write processing runs only when the normalized tool represents a file
mutation. Unsupported tools fail open and produce no malformed output.

## 5. Plugin Packaging

`packages/cairn-plugin` remains the only plugin implementation and bundle.

It ships:

```text
packages/cairn-plugin/
├── .claude-plugin/plugin.json
├── .cursor-plugin/plugin.json
├── .codex-plugin/plugin.json
├── .mcp.json
├── mcp.json
├── hooks/
├── skills/
├── agents/
├── commands/
├── rules/
├── dist/
└── bin/
```

Shared content remains at the plugin root. Host manifests reference the same
skills and bundled runtime. Where MCP placeholder syntax differs, the
host-specific manifest points to a thin host-specific MCP declaration rather
than duplicating server code.

### 5.1 Claude Code

Preserve the current marketplace and manifest behavior. Refactoring may change
the hook command arguments, but not the user-facing installation flow or
Cairn's established Claude Code behavior.

### 5.2 Cursor

Keep `.cursor-plugin/plugin.json`, the Cursor marketplace, Cursor rules, and
Cursor MCP registration. Replace the hook declaration with current native
Cursor structure and current native matcher names.

Cursor configuration paths must use the relative-path form required by the
current plugin specification. The layout gate must reject nested Claude-style
definitions in the native Cursor file.

### 5.3 Codex

Add:

- `.codex-plugin/plugin.json`;
- a repo marketplace at `.agents/plugins/marketplace.json`;
- shared skills registration;
- bundled stdio MCP registration;
- Codex lifecycle hooks;
- CLI and ChatGPT desktop app installation instructions.

The Codex plugin must work from the ChatGPT desktop app and Codex CLI because
both consume the same installed plugin, project instructions, MCP, and hook
surfaces.

Codex hook commands use the plugin root and data locations documented for
Codex. Installation verification uses an isolated temporary Codex home so the
test does not mutate the operator's real configuration.

## 6. Shared Skills and Agent Behavior

The five existing Cairn skills remain single-source. Their wording changes
from Claude-specific actors and tools to capability-based instructions:

- "main Claude" becomes "the active agent";
- question prompts use the host's available structured-question surface, with
  concise chat questions as the portable fallback;
- subagent dispatch uses the host's available agent delegation mechanism;
- MCP tool calls keep their existing `cairn_*` names;
- host-only features such as Claude Code's status line are explicitly scoped.

Claude commands and agent definitions may remain for Claude Code and Cursor,
but no core Cairn workflow may depend exclusively on them. Codex must be able
to reach the equivalent behavior through shared skills and MCP tools.

If a reusable workflow currently exists only as a Claude command or agent,
promote its portable behavior into a shared skill. Do not copy the command body
into a Codex-only tree.

## 7. Repository Guidance and Attribution

`AGENTS.md` becomes the canonical repository instruction file for agent-neutral
project guidance. `CLAUDE.md` becomes a small Claude Code entrypoint that
imports the canonical guidance, preventing two copies from drifting.

Documentation distinguishes:

1. legitimate host-specific mechanisms;
2. supported-host descriptions; and
3. project authorship attribution.

The project attribution reads "Built with Claude Code and Codex." Historical
changelog entries and genuinely Claude-specific features keep their accurate
names. This is not a blind string replacement.

Architecture and user documentation describe the everyday plugin surface as
Claude Code, Cursor, and Codex. MCP-only Codex references are upgraded to the
full native plugin model.

## 8. Combined Branch Review

The review target is:

```text
origin/main
  + six committed contributor changes
  + the intentional working-tree changes
  + tri-host integration changes
```

The audit checks:

- hook and MCP path resolution on POSIX, Windows, paths with spaces, worktrees,
  and nested working directories;
- plugin manifests and marketplace source paths;
- payload parsing and response envelopes;
- session and repo-root selection;
- generated bundle parity;
- removed exports and dead-code cleanup in the intentional working tree;
- docs-to-runtime claims;
- package contents and version synchronization.

Defects found in any of those areas are fixed in the same integration commit.
Unrelated refactors are excluded.

## 9. Verification

### 9.1 Contract smokes

Add or strengthen smokes that assert:

- all three manifests contain required metadata and in-tree relative paths;
- all three marketplaces resolve to the shared plugin directory;
- Cursor uses `version: 1` and flat native hook entries;
- Codex loads the plugin from an isolated marketplace and temporary Codex home;
- Claude Code, Cursor, and Codex payload fixtures normalize to the same internal
  event;
- each host serializer emits only fields accepted by that host;
- Codex `apply_patch`, Bash, MCP, SessionStart, PostToolUse, and Stop fixtures
  behave correctly;
- plugin root paths containing spaces remain quoted and executable;
- the committed `dist/cli.mjs` matches source.

### 9.2 Repository gates

Run:

```text
pnpm build
pnpm typecheck
pnpm smokes
pnpm smokes:all
pnpm version:check
git diff --check
```

Run any additional package or schema validation discovered during
implementation. The opt-in real-LLM smoke remains excluded unless its documented
trigger files change.

### 9.3 Runtime availability

Claude Code and Codex are available locally and can be used for isolated plugin
validation. Cursor is not installed locally, so Cursor validation uses its
current official schema, current official plugin examples, native hook fixtures,
and Cairn's executable smoke harness. The final handoff must state this runtime
coverage precisely.

## 10. Documentation Sources

The implementation is based on current primary documentation:

- OpenAI, "Package your plugin":
  `https://developers.openai.com/plugins/build/plugins`
- OpenAI, "Hooks":
  `https://learn.chatgpt.com/docs/hooks`
- OpenAI, "Custom instructions with AGENTS.md":
  `https://learn.chatgpt.com/docs/agent-configuration/agents-md`
- OpenAI, "Build skills":
  `https://learn.chatgpt.com/docs/build-skills`
- OpenAI, "Model Context Protocol":
  `https://learn.chatgpt.com/docs/extend/mcp`
- Cursor, "Plugins":
  `https://cursor.com/docs/plugins.md`
- Cursor, "Hooks":
  `https://cursor.com/docs/hooks.md`
- Cursor, "Third Party Hooks":
  `https://cursor.com/docs/reference/third-party-hooks.md`
- Cursor official plugin schemas and examples:
  `https://github.com/cursor/plugins`

## 11. Delivery

Preserve the contributor's existing commits. When all verification passes:

1. stage the complete reviewed change set;
2. create one comprehensive integration commit;
3. push `pr-4-review` to `origin`;
4. report the audit findings, verification evidence, and any runtime limitation.

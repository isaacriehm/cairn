# Provider-Neutral Model Runner Design

**Date:** 2026-07-26
**Status:** Approved
**Scope:** Replace Cairn's Claude-only LLM subprocess backend with one shared
runner and thin Claude Code, Codex, and Cursor CLI transports.

## Problem

Cairn's plugin, MCP, skills, and hooks understand Claude Code, Codex, and
Cursor, but its model-assisted backend does not. Mapping, classification,
mission drafting, component reconfirmation, drain judging, and source-of-truth
alignment all call `runClaude`, which directly spawns the `claude` executable.
A Codex or Cursor operator therefore still needs Claude Code installed and
authenticated for those features.

The deterministic state engine, hooks, MCP tools, and sensors remain
model-independent. This change is limited to the subprocess boundary used by
model-assisted work.

## Goals

- Run Cairn's existing model-assisted workflows through the active host's CLI.
- Keep one orchestration path for caching, concurrency, timeouts, tracing,
  errors, structured-output parsing, and schema validation.
- Keep provider-specific code limited to executable discovery, arguments,
  prompt transport, and response-envelope decoding.
- Use `gpt-5.3-codex-spark` for Codex-backed Cairn work.
- Support Cursor's documented headless `cursor-agent` interface.
- Preserve Claude Code behavior through a Claude transport.
- Avoid API keys, direct SDK billing, provider environment variables, and
  quota-consuming tests.

## Approaches Considered

### 1. Shared orchestrator with thin transports — selected

Create a `model/` package boundary. `runModel` owns all shared behavior and
dispatches to a Claude, Codex, or Cursor transport. Existing call sites change
only their import and semantic tier names.

This gives each host native authentication while preventing three copies of
the mapper and classifier logic.

### 2. Add provider branches inside `claude/runner.ts`

This is a smaller initial diff, but it leaves Claude names in public types,
cache paths, errors, traces, and operational output. Provider-specific
branches would spread through one large runner and make future changes harder
to isolate.

### 3. Call provider HTTP APIs directly

Direct SDKs could provide uniform structured output, but they introduce API
keys, separate billing, and authentication distinct from the operator's
Claude Code, Codex, or Cursor subscription. That violates Cairn's local CLI
model.

## Architecture

```text
mapper / classifier / mission / align call sites
                         |
                         v
                    runModel()
        cache | concurrency | timeout | trace
        schema validation | error classification
             /             |              \
            v              v               v
      Claude transport  Codex transport  Cursor transport
       claude --print    codex exec       cursor-agent --print
```

### Shared contracts

`ModelProvider` is `"claude" | "codex" | "cursor"`.

`ModelTier` is semantic rather than vendor-specific:

- `fast`: small classification and judging work.
- `capable`: repository mapping and component discovery.

The current Cairn pipelines have no deep-reasoning call site, so no third tier
is introduced.

`RunModelOptions` retains the existing prompt, optional system instruction,
JSON Schema, timeout, working directory, purpose, repository/session trace
context, caching, and ambient-context isolation fields. It adds an optional
provider override for API callers and tests.

`RunModelResult` reports the semantic tier, selected provider, actual model
name, parsed structured result, optional provider envelope/usage, duration,
and cache status.

### Provider selection

Selection is deterministic:

1. An explicit per-call provider or CLI `--model-provider` override wins and
   fails clearly if that executable is unavailable.
2. Native plugin markers prefer their own transport:
   `PLUGIN_ROOT` → Codex, `CURSOR_PLUGIN_ROOT` → Cursor, and
   `CLAUDE_PLUGIN_ROOT` → Claude.
3. Shipped plugin commands pass an explicit provider, so a missing host CLI
   fails with provider-specific remediation instead of silently spending a
   different subscription. Marker-based preference remains a fallback for
   custom embeddings that do not pass the flag.
4. Outside a plugin process, Claude remains first for backward compatibility,
   followed by Codex and Cursor.
5. If no transport is installed, model-assisted work follows its existing
   skip/fallback/error path with a provider-neutral diagnostic.

The CLI accepts `--model-provider auto|claude|codex|cursor` anywhere in the
argument list. Plugin MCP and hook commands pass their host explicitly.
This is process-scoped configuration, not a user-facing environment variable
and not committed project configuration.

### Provider transports

#### Claude

The Claude transport preserves the current invocation:

```text
claude --print --output-format json --no-session-persistence
       --model haiku|sonnet
```

`fast` maps to `haiku`; `capable` maps to `sonnet`. System instructions and
JSON Schema continue using Claude CLI flags.

#### Codex

The Codex transport invokes:

```text
codex exec --ephemeral --ignore-user-config --ignore-rules
           --sandbox read-only --skip-git-repo-check --color never
           --model gpt-5.3-codex-spark
```

Prompts are written on stdin. System instructions use the documented
`developer_instructions` configuration override. When a schema is present,
the runner writes it to a private temporary directory and passes
`--output-schema <path>`, then deletes the directory after the subprocess
settles. Both semantic tiers map to `gpt-5.3-codex-spark`; Cairn's prompts and
schemas already define these bounded tasks.

#### Cursor

The Cursor transport invokes:

```text
cursor-agent --print --output-format json --model auto
```

It never passes `--force`. Isolated calls run from a private temporary
workspace containing `.cursor/cli.json` project permissions that deny shell,
read, and write tools (including absolute-path file access); the prompt also
explicitly prohibits tool use and file modification. Cursor does not document an output-schema
flag, so the shared runner appends the schema contract to the prompt, parses
the returned result, and validates it locally.

`auto` is used because Cursor documents it as a durable model-selection
surface but does not publish a stable small-model CLI slug. This avoids
pinning a transient dated model identifier.

## Structured Output and Validation

All provider responses pass through the same decoder:

1. Decode the provider envelope into final text and optional metadata.
2. When `jsonSchema` is present, prefer a provider-native structured value.
3. Otherwise parse the final text as JSON, accepting a single fenced JSON
   block only as a defensive normalization.
4. Convert the caller's JSON Schema with Zod 4 and validate the value locally.
5. Raise `ModelRunnerError` with provider and classified kind when decoding or
   validation fails.

The cache key includes provider, semantic tier, system instruction, prompt,
and schema. Cached answers can never cross providers.

## Isolation and Safety

- Codex always runs in a read-only sandbox and an ephemeral session.
- Cursor is always isolated by the shared runner, regardless of caller
  options. It never receives `--force`, gets a deny-all project tool policy
  in its private temporary workspace, and is told not to use tools or edit
  files.
- Claude retains its existing no-session-persistence behavior.
- Isolated calls run from a newly created temporary directory and ignore
  ambient user/project instructions as far as each CLI permits.
- Prompts are delivered through stdin, not shell interpolation.
- Subprocesses are spawned without a shell.
- Temporary schemas are removed in `finally` paths.

## Naming Cutover

This is a hard cutover, not a compatibility layer:

- `runClaude` → `runModel`
- `ClaudeError` → `ModelRunnerError`
- `ClaudeTier` → `ModelTier`
- `haikuCalls` and related operational counters → `modelCalls`
- `.cairn/cache/haiku` → `.cairn/cache/model`
- new trace rows use source `model` and include `provider`

Historical changelog entries and Claude-specific host features retain their
accurate names. Version `0.33.0` is the hard release boundary:

- safe migration `0010-model-backend-hard-cut` rewrites legacy session status
  fields and event kinds to the provider-neutral schema;
- the same migration deletes the disposable `.cairn/cache/haiku` tree instead
  of translating entries that the new cache cannot read;
- runtime readers and GC contain no legacy Claude/Haiku compatibility paths
  after the migration ships; and
- provider availability without an explicit argument means the configured
  effective provider is available, not merely that some supported CLI exists.

## Testing

No live model request is required.

A smoke creates temporary fake executables named `claude`, `codex`, and
`cursor-agent`, places them first on `PATH`, and exercises the real subprocess
runner. It verifies:

- provider selection and availability fallback;
- exact model mappings and safety flags;
- stdin prompt delivery;
- Codex temporary output-schema lifecycle;
- Claude, Codex, and Cursor response decoding;
- shared schema validation and provider-neutral errors;
- cache isolation between providers;
- configured-provider failure when a different provider remains installed;
- mandatory Cursor isolation even when a caller omits the isolation option;
- hard-cut migration of legacy status state and deletion of legacy cache;
- timeout cleanup.

Existing model-assisted smokes continue using injected judges or fixtures.
The final gate is typecheck, build, version check, the complete default smoke
suite, bundle/layout checks, and diff hygiene. Live Claude, Codex, and Cursor
model calls remain excluded to protect plan credits.

## Documentation

README, architecture documentation, plugin documentation, CLI help, and the
changelog will state that Cairn uses the active host's authenticated CLI.
They will identify Codex Spark explicitly and explain the
`--model-provider` override.

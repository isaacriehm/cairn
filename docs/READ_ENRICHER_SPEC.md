---
type: spec
status: draft-v1
audience: dual
generated: 2026-05-03
depends-on:
  - docs/PRIMER.md (§8 Claude Code integration)
  - docs/DOCS_SPEC.md (§5 token efficiency)
  - docs/FILESYSTEM_LAYOUT.md
---

# Harness — PostToolUse Hooks Spec

Two PostToolUse hooks registered by `harness init`: the **read enricher** (on `Read`) and the **write guardian** (on `Write` and `Edit`). Both follow the same safety contract: enrich or warn, never block. Crashes are no-ops.

---

## Read Enricher

The read enricher is a PostToolUse hook registered on Claude Code's `Read` tool. When Claude reads a source file containing harness citation comments, the enricher intercepts the tool response and prepends a compact **citation legend** — resolving each ID to its current title and status without requiring a separate MCP round-trip.

---

## 1. Why this exists

Without the enricher, when Claude reads a file containing `// §V0023`, it either:
- Ignores the citation (loses the context it was meant to carry), or
- Makes a `harness_invariant_get("V0023")` call to resolve it (costs ~150 tokens and a round-trip)

With the enricher, the resolution arrives in the same response as the code. No MCP call. No token overhead for the request. The agent sees invariant context at the exact line where it matters.

At 3 citations per file, that's ~450 tokens saved per read. At 10 files touched per run, that's 4,500 tokens.

---

## 2. Hook registration

The enricher registers as a PostToolUse hook in `.claude/settings.json` written by `harness init`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "harness hook read-enrich"
          }
        ]
      }
    ]
  }
}
```

`matcher: "Read"` — the hook fires only on `Read` tool calls. Not on `Write`, `Edit`, `Bash`, or any other tool.

---

## 3. Input / output contract

### Input (stdin JSON from Claude Code)

```json
{
  "tool_name": "Read",
  "tool_input": {
    "file_path": "/path/to/file.ts"
  },
  "tool_response": {
    "content": "<raw file content as returned by Read>"
  }
}
```

### Output (stdout JSON to Claude Code)

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "modified_tool_response": {
      "content": "<legend block prepended to raw file content>"
    }
  }
}
```

If the enricher finds no citations, it returns `continue: true` with the original `tool_response` unmodified — zero overhead on clean files.

If the enricher crashes (any uncaught exception): exit 0, write the original content unchanged. Never exit non-zero from a PostToolUse enricher — Claude Code interprets that as a hook failure and surfaces an error.

---

## 4. Citation patterns

The enricher scans file content for two patterns, language-agnostic:

| Pattern | Regex | Example |
|---------|-------|---------|
| Invariant citation | `§V(\d+)` | `// §V0023`, `# §V0023`, `/* §V0023 */` |
| Linked TODO | `TODO\(TSK-([^)]+)\)` | `// TODO(TSK-auth-refactor)`, `# TODO(TSK-2026-05-03-1)` |

The scan is over raw file content — it matches regardless of comment syntax. This handles all language comment formats (JS/TS `//`, Python/Shell `#`, SQL `--`, CSS `/* */`, HTML `<!-- -->`) without a per-language parser. If the pattern appears in a string literal rather than a comment, the legend entry is noise but causes no harm.

Patterns that are explicitly **not scanned** (per PRIMER.md §10 anti-patterns):
- `DEC-\d+` anywhere — DEC-id inline comments are banned. If the enricher encounters one, it adds a policy violation entry to the legend (see §5 below).

---

## 5. Legend format

When ≥1 citation is found, the enricher prepends:

```
┌─ harness citations ──────────────────────────────────────┐
│ §V0023  → null-check before array destructure             │
│          sensor: sensors/v0023-null-check.ts  [active]   │
│ §V0041  → no direct db writes in route handlers           │
│          sensor: sensors/v0041-db-write.ts    [active]   │
│ TODO(TSK-auth-refactor) → bearer token validation [active, est:4h] │
└──────────────────────────────────────────────────────────┘
```

The block is pure text — no markdown, no special formatting. Claude parses it as readable context before the code, not as structured data.

### Resolution states

| State | Legend text |
|-------|-------------|
| Active invariant | `→ <title>  sensor: <path>  [active]` |
| Superseded invariant | `→ <title>  [SUPERSEDED by §V<M> — update this citation]` |
| Not found | `→ [NOT FOUND — orphaned citation, GC will flag on next pass]` |
| Active task | `→ <title>  [active, est:<estimate>]` |
| Done task | `→ <title>  [DONE — this TODO can be removed]` |
| Not found task | `→ [NOT FOUND — orphaned TODO, GC will flag on next pass]` |
| DEC-id comment (policy violation) | `→ [POLICY VIOLATION — DEC-id inline comments are banned. Remove this comment. See PRIMER.md §10.]` |

The agent is expected to act on `SUPERSEDED`, `DONE`, and `POLICY VIOLATION` entries during the current run if the task touches the relevant file. If it doesn't touch the file, it ignores them — GC handles the cleanup on the next pass.

---

## 6. Resolution sources

The enricher resolves citations from disk directly (no MCP call, no subprocess):

| Citation type | Source |
|---------------|--------|
| `§V<N>` | `.harness/ground/invariants/invariants.ledger.yaml` |
| `TODO(TSK-<id>)` | `.harness/tasks/active/<id>/status.yaml` → if not found, `.harness/tasks/done/<id>/attestation.yaml` |
| File-scoped decisions/invariants | `.harness/ground/scope-index.yaml` — O(1) lookup of `files[<repo-relative-path>]` |

Both reads are in-process. The enricher loads each ledger YAML once per hook invocation (not once per citation), with mtime-keyed caching across hook invocations. For a file with 5 invariant citations, that's 1 ledger read + 1 scope-index read + 5 map lookups — total latency < 5ms.

The enricher does NOT call `harness_invariant_get` or any MCP tool. It reads the ledgers directly. This is the correct boundary: the enricher is a hook process (trusted, runs as the operator), not an agent (untrusted, reads via MCP only).

### 6.1 Scope-index integration (replaces glob evaluation)

When the file being read has an entry in `scope-index.yaml`, the legend prepends a "Decisions / invariants in scope of this file" header listing the IDs (titles fetched from the same in-process ledger cache):

```
┌─ harness citations ──────────────────────────────────────┐
│ Decisions in scope: DEC-0042, DEC-0089                   │
│ Invariants in scope: §V0041, §V0052                      │
│ §V0023  → null-check before array destructure  [active]  │
│ TODO(TSK-auth) → bearer token validation  [active]       │
└──────────────────────────────────────────────────────────┘
```

This means the agent sees the full set of rules applicable to the file as it reads — no separate `harness_decisions_in_scope` call needed for the most common case. If the scope-index has no entry for the file (or `unscoped: true`), the in-scope lines are omitted (zero overhead). If the entry has empty `decisions` and empty `invariants`, both lines are omitted.

This replaces the older design where the enricher would have evaluated each decision's `scope_globs` against the file path on every Read — that approach was reactive (new files were silently uncovered) and slow (N decisions × pattern match). Scope-index makes it a single map lookup per file.

---

## 7. Performance

| Condition | Overhead |
|-----------|----------|
| File with 0 citations | ~1ms (regex scan, no match) |
| File with N citations | ~2ms + N × 0.1ms (map lookup) |
| Ledger not found (pre-adoption) | ~0.5ms (stat miss, no-op) |
| Hook crash | ~0ms (pass-through, exit 0) |

The enricher must complete in < 50ms. If ledger read exceeds 10ms (large ledger), cache the parsed ledger in a process-local LRU keyed by `(repoRoot, ledger-mtime)`. Invalidate on mtime change.

---

## 8. Repo root resolution

The enricher resolves `repoRoot` the same way the SessionStart hook does: walk up from `file_path` to find the nearest `.harness/` ancestor. Cache the result in `~/.local/harness/state/<cwd-hash>/repo-root` to avoid repeated walks.

If no `.harness/` ancestor is found: pass through unmodified. The hook is a no-op for files outside harness-adopted projects.

---

## 9. What is NOT enriched

| Not enriched | Reason |
|---|---|
| Binary files | Regex scan exits early on non-UTF-8 content |
| Files in `.archive/` | Historical zone; agents shouldn't be reading these anyway |
| Files in `.harness/ground/` | Ground state files don't contain inline citations |
| Files > 500KB | Skip enrichment, pass through raw. A 500KB file is unusual; if citations matter, the agent fetches them explicitly. |
| Write / Edit tool calls | Enrichment is read-only. No enrichment on write path. |

---

## 10. Interaction with SessionStart

The enricher and SessionStart are complementary, not redundant:

- **SessionStart** injects the *ledger summaries* — the agent knows what decisions and invariants exist in scope, in aggregate.
- **The enricher** injects *point-of-use context* — when the agent reads a specific file, it sees which invariants apply to *this code* without having to correlate ledger IDs to file locations.

Neither replaces the other. Together they mean the agent has global ground state at session start AND local citation context at read time.

---

## 11. Implementation

Package: `harness-core`

```
src/hooks/post-tool-use/
├── read-enricher.ts        — entry point: parse stdin, call enrichFile(), write stdout
├── citation-scanner.ts     — regex scan over file content → CitationMatch[]
├── legend-builder.ts       — CitationMatch[] + LedgerData → legend string
├── ledger-reader.ts        — read + cache invariants.ledger.yaml + task dirs
└── repo-root-resolver.ts   — walk up from file_path to find .harness/ ancestor
```

CLI entry point: `harness hook read-enrich` (added to `harness-cli` command map alongside `harness hook session-start`).

---

## 12. Anti-patterns

| Anti-pattern | Why rejected |
|---|---|
| **Call MCP tools from within the enricher** | Enricher is a hook process, not an agent. Direct disk reads are faster and don't require MCP server to be running. |
| **Modify the actual file on disk** | Enricher only modifies the in-flight tool response. The file on disk is never touched. |
| **Run on Write/Edit tool calls** | Write enrichment would interfere with the agent's write intent. Read-only. |
| **Use PreToolUse instead** | PreToolUse can block the tool call if it crashes. PostToolUse passes through on crash. For enrichment, PostToolUse is always correct. |
| **Per-language comment parsers** | Over-engineered. Pattern matching on `§V\d+` anywhere in the file is sufficient. |
| **Enrich on every Read regardless of content** | Regex scan exits fast on no-match. But skip enrichment entirely for binary files and files > 500KB. |

---

## Write Guardian

### Purpose

Internal copy leaking into user-facing strings is subtle and hard to catch at review time. The write guardian fires on every `Write` or `Edit` call to a UI-surface file and scans the new content for internal-pattern leakage — injecting a warning into the tool result while the agent is still in context and can self-correct.

This is better than a pre-commit sensor because the agent acts on the warning immediately, not after it has moved on to other files.

### Hook registration

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write",
        "hooks": [{ "type": "command", "command": "harness hook write-guard" }]
      },
      {
        "matcher": "Edit",
        "hooks": [{ "type": "command", "command": "harness hook write-guard" }]
      }
    ]
  }
}
```

### Trigger conditions

The write guardian only activates when the file being written matches `copy_safety_globs` in `.harness/config/sensors.yaml`. Proposed at init for any project with a detected frontend:

```yaml
copy_safety:
  enabled: true
  globs:
    - "src/**/*.tsx"
    - "src/**/*.jsx"
    - "src/**/*.vue"
    - "src/**/*.svelte"
    - "**/*.html"
    - "src/**/i18n/**/*.json"
    - "src/**/locales/**/*.json"
```

Files outside these globs: guardian is a no-op.

### What it scans for

Scanned in the new/modified content only (not the whole file — only the changed regions for `Edit` calls):

| Pattern | What it catches |
|---------|----------------|
| `TODO\|FIXME\|HACK\|XXX\|TEMP\|WIP` | Comment markers in display strings |
| `§V\d+\|TSK-[a-z0-9-]+` | Harness citations in UI copy |
| `\[PLACEHOLDER\]\|\[TODO\]\|\[DRAFT\]` | Draft markers |
| `\b[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}\b` | Multi-underscore identifiers (snake_case in display strings) |
| `src/\|packages/\|\.harness/` | Internal path strings |
| `console\.(log\|warn\|error)\s*\(.*["']` | Debug strings that could reach rendered output |

Scanned only within string literals in JSX text positions, template string content, and JSON value strings — not in import paths, variable names, or pure code positions. Uses a lightweight AST scan (not regex on raw text) for TSX/JSX to avoid false positives in code expressions.

### Warning format

```
⚠ harness:copy-safety — 2 potential internal copy issues in src/components/auth/LoginForm.tsx:
  line 47  "TODO: replace with real error message"  → comment-marker in JSX text
  line 83  "§V0041"  → harness citation in display string

If intentional, add to copy-safety allowlist in .harness/config/sensors.yaml:
  copy_safety_allowlist: ["TODO: replace with real error message"]
Write succeeded. Review before committing.
```

The warning is appended to the tool response — the write still succeeds. The agent sees the warning in its tool result and decides whether to act on it now or continue.

### Copy-safety allowlist

Strings that should be in UI copy but match the patterns (e.g. a legitimate "TODO" feature name, or a technical error code) can be allowlisted:

```yaml
copy_safety:
  allowlist:
    - "Error code: AUTH_FAILED"   # intentional technical copy
    - "TODO App"                  # product name happens to contain TODO
```

### Scope-index integration (replaces glob evaluation)

In addition to the copy-safety scan, the write guardian does a single O(1) scope-index lookup against `.harness/ground/scope-index.yaml` for the file being written. When the file has decisions or invariants in scope, the guardian appends a reminder block to the tool result:

```
ℹ harness:scope — this file has rules in scope:
  decisions: DEC-0042, DEC-0089
  invariants: §V0041, §V0052
  Read the full text via harness_decision_get / harness_invariant_get before
  assuming what they require.
```

When the scope-index returns no entry (or `unscoped: true`): the section is omitted (zero overhead). When the entry has only one of the two arrays populated: only the populated row is shown.

This replaces the older design where the guardian would have evaluated each decision's `scope_globs` against the file path on every Write/Edit — that approach was reactive (new files were silently uncovered) and slow (N decisions × pattern match). Scope-index makes it a single map lookup per write.

### Layer D backstop

The write guardian is not a replacement for the Layer D copy-safety sensor. The sensor runs on the complete diff at commit time and catches anything the write guardian missed (e.g. content assembled from multiple writes, or copy in files outside `copy_safety_globs`). The guardian is the early warning; the sensor is the gate.

### Implementation

```
src/hooks/post-tool-use/
├── write-guardian.ts       — entry point: parse stdin, call scanNewContent(), write stdout
├── copy-scanner.ts         — AST scan of JSX/TSX + pattern scan of JSON/HTML → CopyIssue[]
└── allowlist-reader.ts     — load copy_safety allowlist from sensors.yaml
```

CLI entry point: `harness hook write-guard`.

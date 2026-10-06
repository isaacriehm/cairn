# Demo transcript

A real run of the published CLI against a fresh repository. It shows Cairn
adopting the repo, recording a decision, letting a compliant edit through,
and blocking two kinds of drift at commit time and again in CI.

- **Recorded:** 2026-10-05, `@isaacriehm/cairn@0.33.0` from npm, Node 24, macOS.
- **Isolation:** run under a throwaway `HOME`, so no existing Cairn or Claude
  Code config was involved.
- **Edits to the output:** absolute paths are replaced with `<demo>`.
  Nothing else was changed, reordered, or removed. Blank lines separate
  commands. `[exit N]` marks a non-zero exit status.

The decision is recorded with `mcp-call.mjs`, a small MCP client (source
below). It calls `cairn_record_decision` on `cairn mcp serve`, the same call
an agent makes through the plugin. The CLI has no subcommand for calling MCP
tools directly.

Before the first command, the script ran `git init`, wrote a one-line
`package.json`, and wrote this file:

```ts
// src/auth/tokens.ts
export const TOKEN_TTL_SECONDS = 24 * 60 * 60;

export function issueToken(userId: string) {
  return { userId, expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000 };
}
```

```console
$ npm install -g --prefix <demo>/npm --silent @isaacriehm/cairn@0.33.0

$ cairn --version
0.33.0

$ git add -A && git commit -q -m "initial" && git log --oneline
8205874 initial

$ cairn init --no-prompt

── Cairn init — <demo>/demo-api

  Scanning…
    ✓  git root       <demo>/demo-api
    ✓  project slug   demo_api
    ⚠  remote         local-only repo
    ✓  stack          typescript
    ✓  codebase scan  2 files, 2 dirs
    ✓  Model runner   claude CLI available

── Init mapper skipped (--no-prompt mode; pass mockMapperOutput to test the apply path)

── Seeding .cairn/
  + .github/workflows/cairn-check.yml
  + .claude/rules/cairn.md
  + .cairn/JOIN.md
  + .cairn/ground/product/personas.yaml
  + .cairn/ground/product/positioning.md
  + .cairn/ground/canonical-map/topics.yaml
  + .cairn/ground/brand/overview.md
  + .cairn/ground/brand/voice.md
  + .cairn/git-hooks/commit-msg
  + .cairn/git-hooks/post-commit
  + .cairn/git-hooks/pre-commit
  + .cairn/config/sensors.yaml
  + .cairn/config/stub-patterns.yaml
  + .cairn/config/trust-policy.yaml
  + .cairn/config/workflow.md

── Writing .cairn/config.yaml
  + .cairn/config.yaml

── Writing .cairn/ground/scope-index.yaml
  + .cairn/ground/scope-index.yaml

  Phase 13 — multi-dev enforcement install…
    Hosts detected: node-package-json; prepare patched: no
    package.json detected — Claude Code contributors get the SessionStart bootstrap banner; CLI-only contributors run `cairn join` once after `npm install`

  Adopted demo_api in 32ms.
  - 0 active rules baseline verified.
  - 0 new decision drafts found.
  - 0 unpromoted candidates indexed.

  Run `cairn attention` to review drafts and commit them to the ledger.

  Log               ~/.local/cairn/logs/init-2026-10-06T03-32-37-410Z.log

$ cairn join
cairn join — <demo>/demo-api
  cli=0.33.0 project=0.33.0
  ✓ locate-repo           <demo>/demo-api
  ✓ version-check         cairn_version=0.33.0
  ✓ set-hooks-path        core.hooksPath = .cairn/git-hooks
  ✓ chmod-hooks           3 hooks marked executable
  ✓ ensure-sessions-dir   created <demo>/demo-api/.cairn/sessions
  ✓ seed-attested-commits  seeded 1 pre-existing SHA — bypass detection grandfathers them
  ✓ write-cli-path        cli invocation: "<demo>/npm/bin/cairn"
  ✓ rebuild-derived       rebuilt 0 DEC + 0 INV → 0 bindings, 0 cache entries

cairn join: bootstrapped

$ git add -A && git commit -q -m "chore: adopt cairn" && git log --oneline -1
0869421 chore: adopt cairn

$ cat <demo>/decision.json
{
  "title": "Auth tokens expire after 24 hours",
  "summary": "Short-lived bearer tokens are a compliance requirement.",
  "scope_globs": ["src/auth/**"],
  "assertions": [{
    "id": "a1",
    "kind": "text_must_match",
    "pattern": "TOKEN_TTL_SECONDS = 24 \\* 60 \\* 60;",
    "in_globs": ["src/auth/tokens.ts"]
  }]
}

$ node <demo>/mcp-call.mjs cairn_record_decision "$(cat <demo>/decision.json)"
{
  "ok": true,
  "id": "DEC-674be42",
  "target": "accepted",
  "path": ".cairn/ground/decisions/DEC-674be42.md",
  "auto_accepted": true
}

$ git add .cairn && git commit -q -m "docs(decision): auth tokens expire after 24 hours" && git log --oneline -1
10d9bc3 docs(decision): auth tokens expire after 24 hours

$ printf '\n// Tokens are opaque to clients.\n' >> src/auth/tokens.ts && git commit -q -am 'docs(auth): note token opacity' && git log --oneline -1
e261a51 docs(auth): note token opacity

$ sed -i.bak 's/= 24 \* 60 \* 60/= 7 * 24 * 60 * 60/' src/auth/tokens.ts && rm src/auth/tokens.ts.bak && git diff -U0 -- src | tail -2
-export const TOKEN_TTL_SECONDS = 24 * 60 * 60;
+export const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

$ git commit -am "perf(auth): extend token TTL to 7 days"
ERROR decision-assertions: DEC-674be42/a1 text_must_match `TOKEN_TTL_SECONDS = 24 \* 60 \* 60;` — no file under src/auth/tokens.ts matches

Cairn pre-commit gate FAILED — 1 hard finding(s). Fix them, then re-commit (or `git commit --no-verify` to bypass; the bypass is flagged at the next session and caught by CI).
[exit 1]

$ git checkout -q -- src/auth/tokens.ts && printf "export function refreshToken(t: string): string {\n  throw new Error(\"not implemented\");\n}\n" > src/auth/refresh.ts && git add src/auth/refresh.ts && git commit -m "feat(auth): add token refresh"
ERROR stub-pattern-catalog: src/auth/refresh.ts:2 matches stub pattern `throw-not-implemented` — throw new Error('not implemented') — empty stub disguised as code.

Cairn pre-commit gate FAILED — 1 hard finding(s). Fix them, then re-commit (or `git commit --no-verify` to bypass; the bypass is flagged at the next session and caught by CI).
[exit 1]

$ git reset -q && rm src/auth/refresh.ts && sed -i.bak "s/= 24 \\* 60 \\* 60/= 7 * 24 * 60 * 60/" src/auth/tokens.ts && rm src/auth/tokens.ts.bak && git commit -q --no-verify -am "perf(auth): extend token TTL to 7 days" && cairn sensor-run --diff HEAD~1..HEAD --strict
ERROR decision-assertions: DEC-674be42/a1 text_must_match `TOKEN_TTL_SECONDS = 24 \* 60 \* 60;` — no file under src/auth/tokens.ts matches

Cairn sensor sweep FAILED — 1 hard finding(s) over HEAD~1..HEAD.
[exit 1]
```

## What each step shows

| Step | Result |
| --- | --- |
| `cairn init --no-prompt` | Seeds `.cairn/`, the git hooks, and a CI workflow. `--no-prompt` skips the model-backed mapper and doc ingestion, so the ledger starts empty. |
| `cairn join` | Points `core.hooksPath` at `.cairn/git-hooks` for this clone. |
| `cairn_record_decision` | Writes `DEC-<hash>.md` and auto-accepts it into the ledger. |
| Comment-only edit to `tokens.ts` | Commits. The assertion still matches. |
| TTL changed to 7 days | Pre-commit blocks it on the decision assertion. |
| `throw new Error("not implemented")` | Pre-commit blocks it on the stub-pattern catalog. |
| `--no-verify`, then the CI command | `cairn sensor-run --diff <range> --strict` exits 1. The generated `cairn-check.yml` workflow runs this on every PR. |

## Reproduce it

Save the helper next to an installed CLI and set `NM` to the
`node_modules` directory of the installed `@isaacriehm/cairn` package. It
bundles `@modelcontextprotocol/sdk`.

```js
// mcp-call.mjs: spawn `cairn mcp serve` and call one tool.
const NM = process.env.NM;
const { Client } = await import(`${NM}/@modelcontextprotocol/sdk/dist/esm/client/index.js`);
const { StdioClientTransport } = await import(`${NM}/@modelcontextprotocol/sdk/dist/esm/client/stdio.js`);
const [tool, json] = process.argv.slice(2);
const client = new Client({ name: "demo", version: "0" });
await client.connect(new StdioClientTransport({ command: "cairn", args: ["mcp", "serve"], env: process.env, stderr: "ignore" }));
const res = await client.callTool({ name: tool, arguments: JSON.parse(json) });
for (const c of res.content) console.log(c.text);
await client.close();
```

The transcript's helper hard-coded that path. This version reads it from
`NM`. Otherwise the two are identical.

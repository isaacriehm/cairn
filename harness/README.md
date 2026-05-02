# @devplusllc/harness

Portable agent harness for solo developers. Runtime workspace package.

> **Status:** Phase 0 scaffold. No functionality yet. See `../docs/INTEGRATION_PLAN.md` for the phased build.

## Two long-lived processes

| Process | Command | Role |
|---------|---------|------|
| Grounding daemon | `harness watch` | File watcher; mechanically regenerates `.harness/ground/` on change. No LLM in hot path. |
| Orchestrator | `harness run` | Frontend adapter ingress (Discord/Notion/CLI), spec tightener, FIFO queue, agent runner, sensor runners, UAT pipeline, garbage collector. |

Both operate against a parallel mirror checkout at `~/.local/harness/repos/<project>/` — never the user's working tree.

## Adoption

```sh
npx @devplusllc/harness init <repo-dir>
```

Detects stack profile (TypeScript/Python/Rails/Go/Rust/unknown), proposes sensors, scaffolds `.harness/` directory, registers MCP server, prompts for frontend adapter setup. See `../docs/INTEGRATION_PLAN.md` Phase 16.

## Trust posture

| Class | Default |
|-------|---------|
| `harness watch` | Read-only on user's working tree; read-write on mirror only. |
| `harness run` | Read-write on mirror only. Pushes to `origin/main` after sensor + reviewer + UAT pass. |
| `harness init` | Write-only inside the adopting repo, scoped to `.harness/` and adapter config files. |

## Off-limits (default)

`.git/`, `.archive/`, `.env`, `node_modules/`. Adopting projects extend via `.harness/config/workflow.md`.

## Dependencies

| Dep | Why |
|-----|-----|
| `discord.js` | Default frontend adapter |
| `smart-whisper` | Local Whisper voice transcription (audio never written to disk) |
| `chokidar` | Filesystem watcher for grounding daemon |
| `simple-git` | Mirror checkout operations |
| `fastify` | Local HTTP for status surface + harness-mcp |
| `pino` | Structured logging |
| `dotenv` | Secrets-only env loading |
| `zod` | Runtime validation at boundaries (env, MCP schemas, adapter contracts) |
| `ws` | WebSocket (Discord gateway helpers) |

## License

TBD.

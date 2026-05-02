---
type: research
status: draft
audience: dual
agent: D
date: 2026-05-01
topic: Discord operator console + local-Whisper voice ingestion for Symphony-shaped harness
---

# Discord + Whisper Feasibility & Design

Operator console for the agent harness. Solo founder sits in a Discord channel; sends text + voice notes; bot routes everything into the harness. Voice transcribed locally on M-series Mac. Zero per-call API cost.

## TL;DR

| Decision | Choice | Rationale |
|---|---|---|
| Local Whisper backend | **whisper.cpp via Homebrew** | Zero Python in stack, Metal+CoreML out of box, 10x realtime on M2+, mature Node bindings |
| Default model | `large-v3-turbo` (Q5_0 quant) | Near large-v2 accuracy at ~6–8x speed; ~800MB on disk |
| Node binding | **`smart-whisper`** npm | Native addon, automatic model offload, PCM streaming, TS-typed |
| Discord SDK | **`discord.js` v14.x** | Node 22+ native TS, biggest ecosystem, project is TS-everywhere |
| Bot framework | **bare discord.js** (no Sapphire) | Surface is small; framework adds dep weight without payoff |
| Service location | **new top-level `harness/` workspace** | Isolates operator-tooling from product code; matches phone-ai precedent |
| Ingress→harness link | **in-process queue (BullMQ)** initially; HTTP later | Same node, same monorepo, no network hop in v0 |
| Diarization | **Deferred** (single-speaker founder voice notes) | Adds Python (pyannote) — out of scope until multi-speaker emerges |
| Audio storage | **Streamed-and-discarded** | PII safety; transcript persists, audio does not |
| ACL | **Single Discord user-ID allowlist** | Solo founder; multi-user comes later if at all |

---

## A. Voice Pipeline — Whisper local

### A.1. Approach comparison

| Dim | whisper.cpp (brew) | openai-whisper (pip) | mlx-whisper (MLX) |
|---|---|---|---|
| Language | C/C++ | Python + PyTorch | Python + MLX |
| Install | `brew install whisper-cpp` | `brew install ffmpeg && pip install openai-whisper` | `pip install mlx-whisper` |
| Stack pollution | None — stays out of pnpm | Adds Python venv, PyTorch (~2GB) | Adds Python venv, MLX |
| Apple Silicon path | Metal + Accelerate + Core ML (Neural Engine) | MPS (Metal Performance Shaders) | Native MLX (unified memory) |
| Relative speed (M2 Pro, 30s clip, large-v3-turbo) | ~3s | ~10s (CPU/MPS) | ~2s (fastest) |
| Realtime factor | ~10x realtime | ~2–3x realtime | ~15x realtime |
| Model file format | GGUF (`ggml-*.bin`) | PyTorch `.pt` | MLX format |
| Node integration | Mature (`smart-whisper`, `nodejs-whisper`) | Spawn python subprocess | Spawn python subprocess |
| Diarization | Not built-in (combine w/ pyannote externally) | Same | Same |
| Streaming PCM | Yes (`whisper-node-addon`, `smart-whisper`) | Limited | Limited |
| Maintained 2026 | Active (ggml-org) | Active but slower release cadence | Active (Apple-backed) |
| Zero-API-cost | Yes | Yes | Yes |

### A.2. Why whisper.cpp wins

- **TypeScript-everywhere law.** The repo bans Python services if avoidable. whisper.cpp is the only path that keeps the stack TS-only — Node calls a native addon, no python subprocess.
- **Speed is sufficient, not maximum.** mlx-whisper is ~30% faster than whisper.cpp on M-series, but whisper.cpp at 10x realtime already turns a 30-second voice note into ~3s of compute. Operator-console latency budget is dominated by Discord round-trip (~1s), not transcription. The 30% speedup doesn't justify a Python service.
- **Apple stack already covered.** Metal acceleration is automatic at compile time on Apple Silicon. Core ML encoder yields 2–3x extra speedup via Neural Engine. Both come with the brew formula.
- **Mature ecosystem.** `smart-whisper` and `nodejs-whisper` are both actively maintained npm packages. `smart-whisper` has automatic model offload/reload — important if we ever run on a small-RAM box.

### A.3. Model choice

| Model | Size on disk | Accuracy (English WER) | Latency 30s clip (M2 Pro, Metal) | Use |
|---|---|---|---|---|
| tiny | 75MB | ~85% | <1s | Disabled — too inaccurate for command intent |
| base | 142MB | ~88% | ~1s | Disabled — same |
| small | 466MB | ~91% | ~2s | Fallback for low-RAM box |
| medium | 1.5GB | ~93% | ~4s | Reasonable |
| **large-v3-turbo (Q5_0)** | **~800MB** | **~95%** | **~3s** | **Default** |
| large-v3 | 3.1GB | ~96% | ~8s | Overkill for short voice notes |

**Default: `large-v3-turbo` Q5_0 quantized.** Near-best accuracy, smaller than medium, faster than medium, fits in unified memory on any M-series machine. Single ~800MB download, cached on first run.

### A.4. Diarization — deferred

| Requirement | Status |
|---|---|
| Single-speaker founder voice notes | Whisper transcript is sufficient |
| Multi-speaker call recordings | Not in v0 scope (phone-ai owns its own transcription path) |
| pyannote (HF model) | Adds Python service, separate venv, HF token, GPU optional |
| WhisperX (combined) | Same Python burden |

Diarization is a second-system requirement. Voice notes from one human in a Discord channel don't need it. Defer until requirement appears.

### A.5. Pipeline flow

```
discord voice attachment (.ogg, opus, 48kHz mono)
  ↓ discord.js fetches attachment URL
  ↓ pipe to ffmpeg: -ar 16000 -ac 1 -f wav -
  ↓ stdin to smart-whisper.transcribe(pcmBuffer, { model: 'large-v3-turbo-q5' })
  ↓ resolves to { text, segments[] }
  ↓ harness intake job
```

Audio file is **never written to disk**. ffmpeg streams from an in-memory buffer (downloaded from Discord CDN) to whisper-cpp via a unix pipe. Original .ogg lives only in Node's request buffer and Discord's CDN.

### A.6. whisper.cpp install commands (verified 2026-current)

```bash
# system
brew install whisper-cpp ffmpeg

# model — fetched once, cached in harness/var/whisper-models/
# pulled at runtime via the npm package's downloader, not via env var
```

The `harness` workspace owns model paths internally — **not** an env var. Per the no-sprawl rule, only Discord bot token + guild ID + allowed user-ID are secrets.

---

## B. Discord Bot — SDK + command surface

### B.1. SDK choice

| SDK | Lang | Runtime | TypeScript story | Verdict |
|---|---|---|---|---|
| **discord.js v14** | TS/JS | Node 22+ | Built-in `.d.ts` since v14, no `@types/...` needed | **Pick** — matches stack |
| discord.py | Python | CPython 3.10+ | N/A | Skip — adds Python service for the operator console |
| Eris | JS | Node | Loose TS, smaller community | Skip — discord.js dominates ecosystem |
| Sapphire (on top of discord.js) | TS | Node 22+ | Excellent | Skip — adds dep weight; our command surface is ~6 commands, doesn't justify a framework |
| `@discordjs/voice` | — | — | — | **Add** if we ever do live voice (not v0) |

discord.js v14.25.x is the current line; requires Node 22.12+. Fits mypal monorepo's Node baseline.

**Sapphire reconsideration:** if the command surface grows past ~15 commands or the harness grows multi-tenant (multiple founders, each with their own Discord server), revisit Sapphire for its precondition / decorator system. Premature now.

### B.2. Command surface

| Surface | Form | Trigger | Handler | Notes |
|---|---|---|---|---|
| Free text | Plain message in allowed channel | message author = allowed user-ID, channel = allowed channel-ID | Intent classifier → harness | Default path; no slash needed |
| `/task` | Slash | `/task title:<str> agent:<str?>` | Direct task creation in harness | Skips intent classifier |
| `/status` | Slash | `/status [agent:<str?>]` | Reads harness state, returns formatted reply | Read-only; safe by default |
| `/review` | Slash | `/review [scope:<str?>]` | Runs review pipeline | Long-running → bot threads + streams updates |
| `/halt` | Slash | `/halt [run_id:<str?>]` | Sends halt signal to harness orchestrator | Privileged: requires confirm reaction |
| `/agent` | Slash | `/agent action:<spawn\|kill\|list>` | Manage agent registry | |
| `/run` | Slash | `/run pipeline:<str>` | Trigger named pipeline | |
| Voice attachment | Auto | Any audio attachment in allowed channel | Pipeline A.5 → intent classifier → harness | Default path for audio |
| Confirmation | Reaction | `🟢` reaction on bot message | Resumes paused task | Reaction-based to avoid extra commands |
| Cancel | Reaction | `🔴` reaction | Aborts pending action | |
| Error surface | Bot reply in thread | On failure | Posts error + retry button | Never mutates user message |

### B.3. Confirmation flow

```
user: "delete the old marketing rewrite phase"
bot:  Are you sure? React 🟢 within 30s to confirm.
       (target: phase 14, marketing-rewrite-2026)
user: 🟢
bot:  Done.
```

Approval gate is **always reaction-based, not slash-based**, so it's a single tap on mobile. 30s timeout. No timeout = silent abort.

### B.4. Error surface

| Failure | Discord behavior | Logging |
|---|---|---|
| Whisper timeout | Bot replies: "Couldn't transcribe — try shorter clip or text." | Logs raw error to harness pino logger |
| Intent classifier low-confidence | Bot replies: "Not sure what you meant. Try one of: `/task`, `/status`, `/review`." | Logs message id + extracted intent |
| Harness queue offline | Bot replies: "Harness is down. Message saved." | Stores message in dead-letter queue, retries on harness boot |
| Harness internal error | Bot replies: "Harness errored: <code>" with thread for stack trace | Full trace only in thread, not main channel |
| Unauthorized user | Silent ignore | Logs attempted user-ID + content hash |

**Never** echo user PII back into the channel from error path. Never include API keys or stack traces in main-channel replies.

### B.5. Service location — `harness/` workspace

| Option | Pro | Con | Verdict |
|---|---|---|---|
| **`harness/` (top-level workspace)** | Clean separation; matches `phone-ai/` precedent; mypal product code untouched | One more workspace | **Pick** |
| Inside `core/` as NestJS module | Reuses NestJS DI, BullMQ wiring | Couples operator-tooling to product API; bloats core build; harness scheduling is operator-not-customer concern | Skip |
| Standalone Fastify (like phone-ai) | Lightweight | No reuse with core BullMQ; reinvents queue infra | Skip |
| External repo | Maximum isolation | Two repos to ship; secrets management 2x; no monorepo workflow | Skip |

`harness/` is structured like:

```
harness/
├── package.json                     # pnpm workspace member
├── tsconfig.json
├── src/
│   ├── discord/
│   │   ├── bot.ts                  # discord.js client bootstrap
│   │   ├── commands/               # slash command registry
│   │   ├── handlers/
│   │   │   ├── message-intake.ts   # plain-message → intent classifier
│   │   │   └── voice-intake.ts     # attachment → whisper → intent
│   │   ├── intent.ts               # text → intent classifier
│   │   └── acl.ts                  # user-ID allowlist
│   ├── whisper/
│   │   ├── transcribe.ts           # smart-whisper wrapper
│   │   └── models.ts               # model download + path mgmt
│   ├── orchestrator/
│   │   ├── symphony-client.ts      # adapter to symphony API
│   │   └── run-store.ts            # in-memory run registry
│   ├── api/
│   │   └── server.ts               # optional fastify ingress (future multi-client)
│   └── index.ts
├── var/
│   └── whisper-models/             # gitignored; model cache
├── eslint.config.mjs
└── README.md
```

Port: `3004` (next free after phone-ai's 3003) — only used if/when we expose an HTTP ingress.

---

## C. Integration shape — Discord → Symphony

### C.1. Data flow

```
[Discord client]
  │  text or audio attachment
  ▼
[Discord API] ─── webhook gateway (websocket) ───▶ [discord.js bot in harness/]
                                                       │
                                            ┌──────────┴──────────┐
                                            │                     │
                                 (text path)│                     │(voice path)
                                            ▼                     ▼
                                   [intent classifier]    [whisper transcribe]
                                            │                     │
                                            │      ◀────transcript text
                                            ▼
                                   [harness intake queue]   ◀── ack to Discord <2s
                                            │
                                            ▼
                                   [orchestrator dispatcher]
                                            │
                                            ▼
                                   [Symphony agent runner]
                                            │
                                            │── progress events ──▶ [harness publisher] ──▶ [bot thread reply]
                                            ▼
                                   [agent run completes]
                                            │
                                            ▼
                                   [harness formatter] ──▶ [bot final reply in thread]
```

Agents **never** talk to Discord directly. Output goes to harness, harness formats and posts. This prevents hallucinated chrome ("As an AI...") leaking into the operator channel and prevents agent compromise from posting arbitrary messages.

### C.2. API surface — ingress↔harness

| Concern | v0 (single process) | v1 (split process) |
|---|---|---|
| Transport | In-process call (TS function imports) | HTTP/JSON via Fastify on port 3004 |
| Queue | BullMQ (already in core stack) — `harness-intake` queue | Same |
| Schema | TypeScript types + zod validation | Same + zod-to-openapi |
| Backpressure | BullMQ rate limit | Same |
| Auth | None (same process) | HMAC-signed shared secret in env |

**v0 is in-process.** No network hop, no HTTP server, no auth. The Discord handler imports the orchestrator client directly. Trades flexibility for simplicity. Migrate to HTTP only if/when a second client (CLI, web UI) needs the harness.

### C.3. Message schema

```ts
// AI: harness intake message — every Discord ingress (text or voice) becomes one of these.
// AI: voiceTranscript present iff sourceKind = "voice".
// AI: confidenceScore is intent-classifier output, not whisper.
// AI: No model-issued confidence used as write gate (see ai-subsystem rule).

type HarnessIntakeMessage = {
  // identity
  messageId: string                  // discord snowflake
  channelId: string                  // discord channel
  authorId: string                   // discord user
  receivedAt: string                 // ISO8601, when bot saw it

  // payload
  sourceKind: 'text' | 'voice'
  text: string                       // either user's typed text OR voice transcript
  attachmentUrls: string[]           // any non-audio attachments (preserved for context)
  voiceTranscript?: {
    language: string                 // ISO 639-1
    durationSec: number
    segments: Array<{ start: number; end: number; text: string }>
    model: string                    // e.g. 'large-v3-turbo-q5'
    transcribedAt: string
  }

  // intent
  intentLabel: string                // e.g. 'task.create', 'status.read', 'review.run'
  intentArgs: Record<string, string | number | boolean>
  confidenceScore: number            // [0..1] from classifier; informational only

  // routing
  threadId?: string                  // discord thread for streaming progress
  correlationId: string              // ulid; one per intake; flows to all child agent runs
}
```

Intent classifier is a small local model OR a rule-based router. **v0: rule-based** — keyword match on first verb, fallback to a slash-command suggestion. LLM-based intent classifier added only if rule-based misclassifies >10% of operator commands.

### C.4. Intent label set (v0)

| Label | Trigger pattern | Handler |
|---|---|---|
| `task.create` | "file a bug...", "make a task...", "track..." | Calls Symphony `createTask` |
| `task.update` | "update task...", "mark...as done" | Calls Symphony `updateTask` |
| `status.read` | "status of...", "where is...", "what's...progress" | Calls Symphony `readStatus` |
| `review.run` | "review...", "audit..." | Calls Symphony `runReview` |
| `halt.run` | "stop...", "cancel...", "kill..." | Calls Symphony `haltRun` |
| `agent.spawn` | "spawn...agent", "run...agent" | Calls Symphony `spawnAgent` |
| `unknown` | Anything else | Bot replies with command-suggestion menu |

---

## D. Security & trust

### D.1. Threat model

| Threat | Mitigation |
|---|---|
| Random Discord user issues `/halt` | ACL: hard-coded user-ID allowlist; non-allowed users get silent ignore |
| Compromised bot token | Token in env var `DISCORD_BOT_TOKEN` (Joi-required, no default); rotate on suspicion |
| Voice note contains PII | Audio buffer never written to disk; transcript is the only persisted form |
| Transcript contains PII | Stored only in harness DB (which is local in v0); same posture as core/ |
| Agent posts hallucinated content | Agents never call Discord API; harness formats and posts |
| Agent injects markdown to spoof bot identity | Bot replies escape backticks + ats; never interprets agent output as Discord-flavored markdown without sanitization |
| Replay attack via re-uploaded audio | Each intake assigned a `correlationId` ULID; harness dedups by `messageId` |
| Discord CDN expiry on attachment URL | Bot fetches attachment within 60s of receipt; CDN URLs valid 24h+ |
| Attachment content scanning | All audio piped through ffmpeg — limits exploit surface from malformed containers |
| Whisper model tampering | Model file SHA-256 verified on first download (smart-whisper does this); pinned hash committed |

### D.2. ACL spec

```ts
// AI: harness ACL — Discord-side gate. Solo founder allowlist.
// AI: Set in env: HARNESS_ALLOWED_USER_IDS=183... (comma-separated snowflakes)
// AI: Set in env: HARNESS_ALLOWED_CHANNEL_IDS=987... (comma-separated)
// AI: Set in env: HARNESS_ALLOWED_GUILD_IDS=234... (comma-separated)
// AI: All three lists are ANDed: must match user AND channel AND guild.

function isAllowed(msg: Message): boolean {
  return (
    allowedGuildIds.has(msg.guildId) &&
    allowedChannelIds.has(msg.channelId) &&
    allowedUserIds.has(msg.author.id)
  )
}
```

Multi-user mode (later) uses Discord roles, not user-IDs.

### D.3. Audio retention policy

| Stage | Where audio lives | Duration | PII posture |
|---|---|---|---|
| Discord CDN | Discord servers | 24h+ (Discord-controlled) | Outside our control |
| Bot fetch | Node response buffer | <1s before pipe to ffmpeg | RAM only |
| ffmpeg | stdin pipe | streamed | RAM only |
| whisper.cpp | stdin pipe | streamed | RAM only |
| Disk | **never written** | n/a | n/a |
| Transcript | harness DB (postgres or sqlite) | retention = task lifetime | Standard PII handling |

**No audio file ever touches disk.** Even tmp files are skipped — ffmpeg reads from a Node buffer, writes to a pipe.

### D.4. Agent → Discord boundary

```
[agent] ──output──▶ [harness formatter] ──post──▶ [Discord]
   ▲                       │
   └─── tools ─────────────┘
        (never includes a discord-post tool)
```

Agents have tools for: file IO, run metadata, task DB. **Not** for Discord posts. The harness formatter is the single egress point. Formatter:

- Strips role prefixes (`I am an AI assistant...`)
- Truncates over Discord 2000-char limit, posts overflow to thread
- Escapes user-mentions (`@everyone`, `@here`) outside intentional ping contexts
- Wraps code blocks correctly
- Adds run-id footer for traceability

---

## E. Latency budgets

| Stage | Budget | Notes |
|---|---|---|
| Discord webhook → bot.onMessage | <300ms | Discord-controlled |
| Attachment download (CDN) | <500ms for ≤1MB | Founder voice notes typically 100–500KB |
| ffmpeg conversion (in-pipe) | <100ms | streamed, no buffering |
| whisper.cpp transcription (30s clip, large-v3-turbo-q5) | **<3s on M2+** | The hard SLA |
| whisper.cpp transcription (60s clip) | <6s | proportional |
| Intent classifier (rule-based) | <50ms | regex matches |
| Harness intake enqueue | <100ms | BullMQ in-process |
| **End-to-end voice → ack in Discord** | **<5s for 30s clip** | dominated by whisper |
| **End-to-end text → ack** | **<2s** | round-trip |
| Symphony agent run | variable | streamed via thread updates |
| Progress update cadence | 1 update / 5s OR 1 / phase change | whichever first |

### E.1. Slow-path handling

| Condition | Behavior |
|---|---|
| Voice note >2min | Bot replies "Long clip — transcribing in background, will reply when done." |
| Whisper exceeds 15s timeout | Bot kills process, replies failure |
| Agent run >10min | Bot creates a thread, posts initial ack, streams updates there instead of main channel |
| Multiple commands queued | BullMQ FIFO per-user; first-in first-out, no parallelism in v0 |

---

## F. Open questions

1. **Symphony spec.** This doc treats Symphony as a black box with `createTask`/`runReview`/`haltRun`/`spawnAgent` methods. Need the actual API surface to lock the integration shape. Is Symphony a TS library, a service, or a CLI?

2. **Where does the operator's intent classifier live?** v0 is rule-based in-bot. v1 candidate: a tiny local LLM (e.g., `ggml-llama-3-8b-instruct` via llama.cpp) for ambiguous cases. Worth the dep weight?

3. **Multi-Discord-channel routing.** v0 is one allowed channel. Should `#tasks`, `#review`, `#alerts` be different routing buckets? If yes, does channel ACL imply intent?

4. **Voice in phone-ai vs harness.** phone-ai already has its own transcription path (caller side). Should they share infrastructure, or is duplication fine because the use cases are independent (phone-ai = customer call recording; harness = founder voice memo)?

5. **Persistence model for harness state.** Use a sidecar SQLite, reuse mypal core's Postgres, or run an in-memory store with periodic JSON dump? In-memory simplest; SQLite cheapest durable option; postgres reuse means harness now depends on core/ being up.

6. **Confirmation reactions on mobile.** Do reaction-based confirms work cleanly in the Discord mobile app? Slash commands with confirm-button might be easier on phone — needs a quick UX test.

7. **What happens if Discord is down?** Operator console becomes silent. Should there be a CLI fallback (`pnpm harness:cmd "task.create ..."`)? Probably yes, since dev-machine outages are rare but Discord outages are not.

8. **Live voice (real-time channel).** Out of scope for v0. If/when in scope: `@discordjs/voice` + whisper.cpp streaming-PCM mode. Worth keeping the door open in `harness/src/discord/voice/` (empty placeholder) so we don't repaint architecture later.

9. **Model upgrade discipline.** Whisper releases happen ~quarterly. Pin model SHA in `harness/whisper/models.ts`; bump intentionally. Do not auto-update.

10. **Bot identity.** Single bot user `mypal-harness-bot` or per-environment (`harness-dev`, `harness-prod`)? Per-environment is cleaner for log filtering but doubles bot token mgmt.

---

## G. Implementation phases (non-binding)

| Phase | Deliverable | LoE |
|---|---|---|
| 0. Workspace bootstrap | `harness/` workspace, pnpm wired, tsconfig, eslint | <1d |
| 1. Whisper wrapper | `transcribe.ts` + model auto-download + smoke test | <1d |
| 2. Discord skeleton | bot.ts boots, ACL, message echo | <1d |
| 3. Voice ingest | attachment → whisper → console.log transcript | 1d |
| 4. Intent classifier (rule-based) | text → label dispatch | 1d |
| 5. Symphony adapter | createTask + readStatus stubs | depends on Symphony spec |
| 6. Streaming progress | thread-per-run, progress events | 1d |
| 7. Confirmation reactions | 🟢 / 🔴 flow | <1d |
| 8. Slash command registry | /task /status /review /halt | 1d |
| 9. Hardening | error surfaces, retries, dead-letter | 1d |
| 10. Live-voice placeholder | empty module with TODO | <0.5d |

Total founder-time estimate, sequentially: ~9 working days. Half that with focused agent execution.

---

## H. Cross-references

| External reference | Used for |
|---|---|
| `phone-ai/` | Architectural precedent for Fastify-style standalone service |
| `core/src/` BullMQ patterns | Queue infra reused in-process for harness intake |
| `.claude/rules/typescript-law.md` | Bans `any`/`unknown` in harness code |
| `.claude/rules/event-naming.md` | If harness emits events, naming rule applies |
| Discord Developer Portal | Bot creation, intent permissions, slash command registration |
| ggml-org/whisper.cpp | Source of truth for model files + Metal/CoreML build flags |

---

## Appendix — sources consulted (2026-current)

- whisper.cpp Homebrew formula + Metal acceleration: https://formulae.brew.sh/formula/whisper-cpp · https://github.com/ggml-org/whisper.cpp
- whisper-cpp on M-series benchmarks: https://itblog.today/blog/building/whisper-metal.html · https://www.voicci.com/blog/apple-silicon-whisper-performance.html
- mlx-whisper benchmarks: https://medium.com/@ingridwickstevens/whisper-asr-in-mlx-how-much-faster-is-speech-recognition-really-5389e3c87aa2 · https://owehrens.com/whisper-nvidia-rtx-4090-vs-m1pro-with-mlx/
- Whisper model accuracy: https://huggingface.co/openai/whisper-large-v3-turbo · https://medium.com/axinc-ai/whisper-large-v3-turbo-high-accuracy-and-fast-speech-recognition-model-be2f6af77bdc
- Node bindings: https://www.npmjs.com/package/smart-whisper · https://www.npmjs.com/package/nodejs-whisper
- discord.js current: https://discord.js.org/ · https://discord.js.org/docs · https://github.com/discordjs/discord.js/releases
- Sapphire framework: https://sapphirejs.dev/ · https://github.com/sapphiredev/framework
- Discord voice message format: https://gist.github.com/HDR/7d5d4ce8bbe4b715d788a9bc9f99e02d
- Slash command permissions: https://discordjs.guide/slash-commands/permissions
- Diarization (deferred): https://huggingface.co/pyannote/speaker-diarization · https://github.com/m-bain/whisperX

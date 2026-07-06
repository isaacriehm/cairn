---
type: rule
status: draft
audience: dual
generated: <seed_timestamp>
verified-at: <seed_timestamp>
source-commits:
  - manual
---

# Brand voice

<!--
WHAT THIS FILE IS

How the brand TALKS. Tone, vocabulary, sentence rhythm, default
register. Read at every SessionStart so Claude matches your voice
in chat replies, commit messages, PR descriptions, marketing copy,
and any operator-facing text it generates.

WHEN TO FILL IT IN

Adoption pre-fills the body with a sensible default derived from your
existing CLAUDE.md / AGENTS.md tone. Edit to add specifics. Flip
`status: draft` → `status: accepted` once it matches reality.

FORMAT

≤200 tokens. Cover four things:
  1. Default register (formal / casual / technical / playful)
  2. Sentence shape (short fragments? full sentences? lists?)
  3. Vocabulary preferences (industry terms YES / NO)
  4. Pet peeves (phrases that immediately feel "off-brand")

Two examples to anchor on:

  Example A (fictional consumer service):
  > Casual, friendly, no jargon. Full sentences but never
  > corporate. Use everyday words: "we'll deliver", not "we shall
  > facilitate delivery". Avoid: "premium", "world-class", "passion
  > for quality" — empty signals that read as filler. Sign emails
  > with first name only.

  Example B (fictional B2B SaaS):
  > Technical, terse, engineer-to-engineer. Drop articles when it
  > reads cleanly ("hook fires" not "the hook fires"). Lead with
  > the answer; preamble dies. Use precise technical terms (HTTP
  > 429 not "rate-limited"). Avoid: "AI-powered", "game-changing",
  > emoji-heavy lists.
-->

(adoption auto-fill writes a default voice profile here; edit to match how your team actually talks)

Design is buildable. I would not start Phase 0 until three fixes land: mirror dirty-overlap gate, decision-assertion DSL expansion, and GC batch safety.

**Architectural Contradictions**

1. **Severity:** should-revisit-soon  
   **Location:** [FILESYSTEM_LAYOUT.md §0](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/FILESYSTEM_LAYOUT.md:22), [RESUME_PROMPT.md L08](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/RESUME_PROMPT.md:74)  
   **Finding:** Notion is both “deferred indefinitely” and a peer frontend adapter. This is easy to misread during implementation.  
   **Suggested resolution:** Rewrite as: “No Notion as state. Notion frontend adapter supported, but not v0 default.”  
   **Evidence:** “Notion | None (deferred indefinitely...)” vs “Notion is a peer.”

2. **Severity:** should-revisit-soon  
   **Location:** [PRIMER.md §4.3](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/PRIMER.md:216), [FILESYSTEM_LAYOUT.md §3](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/FILESYSTEM_LAYOUT.md:190)  
   **Finding:** Current load-bearing docs would fail the proposed frontmatter rule because they lack `verified-at` and `source-commits`.  
   **Suggested resolution:** Add a draft-doc exemption or update the Harness docs now so the harness dogfoods its own rule.  
   **Evidence:** “Frontmatter required on every load-bearing markdown.”

**Missing Assumptions**

3. **Severity:** must-fix-before-build  
   **Location:** [PRIMER.md §5.5](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/PRIMER.md:291), [INTEGRATION_PLAN.md §6.4](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/INTEGRATION_PLAN.md:507)  
   **Finding:** Q3. Mirror checkout race is under-specified. Worst case: operator has local uncommitted edits to `core/src/integrations/oauth-token.service.ts`; harness modifies same file in mirror and pushes; operator later pulls, resolves conflict manually, bypasses sensors, and pushes broken code. No work is directly lost by harness, but the user gets conflict noise and a sensor-blind final state.  
   **Suggested resolution:** Add a `local_dirty_overlap` pre-dispatch/pre-push gate. Since the daemon watches user tree + mirror, pause when dirty local files overlap run target globs.  
   **Evidence:** “User's working tree is sacred” and “User pushed... next task picks up new HEAD.”

4. **Severity:** should-revisit-soon  
   **Location:** [MCP_SURFACE.md §historical](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/MCP_SURFACE.md:199)  
   **Finding:** `harness_query_history` can reintroduce stale claims as summarized truth. The raw stale doc is hidden, but the summary itself can still carry wrong claims.  
   **Suggested resolution:** Return dated, source-bound claims with `historical_only: true`, `superseded_by`, and mandatory canonical cross-check pointers.  
   **Evidence:** “Raw stale content NEVER enters... only the summary does.”

**Honest-Agent Layer Weak Spots**

5. **Severity:** must-fix-before-build  
   **Location:** [PRIMER.md §10](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/PRIMER.md:452), [UAT_PIPELINE.md §5.1](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/UAT_PIPELINE.md:169)  
   **Finding:** Q1. Concrete fake-completion: file `core/src/integrations/oauth-token.service.ts`, symbol `getActiveToken`. Diff adds the required partial unique index but query filters by `provider` only, omitting `user_id`. Attestation claims `behavior: full`; Layer A sees no stub; Layer B matches files/sensors; decision assertions pass because they only check index/text; reviewer sees plausible code; E2E/UAT uses one seeded user, so API transcript proves duplicate insert behavior but not cross-user isolation.  
   **Suggested resolution:** Every high-stakes UAT must include at least one negative/cross-tenant fixture. Decision assertions need query-scope checks.  
   **Evidence:** “High-stakes... integrations” and UAT “acceptance criteria... status: pass.”

6. **Severity:** must-fix-before-build  
   **Location:** [RESUME_PROMPT.md L26](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/RESUME_PROMPT.md:92), [FILESYSTEM_LAYOUT.md §4](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/FILESYSTEM_LAYOUT.md:245)  
   **Finding:** Q2. Current assertion kinds cover schema/text/index/file rules, maybe 60-70% of CRM decisions, not 80%. Missing class: behavioral code-contract assertions.  
   **Suggested resolution:** Add these kinds: `query_must_filter_by`, `route_must_have_guard`, `event_must_emit`, `service_method_must_call`. Example grammar: `kind: query_must_filter_by; orm: drizzle; in_globs: [...]; table; column; param; operator: eq|and`.  
   **Evidence:** Existing kinds are listed without query/guard/event contracts.

**Over-Specification**

7. **Severity:** should-revisit-soon  
   **Location:** [WORKFLOW_GUIDE.md §1](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/WORKFLOW_GUIDE.md:58), [WORKFLOW_GUIDE.md §4.3](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/WORKFLOW_GUIDE.md:212)  
   **Finding:** Q5/Q7. “Always A/B/C/D” breaks when the spec tightener surfaces 5+ orthogonal questions. The UX becomes ceremony by another name.  
   **Suggested resolution:** Cap dialogs at two questions. If more, produce one tightened draft with a single approve/edit/rewrite choice. Threshold `quality_score >= 7` is okay for safe-class, too lenient for code-class; require explicit target files and negative acceptance criteria for high-stakes.  
   **Evidence:** “ALWAYS proposes A/B/C/D” and sample two-question dialog.

**Under-Specification For Portability**

8. **Severity:** must-fix-before-build  
   **Location:** [INTEGRATION_PLAN.md Phase 16](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/INTEGRATION_PLAN.md:431), [FILESYSTEM_LAYOUT.md §11](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/FILESYSTEM_LAYOUT.md:596)  
   **Finding:** Q8. Python FastAPI breaks the split. Generic harness still assumes `.claude/settings.json`, TS-oriented sensors, `pnpm`, OpenAPI/Drizzle conventions, and Claude Code hooks.  
   **Suggested resolution:** Add stack profiles: `typescript-next-nest`, `python-fastapi`, `rails`, `go`, `rust`. Each profile owns sensors, start commands, generated artifacts, and hook capability.  
   **Evidence:** “Detect stack... Cargo.toml, go.mod” but scaffold still adds Claude Code hooks and TS workspace assumptions.

**Tier-Ladder Economics**

9. **Severity:** should-revisit-soon  
   **Location:** [WORKFLOW_GUIDE.md §2.2](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/WORKFLOW_GUIDE.md:115), [INTEGRATION_PLAN.md DoD](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/INTEGRATION_PLAN.md:547)  
   **Finding:** Q5/economics. The $50/day cap is plausible only if runs are short and retries are rare. A normal code run can spend Tier 2 on implementer, reviewer, UAT-runner, and backprop; two retries or Opus escalation can blow the estimate.  
   **Suggested resolution:** Add pre-run projected cost, hard stop before Tier 3, and per-task max attempts. Alarms after spend is recorded are too late.  
   **Evidence:** “Hard alarm at $50/day” and “Cost... < $50/day.”

**Operator-UX Failure Modes**

10. **Severity:** should-revisit-soon  
    **Location:** [WORKFLOW_GUIDE.md §5](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/WORKFLOW_GUIDE.md:339), [UAT_PIPELINE.md §5.3](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/UAT_PIPELINE.md:237)  
    **Finding:** Q7. Notion 5s polling is technically possible for one active page, but bad as a general live surface. Official Notion docs state average 3 requests/sec and variable rate limits; webhooks exist, but aggregated updates can take around a minute.  
    **Suggested resolution:** Keep Notion as UAT/status, not progress streaming. Poll only one active decision property, back off on 429, and document 30-120s degraded latency.  
    **Evidence:** “adapter polls... every 5s” and “Real-time push... polls.”

**Claude-Blindspot Risks**

11. **Severity:** should-revisit-soon  
    **Location:** [PRIMER.md §11](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/PRIMER.md:554), [PRIMER.md §14](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/PRIMER.md:637)  
    **Finding:** Q6. Claude likely over-named the claude-mem issue. Public claude-mem docs describe automatic tool observation capture, semantic summaries, SessionStart injection, and file-read gating; I did not verify “LLM invoked on every tool call to decide whether to remember.”  
    **Suggested resolution:** Replace anti-pattern with “automatic stale-context injection and read-tool interposition.” Keep the deterministic prefilter principle.  
    **Evidence:** PRIMER says “LLM invoked on every tool call”; claude-mem says it captures tool observations and generates summaries.

12. **Severity:** note-for-record  
    **Location:** [PRIMER.md §14](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/PRIMER.md:638), [RESUME_PROMPT.md §6](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/RESUME_PROMPT.md:132)  
    **Finding:** Q10. Quote risk is real but low-rework. I verified the OpenAI page supports AGENTS-as-TOC, custom lint remediation, GC cadence, and “Human taste...” The phrase “Instructions decay, enforcement persists” did not appear in the official OpenAI page I could access.  
    **Suggested resolution:** Mark unsupported “verbatim” lines as “OpenAI-derived principle” unless a primary source proves exact wording.  
    **Evidence:** Current docs label both as “OpenAI verbatim.”

**Profile Risk**

13. **Severity:** should-revisit-soon  
    **Location:** [RESUME_PROMPT.md L05](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/RESUME_PROMPT.md:71), [FILESYSTEM_LAYOUT.md §12](/Users/user/Documents/DevPlus%20LLC/06%20-%20Projects/Harness/docs/FILESYSTEM_LAYOUT.md:618)  
    **Finding:** Q9. Direct commits to `main` is the decision most likely to fail outside Isaac’s profile. Small teams and junior devs need review boundaries.  
    **Suggested resolution:** Add `collaboration_mode: solo | team`. Solo keeps direct-main. Team switches to branch/PR or protected-main with required harness gate.  
    **Evidence:** “NO branches, NO PRs” and “Multi-user identity” omitted.

**External Checks**

Sources checked: [OpenAI Harness Engineering](https://openai.com/index/harness-engineering/), [OpenAI Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/), [openai/symphony README](https://raw.githubusercontent.com/openai/symphony/main/README.md), [Notion request limits](https://developers.notion.com/reference/request-limits), [Notion webhooks](https://developers.notion.com/reference/webhooks), [claude-mem README](https://raw.githubusercontent.com/thedotmack/claude-mem/main/README.md).

**Executive Summary**

Ship v0 next month only after three changes: add local dirty-overlap protection for mirror runs, expand decision assertions beyond schema/text into query/guard/event contracts, and make GC safe-class commits batch-validated with a canary prompt render. Everything else can be v0.1 cleanup. The design is strong enough; the failure mode is not architecture. It is unsensed edge cases hiding behind “safe” labels.

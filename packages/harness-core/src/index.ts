/**
 * @isaacriehm/harness-core — state + context-loading layer.
 *
 * SKELETON: this file will become the public API surface once the file
 * moves land. See docs/ARCHITECTURE.md §3.1 for what belongs here, and
 * RESUME_PROMPT.md for the migration plan.
 *
 * Expected exports (post-move):
 *   - init: runInit, buildRepoSummary, runMapper, validateMapperOutput,
 *     updateWorkflowSlugBlock, MAPPER_OUTPUT_SCHEMA, types
 *   - mcp: server bootstrap + 18 tool registrations
 *   - ground: writers for decisions, invariants, canonical-map,
 *     quality-grades, manifest
 *   - decision-capture: extractor + refinement-proposer
 *   - gc: drift-sweep daemon + auto-merge classifier
 *   - tightener: spec quality gate
 *   - stub-pattern: catalog evaluator
 *   - decision-assertion: evaluator
 *   - claude: subprocess runner + error classifier
 *   - tier0: Ollama classifier
 *   - types: RunPhase, DialogSpec, PostUpdate, FrontendAdapter contract,
 *     ProjectGlobs, …
 *   - logger: pino setup
 */

export const __SKELETON__ = "harness-core";

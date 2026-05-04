/**
 * @isaacriehm/harness-runtime — orchestration consumer.
 *
 * SKELETON: this file will become the public API surface once the file
 * moves land. See docs/ARCHITECTURE.md §3.2 for what belongs here, and
 * RESUME_PROMPT.md for the migration plan.
 *
 * Expected exports (post-move):
 *   - Orchestrator class + OrchestratorOptions
 *   - mirror: ensureMirror, syncMirror, pushMirror, dirty-overlap helpers
 *   - runner: runImplementer (claude --print --output-format stream-json)
 *   - sensors: runSensors, sensor-registry
 *   - reviewer: runReviewerStep, formatReviewerRemediation
 *   - uat: runUatStep, evidence-file gate, persistent UAT.md
 *   - backprop: runBackpropStep
 *   - watchdog: stall detector
 *   - slash command handlers for /halt /status /queue /eval /resume /oops
 *     /archive /unpause /help
 */

export const __SKELETON__ = "harness-runtime";

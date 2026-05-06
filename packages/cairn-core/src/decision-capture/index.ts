/**
 * Decision-capture surface.
 *
 * Only the monotonic id allocators remain — the Tier-1 LLM extractor +
 * refinement pipeline was orchestrator-era code (auto-extract DECs from
 * sessions) that is no longer wired into the plugin flow. Operator-driven
 * DEC creation lives in the `cairn-direction` skill + the
 * `cairn_record_decision` MCP tool now.
 */

export {
  allocateDecisionId,
  allocateInvariantId,
  scanExistingDecisionIds,
  scanExistingInvariantIds,
} from "./id.js";

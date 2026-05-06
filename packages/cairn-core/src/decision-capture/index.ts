/**
 * Decision-capture surface.
 *
 * Only the content-addressed id helpers remain — the Tier-1 LLM extractor
 * + refinement pipeline was orchestrator-era code (auto-extract DECs from
 * sessions) that is no longer wired into the plugin flow. Operator-driven
 * DEC creation lives in the `cairn-direction` skill + the
 * `cairn_record_decision` MCP tool now.
 */

export {
  computeDecisionId,
  computeInvariantId,
  scanExistingDecisionIds,
  scanExistingInvariantIds,
  type DecisionIdInput,
  type InvariantIdInput,
} from "./id.js";

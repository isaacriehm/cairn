// Cairn-aware enrichment helpers. Pure-deterministic detectors applied
// to projected events. Used by ops/cairn.mjs and ops/errors.mjs.

const CAIRN_MCP_PREFIX = "mcp__plugin_cairn_cairn__cairn_";
const CAIRN_SKILL_PREFIX_RE = /^cairn:/i;

/**
 * @param {import("./types.mjs").ProjectedEvent} ev
 */
export function isCairnMcpCall(ev) {
  return ev.kind === "tool_use" && typeof ev.tool === "string" && ev.tool.startsWith(CAIRN_MCP_PREFIX);
}

/**
 * @param {import("./types.mjs").ProjectedEvent} ev
 */
export function isCairnSkillCall(ev) {
  if (ev.kind !== "tool_use" || ev.tool !== "Skill") return false;
  const skill = ev.args?.skill;
  return typeof skill === "string" && CAIRN_SKILL_PREFIX_RE.test(skill);
}

/**
 * Strip the verbose MCP prefix for display.
 * @param {string} toolName
 */
export function shortToolName(toolName) {
  if (!toolName) return toolName;
  if (toolName.startsWith(CAIRN_MCP_PREFIX)) return toolName.slice(CAIRN_MCP_PREFIX.length);
  if (toolName.startsWith("mcp__")) {
    return toolName.replace(/^mcp__[^_]+__/, "");
  }
  return toolName;
}

/**
 * Detect cairn_init_run phase progression. Returns phase id or undefined.
 * @param {import("./types.mjs").ProjectedEvent} ev
 */
export function cairnInitPhase(ev) {
  if (ev.kind !== "tool_use") return undefined;
  if (ev.tool !== `${CAIRN_MCP_PREFIX}init_run`) return undefined;
  const phase = ev.args?.phase;
  return typeof phase === "string" ? phase : undefined;
}

/**
 * Detect attention resolutions. Returns { kind, item_id, choice } when present.
 * @param {import("./types.mjs").ProjectedEvent} ev
 */
export function cairnAttentionResolve(ev) {
  if (ev.kind !== "tool_use") return undefined;
  if (ev.tool !== `${CAIRN_MCP_PREFIX}resolve_attention`) return undefined;
  const a = ev.args ?? {};
  return {
    kind: typeof a.kind === "string" ? a.kind : undefined,
    item_id: typeof a.item_id === "string" ? a.item_id : undefined,
    choice: typeof a.choice === "string" ? a.choice : undefined,
  };
}

/**
 * Detect record_decision calls (operator-driven decision writes).
 * @param {import("./types.mjs").ProjectedEvent} ev
 */
export function cairnRecordDecision(ev) {
  if (ev.kind !== "tool_use") return undefined;
  if (ev.tool !== `${CAIRN_MCP_PREFIX}record_decision`) return undefined;
  return ev.args ?? {};
}

/**
 * Is this event a tool failure? Either an explicit tool_result with
 * is_error=true, or a system event with non-empty hook_errors.
 * @param {import("./types.mjs").ProjectedEvent} ev
 */
export function isErrorEvent(ev) {
  if (ev.kind === "tool_result" && ev.is_error) return true;
  if (ev.kind === "system" && Array.isArray(ev.hook_errors) && ev.hook_errors.length > 0) return true;
  return false;
}

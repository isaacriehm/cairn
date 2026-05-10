/**
 * Mission orchestration — helpers for the `cairn_mission_*` MCP tools.
 * State + I/O lives in `@isaacriehm/cairn-state`; this module holds
 * the LLM call (Haiku doc-parse), cursor advance, and task linkage.
 */

export {
  draftRoadmapFromSpec,
  stubRoadmap,
  type DraftRoadmapArgs,
  type DraftRoadmapResult,
} from "./draft.js";
export {
  advancePhase as advanceMissionPhase,
  allPhaseTasksDone,
  lookupPhase,
  type AdvanceResult,
  type AdvanceError,
} from "./cursor.js";
export {
  onTaskCompleted,
  readTaskMissionAnchor,
  linkTaskToPhase,
  type TaskMissionAnchor,
  type TaskCompletionLink,
} from "./task-link.js";
export {
  listMissions,
  loadDraftFromFile,
  previewRoadmap,
  runMissionAccept,
  runMissionAdvance,
  runMissionClose,
  runMissionGet,
  runMissionReopen,
  runMissionStart,
  writeDraftToFile,
} from "./cli.js";

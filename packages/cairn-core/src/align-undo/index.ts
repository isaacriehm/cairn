/**
 * Layer A undo log + `cairn attention undo` runner. Plan §11.7.
 */

export {
  AlignUndoEntry,
  alignUndoLogPath,
  appendAlignUndoEntry,
  pruneAlignUndoLog,
  readAlignUndoLog,
} from "./log.js";
export { runAttentionUndo } from "./undo.js";
export type { UndoArgs, UndoEntryOutcome, UndoResult } from "./undo.js";

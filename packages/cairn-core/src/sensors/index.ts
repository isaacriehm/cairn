export type {
  DiffEntry,
  SensorFinding,
  SensorLanguage,
  SensorResult,
  SensorSweepResult,
  StubCatalog,
  StubPattern,
} from "./types.js";

export {
  getDiff,
  getStagedDiff,
  getRangeDiff,
  diffHasGlobMatch,
  filterDiffByGlobs,
} from "./diff.js";
export { loadStubCatalog, parseStubCatalog, loadSensorRegistry } from "./catalog.js";
export type { SensorRegistry, SensorRegistryEntry } from "./catalog.js";
export { detectStubMatches, runStubCatalog, detectLanguage } from "./stub-catalog.js";
export type { StubMatch } from "./stub-catalog.js";
export {
  loadAcceptedDecisions,
  decisionsInScope,
  listMirrorFiles,
  runDecisionAssertions,
} from "./decisions.js";
export { formatRemediation } from "./remediation.js";
export type { RemediationOptions } from "./remediation.js";
export { runSensorsOnDiff } from "./runner.js";
export type { RunSensorsOnDiffArgs } from "./runner.js";

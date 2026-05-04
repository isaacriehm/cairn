export type {
  Attestation,
  AttestationDelivered,
  AttestationDeferred,
  DiffEntry,
  ProjectGlobs,
  SensorFinding,
  SensorInput,
  SensorLanguage,
  SensorResult,
  SensorSweepResult,
  StubCatalog,
  StubPattern,
} from "./types.js";

export { getDiff, diffHasGlobMatch, filterDiffByGlobs } from "./diff.js";
export { loadStubCatalog, parseStubCatalog, loadSensorRegistry } from "./catalog.js";
export type { SensorRegistry, SensorRegistryEntry } from "./catalog.js";
export { detectStubMatches, runStubCatalog, detectLanguage } from "./stub-catalog.js";
export type { StubMatch } from "./stub-catalog.js";
export {
  extractAttestation,
  runAttestationCrossCheck,
} from "./attestation.js";
export {
  runRouteHandlerNonEmpty,
  runDtoNoFakeFields,
} from "./structural.js";
export {
  loadAcceptedDecisions,
  decisionsInScope,
  listMirrorFiles,
  runDecisionAssertions,
} from "./decisions.js";
export { formatRemediation } from "./remediation.js";
export type { RemediationOptions } from "./remediation.js";
export { runSensors } from "./runner.js";
export type { RunSensorsArgs } from "./runner.js";

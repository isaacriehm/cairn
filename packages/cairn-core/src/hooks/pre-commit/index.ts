/**
 * Layer B git pre-commit hooks. Detection-only — never modifies the
 * commit, never blocks. The runner is invoked from the bundled
 * `.cairn/git-hooks/pre-commit` shell template via
 * `cairn hook pre-commit-align`.
 */

export {
  alignStagedTree,
  runPreCommitAlign,
} from "./sot-align-precommit.js";
export type {
  PreCommitAlignArgs,
  PreCommitAlignResult,
} from "./sot-align-precommit.js";

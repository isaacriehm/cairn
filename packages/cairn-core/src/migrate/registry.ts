/**
 * Ordered migration registry. New migrations append here, tagged with the
 * `introducedIn` version that requires their state shape.
 *
 * Release gate: any release that changes the `.cairn/` contract must ship a
 * migration here and link it from CHANGELOG.
 */

import type { Migration } from "./types.js";
import { dropDeadConfigFields } from "./migrations/0001-drop-dead-config-fields.js";
import { backfillGitignore } from "./migrations/0002-backfill-gitignore.js";
import { pruneScaffolding } from "./migrations/0003-prune-scaffolding.js";
import { dropGlobSettings } from "./migrations/0004-drop-glob-settings.js";
import { demoteAutofilledBrand } from "./migrations/0005-demote-autofilled-brand.js";
import { pruneSotAlignInvariants } from "./migrations/0006-prune-sot-align-invariants.js";
import { collapseComponentDirs } from "./migrations/0007-collapse-component-dirs.js";
import { cleanAdoptionScaffolding } from "./migrations/0008-clean-adoption-scaffolding.js";
import { repairArchivedCites } from "./migrations/0009-repair-archived-cites.js";

export const MIGRATIONS: readonly Migration[] = [
  dropDeadConfigFields,
  backfillGitignore,
  pruneScaffolding,
  dropGlobSettings,
  demoteAutofilledBrand,
  pruneSotAlignInvariants,
  collapseComponentDirs,
  cleanAdoptionScaffolding,
  repairArchivedCites,
];

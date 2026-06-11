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

export const MIGRATIONS: readonly Migration[] = [
  dropDeadConfigFields,
  backfillGitignore,
  pruneScaffolding,
  dropGlobSettings,
];

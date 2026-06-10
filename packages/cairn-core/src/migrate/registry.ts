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

export const MIGRATIONS: readonly Migration[] = [dropDeadConfigFields, backfillGitignore];

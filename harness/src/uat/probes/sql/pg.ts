/**
 * Postgres driver — placeholder. Phase 11.5b adds the live `pg` client
 * + connection pool. Until then probes referencing a postgres connection
 * receive a structured error so the operator knows to opt in.
 */

import type { SqlDriver } from "./types.js";

export const pgDriver: SqlDriver = {
  kind: "postgres",
  async query() {
    throw new Error(
      "postgres driver not yet implemented — opt in via Phase 11.5b setup, or use sqlite for v1",
    );
  },
};

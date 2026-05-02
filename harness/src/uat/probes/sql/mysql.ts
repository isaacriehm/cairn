/**
 * MySQL driver — placeholder. Phase 11.5b adds the live `mysql2` client.
 */

import type { SqlDriver } from "./types.js";

export const mysqlDriver: SqlDriver = {
  kind: "mysql",
  async query() {
    throw new Error(
      "mysql driver not yet implemented — opt in via Phase 11.5b setup, or use sqlite for v1",
    );
  },
};

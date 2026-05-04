/**
 * sqlite driver — lazy-loads `better-sqlite3`.
 *
 * v1 sqlite is the only fully-functional driver. Operator runs
 * `harness setup:uat-sql` to install better-sqlite3; smoke skips
 * gracefully if the package is missing.
 */

import type { SqliteConnection, SqlDriver, SqlQueryResult } from "./types.js";

interface BetterSqlite3Like {
  default?: BetterSqlite3Ctor;
}

interface BetterSqlite3Ctor {
  new (file: string, opts?: { readonly?: boolean }): BetterSqlite3Db;
}

interface BetterSqlite3Db {
  prepare(sql: string): BetterSqlite3Stmt;
  close(): void;
}

interface BetterSqlite3Stmt {
  all(...params: unknown[]): unknown[];
  raw(toggle: boolean): BetterSqlite3Stmt;
  reader: boolean;
}

let cachedCtor: BetterSqlite3Ctor | null | undefined;

async function loadDriver(): Promise<BetterSqlite3Ctor | null> {
  if (cachedCtor !== undefined) return cachedCtor;
  try {
    const mod = (await import(
      /* @vite-ignore */ "better-sqlite3" as string
    ).catch(() => null)) as BetterSqlite3Like | BetterSqlite3Ctor | null;
    if (!mod) {
      cachedCtor = null;
      return null;
    }
    // better-sqlite3 may export as default or as the bare ctor depending on
    // module interop. Cover both.
    const ctor: BetterSqlite3Ctor | null =
      typeof mod === "function"
        ? (mod as BetterSqlite3Ctor)
        : ((mod as BetterSqlite3Like).default ?? null);
    cachedCtor = ctor;
    return ctor;
  } catch {
    cachedCtor = null;
    return null;
  }
}

export const sqliteDriver: SqlDriver = {
  kind: "sqlite",
  async query(connection, sql) {
    if (connection.driver !== "sqlite") {
      throw new Error(`sqlite driver received non-sqlite connection: ${connection.driver}`);
    }
    const Ctor = await loadDriver();
    if (!Ctor) {
      throw new Error(
        "better-sqlite3 not installed — run `harness setup:uat-sql` to enable sqlite probes",
      );
    }
    const db = new Ctor((connection as SqliteConnection).file, { readonly: true });
    try {
      const stmt = db.prepare(sql);
      // Reject mutating queries by inspecting the prepared statement's reader flag.
      if (!stmt.reader) {
        throw new Error("sql probe rejects non-SELECT queries (DDL/DML never run as a probe)");
      }
      const rows = stmt.all() as Record<string, unknown>[];
      const result: SqlQueryResult = { rowcount: rows.length, rows };
      return result;
    } finally {
      db.close();
    }
  },
};

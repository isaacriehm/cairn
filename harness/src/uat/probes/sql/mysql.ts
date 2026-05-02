/**
 * MySQL SQL probe driver — live.
 *
 * Lazy-loads `mysql2/promise`. Adopting projects opt in via
 * `harness setup:uat-sql --driver mysql --install`.
 *
 * READ-ONLY by contract — the upstream regex gate rejects mutating
 * queries. We also issue `SET SESSION TRANSACTION READ ONLY` before the
 * query as defense-in-depth.
 */

import { logger } from "../../../logger.js";
import type {
  MysqlConnection,
  SqlDriver,
  SqlQueryResult,
} from "./types.js";

const log = logger("uat.probe.sql.mysql");

interface MysqlConn {
  query(sql: string): Promise<[Record<string, unknown>[] | { affectedRows: number }, unknown]>;
  end(): Promise<void>;
}

interface MysqlPromise {
  createConnection(config: {
    host: string;
    port?: number;
    database: string;
    user?: string;
    password?: string;
    connectTimeout?: number;
  }): Promise<MysqlConn>;
}

interface Mysql2Module {
  promise?: MysqlPromise;
  default?: { promise?: MysqlPromise };
  createConnection?: MysqlPromise["createConnection"];
}

let cachedPromise: MysqlPromise | null | undefined;

async function loadMysql(): Promise<MysqlPromise | null> {
  if (cachedPromise !== undefined) return cachedPromise;
  try {
    const mod = (await import(
      /* @vite-ignore */ "mysql2/promise" as string
    ).catch(
      async () =>
        (await import(/* @vite-ignore */ "mysql2" as string).catch(() => null)) as Mysql2Module | null,
    )) as Mysql2Module | null;
    if (!mod) {
      cachedPromise = null;
      return null;
    }
    if (mod.promise) {
      cachedPromise = mod.promise;
      return mod.promise;
    }
    if (mod.default?.promise) {
      cachedPromise = mod.default.promise;
      return mod.default.promise;
    }
    if (mod.createConnection) {
      cachedPromise = { createConnection: mod.createConnection };
      return cachedPromise;
    }
    cachedPromise = null;
    return null;
  } catch {
    cachedPromise = null;
    return null;
  }
}

export const mysqlDriver: SqlDriver = {
  kind: "mysql",
  async query(connection, sql) {
    if (connection.driver !== "mysql") {
      throw new Error(`mysql driver received non-mysql connection: ${connection.driver}`);
    }
    const promise = await loadMysql();
    if (!promise) {
      throw new Error(
        "mysql2 client not installed — run `pnpm add -D mysql2` then re-run `harness setup:uat-sql --driver mysql`",
      );
    }
    const conn = connection as MysqlConnection;
    const user = conn.user_env ? process.env[conn.user_env] : undefined;
    const password = conn.password_env ? process.env[conn.password_env] : undefined;
    const config: {
      host: string;
      port?: number;
      database: string;
      user?: string;
      password?: string;
      connectTimeout?: number;
    } = {
      host: conn.host,
      database: conn.database,
      connectTimeout: 30_000,
    };
    if (conn.port !== undefined) config.port = conn.port;
    if (user !== undefined) config.user = user;
    if (password !== undefined) config.password = password;

    const client = await promise.createConnection(config);
    try {
      // Defense-in-depth read-only session.
      try {
        await client.query("SET SESSION TRANSACTION READ ONLY");
      } catch {
        // Best effort — older MySQL may not support; the regex gate is
        // primary protection.
      }
      const [rowsRaw] = await client.query(sql);
      const rows: Record<string, unknown>[] = Array.isArray(rowsRaw)
        ? (rowsRaw as Record<string, unknown>[])
        : [];
      log.debug(
        { host: conn.host, database: conn.database, rowcount: rows.length },
        "mysql query complete",
      );
      const out: SqlQueryResult = { rowcount: rows.length, rows };
      return out;
    } finally {
      try {
        await client.end();
      } catch {
        // best effort
      }
    }
  },
};

/**
 * Postgres SQL probe driver — live.
 *
 * Lazy-loads `pg` so the harness package install stays lean. Adopting
 * projects opt in via `harness setup:uat-sql --driver postgres --install`,
 * which adds `pg` to their devDeps + writes a connection template to
 * `.harness/config/probes/sql.yaml`.
 *
 * Connection credentials live in env vars referenced from the YAML
 * (`user_env: PGUSER`, `password_env: PGPASSWORD`) — never literal in
 * config files. Per operator preference: secrets in env, host/port/db in
 * YAML.
 *
 * READ-ONLY by contract — the upstream `runSqlProbe` regex gate rejects
 * any query that doesn't start with SELECT/WITH/SHOW/EXPLAIN/PRAGMA. We
 * also wrap each query in a `BEGIN READ ONLY ... ROLLBACK` cycle as
 * defense-in-depth so a bug elsewhere can't accidentally mutate.
 */

import { logger } from "../../../logger.js";
import type {
  PostgresConnection,
  SqlDriver,
  SqlQueryResult,
} from "./types.js";

const log = logger("uat.probe.sql.pg");

interface PgQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<PgQueryResult>;
  end(): Promise<void>;
}

interface PgClientCtor {
  new (config: {
    host: string;
    port?: number;
    database: string;
    user?: string;
    password?: string;
    ssl?: boolean;
    statement_timeout?: number;
  }): PgClient;
}

interface PgModule {
  Client?: PgClientCtor;
  default?: { Client?: PgClientCtor };
}

let cachedCtor: PgClientCtor | null | undefined;

async function loadPg(): Promise<PgClientCtor | null> {
  if (cachedCtor !== undefined) return cachedCtor;
  try {
    const mod = (await import(
      /* @vite-ignore */ "pg" as string
    ).catch(() => null)) as PgModule | null;
    if (!mod) {
      cachedCtor = null;
      return null;
    }
    const ctor: PgClientCtor | null = mod.Client ?? mod.default?.Client ?? null;
    cachedCtor = ctor;
    return ctor;
  } catch {
    cachedCtor = null;
    return null;
  }
}

export const pgDriver: SqlDriver = {
  kind: "postgres",
  async query(connection, sql) {
    if (connection.driver !== "postgres") {
      throw new Error(`pg driver received non-postgres connection: ${connection.driver}`);
    }
    const Ctor = await loadPg();
    if (!Ctor) {
      throw new Error(
        "pg client not installed — run `pnpm add -D pg @types/pg` then re-run `harness setup:uat-sql --driver postgres`",
      );
    }
    const conn = connection as PostgresConnection;
    const user = conn.user_env ? process.env[conn.user_env] : undefined;
    const password = conn.password_env ? process.env[conn.password_env] : undefined;
    const config: {
      host: string;
      port?: number;
      database: string;
      user?: string;
      password?: string;
      ssl?: boolean;
      statement_timeout: number;
    } = {
      host: conn.host,
      database: conn.database,
      statement_timeout: 30_000,
    };
    if (conn.port !== undefined) config.port = conn.port;
    if (user !== undefined) config.user = user;
    if (password !== undefined) config.password = password;
    if (conn.ssl === true) config.ssl = true;

    const client = new Ctor(config);
    try {
      await client.connect();
      // Defense-in-depth: read-only transaction wrapper. Any DDL/DML the
      // gate misses is forced to roll back. SELECT works inside RO.
      await client.query("BEGIN TRANSACTION READ ONLY");
      let result: PgQueryResult;
      try {
        result = await client.query(sql);
      } finally {
        try {
          await client.query("ROLLBACK");
        } catch {
          // best effort
        }
      }
      log.debug(
        { host: conn.host, database: conn.database, rowcount: result.rows.length },
        "pg query complete",
      );
      const out: SqlQueryResult = {
        rowcount: result.rowCount ?? result.rows.length,
        rows: result.rows,
      };
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

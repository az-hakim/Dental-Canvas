/**
 * Database seam for the whole server.
 *
 * Cloudflare Workers and the offline (service-worker / in-page) backend use the
 * original `@clawnify/db` adapter over a D1-shaped binding — nothing changes
 * there. A hosted multi-tenant deployment (Vercel/Node) installs a *driver
 * resolver* instead: every `query` / `get` / `run` call then goes to the
 * SQLite connection for the clinic that owns the current request, with that
 * clinic's table namespace applied (see `tenant/sql-prefix.ts`).
 *
 * The resolver is installed by the Node runtime only, so the browser bundle
 * never pulls a database driver into the service worker.
 */

import {
  initDB,
  query as baseQuery,
  get as baseGet,
  run as baseRun,
} from "@clawnify/db";

export interface SqlStatement {
  sql: string;
  params?: unknown[];
}

export interface SqlDriver {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>;
  /**
   * Optional: send many statements in one round trip. A hosted database pays
   * full network latency per statement, and first-run setup issues hundreds.
   */
  batch?(statements: SqlStatement[]): Promise<void>;
  /** Optional: queue `run` calls and flush them in batches. Return values of
   *  queued writes are placeholders, so use it only for fire-and-forget setup. */
  collectStatements?(enabled?: boolean): void;
  flushStatements?(): Promise<void>;
}

let driverResolver: (() => SqlDriver | null) | null = null;
let tenantKeyResolver: (() => string | null) | null = null;

/** Install the per-request driver lookup. Called once by the Node runtime. */
export function setSqlDriverResolver(fn: (() => SqlDriver | null) | null): void {
  driverResolver = fn;
}

/** Install the per-request clinic id lookup (used to scope once-only work). */
export function setTenantKeyResolver(fn: (() => string | null) | null): void {
  tenantKeyResolver = fn;
}

/**
 * Stable key for the clinic handling this request. Falls back to "default" on
 * single-tenant deployments (Workers, offline), where there is only one.
 */
export function currentTenantKey(): string {
  return tenantKeyResolver?.() ?? "default";
}

/** The driver bound to the active request, or null outside a tenant scope. */
export function activeDriver(): SqlDriver | null {
  return driverResolver?.() ?? null;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const driver = driverResolver?.();
  if (!driver) return baseQuery<T>(sql, params);
  return driver.query<T>(sql, params);
}

export async function get<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const driver = driverResolver?.();
  if (!driver) return baseGet<T>(sql, params);
  return driver.get<T>(sql, params);
}

export async function run(
  sql: string,
  params: unknown[] = [],
): Promise<{ changes: number; lastInsertRowid: number }> {
  const driver = driverResolver?.();
  if (!driver) return baseRun(sql, params);
  return driver.run(sql, params);
}

/**
 * Run `fn` with writes queued and flushed in batches (a no-op for drivers
 * without batching). Only for setup work that ignores `run`'s return value.
 */
export async function withBatchedWrites<T>(fn: () => Promise<T>): Promise<T> {
  const driver = driverResolver?.();
  if (!driver?.collectStatements) return fn();
  driver.collectStatements();
  try {
    return await fn();
  } finally {
    await driver.flushStatements?.();
    // Must be switched off even on success: while it stays on, `run` keeps
    // queueing and reports placeholder row ids to every later request.
    driver.collectStatements?.(false);
  }
}

/**
 * Run several statements in order, in one round trip where the driver can. Used
 * by first-run setup (schema, sync triggers, starter rows), where sending them
 * one at a time takes minutes against a remote database.
 */
export async function runBatch(statements: SqlStatement[]): Promise<void> {
  if (statements.length === 0) return;
  const driver = driverResolver?.();
  if (driver?.batch && statements.length > 1) {
    await driver.batch(statements);
    return;
  }
  for (const statement of statements) await run(statement.sql, statement.params ?? []);
}

export { initDB };

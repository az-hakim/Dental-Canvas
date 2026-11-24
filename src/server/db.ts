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

export interface SqlDriver {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>;
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

export { initDB };

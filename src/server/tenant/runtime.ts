/**
 * Hosted multi-tenant runtime (Vercel / any Node host).
 *
 * Responsibilities
 *   1. Open the SQLite database (Turso in production, a local file in dev).
 *   2. Keep a control plane — clinics, memberships, public-token index — in the
 *      same database under the reserved `dc_` prefix.
 *   3. Hand every request a driver bound to the caller's clinic, with that
 *      clinic's table namespace applied.
 *   4. Provision a clinic on first sign-in: create its namespaced tables and
 *      let the app's own seed/migration path populate them.
 *
 * Isolation model: one clinic = one physical set of tables. See
 * `sql-prefix.ts` for why.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createClient } from "@libsql/client";
import {
  setSqlDriverResolver,
  setTenantKeyResolver,
  type SqlDriver,
  type SqlStatement,
} from "../db";
import { setPublicTokenRegistrar, type PublicTokenKind } from "./token-registry";
import { rewriteSchema, rewriteSql, tenantPrefix } from "./sql-prefix";
import { SCHEMA_SQL } from "../schema.generated";

interface RequestScope {
  clinicId: string;
  driver: SqlDriver;
}

const storage = new AsyncLocalStorage<RequestScope>();

// ── Configuration ──────────────────────────────────────────────────

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

export interface RuntimeConfig {
  databaseUrl: string;
  databaseToken: string;
}

export function readRuntimeConfig(): RuntimeConfig {
  const url = env("TURSO_DATABASE_URL") || env("DATABASE_URL");
  const token = env("TURSO_AUTH_TOKEN") || env("DATABASE_AUTH_TOKEN");
  if (url) return { databaseUrl: url, databaseToken: token };
  // Local development / self-hosting without Turso: a file next to the project.
  // Vercel's filesystem is read-only apart from /tmp, so production must set
  // TURSO_DATABASE_URL.
  return {
    databaseUrl: env("DENTAL_CANVAS_LOCAL_DB") || "file:./.data/dental-canvas.db",
    databaseToken: "",
  };
}

/**
 * Why this deployment cannot use a database right now, or `null` when it can.
 *
 * A serverless host mounts the function bundle read-only, so the local-file
 * fallback that makes development and the desktop build work cannot create its
 * database there: the connection fails with SQLITE_CANTOPEN and every request
 * 500s as a bare "Internal server error", with nothing pointing at the missing
 * variable. Checking for that case up front turns a mystery crash into a
 * one-line diagnosis.
 */
export function databaseConfigError(): string | null {
  const { databaseUrl } = readRuntimeConfig();
  if (!databaseUrl.startsWith("file:")) return null;
  const serverless = Boolean(env("VERCEL") || env("AWS_LAMBDA_FUNCTION_NAME") || env("AWS_EXECUTION_ENV"));
  if (!serverless) return null;
  return (
    "This deployment has no database configured. Set TURSO_DATABASE_URL and " +
    "TURSO_AUTH_TOKEN in the project's environment variables, then redeploy."
  );
}

// Type-only: named type exports differ between @libsql/client versions.
type Client = ReturnType<typeof createClient>;

/**
 * Anything that quacks like a request: the client's class is not always the
 * global `Request` (on Vercel it is a different implementation), so
 * `instanceof` cannot be used to detect one.
 */
interface RequestLike {
  url: string;
  method: string;
  headers: { entries(): IterableIterator<[string, string]> };
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isRequestLike(value: unknown): value is RequestLike {
  if (typeof value !== "object" || value === null) return false;
  const req = value as Partial<RequestLike>;
  return (
    typeof req.url === "string" &&
    typeof req.arrayBuffer === "function" &&
    typeof req.headers?.entries === "function"
  );
}

/**
 * `fetch` for the database client.
 *
 * The libSQL client hands `fetch` a finished request object. On Vercel's Node
 * runtime that request reached Turso without its credentials and every query
 * failed with `SERVER_ERROR: Server returned HTTP status 401`, while the same
 * URL, headers and body sent as a plain `fetch(url, { … })` were accepted — the
 * token itself was correct. Rebuilding the request from its parts avoids the
 * runtime's handling of a prebuilt request from another implementation. Without
 * this the failure surfaces as a bare "Internal server error" on every
 * authenticated request.
 */
const databaseFetch: typeof fetch = async (input, init) => {
  if (isRequestLike(input)) {
    const method = input.method.toUpperCase();
    const body =
      method === "GET" || method === "HEAD" ? undefined : new Uint8Array(await input.arrayBuffer());
    return fetch(input.url, {
      method,
      headers: Array.from(input.headers.entries()),
      body,
    });
  }
  return fetch(input as RequestInfo, init);
};

let client: Client | null = null;

function db(): Client {
  if (!client) {
    const cfg = readRuntimeConfig();
    client = createClient({
      url: cfg.databaseUrl,
      authToken: cfg.databaseToken || undefined,
      fetch: databaseFetch,
    });
  }
  return client;
}

// ── Control plane ──────────────────────────────────────────────────

const CONTROL_DDL = [
  `CREATE TABLE IF NOT EXISTS dc_clinics (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     owner_id TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS dc_clinic_members (
     clinic_id TEXT NOT NULL REFERENCES dc_clinics(id) ON DELETE CASCADE,
     user_id TEXT NOT NULL,
     email TEXT,
     role TEXT NOT NULL DEFAULT 'owner',
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (clinic_id, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS dc_idx_members_user ON dc_clinic_members(user_id)`,
  `CREATE TABLE IF NOT EXISTS dc_public_tokens (
     token TEXT PRIMARY KEY,
     clinic_id TEXT NOT NULL REFERENCES dc_clinics(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
];

let controlReady: Promise<void> | null = null;

async function ensureControlPlane(): Promise<void> {
  controlReady ??= (async () => {
    for (const stmt of CONTROL_DDL) {
      await db().execute(stmt);
    }
  })().catch((err) => {
    controlReady = null;
    throw err;
  });
  await controlReady;
}

/** Run an unprefixed query against the control plane. */
async function controlAll(sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> {
  await ensureControlPlane();
  const rs = await db().execute({ sql, args: args as never });
  return rs.rows as unknown as Record<string, unknown>[];
}

// ── Per-tenant schema + drivers ────────────────────────────────────

const schemaReady = new Map<string, Promise<void>>();
const drivers = new Map<string, SqlDriver>();

class LibsqlDriver implements SqlDriver {
  constructor(
    private readonly client: Client,
    private readonly prefix: string,
  ) {}

  /**
   * While collecting, `run` queues statements instead of sending them, so a
   * multi-statement setup step goes out in a few pipelines instead of a round
   * trip per statement. Reads flush first, keeping the order callers expect.
   */
  private queued: { sql: string; args: never }[] | null = null;

  collectStatements(enabled = true): void {
    if (enabled) this.queued ??= [];
    else this.queued = null;
  }

  async flushStatements(): Promise<void> {
    if (!this.queued?.length) return;
    const pending = this.queued;
    this.queued = [];
    await this.client.batch(pending, "write");
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    await this.flushStatements();
    const rs = await this.client.execute({
      sql: rewriteSql(sql, this.prefix),
      args: params as never,
    });
    return rs.rows as unknown as T[];
  }

  async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertRowid: number }> {
    if (this.queued) {
      this.queued.push({ sql: rewriteSql(sql, this.prefix), args: params as never });
      return { changes: 0, lastInsertRowid: 0 };
    }
    const rs = await this.client.execute({
      sql: rewriteSql(sql, this.prefix),
      args: params as never,
    });
    return {
      changes: Number(rs.rowsAffected ?? 0),
      lastInsertRowid: Number(rs.lastInsertRowid ?? 0),
    };
  }

  /** One pipeline (thus one round trip) for a whole first-run batch. */
  async batch(statements: SqlStatement[]): Promise<void> {
    await this.flushStatements();
    await this.client.batch(
      statements.map((s) => ({ sql: rewriteSql(s.sql, this.prefix), args: (s.params ?? []) as never })),
      "write",
    );
  }
}

/**
 * Create this clinic's tables once per process. `IF NOT EXISTS` everywhere in
 * schema.sql makes a concurrent double-apply harmless.
 */
function ensureTenantSchema(clinicId: string): Promise<void> {
  let ready = schemaReady.get(clinicId);
  if (!ready) {
    ready = (async () => {
      const statements = rewriteSchema(SCHEMA_SQL, tenantPrefix(clinicId));
      // One pipeline for the whole schema. Sent statement by statement this is
      // ~180 round trips, which took 40 s against a remote database and blew
      // through the function's time limit on a clinic's first request.
      try {
        await db().batch(
          statements.map((sql) => ({ sql, args: [] })),
          "write",
        );
      } catch (err) {
        console.warn("[tenant] schema batch failed, retrying one statement at a time:", (err as Error).message);
        for (const stmt of statements) {
          try {
            await db().execute(stmt);
          } catch (inner) {
            // Same tolerance as the offline adapter: a statement that a SQLite
            // build rejects (e.g. an older FTS variant) must not stop the rest
            // of the schema from being created.
            console.warn("[tenant] schema statement failed:", (inner as Error).message);
          }
        }
      }
    })().catch((err) => {
      schemaReady.delete(clinicId);
      throw err;
    });
    schemaReady.set(clinicId, ready);
  }
  return ready;
}

/** The driver for a clinic, with its schema guaranteed to exist. */
export async function driverForClinic(clinicId: string): Promise<SqlDriver> {
  await ensureTenantSchema(clinicId);
  let driver = drivers.get(clinicId);
  if (!driver) {
    driver = new LibsqlDriver(db(), tenantPrefix(clinicId));
    drivers.set(clinicId, driver);
  }
  return driver;
}

// ── Clinics & membership ───────────────────────────────────────────

export interface Clinic {
  id: string;
  name: string;
}

export interface AuthedUser {
  id: string;
  email: string | null;
  clinicName: string;
}

/**
 * Resolve the clinic a signed-in user belongs to, provisioning a personal
 * clinic on first sign-in. A user with several memberships gets their oldest.
 */
export async function resolveClinic(user: AuthedUser): Promise<Clinic> {
  const memberships = await controlAll(
    `SELECT c.id, c.name FROM dc_clinic_members m
     JOIN dc_clinics c ON c.id = m.clinic_id
     WHERE m.user_id = ? ORDER BY m.created_at LIMIT 1`,
    [user.id],
  );

  const chosen = memberships[0];
  if (chosen) return { id: String(chosen.id), name: String(chosen.name) };

  const id = crypto.randomUUID();
  const name = (user.clinicName || "").trim() || defaultClinicName(user.email);
  await db().execute({
    sql: "INSERT OR IGNORE INTO dc_clinics (id, name, owner_id) VALUES (?, ?, ?)",
    args: [id, name, user.id],
  });
  await db().execute({
    sql: "INSERT OR IGNORE INTO dc_clinic_members (clinic_id, user_id, email, role) VALUES (?, ?, ?, 'owner')",
    args: [id, user.id, user.email],
  });
  return { id, name };
}

function defaultClinicName(email: string | null): string {
  const local = email?.split("@")[0]?.replace(/[._-]+/g, " ").trim();
  return local ? `${local} practice` : "My practice";
}

// ── Public tokens ──────────────────────────────────────────────────

export async function clinicForPublicToken(token: string): Promise<string | null> {
  const rows = await controlAll("SELECT clinic_id FROM dc_public_tokens WHERE token = ?", [token]);
  return rows[0] ? String(rows[0].clinic_id) : null;
}

// ── Request scoping ────────────────────────────────────────────────

/**
 * Run `fn` with the given clinic as the active tenant. Every `query`/`get`/
 * `run` inside — including nested awaits — talks to that clinic's tables.
 */
export async function withClinic<T>(clinicId: string, fn: () => Promise<T>): Promise<T> {
  const driver = await driverForClinic(clinicId);
  return storage.run({ clinicId, driver }, fn);
}

export function activeClinicId(): string | null {
  return storage.getStore()?.clinicId ?? null;
}

/**
 * Wire the runtime into the database seam. Called once by the server entry.
 */
export function installTenantRuntime(): void {
  setSqlDriverResolver(() => storage.getStore()?.driver ?? null);
  setTenantKeyResolver(() => storage.getStore()?.clinicId ?? null);
  setPublicTokenRegistrar(async (token, clinicId, kind) => {
    await ensureControlPlane();
    await db().execute({
      sql: "INSERT OR REPLACE INTO dc_public_tokens (token, clinic_id, kind) VALUES (?, ?, ?)",
      args: [token, clinicId, kind],
    });
  });
}

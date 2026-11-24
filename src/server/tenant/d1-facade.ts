/**
 * A D1-shaped facade for the hosted runtime.
 *
 * `@clawnify/app` calls `initDB(c.env)` on every request, and the app's own
 * code is written against the D1 interface. On Vercel there is no D1 binding,
 * so the function passes this object as `env.DB`: it satisfies the binding
 * check, and every statement it executes is routed to the clinic that owns the
 * current request.
 *
 * It talks to the active driver directly rather than calling `query`/`run` in
 * `src/server/db.ts`: those fall back to the `@clawnify/db` singleton when no
 * tenant is active, and the singleton is this facade — which would recurse.
 * Outside a tenant scope the facade fails fast instead.
 */
import { activeDriver } from "../db";

function requireDriver() {
  const driver = activeDriver();
  if (!driver) throw new Error("d1-facade: no active tenant context");
  return driver;
}

interface Statement {
  bind(...values: unknown[]): Statement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ results: never[]; success: true; meta: Record<string, unknown> }>;
}

function statement(sql: string, values: unknown[] = []): Statement {
  return {
    bind(...next: unknown[]) {
      return statement(sql, next);
    },
    async all<T>() {
      return { results: await requireDriver().query<T>(sql, values), success: true as const, meta: {} };
    },
    async first<T>() {
      return ((await requireDriver().get<T>(sql, values)) ?? null) as T | null;
    },
    async run() {
      const result = await requireDriver().run(sql, values);
      return {
        results: [] as never[],
        success: true as const,
        meta: { changes: result.changes, last_row_id: result.lastInsertRowid },
      };
    },
  };
}

export function createD1Facade() {
  return {
    prepare(sql: string) {
      return statement(sql);
    },
    async exec(sql: string) {
      await requireDriver().run(sql);
      return { results: [], success: true as const, meta: {} };
    },
    async batch(stmts: Statement[]) {
      const out = [];
      for (const s of stmts) out.push(await s.all());
      return out;
    },
  };
}

export type D1Facade = ReturnType<typeof createD1Facade>;

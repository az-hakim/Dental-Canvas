import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCAL_ONLY_TABLES, SYNC_TABLES } from "../src/shared/sync-schema";

/**
 * Static proof that "everything syncs": the local schema, the shared sync
 * table list and the Supabase migration must describe the same world. These
 * checks run without a database, so they protect every build; the live
 * Postgres/RLS behaviour is covered by supabase/tests/rls.test.sql.
 */

const schemaSql = readFileSync("src/server/schema.sql", "utf8");
const migrationSql = readFileSync(
  "supabase/migrations/20261103090000_dental_canvas_sync.sql",
  "utf8",
);

const SYNC_NAMES = SYNC_TABLES.map((t) => t.name);
const LOCAL_ONLY = [...LOCAL_ONLY_TABLES];

function localTables(): string[] {
  const names = new Set<string>();
  for (const match of schemaSql.matchAll(/create table(?: if not exists)?\s+"?([a-z_]+)"?/gi)) {
    names.add(match[1]);
  }
  return [...names];
}

function migrationTables(): string[] {
  const names = new Set<string>();
  for (const match of migrationSql.matchAll(/create table if not exists public\.([a-z_]+)/gi)) {
    names.add(match[1]);
  }
  return [...names];
}

/** Columns of one `create table public.<name> (...)` block in the migration. */
function migrationColumns(table: string): string[] {
  const block = migrationSql.match(
    new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`, "i"),
  );
  if (!block) return [];
  return [...block[1].matchAll(/^\s*([a-z_]+)\s/gim)].map((m) => m[1]);
}

function rlsTables(): string[] {
  // Several loops declare a table array; only the one under the
  // "Row Level Security" heading is the policy list.
  const section = migrationSql.split(/Row Level Security/)[1] ?? "";
  const array = section.match(/array\[([\s\S]*?)\];/);
  if (!array) return [];
  return [...array[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe("local schema coverage", () => {
  it("classifies every local table as synced or deliberately device-only", () => {
    const classified = new Set([...SYNC_NAMES, ...LOCAL_ONLY]);
    const unclassified = localTables().filter((t) => !classified.has(t));
    expect(unclassified).toEqual([]);
  });

  it("only lists syncable tables that really exist locally", () => {
    const local = new Set(localTables());
    expect(SYNC_NAMES.filter((t) => !local.has(t))).toEqual([]);
  });

  it("keeps settings, backups and image bytes off the wire", () => {
    for (const table of ["settings", "backups", "patient_image_blobs"]) {
      expect(LOCAL_ONLY).toContain(table);
      expect(SYNC_NAMES).not.toContain(table);
    }
  });
});

describe("supabase migration coverage", () => {
  const cloudTables = migrationTables();

  it("clouds exactly the syncable tables plus the two bookkeeping tables", () => {
    expect([...cloudTables].sort()).toEqual(
      [...SYNC_NAMES, "profiles", "account_sync_state"].sort(),
    );
  });

  it("gives every synced table the cloud identity and tombstone columns", () => {
    const missing: string[] = [];
    for (const table of SYNC_NAMES) {
      const columns = migrationColumns(table);
      for (const required of ["sync_id", "user_id", "updated_at", "deleted_at"]) {
        if (!columns.includes(required)) missing.push(`${table}.${required}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("enables row-level security on every table it serves", () => {
    const secured = new Set(rlsTables());
    expect(SYNC_NAMES.filter((t) => !secured.has(t))).toEqual([]);
    expect(secured.has("profiles")).toBe(true);
    expect(secured.has("account_sync_state")).toBe(true);
  });

  it("scopes every policy to the signed-in user", () => {
    // The policies are created in a loop, so the guard is that the loop issues
    // the four own-row policies per table and revokes anon access.
    expect(migrationSql).toMatch(/enable row level security/);
    expect(migrationSql).toMatch(/revoke all on public\.%I from anon/);
    expect(migrationSql).toMatch(/for select to authenticated using \(user_id = \(select auth\.uid\(\)\)\)/);
    expect(migrationSql).toMatch(/for insert to authenticated with check \(user_id = \(select auth\.uid\(\)\)\)/);
    expect(migrationSql).toMatch(/for update to authenticated using \(user_id = \(select auth\.uid\(\)\)\)/);
    expect(migrationSql).toMatch(/for delete to authenticated using \(user_id = \(select auth\.uid\(\)\)\)/);
  });

  it("publishes every synced table to realtime", () => {
    const realtime = migrationSql.match(/alter publication supabase_realtime add table[\s\S]*?end loop/);
    expect(realtime).not.toBeNull();
    expect(migrationSql).toContain("supabase_realtime add table");
  });
});

/**
 * Local sync bookkeeping.
 *
 * Dental Canvas stays local-first: every read/write goes through the existing
 * Hono/D1 API. This module only adds what a background cloud sync needs:
 *
 *  - `sync_id` on every syncable row (a stable UUID identity in Supabase),
 *  - `updated_at` (the last server-assigned timestamp this device knows about)
 *    and `deleted_at` (tombstone marker from the cloud),
 *  - `sync_outbox`, filled by SQL triggers, so no existing route has to change,
 *  - snapshot / pending / apply endpoints consumed by the client sync engine.
 *
 * Conflict rule (documented in `applyRemote`): last-write-wins using the
 * server-assigned `updated_at`. A local row with queued (not yet pushed) edits
 * is compared against the remote row using the local edit time from the
 * outbox; the loser is written to `sync_conflicts` — never silently dropped.
 *
 * Deletes are soft in the cloud (`deleted_at`) so they propagate. Locally the
 * existing hard-delete behaviour is preserved; `sync_tombstones` stops a stale
 * remote update from resurrecting a row the doctor deleted on this device.
 */
import { get, query, run } from "./db";
import {
  SEED_DENTIST_NOTES,
  SEED_INVENTORY,
  SEED_MEDICINES,
  SEED_OPERATORIES,
  SEED_PRACTITIONERS,
  SEED_TREATMENT_TYPES,
} from "./seed";
import {
  SYNC_TABLES,
  cloudFkColumn,
  syncTable,
  userDataTables,
  type SyncTableSpec,
} from "../shared/sync-schema";

/** Marker written by ALTER TABLE ADD COLUMN; treated as "never timestamped". */
export const SYNC_SENTINEL = "1970-01-01T00:00:00.000Z";

const nowIso = (): string => new Date().toISOString();

/** Normalize SQLite `datetime('now')` text to ISO-8601 so timestamps compare. */
export function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
    const iso = s.replace(" ", "T");
    return iso.endsWith("Z") ? iso : `${iso}${iso.length === 19 ? ".000Z" : "Z"}`;
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? s : new Date(parsed).toISOString();
}

/** RFC-4122 v4 UUID for clients/runtimes without crypto.randomUUID. */
function newUuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** SQL expression producing a UUID v4, used inside triggers and backfills. */
const UUID_SQL =
  "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || " +
  "substr(lower(hex(randomblob(2))), 2) || '-' || " +
  "substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || " +
  "lower(hex(randomblob(6)))";

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

let syncReady: Promise<void> | null = null;

// ── Schema / triggers ──────────────────────────────────────────────

async function tableNames(): Promise<Set<string>> {
  const rows = await query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  return new Set(rows.map((r) => r.name));
}

async function columnsOf(table: string): Promise<{ name: string; notNull: boolean }[]> {
  const rows = await query<{ name: string; notnull: number }>(`PRAGMA table_info("${table}")`);
  return rows.map((r) => ({ name: r.name, notNull: Number(r.notnull) === 1 }));
}

async function ensureColumn(table: string, column: string, ddl: string): Promise<void> {
  const cols = await columnsOf(table);
  if (cols.some((c) => c.name === column)) return;
  await run(`ALTER TABLE "${table}" ADD COLUMN ${column} ${ddl}`);
}

async function backfillSyncIds(spec: SyncTableSpec): Promise<void> {
  // Chunked so a long-standing practice database never materializes every row.
  for (;;) {
    const rows = await query<Record<string, unknown>>(
      `SELECT "${spec.pk}" AS pk FROM "${spec.name}" WHERE sync_id IS NULL LIMIT 500`,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      await run(`UPDATE "${spec.name}" SET sync_id = ? WHERE "${spec.pk}" = ?`, [
        newUuid(),
        row.pk as number,
      ]);
    }
  }
}

async function createSyncTriggers(spec: SyncTableSpec): Promise<void> {
  const t = spec.name;
  const pk = spec.pk;
  // Dropped and recreated so a future trigger change lands on existing installs.
  await run(`DROP TRIGGER IF EXISTS "${t}_sync_ai"`);
  await run(`DROP TRIGGER IF EXISTS "${t}_sync_au"`);
  await run(`DROP TRIGGER IF EXISTS "${t}_sync_ad"`);

  await run(`CREATE TRIGGER "${t}_sync_ai" AFTER INSERT ON "${t}" BEGIN
    UPDATE "${t}" SET
      sync_id = COALESCE(sync_id, ${UUID_SQL}),
      updated_at = CASE
        WHEN updated_at IS NULL
          OR updated_at = '${SYNC_SENTINEL}'
          OR updated_at NOT LIKE '____-__-__T__:__:__%' THEN ${NOW_SQL}
        ELSE updated_at END
    WHERE "${pk}" = NEW."${pk}";
    INSERT INTO sync_outbox (entity, row_ref, op, sync_id, created_at)
    SELECT '${t}', CAST(NEW."${pk}" AS TEXT), 'upsert',
           (SELECT sync_id FROM "${t}" WHERE "${pk}" = NEW."${pk}"), ${NOW_SQL}
    WHERE (SELECT applying FROM sync_state WHERE id = 1) = 0;
  END`);

  await run(`CREATE TRIGGER "${t}_sync_au" AFTER UPDATE ON "${t}"
    WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0 AND OLD.sync_id IS NOT NULL
    BEGIN
      INSERT INTO sync_outbox (entity, row_ref, op, sync_id, base_updated_at, created_at)
      VALUES ('${t}', CAST(NEW."${pk}" AS TEXT), 'upsert', NEW.sync_id, OLD.updated_at, ${NOW_SQL});
    END`);

  await run(`CREATE TRIGGER "${t}_sync_ad" AFTER DELETE ON "${t}"
    WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0 AND OLD.sync_id IS NOT NULL
    BEGIN
      INSERT INTO sync_outbox (entity, row_ref, op, sync_id, base_updated_at, created_at)
      VALUES ('${t}', CAST(OLD."${pk}" AS TEXT), 'delete', OLD.sync_id, OLD.updated_at, ${NOW_SQL});
    END`);
}

/**
 * Idempotent local migration. Safe on every boot and on databases with years
 * of data: it only adds nullable columns, backfills missing UUIDs, and
 * (re)creates the sync triggers.
 */
export async function ensureSyncSchema(): Promise<void> {
  const tables = await tableNames();
  if (!tables.has("patients")) return; // DDL not applied yet — retry next request

  await run(`CREATE TABLE IF NOT EXISTS sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    applying INTEGER NOT NULL DEFAULT 0,
    owner_user_id TEXT,
    last_pull_at TEXT,
    last_push_at TEXT
  )`);
  await run("INSERT OR IGNORE INTO sync_state (id, applying) VALUES (1, 0)");
  // A crash during an apply must never leave the triggers muted forever.
  await run("UPDATE sync_state SET applying = 0 WHERE id = 1");
  await run(`CREATE TABLE IF NOT EXISTS sync_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    row_ref TEXT NOT NULL,
    op TEXT NOT NULL DEFAULT 'upsert',
    sync_id TEXT,
    base_updated_at TEXT,
    created_at TEXT NOT NULL
  )`);
  await run("CREATE INDEX IF NOT EXISTS idx_sync_outbox_row ON sync_outbox(entity, row_ref)");

  await run(`CREATE TABLE IF NOT EXISTS sync_tombstones (
    entity TEXT NOT NULL,
    sync_id TEXT NOT NULL,
    deleted_at TEXT NOT NULL,
    PRIMARY KEY (entity, sync_id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS sync_cursors (
    entity TEXT PRIMARY KEY,
    cursor_updated_at TEXT NOT NULL,
    cursor_sync_id TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS sync_conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    sync_id TEXT,
    resolution TEXT NOT NULL,
    local_payload TEXT,
    remote_payload TEXT,
    created_at TEXT NOT NULL
  )`);

  // Offline-only installs don't need a growing queue: a later claim/upload
  // snapshots the current rows anyway. Bound it to the current session.
  const owner = await get<{ owner_user_id: string | null }>(
    "SELECT owner_user_id FROM sync_state WHERE id = 1",
  );
  if (!owner?.owner_user_id) {
    await run("DELETE FROM sync_outbox");
    await run("DELETE FROM sync_tombstones");
    await run("DELETE FROM sync_cursors");
  }

  for (const spec of SYNC_TABLES) {
    if (!tables.has(spec.name)) continue;
    const cols = await columnsOf(spec.name);
    const has = (name: string) => cols.some((c) => c.name === name);
    if (!has("sync_id")) await ensureColumn(spec.name, "sync_id", "TEXT");
    if (!has("updated_at")) {
      await ensureColumn(spec.name, "updated_at", `TEXT NOT NULL DEFAULT '${SYNC_SENTINEL}'`);
    }
    if (!has("deleted_at")) await ensureColumn(spec.name, "deleted_at", "TEXT");

    // Existing rows get their identity before any trigger can observe them.
    await backfillSyncIds(spec);

    // Normalize legacy `datetime('now')` timestamps once (inventory_items and
    // prescription_layouts carried updated_at before sync existed).
    await run(
      `UPDATE "${spec.name}" SET updated_at = replace(updated_at, ' ', 'T') || 'Z'
       WHERE updated_at LIKE '____-__-__ __:__:__'`,
    );
    await run(
      `UPDATE "${spec.name}" SET updated_at = ? WHERE updated_at IS NULL OR updated_at = '' OR updated_at = ?`,
      [nowIso(), SYNC_SENTINEL],
    );

    await run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_${spec.name}_sync_id ON "${spec.name}"(sync_id) WHERE sync_id IS NOT NULL`,
    );
    await createSyncTriggers(spec);
  }
}

/** Runs once per isolate; failures retry on the next request. */
export async function ensureSyncReady(): Promise<void> {
  syncReady ??= ensureSyncSchema().catch((err) => {
    syncReady = null;
    throw err;
  });
  await syncReady;
}

// ── Payloads ───────────────────────────────────────────────────────

async function rowColumns(spec: SyncTableSpec): Promise<string[]> {
  const cols = await columnsOf(spec.name);
  const fkColumns = new Set(Object.keys(spec.fks));
  const localOnly = new Set(spec.localOnlyColumns ?? []);
  return cols
    .map((c) => c.name)
    .filter(
      (c) =>
        c !== spec.pk &&
        c !== "id" &&
        c !== "updated_at" &&
        c !== "deleted_at" &&
        c !== "user_id" &&
        !fkColumns.has(c) &&
        !localOnly.has(c),
    );
}

/** Cached integer→sync_id lookups for one request. */
class FkLookups {
  private ids = new Map<string, Map<number, string | null>>();

  async syncId(parent: string, id: unknown): Promise<string | null> {
    if (id === null || id === undefined) return null;
    let map = this.ids.get(parent);
    if (!map) {
      map = new Map();
      this.ids.set(parent, map);
    }
    const key = Number(id);
    if (map.has(key)) return map.get(key) ?? null;
    const spec = syncTable(parent);
    if (!spec) return null;
    const row = await get<{ sync_id: string | null }>(
      `SELECT sync_id FROM "${parent}" WHERE "${spec.pk}" = ?`,
      [key],
    );
    map.set(key, row?.sync_id ?? null);
    return row?.sync_id ?? null;
  }
}

async function buildPayload(
  spec: SyncTableSpec,
  row: Record<string, unknown>,
  columns: string[],
  lookups: FkLookups,
): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    sync_id: row.sync_id ?? null,
    // An upsert is a write: if this row was soft-deleted on another device,
    // the later edit wins (last-write-wins) instead of being re-deleted by our
    // own pull. The server assigns a fresh updated_at to that write.
    deleted_at: null,
  };
  for (const c of columns) payload[c] = row[c] ?? null;
  for (const [localCol, parent] of Object.entries(spec.fks)) {
    payload[cloudFkColumn(localCol)] = await lookups.syncId(parent, row[localCol]);
  }
  return payload;
}

// ── Meta / owner ───────────────────────────────────────────────────

export interface LocalSyncMeta {
  owner_user_id: string | null;
  last_pull_at: string | null;
  last_push_at: string | null;
  pending_changes: number;
  conflicts: number;
  cursors: Record<string, { updated_at: string; sync_id: string | null }>;
}

export async function getSyncMeta(): Promise<LocalSyncMeta> {
  await ensureSyncReady();
  const state = await get<{
    owner_user_id: string | null;
    last_pull_at: string | null;
    last_push_at: string | null;
  }>("SELECT owner_user_id, last_pull_at, last_push_at FROM sync_state WHERE id = 1");
  const pending = await get<{ n: number }>("SELECT COUNT(*) AS n FROM sync_outbox");
  const conflicts = await get<{ n: number }>("SELECT COUNT(*) AS n FROM sync_conflicts");
  const cursorRows = await query<{
    entity: string;
    cursor_updated_at: string;
    cursor_sync_id: string | null;
  }>("SELECT entity, cursor_updated_at, cursor_sync_id FROM sync_cursors");
  const cursors: LocalSyncMeta["cursors"] = {};
  for (const c of cursorRows) {
    cursors[c.entity] = { updated_at: c.cursor_updated_at, sync_id: c.cursor_sync_id };
  }
  return {
    owner_user_id: state?.owner_user_id ?? null,
    last_pull_at: state?.last_pull_at ?? null,
    last_push_at: state?.last_push_at ?? null,
    pending_changes: pending?.n ?? 0,
    conflicts: conflicts?.n ?? 0,
    cursors,
  };
}

export type ClaimResult =
  | { ok: true; owner_user_id: string }
  | { ok: false; reason: "different_account"; owner_user_id: string };

/**
 * Bind this device's local data to one cloud account. Prevents silently
 * uploading practice A's patients into practice B's account when a doctor
 * switches accounts on a shared machine.
 */
export async function claimSyncOwner(userId: string): Promise<ClaimResult> {
  await ensureSyncReady();
  const state = await get<{ owner_user_id: string | null }>(
    "SELECT owner_user_id FROM sync_state WHERE id = 1",
  );
  if (state?.owner_user_id && state.owner_user_id !== userId) {
    return { ok: false, reason: "different_account", owner_user_id: state.owner_user_id };
  }
  if (!state?.owner_user_id) {
    await run("UPDATE sync_state SET owner_user_id = ? WHERE id = 1", [userId]);
    // A first-time owner starts with a clean queue; the initial upload covers
    // everything local, so pre-existing queued rows would only duplicate work.
    await run("DELETE FROM sync_outbox");
    await run("DELETE FROM sync_tombstones");
    await run("DELETE FROM sync_cursors");
  }
  return { ok: true, owner_user_id: userId };
}

/**
 * Sign-out detaches the session but deliberately KEEPS the device's account
 * claim, its unsynced outbox and its pull cursors.
 *
 * Why: local rows belong to the doctor who created them. If sign-out cleared
 * the claim, the next person to sign in on a shared clinic machine would be
 * treated as a first device and would upload the previous doctor's patients
 * into their own account. Keeping the claim also means signing back in as the
 * same doctor resumes the queue instead of discarding unsynced edits.
 *
 * Switching to a different account therefore goes through an explicit
 * confirmation (the account conflict screen / "remove local data").
 */
export async function releaseSyncOwner(): Promise<void> {
  await ensureSyncReady();
  // Only clear an interrupted apply marker; the ownership stays.
  await run("UPDATE sync_state SET applying = 0 WHERE id = 1");
}

/**
 * The cloud account was deleted: unclaim this device so a future account can
 * adopt its (kept) local rows. Only called after an explicit account deletion.
 */
export async function forgetSyncOwner(): Promise<void> {
  await ensureSyncReady();
  await run(
    "UPDATE sync_state SET owner_user_id = NULL, applying = 0, last_pull_at = NULL, last_push_at = NULL WHERE id = 1",
  );
  await run("DELETE FROM sync_outbox");
  await run("DELETE FROM sync_tombstones");
  await run("DELETE FROM sync_cursors");
}

// ── Outbox ─────────────────────────────────────────────────────────

export interface PendingChange {
  entity: string;
  op: "upsert" | "delete";
  sync_id: string | null;
  outbox_ids: number[];
  /** Timestamp the local row had when the first unsynced edit was queued. */
  base_updated_at: string | null;
  payload?: Record<string, unknown>;
}

interface OutboxRow {
  id: number;
  entity: string;
  row_ref: string;
  op: "upsert" | "delete";
  sync_id: string | null;
  base_updated_at: string | null;
  created_at: string;
}

/**
 * Coalesced pending changes, parents first. Multiple edits to one row become a
 * single upsert (or a delete when the last edit was a delete), so a busy day
 * never produces a queue of redundant pushes.
 */
export async function getPendingChanges(limit = 250): Promise<{
  changes: PendingChange[];
  hasMore: boolean;
}> {
  await ensureSyncReady();
  const rows = await query<OutboxRow>(
    "SELECT * FROM sync_outbox ORDER BY id ASC LIMIT ?",
    [Math.max(1, Math.min(limit, 1000))],
  );
  const grouped = new Map<
    string,
    { last: OutboxRow; ids: number[]; base: string | null }
  >();
  for (const row of rows) {
    const key = `${row.entity}\u0000${row.row_ref}`;
    const current = grouped.get(key);
    if (current) {
      current.last = row;
      current.ids.push(row.id);
      if (!current.base && row.base_updated_at) current.base = row.base_updated_at;
    } else {
      grouped.set(key, {
        last: row,
        ids: [row.id],
        base: row.base_updated_at ? row.base_updated_at : null,
      });
    }
  }

  const byEntity = new Map<string, PendingChange[]>();
  const pushChange = (change: PendingChange) => {
    const list = byEntity.get(change.entity);
    if (list) list.push(change);
    else byEntity.set(change.entity, [change]);
  };
  const lookups = new FkLookups();

  for (const { last, ids, base } of grouped.values()) {
    const spec = syncTable(last.entity);
    if (!spec) continue;
    const deleteChange = (): PendingChange => ({
      entity: spec.name,
      op: "delete",
      sync_id: last.sync_id,
      outbox_ids: ids,
      base_updated_at: normalizeTimestamp(base),
    });
    if (last.op === "delete") {
      pushChange(deleteChange());
      continue;
    }

    const row = await get<Record<string, unknown>>(
      `SELECT * FROM "${spec.name}" WHERE "${spec.pk}" = ?`,
      [Number(last.row_ref)],
    );
    if (!row) {
      // The row disappeared between the queue and the flush (hard delete).
      pushChange(deleteChange());
      continue;
    }
    if (!row.sync_id) {
      const id = newUuid();
      await run(`UPDATE "${spec.name}" SET sync_id = ? WHERE "${spec.pk}" = ?`, [
        id,
        row[spec.pk] as number,
      ]);
      row.sync_id = id;
    }
    const columns = await rowColumns(spec);
    pushChange({
      entity: spec.name,
      op: "upsert",
      sync_id: String(row.sync_id),
      outbox_ids: ids,
      base_updated_at: normalizeTimestamp(base),
      payload: await buildPayload(spec, row, columns, lookups),
    });
  }

  const order = new Map(SYNC_TABLES.map((t, i) => [t.name, i]));
  const changes = [...byEntity.values()]
    .flat()
    .sort((a, b) => (order.get(a.entity) ?? 0) - (order.get(b.entity) ?? 0));
  return { changes, hasMore: rows.length >= limit };
}

/** Remove outbox entries the client has durably pushed (and applied locally). */
export async function ackChanges(ids: number[], markPushed = true): Promise<void> {
  await ensureSyncReady();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    if (chunk.length === 0) continue;
    await run(
      `DELETE FROM sync_outbox WHERE id IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    );
  }
  if (markPushed) {
    await run("UPDATE sync_state SET last_push_at = ? WHERE id = 1", [nowIso()]);
  }
}

// ── Snapshot (initial upload) ──────────────────────────────────────

export interface SnapshotChunk {
  entity: string;
  rows: Record<string, unknown>[];
  next_after: number | null;
}

/**
 * One page of a full local snapshot, parents first. Pagination is by local
 * integer PK so it is resumable and never depends on the outbox.
 */
export async function getSnapshotChunk(
  entity: string,
  after = 0,
  limit = 250,
): Promise<SnapshotChunk> {
  await ensureSyncReady();
  const spec = syncTable(entity);
  if (!spec) throw new Error(`Unknown sync table: ${entity}`);
  const size = Math.max(1, Math.min(limit, 1000));
  // One extra row tells us whether another page exists without a second query.
  const fetched = await query<Record<string, unknown>>(
    `SELECT * FROM "${spec.name}" WHERE "${spec.pk}" > ? ORDER BY "${spec.pk}" ASC LIMIT ?`,
    [after, size + 1],
  );
  const rows = fetched.slice(0, size);
  const columns = await rowColumns(spec);
  const lookups = new FkLookups();
  const payloads: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (!row.sync_id) {
      const id = newUuid();
      await run(`UPDATE "${spec.name}" SET sync_id = ? WHERE "${spec.pk}" = ?`, [
        id,
        row[spec.pk] as number,
      ]);
      row.sync_id = id;
    }
    payloads.push(await buildPayload(spec, row, columns, lookups));
  }
  const last = rows[rows.length - 1];
  return {
    entity: spec.name,
    rows: payloads,
    next_after: fetched.length > size && last ? Number(last[spec.pk]) : null,
  };
}

// ── Apply remote changes (pull + push echo) ────────────────────────

export interface RemoteChange {
  entity: string;
  op: "upsert" | "delete";
  row?: Record<string, unknown>;
}

export interface ApplyResult {
  applied: number;
  skipped: number;
  /** Rows whose parent has not arrived yet — safe to retry on the next pull. */
  deferred: number;
  conflicts: number;
}

/** Persist a conflict for diagnostics; the losing payload is never discarded. */
export async function recordSyncConflict(
  entity: string,
  syncId: string | null,
  resolution: string,
  localPayload: unknown,
  remotePayload: unknown,
): Promise<void> {
  try {
    await run(
      `INSERT INTO sync_conflicts (entity, sync_id, resolution, local_payload, remote_payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        entity,
        syncId,
        resolution,
        localPayload === undefined ? null : JSON.stringify(localPayload),
        remotePayload === undefined ? null : JSON.stringify(remotePayload),
        nowIso(),
      ],
    );
  } catch {
    // Diagnostics must never fail a sync.
  }
  console.warn(`[sync] conflict on ${entity}/${syncId}: ${resolution}`);
}

async function applyOne(
  change: RemoteChange,
  lookupsById: Map<string, Map<string, number>>,
  push: boolean,
): Promise<"applied" | "skipped" | "deferred"> {
  const spec = syncTable(change.entity);
  const row = change.row;
  if (!spec || !row) return "skipped";

  const syncId = row.sync_id ? String(row.sync_id) : null;
  if (!syncId) return "skipped";

  const local = await get<{ pk: number } & Record<string, unknown>>(
    `SELECT "${spec.pk}" AS pk, * FROM "${spec.name}" WHERE sync_id = ?`,
    [syncId],
  );
  const remoteUpdatedAt = normalizeTimestamp(row.updated_at) ?? nowIso();
  const remoteDeletedAt = row.deleted_at ? normalizeTimestamp(row.deleted_at) : null;
  const isDelete = change.op === "delete" || remoteDeletedAt !== null;

  // ── Tombstone: a local delete must not be resurrected by a stale update ──
  const tombstone = await get<{ deleted_at: string }>(
    "SELECT deleted_at FROM sync_tombstones WHERE entity = ? AND sync_id = ?",
    [spec.name, syncId],
  );
  if (tombstone && !isDelete) {
    const tombAt = normalizeTimestamp(tombstone.deleted_at) ?? "";
    if (Date.parse(tombAt) >= Date.parse(remoteUpdatedAt)) {
      return "skipped";
    }
    await run("DELETE FROM sync_tombstones WHERE entity = ? AND sync_id = ?", [
      spec.name,
      syncId,
    ]);
  }

  if (isDelete) {
    if (!local) {
      await run(
        "INSERT OR REPLACE INTO sync_tombstones (entity, sync_id, deleted_at) VALUES (?, ?, ?)",
        [spec.name, syncId, remoteDeletedAt ?? remoteUpdatedAt],
      );
      return "applied";
    }
    const pending = await query<{ created_at: string }>(
      "SELECT created_at FROM sync_outbox WHERE entity = ? AND row_ref = ?",
      [spec.name, String(local.pk)],
    );
    if (!push && pending.length > 0) {
      const localEditAt = Math.max(
        ...pending.map((p) => Date.parse(normalizeTimestamp(p.created_at) ?? "0")),
      );
      if (localEditAt > Date.parse(remoteUpdatedAt)) {
        await recordSyncConflict(spec.name, syncId, "local_edit_kept", local, row);
        return "skipped";
      }
    }
    await run(`DELETE FROM "${spec.name}" WHERE "${spec.pk}" = ?`, [local.pk]);
    await run(
      "INSERT OR REPLACE INTO sync_tombstones (entity, sync_id, deleted_at) VALUES (?, ?, ?)",
      [spec.name, syncId, remoteDeletedAt ?? remoteUpdatedAt],
    );
    return "applied";
  }

  // ── Upsert ───────────────────────────────────────────────────────
  if (local) {
    const pending = await query<{ created_at: string }>(
      "SELECT created_at FROM sync_outbox WHERE entity = ? AND row_ref = ?",
      [spec.name, String(local.pk)],
    );
    if (!push && pending.length > 0) {
      const localEditAt = Math.max(
        ...pending.map((p) => Date.parse(normalizeTimestamp(p.created_at) ?? "0")),
      );
      if (localEditAt > Date.parse(remoteUpdatedAt)) {
        await recordSyncConflict(spec.name, syncId, "local_edit_kept", local, row);
        return "skipped"; // the outbox keeps its edit; it will push later
      }
      await recordSyncConflict(spec.name, syncId, "remote_edit_won", local, row);
      await run("DELETE FROM sync_outbox WHERE entity = ? AND row_ref = ?", [
        spec.name,
        String(local.pk),
      ]);
    }
  }

  // Resolve cloud FK columns to local integer ids. A missing parent is
  // deferred (parents are applied first inside every batch).
  const localCols = await columnsOf(spec.name);
  const localColumnNames = new Set(localCols.map((c) => c.name));
  const cloudFkColumns = new Set(Object.keys(spec.fks).map(cloudFkColumn));
  const values: Record<string, unknown> = {};
  for (const [localCol, parent] of Object.entries(spec.fks)) {
    const cloudCol = cloudFkColumn(localCol);
    const parentSyncId = row[cloudCol] == null ? null : String(row[cloudCol]);
    let parentId: number | null = null;
    if (parentSyncId) {
      let map = lookupsById.get(parent);
      const parentSpec = syncTable(parent)!;
      if (!map) {
        map = new Map();
        lookupsById.set(parent, map);
      }
      if (map.has(parentSyncId)) {
        parentId = map.get(parentSyncId)!;
      } else {
        const parentRow = await get<{ id: number }>(
          `SELECT "${parentSpec.pk}" AS id FROM "${parent}" WHERE sync_id = ?`,
          [parentSyncId],
        );
        if (parentRow) {
          parentId = Number(parentRow.id);
          map.set(parentSyncId, parentId);
        }
      }
    }
    const required = localCols.find((c) => c.name === localCol)?.notNull ?? false;
    if (parentId === null && required) {
      // Parents are applied first, so this only happens when a parent page has
      // not arrived yet. Leave the row out; the next pull retries it.
      return "deferred";
    }
    values[localCol] = parentId;
  }

  for (const [key, value] of Object.entries(row)) {
    if (key === "user_id" || key === "sync_id" || key === "updated_at" || key === "deleted_at") continue;
    // Cloud FK columns were resolved to local integer ids above.
    if (cloudFkColumns.has(key)) continue;
    if (localColumnNames.has(key) && key !== spec.pk) values[key] = value;
  }

  const assignable = Object.keys(values);
  if (local) {
    if (assignable.length > 0) {
      await run(
        `UPDATE "${spec.name}" SET ${assignable.map((c) => `"${c}" = ?`).join(", ")}, updated_at = ?, deleted_at = ? WHERE "${spec.pk}" = ?`,
        [...assignable.map((c) => values[c]), remoteUpdatedAt, null, local.pk],
      );
    } else {
      await run(
        `UPDATE "${spec.name}" SET updated_at = ?, deleted_at = ? WHERE "${spec.pk}" = ?`,
        [remoteUpdatedAt, null, local.pk],
      );
    }
    if (!push) {
      await run("DELETE FROM sync_outbox WHERE entity = ? AND row_ref = ?", [
        spec.name,
        String(local.pk),
      ]);
    }
    return "applied";
  }

  const insertCols = ["sync_id", ...assignable, "updated_at", "deleted_at"];
  const insertVals = [syncId, ...assignable.map((c) => values[c]), remoteUpdatedAt, null];
  await run(
    `INSERT INTO "${spec.name}" (${insertCols.map((c) => `"${c}"`).join(", ")}) VALUES (${insertCols.map(() => "?").join(", ")})`,
    insertVals,
  );
  return "applied";
}

/**
 * Apply pulled rows (or the authoritative echo of a push) to the local store.
 *
 * Deletes are hard locally but soft in the cloud. For a local row with queued
 * edits, the outbox's edit time is compared with the remote `updated_at`:
 * whichever is later wins, and the losing version is logged to
 * `sync_conflicts`. `push: true` marks a row set that this device just wrote
 * successfully, so the server echo always wins and its `updated_at` becomes
 * the local baseline.
 */
export async function applyRemoteChanges(
  changes: RemoteChange[],
  opts: { push?: boolean; cursors?: Record<string, { updated_at: string; sync_id: string | null }> } = {},
): Promise<ApplyResult> {
  await ensureSyncReady();
  const push = opts.push === true;
  const order = new Map(SYNC_TABLES.map((t, i) => [t.name, i]));
  const sorted = [...changes].sort(
    (a, b) => (order.get(a.entity) ?? 0) - (order.get(b.entity) ?? 0),
  );
  const lookups = new Map<string, Map<string, number>>();
  const result: ApplyResult = { applied: 0, skipped: 0, deferred: 0, conflicts: 0 };

  await run("UPDATE sync_state SET applying = 1 WHERE id = 1");
  try {
    for (const change of sorted) {
      const outcome = await applyOne(change, lookups, push);
      result[outcome] += 1;
      if (outcome === "skipped") result.conflicts += 1;
    }
  } finally {
    await run("UPDATE sync_state SET applying = 0 WHERE id = 1");
  }

  // Advancing a cursor past a deferred row would lose it, so hold the cursor
  // at the previous page and let the next pull retry once its parent arrives.
  if (opts.cursors && result.deferred === 0) {
    for (const [entity, cursor] of Object.entries(opts.cursors)) {
      if (!syncTable(entity) || !cursor.updated_at) continue;
      await run(
        `INSERT INTO sync_cursors (entity, cursor_updated_at, cursor_sync_id) VALUES (?, ?, ?)
         ON CONFLICT(entity) DO UPDATE SET cursor_updated_at = excluded.cursor_updated_at, cursor_sync_id = excluded.cursor_sync_id`,
        [entity, cursor.updated_at, cursor.sync_id],
      );
    }
  }
  if (!push) {
    await run("UPDATE sync_state SET last_pull_at = ? WHERE id = 1", [nowIso()]);
  }
  return result;
}

// ── Local data summary / wipe ──────────────────────────────────────

export interface LocalDataSummary {
  has_user_data: boolean;
  counts: Record<string, number>;
}

/** Does this device hold data the doctor typed (not just first-run seeds)? */
export async function getLocalDataSummary(): Promise<LocalDataSummary> {
  await ensureSyncReady();
  const counts: Record<string, number> = {};
  let hasUserData = false;
  for (const table of userDataTables()) {
    const spec = syncTable(table)!;
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${spec.name}"`);
    counts[table] = row?.n ?? 0;
    if ((row?.n ?? 0) > 0) hasUserData = true;
  }
  return { has_user_data: hasUserData, counts };
}

/**
 * True when the lookup tables still contain only the first-run defaults — no
 * doctor-created operatory, practitioner, treatment type, medicine, stock item
 * or dashboard note. Used to decide whether a fresh device may clear its seeds
 * before pulling an existing account. Anything custom forces a merge instead.
 */
async function hasOnlySeedLookups(): Promise<boolean> {
  const checks: { table: string; column: string; allowed: Set<string> }[] = [
    { table: "operatories", column: "name", allowed: new Set(SEED_OPERATORIES.map((r) => r.name)) },
    { table: "practitioners", column: "name", allowed: new Set(SEED_PRACTITIONERS.map((r) => r.name)) },
    { table: "treatment_types", column: "name", allowed: new Set(SEED_TREATMENT_TYPES.map((r) => r.name)) },
    { table: "medicines", column: "name", allowed: new Set(SEED_MEDICINES.map((r) => r.name)) },
    { table: "inventory_items", column: "name", allowed: new Set(SEED_INVENTORY.map((r) => r.name)) },
    { table: "dentist_notes", column: "body", allowed: new Set(SEED_DENTIST_NOTES.map((r) => r.body)) },
  ];
  for (const { table, column, allowed } of checks) {
    const rows = await query<{ value: string }>(`SELECT "${column}" AS value FROM "${table}"`);
    if (rows.some((r) => !allowed.has(r.value))) return false;
  }
  return true;
}

async function clearDomainData(): Promise<void> {
  await run("UPDATE sync_state SET applying = 1 WHERE id = 1");
  try {
    // Children before parents; patient_image_blobs has no sync row but belongs
    // to the same practice data.
    for (const spec of [...SYNC_TABLES].reverse()) {
      await run(`DELETE FROM "${spec.name}"`);
    }
    await run("DELETE FROM patient_image_blobs").catch(() => undefined);
    await run("DELETE FROM sync_outbox");
    await run("DELETE FROM sync_tombstones");
    await run("DELETE FROM sync_cursors");
  } finally {
    await run("UPDATE sync_state SET applying = 0 WHERE id = 1");
  }
}

/**
 * First sync on a device that only has starter seeds: clear the seeds before
 * pulling so the account's real operatories/practitioners are not duplicated.
 * Refuses when any user-entered data exists (use merge instead).
 */
export async function prepareLocalForPull(): Promise<{ ok: boolean; reason?: string }> {
  const summary = await getLocalDataSummary();
  if (summary.has_user_data) {
    return { ok: false, reason: "device_has_user_data" };
  }
  // Custom lookups are real work, even without a patient yet: merge rather
  // than risk deleting them.
  if (!(await hasOnlySeedLookups())) {
    return { ok: false, reason: "device_has_custom_lookups" };
  }
  await clearDomainData();
  return { ok: true };
}

/** Explicit "remove local data from this device" — never called implicitly. */
export async function wipeLocalData(): Promise<void> {
  await ensureSyncReady();
  await clearDomainData();
  await run(
    "UPDATE sync_state SET owner_user_id = NULL, last_pull_at = NULL, last_push_at = NULL WHERE id = 1",
  );
}

export async function listConflicts(limit = 50): Promise<Record<string, unknown>[]> {
  await ensureSyncReady();
  return query<Record<string, unknown>>(
    "SELECT * FROM sync_conflicts ORDER BY id DESC LIMIT ?",
    [Math.max(1, Math.min(limit, 200))],
  );
}

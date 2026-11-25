import { query, get, run } from "./db";
import { invalidateSearchIndex } from "./search";
import { isDbStorage, isStorageConfigured, readStorageSettings, storageUrlForFile } from "./storage";

/** Portable backups: a complete JSON dump of every data table, importable back
 *  into an empty or existing database. The format is versioned so future
 *  releases can migrate old exports on import.
 *
 *  The dump excludes derived tables (search_index — rebuilt automatically) and
 *  the backups table itself (a snapshot must never include snapshots).
 */

export const BACKUP_FORMAT_VERSION = 3;

/** Restore order matters: parents before children (FK constraints), and
 *  `settings` / `dentist_notes` / `backups` have no parents. `search_index` is
 *  intentionally absent — it is derived and rebuilt after import.
 */
export const BACKUP_TABLES = [
  "settings",
  "operatories",
  "practitioners",
  "treatment_types",
  "medicines",
  "inventory_items",
  "inventory_alerts",
  "inventory_movements",
  "patients",
  "appointments",
  "patient_images",
  "patient_image_blobs",
  "treatment_plan_items",
  "clinical_notes",
  "tooth_conditions",
  "invoices",
  "invoice_items",
  "invoice_payments",
  "waiting_list",
  "insurance_plans",
  "lab_cases",
  "appointments_to_make",
  "dentist_notes",
  "prescriptions",
  "prescription_items",
  // Practice-defined prescription templates (no FK): a restored practice keeps
  // the letterheads its prescriptions were issued with.
  "prescription_layouts",
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

export interface BackupPayload {
  format: "dental-canvas-backup";
  version: number;
  created_at: string;
  /** Source practice name, if configured — informational only. */
  clinic_name?: string;
  tables: { [K in BackupTable]: unknown[] };
  /** Real image byte payloads, keyed by the same file_key `patient_image_blobs`
   *  uses. Kept separate from `tables` so a broken export can never lose images:
   *  each file is a 1:1 JSON object, and every `file_key` maps to exactly one
   *  `patient_image_blobs` row on restore. */
  image_files?: BackupImageFile[];
}

export interface BackupImageFile {
  file_key: string;
  mime_type: string;
  created_at: string;
  data_base64: string;
}

export interface BackupSummary {
  id: number;
  kind: string;
  trigger: string;
  table_counts: Record<string, number> | null;
  size_bytes: number | null;
  created_at: string;
}

// ── Dump ───────────────────────────────────────────────────────────

/**
 * BLOB columns need special handling: runtimes materialize them differently
 * (D1 → ArrayBuffer, Miniflare → number[], the offline sql.js adapter →
 * ArrayBuffer) and `JSON.stringify` destroys every one of those into `{}` —
 * which silently dropped every patient image from exports, snapshots and
 * Drive uploads before v1.4.14. Blobs are therefore transported as base64
 * (`data_base64`) and decoded back to binary bytes on import.
 */
function blobValueToBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000; // avoid blowing the argument limit on big images
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  const withTimeout = (AbortSignal as unknown as { timeout?: (n: number) => AbortSignal }).timeout;
  return typeof withTimeout === "function" ? withTimeout.call(AbortSignal, ms) : undefined;
}

/**
 * Download an image whose bytes live in the configured bucket (s3/r2).
 *
 * Bucket uploads go straight from the browser to the bucket and never write
 * `patient_image_blobs`, so without this the export carried metadata only and
 * an import restored image *records* pointing at objects the target install's
 * bucket does not have — the x-rays silently disappeared. Returns null when
 * there is nothing to download (db provider, storage off) or the object is
 * missing/oversized, so one unreadable file never aborts the whole backup.
 */
async function downloadStoredImage(fileKey: string): Promise<Uint8Array | null> {
  const settings = await readStorageSettings();
  if (!isStorageConfigured(settings) || isDbStorage(settings)) return null;
  // storageUrlForFile returns the public base URL or a short-lived presigned
  // GET; a same-origin /api/... URL means the bytes are already in the DB and
  // were collected first.
  const url = await storageUrlForFile(fileKey);
  if (!url || url.startsWith("/")) return null;
  const res = await fetch(url, { signal: timeoutSignal(20_000) });
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) return null;
  const maxBytes = Math.max(1, settings.maxFileMb) * 1024 * 1024;
  if (buf.byteLength > maxBytes) return null;
  return new Uint8Array(buf);
}

/**
 * Every stored image's real bytes, ready to travel in the backup.
 *
 * The payload is base64 (`data_base64`), decoded back into bytes by
 * restoreImageFileBytes: a raw Uint8Array must never be attached here, because
 * JSON.stringify turns it into a mangled object and the INSERT on import then
 * silently dropped every image (the pre-v1.4.14 behaviour).
 *
 * Two sources are merged, so a backup is self-contained whatever storage tier
 * the practice uses:
 *   1. `patient_image_blobs` — the built-in database tier, and anything a
 *      previous import restored;
 *   2. the configured bucket — downloaded now for every `patient_images` row
 *      that has no database copy.
 */
async function dumpImageFiles(): Promise<BackupImageFile[]> {
  const files = new Map<string, BackupImageFile>();

  const rows = await query<{
    file_key: string;
    mime_type: string;
    data: unknown;
    created_at: string;
  }>("SELECT file_key, mime_type, data, created_at FROM patient_image_blobs").catch(() => []);
  for (const r of rows) {
    const bytes = blobValueToBytes(r.data);
    if (!bytes || bytes.byteLength === 0) continue; // corrupt row — skip, don't fail the export
    files.set(r.file_key, {
      file_key: r.file_key,
      mime_type: r.mime_type,
      created_at: r.created_at,
      data_base64: bytesToBase64(bytes),
    });
  }

  const referenced = await query<{ file_key: string; mime_type: string; created_at: string }>(
    "SELECT file_key, mime_type, created_at FROM patient_images WHERE deleted = 0",
  ).catch(() => []);
  const missing = referenced.filter((r) => !files.has(r.file_key));
  // Small batches: a practice with hundreds of x-rays would otherwise make the
  // export a serial walk of bucket GETs, but firing them all at once would
  // exhaust the runtime's concurrent-fetch budget.
  const BATCH = 4;
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (r) => ({ r, bytes: await downloadStoredImage(r.file_key).catch(() => null) })),
    );
    for (const { r, bytes } of results) {
      if (!bytes) continue;
      files.set(r.file_key, {
        file_key: r.file_key,
        mime_type: r.mime_type,
        created_at: r.created_at,
        data_base64: bytesToBase64(bytes),
      });
    }
  }

  // Stable order keeps two exports of an unchanged practice byte-comparable.
  return [...files.values()].sort((a, b) => (a.file_key < b.file_key ? -1 : a.file_key > b.file_key ? 1 : 0));
}

function tableRowCounts(payload: BackupPayload): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of BACKUP_TABLES) counts[t] = payload.tables[t]?.length ?? 0;
  return counts;
}

/** Read every backed-up table. Each table is fetched defensively so a missing
 *  table (partially-migrated dev DB) degrades to `[]` instead of failing the
 *  whole export. */
export async function dumpAllData(): Promise<BackupPayload> {
  const tables = {} as BackupPayload["tables"];
  // Images first: the byte payload has to be assembled from both storage tiers
  // before the table dump is written, and patient_image_blobs *is* that list.
  const imageFiles = await dumpImageFiles();
  await Promise.all(
    BACKUP_TABLES.filter((t) => t !== "patient_image_blobs").map(async (t) => {
      try {
        tables[t] = await query<unknown>(`SELECT * FROM ${t}`);
      } catch {
        tables[t] = [];
      }
    }),
  );
  tables.patient_image_blobs = imageFiles;
  const clinic = (tables.settings as { key: string; value: string }[] | undefined)
    ?.find((r) => r.key === "clinic_name")?.value;

  return {
    format: "dental-canvas-backup",
    version: BACKUP_FORMAT_VERSION,
    created_at: new Date().toISOString(),
    clinic_name: clinic || undefined,
    tables,
    // image_files mirrors patient_image_blobs, keyed by file_key, and travels
    // as a separate top-level array so a truncated/partial export can never
    // silently drop patient bytes.
    image_files: imageFiles,
  };
}

export function countRows(payload: BackupPayload): Record<string, number> {
  return tableRowCounts(payload);
}

// ── Restore ────────────────────────────────────────────────────────

// Base64 inflates image bytes by ~4/3; a practice with many x-rays can
// legitimately produce a multi-hundred-MB export. Images are capped at 5 MB
// each (DB_STORAGE_MAX_MB), so 512 MB ≈ 100+ images — generous.
/** Real image byte payloads keyed by file_key — used by restoreImageFileBytes. */
const byFileKey = new Map<string, Uint8Array>();

export const MAX_IMPORT_BYTES = 512 * 1024 * 1024;

export function validateBackupPayload(raw: unknown): { ok: true; data: BackupPayload } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Backup must be a JSON object" };
  const p = raw as Partial<BackupPayload>;
  if (p.format !== "dental-canvas-backup") {
    return { ok: false, error: "Not a Dental Canvas backup (missing format marker)" };
  }
  if (typeof p.version !== "number") return { ok: false, error: "Backup version is missing" };
  if (p.version > BACKUP_FORMAT_VERSION) {
    return { ok: false, error: `Backup was made by a newer version (${p.version} > ${BACKUP_FORMAT_VERSION}). Update the app first.` };
  }
  if (!p.tables || typeof p.tables !== "object") return { ok: false, error: "Backup has no tables" };
  for (const t of BACKUP_TABLES) {
    if (p.tables[t] !== undefined && !Array.isArray(p.tables[t])) {
      return { ok: false, error: `Table "${t}" must be an array` };
    }
  }
  if (p.image_files !== undefined && !Array.isArray(p.image_files)) {
    return { ok: false, error: "image_files must be an array" };
  }
  for (const f of p.image_files ?? []) {
    if (typeof f?.file_key !== "string" || typeof f?.mime_type !== "string" || typeof f?.data_base64 !== "string" || typeof f?.created_at !== "string") {
      return { ok: false, error: "image_files entries must be { file_key, mime_type, data_base64, created_at }" };
    }
  }
  return { ok: true, data: p as BackupPayload };
}

export async function restoreImageFileBytes(payload: BackupPayload): Promise<number> {
  let n = 0;
  for (const f of payload.image_files ?? []) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = base64ToBytes(f.data_base64);
    } catch {
      // Corrupt/empty base64 — skip, don't abort the import.
    }
    if (!bytes || bytes.byteLength === 0) continue;
    if (!byFileKey.has(f.file_key)) {
      byFileKey.set(f.file_key, bytes);
    }
    n += 1;
  }
  return n;
}

export function isPayloadTooLarge(jsonText: string): boolean {
  return jsonText.length > MAX_IMPORT_BYTES;
}

/** Identity columns that must be preserved for FK integrity. Everything else is
 *  rebuilt row-by-row with explicit ids. Rows are inserted in id order per
 *  table so SQLite keeps AUTOINCREMENT ahead of the imported ids. */
async function insertRows(table: BackupTable, rows: unknown[]): Promise<number> {
  let n = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    let rec = row as Record<string, unknown>;
    if (table === "patient_image_blobs") {
      // The byte payload was moved into image_files and decoded back to real
      // bytes here; the JSON transport columns are dropped before the INSERT.
      const fileKeyVal = rec.file_key;
      const fileKey = typeof fileKeyVal === "string" ? fileKeyVal : undefined;
      const bytes = fileKey !== undefined ? byFileKey.get(fileKey) ?? null : null;
      if (!bytes || bytes.byteLength === 0) continue; // bytes are lost in this backup — skip rather than insert a corrupt image
      rec = { ...rec, data: bytes, data_base64: undefined };
    }
    const cols = Object.keys(rec).filter((k) => rec[k] !== undefined);
    if (cols.length === 0) continue;
    const placeholders = cols.map(() => "?").join(", ");
    const values = cols.map((k) => {
      const v = rec[k];
      // Booleans aren't a SQLite storage class — normalize like the API does.
      if (typeof v === "boolean") return v ? 1 : 0;
      return v;
    });
    await run(
      `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`,
      values,
    );
    n += 1;
  }
  return n;
}

/** Human-facing per-table result counts for the UI. */
export type RestoreCounts = Partial<Record<BackupTable, number>>;

/**
 * Replace the entire dataset with the backup's contents.
 * Deletes (children first), re-inserts (parents first), then rebuilds the
 * derived search index. Not transactional across statements (D1 has no
 * multi-statement API from the worker); a failed import leaves the safety
 * snapshot as the recovery path.
 */
export async function restoreFromBackup(payload: BackupPayload): Promise<RestoreCounts> {
  // 1. Wipe children → parents (reverse restore order).
  for (const t of [...BACKUP_TABLES].reverse()) {
    await run(`DELETE FROM ${t}`).catch(() => undefined);
  }

  // 2. Re-insert parents → children.
  const counts: RestoreCounts = {};
  // Restore real image bytes into the scratch map BEFORE inserting rows
  // (insertRows for patient_image_blobs reads from byFileKey, keyed by
  // file_key). The map starts empty for every import.
  byFileKey.clear();
  await restoreImageFileBytes(payload);
  for (const t of BACKUP_TABLES) {
    const rows = payload.tables[t];
    if (!Array.isArray(rows) || rows.length === 0) {
      counts[t] = 0;
      continue;
    }
    try {
      counts[t] = await insertRows(t, rows);
    } catch {
      // Missing table on a pre-migration dev DB — skip rather than abort.
      counts[t] = 0;
    }
  }

  // 2b. Every image_files entry must exist as a blob row even when the
  // portable tables copy lost it (a stale/partial export ships only part of
  // the payload). The tables loop above covers the normal case; this only
  // fills the gaps, keyed by file_key — the bytes come from the scratch map
  // that restoreImageFileBytes populated.
  let imageFilesRestored = 0;
  for (const f of payload.image_files ?? []) {
    const bytes = byFileKey.get(f.file_key);
    if (!bytes || bytes.byteLength === 0) continue;
    const existing = await get<{ file_key: string }>(
      "SELECT file_key FROM patient_image_blobs WHERE file_key = ?",
      [f.file_key],
    ).catch(() => null);
    if (existing) continue;
    try {
      await run(
        "INSERT INTO patient_image_blobs (file_key, mime_type, data) VALUES (?, ?, ?)",
        [f.file_key, f.mime_type, bytes],
      );
      imageFilesRestored += 1;
    } catch {
      // Missing table / unreadable row — keep importing the rest.
    }
  }
  if (imageFilesRestored > 0) {
    counts.patient_image_blobs = (counts.patient_image_blobs ?? 0) + imageFilesRestored;
  }

  // Clear the scratch map for the next import — restoreImageFileBytes only
  // ever needs the current payload.
  byFileKey.clear();

  // 3. Derived data: clear the search index and invalidate the lazy-backfill
  //    state so the next search re-indexes exactly what was imported (see
  //    src/server/search.ts). Clearing here also covers empty imports, where
  //    the lazy backfill would otherwise skip rebuilding entirely.
  await run("DELETE FROM search_index").catch(() => undefined);
  await invalidateSearchIndex();

  return counts;
}

// ── Snapshot storage ───────────────────────────────────────────────

async function pruneSnapshots(keep: number): Promise<number> {
  const cap = Number.isFinite(keep) && keep > 0 ? Math.min(Math.floor(keep), 100) : 10;
  const stale = await query<{ id: number }>(
    `SELECT id FROM backups ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?`,
    [cap],
  ).catch(() => [] as { id: number }[]);
  let pruned = 0;
  for (const row of stale) {
    await run("DELETE FROM backups WHERE id = ?", [row.id]).catch(() => undefined);
    pruned += 1;
  }
  return pruned;
}

/**
 * Create a snapshot row. `kind`/`trigger` describe why it exists; the payload
 * is the same portable format used for file exports, so any snapshot can be
 * downloaded or restored later.
 */
export async function createSnapshot(
  kind: "auto" | "manual",
  trigger: "timer" | "data_change" | "user" | "pre-import" | "pre-restore",
  keep: number,
): Promise<{ snapshot: BackupSummary; pruned: number; payload: BackupPayload }> {
  const payload = await dumpAllData();
  const json = JSON.stringify(payload);
  const counts = tableRowCounts(payload);

  const result = await run(
    `INSERT INTO backups (kind, trigger, payload, table_counts, size_bytes) VALUES (?, ?, ?, ?, ?)`,
    [kind, trigger, json, JSON.stringify(counts), json.length],
  );
  const pruned = await pruneSnapshots(keep);
  const row = await get<BackupSummary>(
    "SELECT id, kind, trigger, table_counts, size_bytes, created_at FROM backups WHERE id = ?",
    [result.lastInsertRowid],
  );
  const snapshot = {
    ...row,
    table_counts: row?.table_counts ? JSON.parse(row.table_counts as unknown as string) : null,
  } as BackupSummary;
  return { snapshot, pruned, payload };
}

export async function listSnapshots(limit = 50): Promise<BackupSummary[]> {
  const rows = await query<{ id: number; kind: string; trigger: string; table_counts: string | null; size_bytes: number | null; created_at: string }>(
    `SELECT id, kind, trigger, table_counts, size_bytes, created_at
     FROM backups
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    [Math.min(Math.max(limit, 1), 100)],
  ).catch(() => []);
  return rows.map((r) => ({
    ...r,
    table_counts: r.table_counts ? (JSON.parse(r.table_counts) as Record<string, number>) : null,
  }));
}

/** Full payload of one snapshot, for download or restore. Returns null if missing. */
export async function getSnapshotPayload(id: number): Promise<BackupPayload | null> {
  const row = await get<{ payload: string }>("SELECT payload FROM backups WHERE id = ?", [id]);
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as BackupPayload;
  } catch {
    return null;
  }
}

export async function deleteSnapshot(id: number): Promise<boolean> {
  const r = await run("DELETE FROM backups WHERE id = ?", [id]);
  return r.changes > 0;
}

/** Total snapshot storage footprint, for the settings UI. */
export async function snapshotsStats(): Promise<{ count: number; total_bytes: number; last_at: string | null }> {
  const row = await get<{ count: number; total_bytes: number; last_at: string | null }>(
    `SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS total_bytes,
            MAX(created_at) AS last_at
     FROM backups`,
  ).catch(() => ({ count: 0, total_bytes: 0, last_at: null }));
  return row ?? { count: 0, total_bytes: 0, last_at: null };
}

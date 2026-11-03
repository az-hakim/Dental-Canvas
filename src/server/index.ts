import { type Context } from "hono";
import { z } from "zod";
import { createApp } from "@clawnify/app";
import { query, get, run } from "./db";
import {
  DEFAULT_BACKUP_SETTINGS,
  DEFAULT_INVENTORY_SETTINGS,
  DEFAULT_PROFILE_SETTINGS,
  DEFAULT_SETTINGS,
  DEFAULT_STORAGE_SETTINGS,
  MEDICINES_PRESETS_VERSION,
  SEED_DENTIST_NOTES,
  SEED_INVENTORY,
  SEED_MEDICINES,
  SEED_OPERATORIES,
  SEED_PRACTITIONERS,
  SEED_TREATMENT_TYPES,
  INVOICE_STYLE_IDS,
} from "./seed";
import { reindexSearchIndex, searchAll } from "./search";
import {
  authUrl as driveAuthUrl,
  exchangeCodeForTokens,
  getDriveSettings,
  hasCredentials,
  isDriveConfigured,
  recordUploadResult,
  testDriveConnection,
  uploadJsonToDrive,
} from "./gdrive";
import {
  getInventorySettings,
  INVENTORY_CATEGORIES,
  runInventoryScan,
  type InventoryItemRow,
} from "./inventory";
import {
  createSnapshot,
  deleteSnapshot,
  dumpAllData,
  getSnapshotPayload,
  listSnapshots,
  restoreFromBackup,
  snapshotsStats,
  validateBackupPayload,
  isPayloadTooLarge,
  MAX_IMPORT_BYTES,
  countRows,
  type BackupPayload,
} from "./backup";
import {
  IMAGE_KINDS,
  IMAGE_MIME_TYPES,
  DB_STORAGE_MAX_MB,
  isDbStorage,
  isStorageConfigured,
  newObjectKey,
  presignUpload,
  readStorageSettings,
  storageStatus,
  storageUrlForFile,
  validateStorageInput,
} from "./storage";
import { syncTable } from "../shared/sync-schema";
import {
  ackChanges,
  applyRemoteChanges,
  claimSyncOwner,
  ensureSyncReady,
  getLocalDataSummary,
  getPendingChanges,
  getSnapshotChunk,
  getSyncMeta,
  listConflicts,
  prepareLocalForPull,
  recordSyncConflict,
  releaseSyncOwner,
  forgetSyncOwner,
  wipeLocalData,
} from "./sync";

type Env = { Bindings: { DB: D1Database } };

const app = createApp<Env>({
  title: "Dental Canvas",
  version: "1.0.0",
  description: "Dental practice management: patients, appointments, operatories, treatments, and billing.",
});

// ── First-run seed ─────────────────────────────────────────────────
// `schema.sql` is applied as DDL only by the Clawnify deploy pipeline, so the
// practice defaults and the sample rows are inserted here, on the first request
// that reaches the app, instead of from the schema file.

type SeedTable = "operatories" | "practitioners" | "treatment_types" | "dentist_notes" | "medicines" | "inventory_items";

let seeded = false;
let seeding: Promise<void> | null = null;

async function isEmpty(table: SeedTable): Promise<boolean> {
  const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return (row?.n ?? 0) === 0;
}

async function seedOnce(): Promise<void> {
  for (const [key, value] of Object.entries({
    ...DEFAULT_SETTINGS,
    ...DEFAULT_PROFILE_SETTINGS,
    ...DEFAULT_BACKUP_SETTINGS,
    ...DEFAULT_INVENTORY_SETTINGS,
    ...DEFAULT_STORAGE_SETTINGS,
  })) {
    await run("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [key, value]);
  }

  // Sample rows land only while the table is still empty, so a redeploy never
  // resurrects an operatory, practitioner or treatment type the user deleted.
  if (await isEmpty("operatories")) {
    for (const o of SEED_OPERATORIES) {
      await run("INSERT INTO operatories (name, color, sort_order) VALUES (?, ?, ?)", [o.name, o.color, o.sort_order]);
    }
  }

  if (await isEmpty("practitioners")) {
    for (const p of SEED_PRACTITIONERS) {
      await run("INSERT INTO practitioners (name, role, color) VALUES (?, ?, ?)", [p.name, p.role, p.color]);
    }
  }

  if (await isEmpty("treatment_types")) {
    for (const t of SEED_TREATMENT_TYPES) {
      await run(
        "INSERT INTO treatment_types (code, name, duration_minutes, default_fee, color) VALUES (?, ?, ?, ?, ?)",
        [t.code, t.name, t.duration_minutes, t.default_fee, t.color],
      );
    }
  }

  if (await isEmpty("dentist_notes")) {
    for (const n of SEED_DENTIST_NOTES) {
      await run("INSERT INTO dentist_notes (body) VALUES (?)", [n.body]);
    }
  }

  if (await isEmpty("medicines")) {
    for (const m of SEED_MEDICINES) {
      await run(
        "INSERT INTO medicines (name, drug_group, dosage, frequency, duration, instructions) VALUES (?, ?, ?, ?, ?, ?)",
        [m.name, m.drug_group, m.dosage, m.frequency, m.duration, m.instructions],
      );
    }
  } else {
    // The built-in preset list gains entries over time. When it ships a new
    // version, add just the missing names (INSERT OR IGNORE keyed on the name
    // unique index) without touching the user's edits to existing medicines or
    // undoing a medicine they deliberately deleted.
    const cur = await get<{ value: string }>("SELECT value FROM settings WHERE key = 'medicines_presets_version'");
    if ((cur?.value ?? "") !== MEDICINES_PRESETS_VERSION) {
      for (const m of SEED_MEDICINES) {
        await run(
          "INSERT OR IGNORE INTO medicines (name, drug_group, dosage, frequency, duration, instructions) VALUES (?, ?, ?, ?, ?, ?)",
          [m.name, m.drug_group, m.dosage, m.frequency, m.duration, m.instructions],
        );
      }
      await run("INSERT OR REPLACE INTO settings (key, value) VALUES ('medicines_presets_version', ?)", [
        MEDICINES_PRESETS_VERSION,
      ]);
    }
  }

  // Starter dental-supply stock. Expiry dates are rolled relative to the
  // first-run date so the expiring/expired alerts surface right away.
  if (await isEmpty("inventory_items")) {
    for (const it of SEED_INVENTORY) {
      await run(
        `INSERT INTO inventory_items
           (name, category, sku, unit, current_stock, min_threshold, reorder_quantity,
            supplier_name, supplier_contact, batch_number, expiry_date, location, unit_cost, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE date('now', '+' || ? || ' days') END, ?, ?, ?)`,
        [
          it.name, it.category, it.sku, it.unit, it.current_stock, it.min_threshold, it.reorder_quantity,
          it.supplier_name, it.supplier_contact, it.batch_number,
          it.expiry_offset_days, it.expiry_offset_days, it.location, it.unit_cost, it.notes,
        ],
      );
    }
  }
}

async function ensureSeeded(): Promise<void> {
  if (seeded) return;
  try {
    // Concurrent first requests share one run — the app shell fires four API
    // calls in parallel on load, and without this each would read COUNT(*) = 0
    // and insert its own copy of the sample rows.
    // shortcut: the shared promise is per-isolate; if duplicates ever show up on
    // a cold app, claim the seed atomically with an `INSERT OR IGNORE` marker row.
    seeding ??= seedOnce();
    await seeding;
    seeded = true;
  } catch {
    // Sample data must never fail a request.
    seeded = false;
    seeding = null;
  }
}

/**
 * Runtime column migrations for databases created before a schema change.
 * schema.sql only runs as DDL on fresh databases (CREATE TABLE IF NOT EXISTS),
 * so columns added later must be added with ALTER TABLE here. Idempotent and
 * failure-tolerant: a partially-migrated DB must never fail a request.
 */
async function ensureColumnMigrations(): Promise<void> {
  try {
    const cols = await query<{ name: string }>("PRAGMA table_info(prescriptions)");
    // Review-request tracking on appointments (databases predating F3).
    const apptCols = await query<{ name: string }>("PRAGMA table_info(appointments)");
    if (!apptCols.some((c) => c.name === "review_requested_at")) {
      await run("ALTER TABLE appointments ADD COLUMN review_requested_at TEXT");
    }
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("large_print")) {
      await run("ALTER TABLE prescriptions ADD COLUMN large_print INTEGER NOT NULL DEFAULT 0");
    }
    if (!names.has("tooth")) {
      await run("ALTER TABLE prescriptions ADD COLUMN tooth TEXT");
    }
    // Nullable FK: legal in ALTER TABLE because the default is NULL. The plan
    // link is informational (ON DELETE SET NULL) — deleting a plan item must
    // never take a prescription with it.
    if (!names.has("plan_item_id")) {
      await run(
        "ALTER TABLE prescriptions ADD COLUMN plan_item_id INTEGER REFERENCES treatment_plan_items(id) ON DELETE SET NULL",
      );
    }
    // Clinical sidebar fields on the Chamber pad: O/E (on examination) and
    // H/O (history of presenting illness) — databases predating them.
    if (!names.has("on_examination")) {
      await run("ALTER TABLE prescriptions ADD COLUMN on_examination TEXT");
    }
    if (!names.has("history")) {
      await run("ALTER TABLE prescriptions ADD COLUMN history TEXT");
    }
    // Databases created before the chamber template kept the old column
    // default; new rows should default to the chamber pad.
    const dflt = await query<{ dflt_value: string | null }>(
      "SELECT dflt_value FROM pragma_table_info('prescriptions') WHERE name = 'template'",
    );
    if (dflt[0]?.dflt_value && !dflt[0].dflt_value.includes("chamber")) {
      await run("ALTER TABLE prescriptions ALTER COLUMN template SET DEFAULT 'chamber'");
    }
    // Attached image ids (JSON array of patient_images rows) shown on the
    // printed sheet, e.g. the x-ray images associated with this prescription.
    if (!names.has("image_ids")) {
      await run("ALTER TABLE prescriptions ADD COLUMN image_ids TEXT");
    }
    if (!names.has("follow_up_date")) {
      await run("ALTER TABLE prescriptions ADD COLUMN follow_up_date TEXT");
    }
    if (!names.has("complaints")) {
      await run("ALTER TABLE prescriptions ADD COLUMN complaints TEXT");
    }
    if (!names.has("vitals")) {
      await run("ALTER TABLE prescriptions ADD COLUMN vitals TEXT");
    }
    if (!names.has("investigations")) {
      await run("ALTER TABLE prescriptions ADD COLUMN investigations TEXT");
    }
    // Gender snapshot written by the prescription INSERT/UPDATE (reads still
    // join patients for the current value, but the column must exist or every
    // write fails on databases created before it).
    if (!names.has("patient_gender")) {
      await run("ALTER TABLE prescriptions ADD COLUMN patient_gender TEXT");
    }
    // Patient gender (source of truth for the Rx patient info bar).
    const patientCols = await query<{ name: string }>("PRAGMA table_info(patients)");
    if (!patientCols.some((c) => c.name === "patient_gender")) {
      await run("ALTER TABLE patients ADD COLUMN patient_gender TEXT");
    }
    // Medication detail columns: generic / salt name, structured dosing
    // schedule and meal relation. The prescription INSERTs write these
    // unconditionally, so a 1.4.20-era database MUST gain them here or every
    // prescription save fails with "no such column" after the in-app update.
    const itemCols = await query<{ name: string }>("PRAGMA table_info(prescription_items)");
    if (!itemCols.some((c) => c.name === "generic_name")) {
      await run("ALTER TABLE prescription_items ADD COLUMN generic_name TEXT");
    }
    if (!itemCols.some((c) => c.name === "schedule")) {
      await run("ALTER TABLE prescription_items ADD COLUMN schedule TEXT");
    }
    if (!itemCols.some((c) => c.name === "meal_relation")) {
      await run("ALTER TABLE prescription_items ADD COLUMN meal_relation TEXT");
    }
    const medCols = await query<{ name: string }>("PRAGMA table_info(medicines)");
    if (!medCols.some((c) => c.name === "generic_name")) {
      await run("ALTER TABLE medicines ADD COLUMN generic_name TEXT");
    }
    if (!medCols.some((c) => c.name === "schedule")) {
      await run("ALTER TABLE medicines ADD COLUMN schedule TEXT");
    }
    if (!medCols.some((c) => c.name === "meal_relation")) {
      await run("ALTER TABLE medicines ADD COLUMN meal_relation TEXT");
    }
    // Clinical templates saved from a finished prescription gained the Rx's
    // diagnosis / O/E / H/O so a reused template pre-fills the whole clinical
    // note, not just the medications. Databases created before that.
    const templateCols = await query<{ name: string }>("PRAGMA table_info(prescription_templates)");
    for (const column of ["diagnosis", "on_examination", "history"] as const) {
      if (!templateCols.some((c) => c.name === column)) {
        await run(`ALTER TABLE prescription_templates ADD COLUMN ${column} TEXT`);
      }
    }
    // Databases created before the image module existed need the table.
    await run(`CREATE TABLE IF NOT EXISTS patient_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
      file_key TEXT NOT NULL UNIQUE,
      file_name TEXT,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'photo',
      label TEXT,
      compare_group TEXT,
      uploaded_by INTEGER REFERENCES practitioners(id) ON DELETE SET NULL,
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted INTEGER NOT NULL DEFAULT 0
    )`);
    await run("CREATE INDEX IF NOT EXISTS idx_img_patient ON patient_images(patient_id, deleted, uploaded_at DESC)");
    await run("CREATE INDEX IF NOT EXISTS idx_img_appointment ON patient_images(appointment_id)");
    await run("CREATE INDEX IF NOT EXISTS idx_img_compare ON patient_images(patient_id, compare_group)");
    // Byte payloads for the built-in DB storage tier (the default provider).
    // No FK to patient_images — bytes are written before metadata is registered.
    await run(`CREATE TABLE IF NOT EXISTS patient_image_blobs (
      file_key TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL,
      data BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    // Databases created before the medicine list existed need the table.
    await run(`CREATE TABLE IF NOT EXISTS medicines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      generic_name TEXT,
      drug_group TEXT,
      dosage TEXT,
      frequency TEXT,
      schedule TEXT,
      meal_relation TEXT,
      duration TEXT,
      instructions TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await run("CREATE UNIQUE INDEX IF NOT EXISTS idx_medicines_name ON medicines (name)");
    // Reusable prescription clinical templates + advice presets.
    await run(`CREATE TABLE IF NOT EXISTS prescription_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      complaints TEXT,
      vitals TEXT,
      investigations TEXT,
      advice TEXT,
      items TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await run("CREATE INDEX IF NOT EXISTS idx_prescription_templates_name ON prescription_templates(name)");
    // Doctor-defined prescription template skins (Settings → Rx templates).
    await run(`CREATE TABLE IF NOT EXISTS prescription_layouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base TEXT NOT NULL DEFAULT 'chamber',
      config TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await run("CREATE INDEX IF NOT EXISTS idx_prescription_layouts_name ON prescription_layouts(name)");
    await run(`CREATE TABLE IF NOT EXISTS prescription_advice_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    // Databases created before the inventory module existed need the tables.
    await run(`CREATE TABLE IF NOT EXISTS inventory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      sku TEXT,
      unit TEXT NOT NULL DEFAULT 'piece',
      current_stock INTEGER NOT NULL DEFAULT 0,
      min_threshold INTEGER NOT NULL DEFAULT 0,
      reorder_quantity INTEGER,
      supplier_name TEXT,
      supplier_contact TEXT,
      batch_number TEXT,
      expiry_date TEXT,
      location TEXT,
      unit_cost REAL NOT NULL DEFAULT 0,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await run(`CREATE TABLE IF NOT EXISTS inventory_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      unit_cost REAL,
      reference TEXT,
      reason TEXT,
      notes TEXT,
      performed_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await run(`CREATE TABLE IF NOT EXISTS inventory_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    // Databases created before online booking existed.
    await run(`CREATE TABLE IF NOT EXISTS booking_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT 'Online booking',
      practitioner_id INTEGER REFERENCES practitioners(id) ON DELETE CASCADE,
      treatment_type_id INTEGER REFERENCES treatment_types(id) ON DELETE SET NULL,
      days_ahead INTEGER NOT NULL DEFAULT 14,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await run(`CREATE TABLE IF NOT EXISTS booking_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER NOT NULL REFERENCES booking_links(id) ON DELETE CASCADE,
      appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      start_time TEXT NOT NULL,
      treatment_type_id INTEGER REFERENCES treatment_types(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'booked',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    // Databases created before the recall / confirmation features existed.
    const recallCols = await query<{ name: string }>("PRAGMA table_info(appointments_to_make)");
    if (!recallCols.some((c) => c.name === "confirmed_at")) {
      await run("ALTER TABLE appointments_to_make ADD COLUMN confirmed_at TEXT");
    }
    await run(`CREATE TABLE IF NOT EXISTS patient_recall_config (
      patient_id INTEGER PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
      recall_type_id INTEGER REFERENCES treatment_types(id) ON DELETE SET NULL,
      interval_months INTEGER NOT NULL DEFAULT 6,
      last_completed TEXT
    )`);
    // Databases created before the check-in kiosk existed: when the patient
    // physically arrived (kiosk check-in), for wait-time tracking.
    const apptCols2 = await query<{ name: string }>("PRAGMA table_info(appointments)");
    if (!apptCols2.some((c) => c.name === "checked_in_at")) {
      await run("ALTER TABLE appointments ADD COLUMN checked_in_at TEXT");
    }
    // When the patient actually got into the chair — paired with
    // checked_in_at this measures the real reception wait.
    if (!apptCols2.some((c) => c.name === "in_chair_at")) {
      await run("ALTER TABLE appointments ADD COLUMN in_chair_at TEXT");
    }
    // Databases created before payment plans existed.
    await run(`CREATE TABLE IF NOT EXISTS invoice_payment_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      installment_count INTEGER NOT NULL,
      interval TEXT NOT NULL DEFAULT 'monthly',
      start_date TEXT NOT NULL,
      installment_amount REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    // When the front desk last sent an installment reminder for this plan.
    const planCols = await query<{ name: string }>("PRAGMA table_info(invoice_payment_plans)");
    if (!planCols.some((c) => c.name === "payment_plan_reminded_at")) {
      await run("ALTER TABLE invoice_payment_plans ADD COLUMN payment_plan_reminded_at TEXT");
    }
    // Links auto-billed invoice line items back to their treatment-plan item
    // (databases created before treatment-plan → billing sync existed).
    const invItemCols = await query<{ name: string }>("PRAGMA table_info(invoice_items)");
    if (!invItemCols.some((c) => c.name === "treatment_plan_item_id")) {
      await run(
        "ALTER TABLE invoice_items ADD COLUMN treatment_plan_item_id INTEGER REFERENCES treatment_plan_items(id) ON DELETE SET NULL",
      );
    }
    // Databases created before membership plans existed need the tables.
    await run(`CREATE TABLE IF NOT EXISTS membership_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      monthly_fee REAL NOT NULL DEFAULT 0,
      annual_fee REAL,
      discount_percent REAL NOT NULL DEFAULT 0,
      benefits TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await run(`CREATE TABLE IF NOT EXISTS patient_memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      plan_id INTEGER NOT NULL REFERENCES membership_plans(id) ON DELETE CASCADE,
      start_date TEXT NOT NULL,
      end_date TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired')),
      last_billed_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await run("CREATE INDEX IF NOT EXISTS idx_patient_membership ON patient_memberships(patient_id, status)");
    await run("CREATE INDEX IF NOT EXISTS idx_membership_plan ON patient_memberships(plan_id)");
    // Databases created before digital consent forms existed need the tables.
    await run(`CREATE TABLE IF NOT EXISTS consent_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      requires_guardian INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await run(`CREATE TABLE IF NOT EXISTS consent_signatures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL REFERENCES consent_templates(id) ON DELETE CASCADE,
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
      signer_name TEXT NOT NULL,
      signer_role TEXT NOT NULL DEFAULT 'patient',
      signature_data TEXT NOT NULL,
      signed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await run("CREATE INDEX IF NOT EXISTS idx_consent_patient ON consent_signatures(patient_id, signed_at DESC)");
  } catch {
    // Table missing (fresh DB pre-DDL) or PRAGMA unsupported — schema.sql will
    // create the table with the column when it runs.
  }
}

let migrated = false;
let migrating: Promise<void> | null = null;

async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  migrating ??= ensureColumnMigrations()
    .then(() => {
      migrated = true;
    })
    .catch(() => {
      migrating = null; // retry on the next request
    });
  await migrating;
}

app.use("*", async (_c, next) => {
  await ensureMigrated();
  // Sync bookkeeping must exist before the first seed INSERT so those rows get
  // their sync ids and land in the outbox like every later write.
  await ensureSyncReady().catch(() => undefined);
  await ensureSeeded();
  await next();
});

// ── Helpers ────────────────────────────────────────────────────────

const intParam = (raw: string | undefined): number | null => {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
};

/** 'YYYY-MM-DD' plus N days (used for the expiry alert window). */
function datePlusDays(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function parseJson<T>(c: Context, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") };
  return { ok: true, data: parsed.data };
}

// ── Operatories ────────────────────────────────────────────────────

const OperatoryInput = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
  sort_order: z.number().int().optional(),
});

app.get("/api/operatories", async (c) => {
  const rows = await query("SELECT * FROM operatories ORDER BY sort_order, id");
  return c.json({ operatories: rows });
});

app.post("/api/operatories", async (c) => {
  const parsed = await parseJson(c, OperatoryInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { name, color, sort_order } = parsed.data;
  const result = await run(
    "INSERT INTO operatories (name, color, sort_order) VALUES (?, ?, COALESCE(?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM operatories)))",
    [name, color ?? "sky", sort_order ?? null],
  );
  const row = await get("SELECT * FROM operatories WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ operatory: row }, 201);
});

app.put("/api/operatories/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, OperatoryInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const fields = parsed.data;
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
  }
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE operatories SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get("SELECT * FROM operatories WHERE id = ?", [id]);
  return c.json({ operatory: row });
});

app.delete("/api/operatories/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM operatories WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Practitioners ──────────────────────────────────────────────────

const PractitionerInput = z.object({
  name: z.string().min(1),
  role: z.enum(["dentist", "hygienist", "assistant"]).optional(),
  color: z.string().optional(),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
});

app.get("/api/practitioners", async (c) => {
  const rows = await query("SELECT * FROM practitioners ORDER BY name");
  return c.json({ practitioners: rows });
});

app.post("/api/practitioners", async (c) => {
  const parsed = await parseJson(c, PractitionerInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { name, role, color, email, phone } = parsed.data;
  const result = await run(
    "INSERT INTO practitioners (name, role, color, email, phone) VALUES (?, ?, ?, ?, ?)",
    [name, role ?? "dentist", color ?? "teal", email ?? null, phone ?? null],
  );
  const row = await get("SELECT * FROM practitioners WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ practitioner: row }, 201);
});

app.put("/api/practitioners/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, PractitionerInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
  }
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE practitioners SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get("SELECT * FROM practitioners WHERE id = ?", [id]);
  return c.json({ practitioner: row });
});

app.delete("/api/practitioners/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM practitioners WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Treatment types ────────────────────────────────────────────────

const TreatmentTypeInput = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  duration_minutes: z.number().int().min(5).optional(),
  default_fee: z.number().min(0).optional(),
  color: z.string().optional(),
});

app.get("/api/treatment-types", async (c) => {
  const rows = await query("SELECT * FROM treatment_types ORDER BY code");
  return c.json({ treatment_types: rows });
});

app.post("/api/treatment-types", async (c) => {
  const parsed = await parseJson(c, TreatmentTypeInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { code, name, duration_minutes, default_fee, color } = parsed.data;
  const result = await run(
    "INSERT INTO treatment_types (code, name, duration_minutes, default_fee, color) VALUES (?, ?, ?, ?, ?)",
    [code, name, duration_minutes ?? 30, default_fee ?? 0, color ?? "sky"],
  );
  const row = await get("SELECT * FROM treatment_types WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ treatment_type: row }, 201);
});

app.put("/api/treatment-types/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, TreatmentTypeInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
  }
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE treatment_types SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get("SELECT * FROM treatment_types WHERE id = ?", [id]);
  return c.json({ treatment_type: row });
});

app.delete("/api/treatment-types/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM treatment_types WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Medicines (editable practice list → prescription autocomplete) ──

const MedicineInput = z.object({
  name: z.string().min(1),
  drug_group: z.string().optional(),
  dosage: z.string().optional(),
  frequency: z.string().optional(),
  duration: z.string().optional(),
  instructions: z.string().optional(),
});

app.get("/api/medicines", async (c) => {
  const rows = await query("SELECT * FROM medicines ORDER BY name COLLATE NOCASE");
  return c.json({ medicines: rows });
});

app.post("/api/medicines", async (c) => {
  const parsed = await parseJson(c, MedicineInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { name, drug_group, dosage, frequency, duration, instructions } = parsed.data;
  const existing = await get("SELECT id FROM medicines WHERE name = ? COLLATE NOCASE", [name.trim()]);
  if (existing) return c.json({ error: `“${name.trim()}” is already in your medicine list.` }, 409);
  const result = await run(
    "INSERT INTO medicines (name, drug_group, dosage, frequency, duration, instructions) VALUES (?, ?, ?, ?, ?, ?)",
    [name.trim(), drug_group?.trim() || null, dosage?.trim() || null, frequency?.trim() || null, duration?.trim() || null, instructions?.trim() || null],
  );
  const row = await get("SELECT * FROM medicines WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ medicine: row }, 201);
});

app.put("/api/medicines/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, MedicineInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) { sets.push(`${k} = ?`); params.push(typeof v === "string" && v.trim() === "" ? null : v); }
  }
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE medicines SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get("SELECT * FROM medicines WHERE id = ?", [id]);
  return c.json({ medicine: row });
});

app.delete("/api/medicines/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM medicines WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Patients ───────────────────────────────────────────────────────

const PatientInput = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  date_of_birth: z.string().optional().nullable(),
  patient_gender: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  medical_alerts: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  referral_source: z.string().optional().nullable(),
});

app.get("/api/patients", async (c) => {
  const search = c.req.query("q")?.trim();
  if (search) {
    // A query of 7+ digits is treated as a phone search and matched against
    // the *normalized* phone (punctuation stripped), so "5550100111" finds
    // "(555) 010-0111". Short queries use plain LIKE matching.
    const digits = search.replace(/\D/g, "");
    if (digits.length >= 7) {
      const rows = await query(
        "SELECT * FROM patients WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '(', ''), ')', ''), '-', '') LIKE ? ORDER BY last_name, first_name LIMIT 200",
        [`%${digits}%`],
      );
      // Also match plain LIKE so names that happen to be digits still surface.
      const like = `%${search}%`;
      const extra = await query(
        "SELECT * FROM patients WHERE (last_name LIKE ? OR first_name LIKE ? OR email LIKE ? OR phone LIKE ?) ORDER BY last_name, first_name LIMIT 200",
        [like, like, like, like],
      );
      const merged = [...rows, ...extra.filter((e) => !rows.some((r) => r.id === e.id))];
      return c.json({ patients: merged });
    }
    const like = `%${search}%`;
    const rows = await query(
      "SELECT * FROM patients WHERE last_name LIKE ? OR first_name LIKE ? OR email LIKE ? OR phone LIKE ? ORDER BY last_name, first_name LIMIT 200",
      [like, like, like, like],
    );
    return c.json({ patients: rows });
  }
  const rows = await query("SELECT * FROM patients ORDER BY last_name, first_name LIMIT 500");
  return c.json({ patients: rows });
});

app.get("/api/patients/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const row = await get("SELECT * FROM patients WHERE id = ?", [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ patient: row });
});

app.post("/api/patients", async (c) => {
  const parsed = await parseJson(c, PatientInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    "INSERT INTO patients (first_name, last_name, date_of_birth, patient_gender, email, phone, address, medical_alerts, notes, referral_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [d.first_name, d.last_name, d.date_of_birth ?? null, d.patient_gender ?? null, d.email ?? null, d.phone ?? null, d.address ?? null, d.medical_alerts ?? null, d.notes ?? null, d.referral_source ?? null],
  );
  const row = await get("SELECT * FROM patients WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ patient: row }, 201);
});

app.put("/api/patients/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, PatientInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
  }
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE patients SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get("SELECT * FROM patients WHERE id = ?", [id]);
  return c.json({ patient: row });
});

app.delete("/api/patients/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM patients WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Practice-defined prescription templates (Settings → Rx templates) ──
//
// A layout is the printable sheet itself: structure, palette, typography and
// which clinical blocks print. It is stored as JSON so the doctor can edit a
// copy of any built-in template or build their own. A prescription stores the
// sheet id `custom-<id>`; the config is attached on read so print, PDF and the
// public share page render the saved skin without extra lookups.

const BUILTIN_TEMPLATE_IDS = [
  "chamber",
  "classic",
  "modern",
  "compact",
  "elegant",
  "minimal",
  "bold",
  "watermark",
  "two-column",
] as const;

const HexColorInput = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Colors must be six-digit hex, e.g. #0e7490");

const RxSheetSectionInput = z.object({
  key: z.enum([
    "diagnosis",
    "on_examination",
    "history",
    "treatment_plan",
    "complaints",
    "investigations",
    "vitals",
    "xray",
  ]),
  label: z.string().max(40).default(""),
  enabled: z.boolean(),
});

const RxTemplateConfigInput = z.object({
  layout: z.enum(["sidebar", "stacked"]),
  accent: HexColorInput,
  header_bg: HexColorInput,
  header_text: HexColorInput,
  font: z.enum(["sans", "serif"]),
  show_rule: z.boolean(),
  show_logo: z.boolean(),
  show_bangla: z.boolean(),
  show_watermark: z.boolean(),
  show_signature: z.boolean(),
  footer_note: z.string().max(600).default(""),
  sections: z.array(RxSheetSectionInput).max(12),
});

const RxLayoutInput = z.object({
  name: z.string().min(1).max(60),
  base: z.enum(BUILTIN_TEMPLATE_IDS).default("chamber"),
  config: RxTemplateConfigInput,
});

type RxLayoutRow = { id: number; name: string; base: string; config: string };

/** A saved layout row shaped for the client (slug = the prescription template id). */
function shapeRxLayout(r: RxLayoutRow) {
  let config: unknown = null;
  try {
    config = JSON.parse(r.config);
  } catch {
    /* a corrupt row must not take the list down — the client falls back */
  }
  return { id: r.id, slug: `custom-${r.id}`, name: r.name, based_on: r.base, config };
}

async function listRxLayouts(): Promise<RxLayoutRow[]> {
  return query<RxLayoutRow>("SELECT id, name, base, config FROM prescription_layouts ORDER BY name COLLATE NOCASE");
}

/** True when `id` names a template a prescription may be printed with. */
async function isKnownTemplateId(id: string): Promise<boolean> {
  if ((BUILTIN_TEMPLATE_IDS as readonly string[]).includes(id)) return true;
  const m = /^custom-(\d+)$/.exec(id);
  if (!m) return false;
  const row = await get<{ id: number }>("SELECT id FROM prescription_layouts WHERE id = ?", [Number(m[1])]);
  return Boolean(row);
}

/** The saved skin behind a prescription's template id: only custom ids have one. */
async function templateConfigFor(template: unknown): Promise<unknown> {
  if (typeof template !== "string") return null;
  const m = /^custom-(\d+)$/.exec(template);
  if (!m) return null;
  const row = await get<RxLayoutRow>("SELECT id, name, base, config FROM prescription_layouts WHERE id = ?", [Number(m[1])]);
  return row ? shapeRxLayout(row).config : null;
}

app.get("/api/prescription-layouts", async (c) => {
  return c.json({ layouts: (await listRxLayouts()).map(shapeRxLayout) });
});

app.post("/api/prescription-layouts", async (c) => {
  const parsed = await parseJson(c, RxLayoutInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    "INSERT INTO prescription_layouts (name, base, config) VALUES (?, ?, ?)",
    [d.name.trim(), d.base, JSON.stringify(d.config)],
  );
  const row = await get<RxLayoutRow>("SELECT id, name, base, config FROM prescription_layouts WHERE id = ?", [result.lastInsertRowid]);
  if (!row) return c.json({ error: "Could not read back the created template" }, 500);
  return c.json({ layout: shapeRxLayout(row) }, 201);
});

app.put("/api/prescription-layouts/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, RxLayoutInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const exists = await get<{ id: number }>("SELECT id FROM prescription_layouts WHERE id = ?", [id]);
  if (!exists) return c.json({ error: "Not found" }, 404);
  await run(
    "UPDATE prescription_layouts SET name = ?, base = ?, config = ?, updated_at = datetime('now') WHERE id = ?",
    [d.name.trim(), d.base, JSON.stringify(d.config), id],
  );
  const row = await get<RxLayoutRow>("SELECT id, name, base, config FROM prescription_layouts WHERE id = ?", [id]);
  if (!row) return c.json({ error: "Could not read back the template" }, 500);
  return c.json({ layout: shapeRxLayout(row) });
});

app.delete("/api/prescription-layouts/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM prescription_layouts WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Prescriptions ──────────────────────────────────────────────────

const PrescriptionInput = z.object({
  patient_id: z.number().int(),
  practitioner_id: z.number().int().nullable().optional(),
  issued_date: z.string().optional().nullable(),
  template: z.string().max(40).optional(),
  large_print: z.boolean().optional(),
  tooth: z.string().max(32).optional().nullable(),
  plan_item_id: z.number().int().nullable().optional(),
  diagnosis: z.string().optional().nullable(),
  on_examination: z.string().optional().nullable(),
  history: z.string().optional().nullable(),
  advice: z.string().optional().nullable(),
  follow_up: z.string().optional().nullable(),
  follow_up_date: z.string().optional().nullable(),
  patient_gender: z.string().optional().nullable(),
  complaints: z.string().optional().nullable(),
  vitals: z.string().optional().nullable(),
  investigations: z.string().optional().nullable(),
  items: z
    .array(
      z.object({
        drug_name: z.string().min(1),
        generic_name: z.string().optional().nullable(),
        dosage: z.string().optional().nullable(),
        frequency: z.string().optional().nullable(),
        schedule: z.string().optional().nullable(),
        meal_relation: z.string().optional().nullable(),
        duration: z.string().optional().nullable(),
        instructions: z.string().optional().nullable(),
      }),
    )
    .min(1),
  // patient_images rows to show on the printed sheet (x-rays etc).
  image_ids: z.array(z.number().int()).max(12).optional(),
});

const PrescriptionUpdateInput = PrescriptionInput.partial().extend({
  items: z
    .array(
      z.object({
        drug_name: z.string().min(1),
        generic_name: z.string().optional().nullable(),
        dosage: z.string().optional().nullable(),
        frequency: z.string().optional().nullable(),
        schedule: z.string().optional().nullable(),
        meal_relation: z.string().optional().nullable(),
        duration: z.string().optional().nullable(),
        instructions: z.string().optional().nullable(),
      }),
    )
    .optional(),
});

/** A logo must be a small image/* data URL — anything else is refused. */
function isSafeLogoDataUrl(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.startsWith("data:image/") &&
    v.length <= 400_000 &&
    !v.includes("<") &&
    !v.includes(">")
  );
}

async function loadPrescription(id: number) {
  const rx = await get(`
    SELECT rx.*, pr.name as practitioner_name, pr.role as practitioner_role,
           p.first_name as patient_first_name, p.last_name as patient_last_name,
           p.date_of_birth as patient_date_of_birth, p.patient_gender as patient_gender, p.medical_alerts as patient_medical_alerts,
           p.email as patient_email, p.phone as patient_phone,
           tt.name as plan_treatment_name, tt.code as plan_treatment_code
    FROM prescriptions rx
    LEFT JOIN practitioners pr ON pr.id = rx.practitioner_id
    LEFT JOIN patients p ON p.id = rx.patient_id
    LEFT JOIN treatment_plan_items tpi ON tpi.id = rx.plan_item_id
    LEFT JOIN treatment_types tt ON tt.id = tpi.treatment_type_id
    WHERE rx.id = ?
  `, [id]);
  if (!rx) return null;
  const items = await query(
    "SELECT * FROM prescription_items WHERE prescription_id = ? ORDER BY sort_order, id",
    [id],
  );
  const imageIds = parseImageIds(rx.image_ids);
  const images = imageIds.length ? await resolveImageRows(imageIds) : [];
  // A custom template's saved skin travels with the prescription so print/PDF
  // and the public share page render it without a second request.
  const templateConfig = await templateConfigFor(rx.template);
  return { ...rx, image_ids: imageIds.length ? imageIds : null, items, images, template_config: templateConfig };
}

app.get("/api/patients/:id/prescriptions", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const rows = await query(
    `SELECT rx.*, p.first_name as patient_first_name, p.last_name as patient_last_name,
            p.date_of_birth as patient_date_of_birth, p.patient_gender as patient_gender,
            p.medical_alerts as patient_medical_alerts, pr.name as practitioner_name,
            tt.name as plan_treatment_name,
            (SELECT COUNT(*) FROM prescription_items ri WHERE ri.prescription_id = rx.id) as item_count
     FROM prescriptions rx
     LEFT JOIN patients p ON p.id = rx.patient_id
     LEFT JOIN practitioners pr ON pr.id = rx.practitioner_id
     LEFT JOIN treatment_plan_items tpi ON tpi.id = rx.plan_item_id
     LEFT JOIN treatment_types tt ON tt.id = tpi.treatment_type_id
     WHERE rx.patient_id = ?
     ORDER BY rx.issued_date DESC, rx.id DESC`,
    [id],
  );
  return c.json({ prescriptions: rows.map((r) => ({ ...r, image_ids: parseImageIds(r.image_ids) })) });
});

app.get("/api/prescriptions/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const rx = await loadPrescription(id);
  if (!rx) return c.json({ error: "Not found" }, 404);
  return c.json({ prescription: rx });
});

/** Generate a new share token for a prescription (practice only). Returns the
 * token so the UI can open the public share page. Re-issuing replaces any
 * existing token (a prescription can have at most one live share link). */
app.post("/api/prescriptions/:id/share", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const existing = await get<{ id: number }>("SELECT id FROM prescriptions WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "Not found" }, 404);
  const token = newPrescriptionShareToken();
  await run("UPDATE prescriptions SET share_token = ?, share_revoked = 0 WHERE id = ?", [token, id]);
  return c.json({ share_token: token, share_url: `/share/prescription/${token}` });
});

/** Revoke the public share link for a prescription (practice only). After this,
 * the token no longer opens the public page. */
app.post("/api/prescriptions/:id/revoke-share", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const existing = await get<{ id: number }>("SELECT id FROM prescriptions WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "Not found" }, 404);
  await run("UPDATE prescriptions SET share_token = NULL, share_revoked = 1 WHERE id = ?", [id]);
  return c.json({ ok: true });
});

/** Public, no-auth read for a shared prescription. The token is the random hex
 * stored in `share_token`; the link is /share/prescription/<token>. A revoked
 * or missing token returns 404 so the page can show its “not found” state. */
app.get("/api/prescriptions/share/:token", async (c) => {
  const token = c.req.param("token");
  if (!token) return c.json({ error: "Not found" }, 404);
  const rx = await get<Record<string, unknown>>(
    `SELECT rx.*, pr.name as practitioner_name, pr.role as practitioner_role,
            p.first_name as patient_first_name, p.last_name as patient_last_name,
            p.date_of_birth as patient_date_of_birth, p.medical_alerts as patient_medical_alerts,
            p.email as patient_email, p.phone as patient_phone,
            tt.name as plan_treatment_name, tt.code as plan_treatment_code
     FROM prescriptions rx
     LEFT JOIN practitioners pr ON pr.id = rx.practitioner_id
     LEFT JOIN patients p ON p.id = rx.patient_id
     LEFT JOIN treatment_plan_items tpi ON tpi.id = rx.plan_item_id
     LEFT JOIN treatment_types tt ON tt.id = tpi.treatment_type_id
     WHERE rx.share_token = ? AND rx.share_revoked = 0`,
    [token],
  );
  if (!rx) return c.json({ error: "Not found" }, 404);
  const id = Number(rx.id);
  const items = await query(
    "SELECT * FROM prescription_items WHERE prescription_id = ? ORDER BY sort_order, id",
    [id],
  );
  const imageIds = parseImageIds(rx.image_ids);
  const images = imageIds.length ? await resolveImageRows(imageIds) : [];
  const templateConfig = await templateConfigFor(rx.template);
  const out = { ...rx, id, image_ids: imageIds.length ? imageIds : null, items, images, template_config: templateConfig };
  return c.json({ prescription: out });
});

/** Strip HTML-sensitive characters from interpolated email text. */
function escapeEmailHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

/**
 * Email a prescription PDF to the patient. The PDF is rasterized in the
 * browser (the sheet is client-side markup), posted here as base64, and
 * relayed through the Resend API using the practice's configured key —
 * the key never reaches the browser. Defaults to the patient record's
 * email; the request may override the recipient.
 */
app.post("/api/prescriptions/:id/email", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }

  const rx = await loadPrescription(id);
  if (!rx) return c.json({ error: "Not found" }, 404);
  const row = rx as unknown as Record<string, unknown>;

  const settingsRows = await query<{ key: string; value: string }>("SELECT key, value FROM settings").catch(() => []);
  const settings = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));
  const apiKey = (settings.email_api_key ?? "").trim();
  const from = (settings.email_from ?? "").trim();
  if (!apiKey || !from) {
    return c.json({ error: "Email is not configured yet. Add a Resend API key and from address in Settings → Email." }, 400);
  }

  const to = typeof body.to === "string" && body.to.trim() ? body.to.trim() : typeof row.patient_email === "string" ? row.patient_email : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return c.json({ error: "This patient has no email address on file. Add one to the patient record first." }, 400);
  }

  const rawPdf = typeof body.pdf_base64 === "string" ? body.pdf_base64.trim() : "";
  const base64 = rawPdf.includes(",") ? rawPdf.slice(rawPdf.indexOf(",") + 1) : rawPdf;
  if (!base64 || !/^[A-Za-z0-9+/=\r\n]+$/.test(base64.slice(0, 512))) {
    return c.json({ error: "A generated PDF is required to send." }, 400);
  }
  if (base64.length > 10 * 1024 * 1024) {
    return c.json({ error: "The PDF is too large to email." }, 413);
  }

  const clinicName = (settings.clinic_name ?? "").trim();
  const doctorName = (settings.doctor_name ?? "").trim();
  const practiceLabel = clinicName || doctorName || "Dental Canvas";
  const patientFirst = typeof row.patient_first_name === "string" ? row.patient_first_name.trim() : "";
  const issuedDate = typeof row.issued_date === "string" ? row.issued_date : "";
  const note = typeof body.message === "string" ? body.message.trim().slice(0, 2000) : "";

  const subject = `Prescription from ${practiceLabel} — ${issuedDate}`;
  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">
      <h2 style="margin:0 0 4px;color:#166534">${escapeEmailHtml(practiceLabel)}</h2>
      <p style="margin:0 0 16px;color:#6b7280;font-size:13px">Prescription dated ${escapeEmailHtml(issuedDate)}</p>
      <p style="margin:0 0 8px">Hello ${escapeEmailHtml(patientFirst || "there")},</p>
      ${note ? `<p style="margin:0 0 8px;white-space:pre-line">${escapeEmailHtml(note)}</p>` : ""}
      <p style="margin:0 0 8px">Your prescription is attached as a PDF. Please follow the dosage and instructions it contains, and contact the practice with any questions.</p>
      ${doctorName ? `<p style="margin:16px 0 0">— ${escapeEmailHtml(doctorName)}${clinicName ? `, ${escapeEmailHtml(clinicName)}` : ""}</p>` : ""}
    </div>`;

  let providerRes: Response;
  try {
    providerRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html,
        attachments: [{
          filename: typeof body.filename === "string" && body.filename.trim() ? body.filename.trim() : "prescription.pdf",
          content: base64,
        }],
      }),
    });
  } catch (err) {
    return c.json({ error: `Could not reach the email provider: ${(err as Error).message}` }, 502);
  }
  if (!providerRes.ok) {
    const detail = await providerRes.text().catch(() => "");
    return c.json({ error: `The email provider rejected the message (${providerRes.status}). ${detail.slice(0, 300)}` }, 502);
  }
  const sent = (await providerRes.json().catch(() => ({}))) as { id?: string };
  return c.json({ ok: true, provider_id: sent.id ?? null, to });
});

// ── Daily worklist digest (email) ────────────────────────────
// Every morning, the clinic inbox receives one email listing today's three
// outreach worklists: appointment reminders, hygiene recalls due, and
// installments due. The browser timer (use-daily-digest.ts) fires the send
// once per day — the serverless API can't schedule on its own.

interface DigestDigestInput {
  to?: string;
}
/** Shared email-settings loader (Resend key + from address). */
async function loadEmailSettings(): Promise<{ apiKey: string; from: string; clinicName: string; doctorName: string }> {
  const rows = await query<{ key: string; value: string }>("SELECT key, value FROM settings").catch(() => []);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    apiKey: (s.email_api_key ?? "").trim(),
    from: (s.email_from ?? "").trim(),
    clinicName: (s.clinic_name ?? "").trim(),
    doctorName: (s.doctor_name ?? "").trim(),
  };
}

/** Sends an email via Resend. Returns the provider message id, or throws with a readable error. */
async function sendEmail(apiKey: string, from: string, to: string, subject: string, html: string): Promise<string | null> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`The email provider rejected the message (${res.status}). ${detail.slice(0, 300)}`);
  }
  const sent = (await res.json().catch(() => ({}))) as { id?: string };
  return sent.id ?? null;
}

/** The digest's worklist sections, in email order. */
const DIGEST_SECTIONS = ["reminders", "recalls", "installments"] as const;
type DigestSection = (typeof DIGEST_SECTIONS)[number];

/**
 * Parse the digest_sections setting: a comma list of section ids. An empty or
 * unrecognized value means "all sections" — the pre-selection behavior, so
 * existing clinics keep their digest untouched after upgrade.
 */
function parseDigestSections(raw: string | undefined): DigestSection[] {
  const wanted = (raw ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x): x is DigestSection => (DIGEST_SECTIONS as readonly string[]).includes(x));
  return wanted.length ? wanted : [...DIGEST_SECTIONS];
}

async function buildDigestHtml(sections: DigestSection[]): Promise<{ subject: string; html: string; counts: { reminders: number; recalls: number; installments: number } }> {
  const { clinicName, doctorName } = await loadEmailSettings();
  const practiceLabel = clinicName || doctorName || "Dental Canvas";
  const esc = escapeEmailHtml;
  // The digest email is formatted with the practice's currency setting.
  const settingsRows = await query<{ key: string; value: string }>(
    "SELECT key, value FROM settings WHERE key = 'currency'",
  ).catch(() => [] as Array<{ key: string; value: string }>);
  const currency = settingsRows[0]?.value === "BDT" ? "BDT" : "USD";
  const money = (n: number) =>
    currency === "BDT"
      ? `৳${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
      : n.toLocaleString("en-US", { style: "currency", currency: "USD" });

  const wantReminders = sections.includes("reminders");
  const wantRecalls = sections.includes("recalls");
  const wantInstallments = sections.includes("installments");

  const [reminders, recalls, installments] = await Promise.all([
    // A disabled section resolves as an empty list without touching the DB.
    wantReminders
      ? query<{ start_time: string; first_name: string | null; last_name: string | null; treatment_name: string | null; practitioner_name: string | null }>(
      `SELECT a.start_time, p.first_name, p.last_name, tt.name as treatment_name, pr.name as practitioner_name
       FROM appointments a
       LEFT JOIN patients p ON p.id = a.patient_id
       LEFT JOIN treatment_types tt ON tt.id = a.treatment_type_id
       LEFT JOIN practitioners pr ON pr.id = a.practitioner_id
       WHERE substr(a.start_time, 1, 10) = date('now', '+1 day') AND a.kind = 'patient' AND a.status = 'scheduled'
       ORDER BY a.start_time LIMIT 50`,
    ).catch(() => [])
      : Promise.resolve([] as { start_time: string; first_name: string | null; last_name: string | null; treatment_name: string | null; practitioner_name: string | null }[]),
    wantRecalls
      ? query<{ name: string; recall_type: string | null; due_date: string; days_overdue: number }>(
      `SELECT * FROM (
        SELECT atm.id, p.first_name || ' ' || p.last_name AS name,
               tt.name AS recall_type,
               COALESCE(
                 (SELECT date(rc.last_completed, '+' || rc.interval_months || ' months')
                  FROM patient_recall_config rc WHERE rc.patient_id = atm.patient_id),
                 atm.due_after, date(atm.created_at)
               ) AS due_date
        FROM appointments_to_make atm
        JOIN patients p ON p.id = atm.patient_id
        LEFT JOIN treatment_types tt ON tt.id = atm.treatment_type_id
        WHERE atm.status = 'open' AND atm.source = 'system'
          AND COALESCE(
            (SELECT date(rc2.last_completed, '+' || rc2.interval_months || ' months')
             FROM patient_recall_config rc2 WHERE rc2.patient_id = atm.patient_id),
            atm.due_after, date(atm.created_at)
          ) <= date('now', '+30 days')
      ) ORDER BY due_date ASC LIMIT 50`,
    ).catch(() => [] as { name: string; recall_type: string | null; due_date: string; days_overdue: number }[])
      : Promise.resolve([] as { name: string; recall_type: string | null; due_date: string; days_overdue: number }[]),
    wantInstallments
      ? query<{ patient_name: string; installment_n: number; amount: number; due_date: string; overdue: number; balance: number }>(
      `SELECT * FROM (
        SELECT ipp.id,
               p.first_name || ' ' || p.last_name AS patient_name,
               1 AS installment_n,
               ipp.installment_amount AS amount,
               ipp.start_date AS due_date,
               CASE WHEN date(ipp.start_date) < date('now') THEN 1 ELSE 0 END AS overdue,
               i.total - i.amount_paid AS balance
        FROM invoice_payment_plans ipp
        JOIN invoices i ON i.id = ipp.invoice_id
        LEFT JOIN patients p ON p.id = i.patient_id
        WHERE ipp.active = 1 AND i.status != 'void' AND i.total > i.amount_paid
          AND date(ipp.start_date) <= date('now', '+3 days')
      ) ORDER BY due_date ASC LIMIT 50`,
    ).catch(() => [] as { patient_name: string; installment_n: number; amount: number; due_date: string; overdue: number; balance: number }[])
      : Promise.resolve([] as { patient_name: string; installment_n: number; amount: number; due_date: string; overdue: number; balance: number }[]),
  ]);

  const rows = (items: string[]) =>
    items.length === 0
      ? `<li style="color:#9ca3af">Nothing today ✓</li>`
      : items.map((i) => `<li style="margin:0 0 4px">${i}</li>`).join("");

  const reminderItems = reminders.map((r) => {
    const t = new Date(r.start_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `${esc([r.first_name, r.last_name].filter(Boolean).join(" ") || "Unnamed")} — ${t}${r.treatment_name ? ` · ${esc(r.treatment_name)}` : ""}${r.practitioner_name ? ` · ${esc(r.practitioner_name)}` : ""}`;
  });
  const recallItems = recalls.map((r) => `${esc(r.name)} — ${esc(r.recall_type ?? "check-up")}, due ${esc(r.due_date)}`);
  const installmentItems = installments.map((r) => `${esc(r.patient_name)} — ${money(r.amount)}${r.overdue ? " (overdue)" : ""}, due ${esc(r.due_date)} · balance ${money(r.balance)}`);

  const section = (title: string, items: string[], color: string) => `
    <h3 style="margin:20px 0 6px;font-size:14px;color:${color}">${title}</h3>
    <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.5">${rows(items)}</ul>`;

  // Only the enabled sections render; disabled ones vanish entirely (not even
  // a "Nothing today ✓" line — the clinic asked for them out of the email).
  const sectionBlock = (id: DigestSection, title: string, items: string[], color: string) =>
    sections.includes(id) ? section(title, items, color) : "";

  // The header summary and subject only mention the sections that appear.
  const summaryParts: string[] = [];
  if (sections.includes("reminders")) summaryParts.push(`tomorrow's appointments: ${reminders.length}`);
  if (sections.includes("recalls")) summaryParts.push(`recalls due (30d): ${recalls.length}`);
  if (sections.includes("installments")) summaryParts.push(`installments due (3d): ${installments.length}`);

  const subjectParts: string[] = [];
  if (sections.includes("reminders")) subjectParts.push(`${reminders.length} reminder${reminders.length === 1 ? "" : "s"}`);
  if (sections.includes("recalls")) subjectParts.push(`${recalls.length} recall${recalls.length === 1 ? "" : "s"}`);
  if (sections.includes("installments")) subjectParts.push(`${installments.length} installment${installments.length === 1 ? "" : "s"}`);

  const dayLabel = new Date(Date.now() + 86400000).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">
      <h2 style="margin:0 0 2px;color:#166534">${esc(practiceLabel)} — daily worklist</h2>
      <p style="margin:0 0 4px;color:#6b7280;font-size:13px">${esc(summaryParts.join(" · ").replace(/^./, (ch) => ch.toUpperCase()))}</p>
      <p style="margin:0 0 8px;color:#9ca3af;font-size:12px">Sent ${esc(new Date().toLocaleString("en-US"))}</p>
      ${sectionBlock("reminders", `📅 Appointment reminders — ${dayLabel}`, reminderItems, "#1d4ed8")}
      ${sectionBlock("recalls", "🔁 Hygiene recalls due", recallItems, "#047857")}
      ${sectionBlock("installments", "💳 Installments due", installmentItems, "#b45309")}
      <p style="margin:20px 0 0;color:#9ca3af;font-size:11px">Open Dental Canvas → Agenda side panel to work these lists with one-click WhatsApp actions.</p>
    </div>`;

  return {
    subject: `${practiceLabel} daily worklist — ${subjectParts.join(", ")}`,
    html,
    counts: { reminders: reminders.length, recalls: recalls.length, installments: installments.length },
  };
}

/**
 * Send-now endpoint: the browser timer calls this once per day (and the
 * Settings "Send now" button calls it on demand). Sends to the configured
 * digest recipient, or an explicit override.
 */
app.post("/api/email/worklist-digest", async (c) => {
  let body: DigestDigestInput = {};
  try { body = await c.req.json(); } catch { /* empty body allowed */ }

  const { apiKey, from } = await loadEmailSettings();
  if (!apiKey || !from) {
    return c.json({ error: "Email is not configured yet. Add a Resend API key and from address in Settings → Email." }, 400);
  }

  const settingsRows = await query<{ key: string; value: string }>("SELECT key, value FROM settings").catch(() => []);
  const s = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));
  const to = (typeof body.to === "string" && body.to.trim() ? body.to.trim() : (s.digest_recipient ?? "")).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return c.json({ error: "No valid recipient. Set the clinic inbox in Settings → Email → daily digest." }, 400);
  }

  try {
    const { subject, html, counts } = await buildDigestHtml(parseDigestSections(s.digest_sections));
    const providerId = await sendEmail(apiKey, from, to, subject, html);
    await run(
      `INSERT INTO settings (key, value, updated_at) VALUES ('digest_last_sent', datetime('now'), datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = datetime('now'), updated_at = datetime('now')`,
    );
    return c.json({ ok: true, to, provider_id: providerId, counts });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

app.post("/api/prescriptions", async (c) => {
  const parsed = await parseJson(c, PrescriptionInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  if (d.template !== undefined && !(await isKnownTemplateId(d.template))) {
    return c.json({ error: "Unknown prescription template" }, 400);
  }
  const result = await run(
    `INSERT INTO prescriptions (patient_id, practitioner_id, issued_date, template, large_print, tooth, plan_item_id, diagnosis, on_examination, history, advice, follow_up, follow_up_date, patient_gender, complaints, vitals, investigations)
     VALUES (?, ?, COALESCE(?, date('now')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      d.patient_id,
      d.practitioner_id ?? null,
      d.issued_date ?? null,
      d.template ?? "chamber",
      d.large_print ? 1 : 0,
      d.tooth ?? null,
      d.plan_item_id ?? null,
      d.diagnosis ?? null,
      d.on_examination ?? null,
      d.history ?? null,
      d.advice ?? null,
      d.follow_up ?? null,
      d.follow_up_date ?? null,
      d.patient_gender ?? null,
      d.complaints ?? null,
      d.vitals ?? null,
      d.investigations ?? null,
    ],
  );
  const rxId = Number(result.lastInsertRowid);
  for (const [i, item] of d.items.entries()) {
    await run(
      "INSERT INTO prescription_items (prescription_id, drug_name, generic_name, dosage, frequency, schedule, meal_relation, duration, instructions, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [rxId, item.drug_name, item.generic_name ?? null, item.dosage ?? null, item.frequency ?? null, item.schedule ?? null, item.meal_relation ?? null, item.duration ?? null, item.instructions ?? null, i],
    );
  }
  await attachPrescriptionImages(rxId, d.patient_id, d.image_ids);
  const rx = await loadPrescription(rxId);
  return c.json({ prescription: rx }, 201);
});

app.put("/api/prescriptions/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, PrescriptionUpdateInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const existing = await get<{ id: number; patient_id: number }>("SELECT id, patient_id FROM prescriptions WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "Not found" }, 404);
  if (d.template !== undefined && !(await isKnownTemplateId(d.template))) {
    return c.json({ error: "Unknown prescription template" }, 400);
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of ["practitioner_id", "issued_date", "template", "large_print", "tooth", "plan_item_id", "diagnosis", "on_examination", "history", "advice", "follow_up", "follow_up_date", "patient_gender", "complaints", "vitals", "investigations"] as const) {
    const v = d[key];
    if (v !== undefined) {
      sets.push(`${key} = ?`);
      params.push(key === "large_print" ? (v ? 1 : 0) : (v ?? null));
    }
  }
  if (sets.length) {
    params.push(id);
    await run(`UPDATE prescriptions SET ${sets.join(", ")} WHERE id = ?`, params);
  }
  if (d.items !== undefined) {
    await run("DELETE FROM prescription_items WHERE prescription_id = ?", [id]);
    for (const [i, item] of d.items.entries()) {
      await run(
        "INSERT INTO prescription_items (prescription_id, drug_name, generic_name, dosage, frequency, schedule, meal_relation, duration, instructions, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, item.drug_name, item.generic_name ?? null, item.dosage ?? null, item.frequency ?? null, item.schedule ?? null, item.meal_relation ?? null, item.duration ?? null, item.instructions ?? null, i],
      );
    }
  }
  if (d.image_ids !== undefined) {
    await attachPrescriptionImages(id, existing.patient_id, d.image_ids);
  }
  const rx = await loadPrescription(id);
  return c.json({ prescription: rx });
});

app.delete("/api/prescriptions/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM prescriptions WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Appointments ───────────────────────────────────────────────────

// ── Prescription editor helpers ──────────────────────────────────────

/** Recently used drugs across the practice's prescriptions, for the editor's
 * quick-add sidebar. Derived from prescription_items ordered by the parent
 * prescription's created_at (most recent use first), deduplicated by drug name. */
app.get("/api/prescriptions/recent-drugs", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
  const rows = await query<{ drug_name: string; dosage: string | null; frequency: string | null; duration: string | null; instructions: string | null; used_at: string }>(
    `SELECT ri.drug_name, ri.dosage, ri.frequency, ri.duration, ri.instructions, MAX(rx.created_at) as used_at
     FROM prescription_items ri
     JOIN prescriptions rx ON rx.id = ri.prescription_id
     GROUP BY LOWER(ri.drug_name)
     ORDER BY used_at DESC
     LIMIT ?`,
    [limit],
  );
  return c.json({ drugs: rows.map((r) => ({
    name: r.drug_name,
    dosage: r.dosage,
    frequency: r.frequency,
    duration: r.duration,
    instructions: r.instructions,
    used_at: r.used_at,
  })) });
});

// ── Advice presets (reusable advice chips) ────────────────────────────

const AdvicePresetInput = z.object({
  text: z.string().min(1).max(500),
});

app.get("/api/prescriptions/advice-presets", async (c) => {
  const rows = await query<{ id: number; text: string; created_at: string }>(
    "SELECT id, text, created_at FROM prescription_advice_presets ORDER BY created_at DESC",
  );
  return c.json({ presets: rows.map((r) => ({ id: r.id, text: r.text })) });
});

app.post("/api/prescriptions/advice-presets", async (c) => {
  const parsed = await parseJson(c, AdvicePresetInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const existing = await get<{ id: number }>(
    "SELECT id FROM prescription_advice_presets WHERE LOWER(text) = LOWER(?)",
    [d.text.trim()],
  );
  if (existing) return c.json({ error: "That advice preset already exists" }, 409);
  const result = await run(
    "INSERT INTO prescription_advice_presets (text) VALUES (?)",
    [d.text.trim()],
  );
  const row = await get<{ id: number; text: string }>("SELECT id, text FROM prescription_advice_presets WHERE id = ?", [result.lastInsertRowid]);
  if (!row) return c.json({ error: "Could not read back the created preset" }, 500);
  return c.json({ preset: { id: row.id, text: row.text } }, 201);
});

app.delete("/api/prescriptions/advice-presets/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM prescription_advice_presets WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Prescription clinical templates (save/load reusable clinical bundles) ──
// Mounted at /api/prescription-templates, beside /api/prescription-layouts:
// under /api/prescriptions/... a sibling GET would be captured first by
// /api/prescriptions/:id and rejected as an invalid id.

const PrescriptionTemplateInput = z.object({
  name: z.string().min(1).max(120),
  diagnosis: z.string().max(400).optional().nullable(),
  on_examination: z.string().max(2000).optional().nullable(),
  history: z.string().max(2000).optional().nullable(),
  complaints: z.string().optional().nullable(),
  vitals: z.string().optional().nullable(),
  investigations: z.string().optional().nullable(),
  advice: z.string().optional().nullable(),
  items: z.array(z.object({
    drug_name: z.string().min(1),
    generic_name: z.string().optional().nullable(),
    dosage: z.string().optional().nullable(),
    frequency: z.string().optional().nullable(),
    schedule: z.string().optional().nullable(),
    meal_relation: z.string().optional().nullable(),
    duration: z.string().optional().nullable(),
    instructions: z.string().optional().nullable(),
  })).optional(),
});

interface RxClinicalTemplateRow {
  id: number;
  name: string;
  diagnosis: string | null;
  on_examination: string | null;
  history: string | null;
  complaints: string | null;
  vitals: string | null;
  investigations: string | null;
  advice: string | null;
  items: string | null;
  created_at: string;
}

/** A saved clinical template shaped for the client, with its JSON columns parsed. */
function shapeRxClinicalTemplate(r: RxClinicalTemplateRow) {
  const json = (v: string | null) => {
    if (!v) return null;
    try {
      return JSON.parse(v);
    } catch {
      return null; // a corrupt column must not take the picker down
    }
  };
  return {
    id: r.id,
    name: r.name,
    diagnosis: r.diagnosis,
    on_examination: r.on_examination,
    history: r.history,
    complaints: json(r.complaints),
    vitals: json(r.vitals),
    investigations: json(r.investigations),
    advice: r.advice,
    items: json(r.items) ?? [],
    created_at: r.created_at,
  };
}

app.get("/api/prescription-templates", async (c) => {
  const rows = await query<RxClinicalTemplateRow>(
    `SELECT id, name, diagnosis, on_examination, history, complaints, vitals, investigations, advice, items, created_at
     FROM prescription_templates ORDER BY created_at DESC, id DESC`,
  );
  return c.json({ templates: rows.map(shapeRxClinicalTemplate) });
});

app.post("/api/prescription-templates", async (c) => {
  const parsed = await parseJson(c, PrescriptionTemplateInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO prescription_templates (name, diagnosis, on_examination, history, complaints, vitals, investigations, advice, items)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      d.name.trim(),
      d.diagnosis ?? null,
      d.on_examination ?? null,
      d.history ?? null,
      d.complaints ?? null,
      d.vitals ?? null,
      d.investigations ?? null,
      d.advice ?? null,
      d.items ? JSON.stringify(d.items) : null,
    ],
  );
  const row = await get<RxClinicalTemplateRow>(
    `SELECT id, name, diagnosis, on_examination, history, complaints, vitals, investigations, advice, items, created_at
     FROM prescription_templates WHERE id = ?`,
    [result.lastInsertRowid],
  );
  if (!row) return c.json({ error: "Could not read back the created template" }, 500);
  return c.json({ template: shapeRxClinicalTemplate(row) }, 201);
});

app.delete("/api/prescription-templates/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM prescription_templates WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

const AppointmentInput = z.object({
  patient_id: z.number().int().nullable().optional(),
  practitioner_id: z.number().int().nullable().optional(),
  operatory_id: z.number().int(),
  treatment_type_id: z.number().int().nullable().optional(),
  start_time: z.string(),
  end_time: z.string(),
  status: z.enum(["scheduled", "confirmed", "arrived", "in_chair", "completed", "no_show", "cancelled"]).optional(),
  kind: z.enum(["patient", "break", "lunch", "block"]).optional(),
  title: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

interface ApptConflictRow {
  id: number;
  kind: string;
  start_time: string;
  end_time: string;
  title: string | null;
  first_name: string | null;
  last_name: string | null;
  practitioner_name: string | null;
}

/**
 * Double-booking check: overlap in the SAME operatory, or the SAME
 * practitioner (a doctor can't be in two chairs at once). Cancelled
 * appointments and no-shows never conflict. Returns a short human-readable
 * description of the first conflict, or null when the slot is free.
 */
async function findAppointmentConflict(
  operatoryId: number,
  startTime: string,
  endTime: string,
  opts: { practitionerId?: number | null; excludeId?: number; patientKind?: boolean } = {},
): Promise<string | null> {
  if (!opts.patientKind) return null; // blocks/lunch/breaks don't need the check
  const clauses: string[] = [
    "a.start_time < ?",
    "a.end_time > ?",
    "a.status NOT IN ('cancelled', 'no_show')",
    "a.kind = 'patient'",
    "(a.operatory_id = ? OR (a.practitioner_id IS NOT NULL AND ? IS NOT NULL AND a.practitioner_id = ?))",
  ];
  const params: unknown[] = [endTime, startTime, operatoryId, opts.practitionerId ?? null, opts.practitionerId ?? null];
  if (opts.excludeId) {
    clauses.push("a.id != ?");
    params.push(opts.excludeId);
  }
  const rows = await query<ApptConflictRow>(
    `SELECT a.id, a.kind, a.start_time, a.end_time, a.title,
            p.first_name, p.last_name, pr.name as practitioner_name
     FROM appointments a
     LEFT JOIN patients p ON p.id = a.patient_id
     LEFT JOIN practitioners pr ON pr.id = a.practitioner_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY a.start_time LIMIT 1`,
    params,
  ).catch(() => []);
  const hit = rows[0];
  if (!hit) return null;
  const who = hit.first_name || hit.last_name ? `${hit.first_name ?? ""} ${hit.last_name ?? ""}`.trim() : hit.title || "another appointment";
  const at = hit.start_time.slice(11, 16);
  const roomOrDoctor = hit.practitioner_name ? `Dr. ${hit.practitioner_name}` : "that operatory";
  return `${who} is already booked at ${at} with ${roomOrDoctor}. Overlapping appointments in the same chair or with the same practitioner are not allowed.`;
}

/** Conflict probe endpoint — the agenda calls it while editing, before save. */
app.post("/api/appointments/check-conflict", async (c) => {
  const parsed = await parseJson(
    c,
    z.object({
      operatory_id: z.number().int(),
      start_time: z.string(),
      end_time: z.string(),
      practitioner_id: z.number().int().nullable().optional(),
      exclude_id: z.number().int().optional(),
    }),
  );
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const conflict = await findAppointmentConflict(d.operatory_id, d.start_time, d.end_time, {
    practitionerId: d.practitioner_id,
    excludeId: d.exclude_id,
    patientKind: true,
  });
  return c.json({ conflict });
});

const APPT_SELECT = `
  SELECT
    a.*,
    p.first_name as patient_first_name,
    p.last_name as patient_last_name,
    p.date_of_birth as patient_date_of_birth,
    pr.name as practitioner_name,
    pr.color as practitioner_color,
    o.name as operatory_name,
    tt.code as treatment_code,
    tt.name as treatment_name,
    tt.color as treatment_color
  FROM appointments a
  LEFT JOIN patients p ON p.id = a.patient_id
  LEFT JOIN practitioners pr ON pr.id = a.practitioner_id
  LEFT JOIN operatories o ON o.id = a.operatory_id
  LEFT JOIN treatment_types tt ON tt.id = a.treatment_type_id
`;

app.get("/api/appointments", async (c) => {
  // Day-view query: ?date=YYYY-MM-DD returns appointments overlapping that local day.
  const date = c.req.query("date");
  // Range query: ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive) for dashboards/calendars.
  const from = c.req.query("from");
  const to = c.req.query("to");
  const patientId = intParam(c.req.query("patient_id"));
  if (patientId) {
    const rows = await query(`${APPT_SELECT} WHERE a.patient_id = ? ORDER BY a.start_time DESC LIMIT 200`, [patientId]);
    return c.json({ appointments: rows });
  }
  if (date) {
    const dayStart = `${date}T00:00:00`;
    const dayEnd = `${date}T23:59:59`;
    const rows = await query(
      `${APPT_SELECT} WHERE a.start_time < ? AND a.end_time > ? ORDER BY a.start_time`,
      [dayEnd, dayStart],
    );
    return c.json({ appointments: rows });
  }
  if (from && to) {
    const rows = await query(
      `${APPT_SELECT} WHERE substr(a.start_time, 1, 10) >= ? AND substr(a.start_time, 1, 10) <= ? ORDER BY a.start_time`,
      [from, to],
    );
    return c.json({ appointments: rows });
  }
  const rows = await query(`${APPT_SELECT} ORDER BY a.start_time DESC LIMIT 200`);
  return c.json({ appointments: rows });
});

app.post("/api/appointments", async (c) => {
  const parsed = await parseJson(c, AppointmentInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const conflict = await findAppointmentConflict(d.operatory_id, d.start_time, d.end_time, {
    practitionerId: d.practitioner_id,
    patientKind: (d.kind ?? "patient") === "patient",
  });
  if (conflict) return c.json({ error: conflict }, 409);
  const result = await run(
    `INSERT INTO appointments
       (patient_id, practitioner_id, operatory_id, treatment_type_id, start_time, end_time, status, kind, title, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      d.patient_id ?? null,
      d.practitioner_id ?? null,
      d.operatory_id,
      d.treatment_type_id ?? null,
      d.start_time,
      d.end_time,
      d.status ?? "scheduled",
      d.kind ?? "patient",
      d.title ?? null,
      d.notes ?? null,
    ],
  );
  const row = await get(`${APPT_SELECT} WHERE a.id = ?`, [result.lastInsertRowid]);
  return c.json({ appointment: row }, 201);
});

app.put("/api/appointments/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, AppointmentInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  // Conflict check needs the merged (existing + new) time slot.
  const existing = await get<{ operatory_id: number; start_time: string; end_time: string; practitioner_id: number | null; kind: string; patient_id: number | null }>(
    "SELECT operatory_id, start_time, end_time, practitioner_id, kind, patient_id FROM appointments WHERE id = ?",
    [id],
  );
  if (!existing) return c.json({ error: "Not found" }, 404);
  const merged = {
    operatory_id: parsed.data.operatory_id ?? existing.operatory_id,
    start_time: parsed.data.start_time ?? existing.start_time,
    end_time: parsed.data.end_time ?? existing.end_time,
    practitioner_id: parsed.data.practitioner_id !== undefined ? parsed.data.practitioner_id : existing.practitioner_id,
    kind: parsed.data.kind ?? existing.kind,
  };
  const conflict = await findAppointmentConflict(merged.operatory_id, merged.start_time, merged.end_time, {
    practitionerId: merged.practitioner_id,
    excludeId: id,
    patientKind: merged.kind === "patient",
  });
  if (conflict) return c.json({ error: conflict }, 409);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
  }
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  // Wait-time tracking: stamp the moment the patient transitions into the
  // chair (paired with checked_in_at). A move back out of the chair clears
  // the stamp so a re-seat measures the latest wait, not a stale one.
  const newStatus: string | undefined = parsed.data.status;
  if (newStatus === "in_chair") sets.push("in_chair_at = datetime('now')");
  else if (newStatus && newStatus !== "completed") sets.push("in_chair_at = NULL");
  const r = await run(`UPDATE appointments SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  // Auto-recall: a completed patient visit advances the recall cycle.
  if (parsed.data.status === "completed" && existing.kind === "patient" && existing.patient_id) {
    await processRecallOnCompletion(existing.patient_id, existing.end_time.slice(0, 10));
  }
  const row = await get(`${APPT_SELECT} WHERE a.id = ?`, [id]);
  return c.json({ appointment: row });
});

app.delete("/api/appointments/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM appointments WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Treatment plan items ───────────────────────────────────────────

const TreatmentPlanItemInput = z.object({
  patient_id: z.number().int(),
  treatment_type_id: z.number().int().nullable().optional(),
  tooth: z.string().optional().nullable(),
  surface: z.string().optional().nullable(),
  fee: z.number().min(0).optional(),
  status: z.enum(["planned", "accepted", "completed", "declined"]).optional(),
  notes: z.string().optional().nullable(),
  sort_order: z.number().int().optional(),
});

app.get("/api/patients/:id/treatment-plan", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const rows = await query(
    `SELECT tpi.*, tt.code as treatment_code, tt.name as treatment_name, tt.color as treatment_color
     FROM treatment_plan_items tpi
     LEFT JOIN treatment_types tt ON tt.id = tpi.treatment_type_id
     WHERE tpi.patient_id = ?
     ORDER BY tpi.sort_order, tpi.id`,
    [id],
  );
  return c.json({ items: rows });
});

app.post("/api/treatment-plan-items", async (c) => {
  const parsed = await parseJson(c, TreatmentPlanItemInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO treatment_plan_items (patient_id, treatment_type_id, tooth, surface, fee, status, notes, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM treatment_plan_items WHERE patient_id = ?)))`,
    [d.patient_id, d.treatment_type_id ?? null, d.tooth ?? null, d.surface ?? null, d.fee ?? 0, d.status ?? "planned", d.notes ?? null, d.sort_order ?? null, d.patient_id],
  );
  const row = await get(
    `SELECT tpi.*, tt.code as treatment_code, tt.name as treatment_name, tt.color as treatment_color
     FROM treatment_plan_items tpi LEFT JOIN treatment_types tt ON tt.id = tpi.treatment_type_id
     WHERE tpi.id = ?`,
    [result.lastInsertRowid],
  );
  return c.json({ item: row }, 201);
});

app.put("/api/treatment-plan-items/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, TreatmentPlanItemInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
  }
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE treatment_plan_items SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get(
    `SELECT tpi.*, tt.code as treatment_code, tt.name as treatment_name, tt.color as treatment_color
     FROM treatment_plan_items tpi LEFT JOIN treatment_types tt ON tt.id = tpi.treatment_type_id
     WHERE tpi.id = ?`,
    [id],
  );
  return c.json({ item: row });
});

app.delete("/api/treatment-plan-items/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM treatment_plan_items WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// Add a treatment-plan item to the patient's billing as a line item on an
// open invoice (creating the invoice when none exists). Idempotent: a plan
// item already on a non-void invoice is returned instead of duplicated.
app.post("/api/treatment-plan-items/:id/invoice", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const item = await get<{ id: number; patient_id: number; fee: number; treatment_type_id: number | null; tooth: string | null }>(
    "SELECT id, patient_id, fee, treatment_type_id, tooth FROM treatment_plan_items WHERE id = ?",
    [id],
  );
  if (!item) return c.json({ error: "Not found" }, 404);

  const tt = item.treatment_type_id
    ? await get<{ name: string; code: string }>("SELECT name, code FROM treatment_types WHERE id = ?", [item.treatment_type_id])
    : null;
  const description = [tt?.name ?? "Treatment", item.tooth ? `(tooth ${item.tooth})` : null].filter(Boolean).join(" ");

  // Reuse an existing open invoice that already carries this plan item.
  const existing = await get<{ invoice_id: number }>(
    `SELECT ii.invoice_id AS invoice_id
     FROM invoice_items ii
     JOIN invoices i ON i.id = ii.invoice_id
     WHERE i.patient_id = ? AND i.status != 'void' AND ii.treatment_plan_item_id = ?
     LIMIT 1`,
    [item.patient_id, id],
  );
  if (existing) {
    const inv = await get(
      "SELECT *, total - amount_paid AS balance FROM invoices WHERE id = ?",
      [existing.invoice_id],
    );
    return c.json({ invoice: inv });
  }

  // Prefer the patient's most recent open invoice; otherwise create one.
  let invoiceId: number | null = null;
  const open = await get<{ id: number }>(
    "SELECT id FROM invoices WHERE patient_id = ? AND status = 'open' ORDER BY issued_at DESC, id DESC LIMIT 1",
    [item.patient_id],
  );
  if (open) {
    invoiceId = open.id;
  } else {
    const res = await run(
      "INSERT INTO invoices (patient_id, status, total, amount_paid) VALUES (?, 'open', 0, 0)",
      [item.patient_id],
    );
    invoiceId = Number(res.lastInsertRowid);
  }

  const maxOrder = await get<{ m: number | null }>(
    "SELECT MAX(sort_order) AS m FROM invoice_items WHERE invoice_id = ?",
    [invoiceId],
  );
  await run(
    "INSERT INTO invoice_items (invoice_id, treatment_type_id, treatment_plan_item_id, description, quantity, unit_price, sort_order) VALUES (?, ?, ?, ?, 1, ?, ?)",
    [invoiceId, item.treatment_type_id, id, description || "Treatment", item.fee, (maxOrder?.m ?? -1) + 1],
  );
  await run(
    "UPDATE invoices SET total = (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM invoice_items WHERE invoice_id = ?) WHERE id = ?",
    [invoiceId, invoiceId],
  );
  const inv = await get(
    "SELECT *, total - amount_paid AS balance FROM invoices WHERE id = ?",
    [invoiceId],
  );
  return c.json({ invoice: inv }, 201);
});

// ── Clinical notes ─────────────────────────────────────────────────

const ClinicalNoteInput = z.object({
  patient_id: z.number().int(),
  practitioner_id: z.number().int().nullable().optional(),
  note_date: z.string().optional(),
  body: z.string().min(1),
});

app.get("/api/patients/:id/notes", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const rows = await query(
    `SELECT cn.*, pr.name as practitioner_name
     FROM clinical_notes cn LEFT JOIN practitioners pr ON pr.id = cn.practitioner_id
     WHERE cn.patient_id = ? ORDER BY cn.note_date DESC`,
    [id],
  );
  return c.json({ notes: rows });
});

app.post("/api/clinical-notes", async (c) => {
  const parsed = await parseJson(c, ClinicalNoteInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    "INSERT INTO clinical_notes (patient_id, practitioner_id, note_date, body) VALUES (?, ?, COALESCE(?, datetime('now')), ?)",
    [d.patient_id, d.practitioner_id ?? null, d.note_date ?? null, d.body],
  );
  const row = await get(
    `SELECT cn.*, pr.name as practitioner_name FROM clinical_notes cn LEFT JOIN practitioners pr ON pr.id = cn.practitioner_id WHERE cn.id = ?`,
    [result.lastInsertRowid],
  );
  return c.json({ note: row }, 201);
});

app.delete("/api/clinical-notes/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM clinical_notes WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Tooth chart conditions ─────────────────────────────────────────

const ToothConditionInput = z.object({
  patient_id: z.number().int(),
  tooth: z.string().min(1),
  surface: z.string().optional().nullable(),
  condition: z.enum(["caries", "restoration", "crown", "missing", "implant", "endo"]),
});

app.get("/api/patients/:id/tooth-chart", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const rows = await query(
    "SELECT * FROM tooth_conditions WHERE patient_id = ? ORDER BY tooth, surface",
    [id],
  );
  return c.json({ conditions: rows });
});

app.post("/api/tooth-conditions", async (c) => {
  const parsed = await parseJson(c, ToothConditionInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    "INSERT INTO tooth_conditions (patient_id, tooth, surface, condition) VALUES (?, ?, ?, ?)",
    [d.patient_id, d.tooth, d.surface ?? null, d.condition],
  );
  const row = await get("SELECT * FROM tooth_conditions WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ condition: row }, 201);
});

app.delete("/api/tooth-conditions/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM tooth_conditions WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Invoices ───────────────────────────────────────────────────────

const InvoiceInput = z.object({
  patient_id: z.number().int(),
  appointment_id: z.number().int().nullable().optional(),
  status: z.enum(["open", "paid", "void"]).optional(),
  total: z.number().min(0).optional(),
  amount_paid: z.number().min(0).optional(),
  notes: z.string().optional().nullable(),
});

app.get("/api/patients/:id/invoices", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const invoices = await query(
    "SELECT *, total - amount_paid AS balance FROM invoices WHERE patient_id = ? ORDER BY issued_at DESC",
    [id],
  );
  return c.json({ invoices });
});

// Full invoice detail: header + line items + payment history.
app.get("/api/invoices/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const invoice = await get(
    `SELECT i.*, i.total - i.amount_paid AS balance,
            p.first_name as patient_first_name, p.last_name as patient_last_name,
            p.date_of_birth as patient_date_of_birth
     FROM invoices i LEFT JOIN patients p ON p.id = i.patient_id WHERE i.id = ?`,
    [id],
  );
  if (!invoice) return c.json({ error: "Not found" }, 404);
  const items = await query(
    "SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id",
    [id],
  );
  const payments = await query(
    "SELECT id, amount, method, paid_at, note FROM invoice_payments WHERE invoice_id = ? ORDER BY paid_at DESC, id DESC",
    [id],
  );
  return c.json({ invoice, items, payments });
});

// Replace the line items of an invoice and recompute its total.
app.put("/api/invoices/:id/items", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(
    c,
    z.object({
      items: z
        .array(
          z.object({
            description: z.string().min(1),
            quantity: z.number().min(1).optional(),
            unit_price: z.number().min(0),
            treatment_type_id: z.number().int().nullable().optional(),
          }),
        )
        .max(100),
    }),
  );
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const existing = await get("SELECT id FROM invoices WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "Not found" }, 404);

  await run("DELETE FROM invoice_items WHERE invoice_id = ?", [id]);
  let total = 0;
  for (const [i, item] of parsed.data.items.entries()) {
    const qty = item.quantity ?? 1;
    total += qty * item.unit_price;
    await run(
      "INSERT INTO invoice_items (invoice_id, treatment_type_id, description, quantity, unit_price, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
      [id, item.treatment_type_id ?? null, item.description, qty, item.unit_price, i],
    );
  }
  await run("UPDATE invoices SET total = ? WHERE id = ?", [Math.round(total * 100) / 100, id]);
  const row = await get("SELECT *, total - amount_paid AS balance FROM invoices WHERE id = ?", [id]);
  return c.json({ invoice: row });
});

// Record a payment; keeps invoices.amount_paid (and thus balance) in sync.
app.post("/api/invoices/:id/payments", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(
    c,
    z.object({
      amount: z.number().positive(),
      method: z.enum(["cash", "card", "transfer", "insurance", "other"]).optional(),
      note: z.string().optional().nullable(),
    }),
  );
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const invoice = await get("SELECT id, total, amount_paid FROM invoices WHERE id = ?", [id]);
  if (!invoice) return c.json({ error: "Not found" }, 404);
  const newPaid = Math.round(((invoice.amount_paid as number) + parsed.data.amount) * 100) / 100;
  if (newPaid > (invoice.total as number) + 0.001) {
    return c.json({ error: "Payment exceeds the outstanding balance" }, 400);
  }
  await run(
    "INSERT INTO invoice_payments (invoice_id, amount, method, note) VALUES (?, ?, ?, ?)",
    [id, parsed.data.amount, parsed.data.method ?? "cash", parsed.data.note ?? null],
  );
  await run(
    "UPDATE invoices SET amount_paid = ?, status = CASE WHEN ? >= total THEN 'paid' ELSE status END WHERE id = ?",
    [newPaid, newPaid, id],
  );
  const row = await get("SELECT *, total - amount_paid AS balance FROM invoices WHERE id = ?", [id]);
  return c.json({ invoice: row }, 201);
});

// Remove a payment (mis-entry correction); recompute from the ledger, not a delta.
app.delete("/api/invoices/:id/payments/:paymentId", async (c) => {
  const id = intParam(c.req.param("id"));
  const paymentId = intParam(c.req.param("paymentId"));
  if (!id || !paymentId) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM invoice_payments WHERE id = ? AND invoice_id = ?", [paymentId, id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const sumRow = await get("SELECT COALESCE(SUM(amount), 0) AS s FROM invoice_payments WHERE invoice_id = ?", [id]);
  const paid = Math.round((sumRow?.s as number) * 100) / 100;
  await run(
    "UPDATE invoices SET amount_paid = ?, status = CASE WHEN amount_paid > 0 AND amount_paid < total THEN 'open' WHEN amount_paid >= total THEN 'paid' ELSE status END WHERE id = ?",
    [paid, id],
  );
  const row = await get("SELECT *, total - amount_paid AS balance FROM invoices WHERE id = ?", [id]);
  return c.json({ invoice: row });
});// ── CSV export (accounting-friendly) ─────────────────────────

// Outstanding balance per patient (open invoices only) — powers the list badge.
app.get("/api/reports/balances", async (c) => {
  const rows = await query<{ patient_id: number; due: number }>(
    "SELECT patient_id, SUM(total - amount_paid) AS due FROM invoices WHERE status = 'open' AND total > amount_paid GROUP BY patient_id",
  ).catch(() => [] as { patient_id: number; due: number }[]);
  const balances: Record<string, number> = {};
  for (const r of rows) balances[String(r.patient_id)] = Math.round(r.due * 100) / 100;
  return c.json({ balances });
});

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvResponse(filename: string, rows: unknown[][]): Response {
  const body = rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

app.get("/api/export/patients.csv", async (c) => {
  const rows = await query<Record<string, unknown>>(
    "SELECT id, first_name, last_name, date_of_birth, patient_gender, email, phone, address, medical_alerts, referral_source, created_at FROM patients ORDER BY id",
  );
  return csvResponse("patients.csv", [
    ["id", "first_name", "last_name", "date_of_birth", "patient_gender", "email", "phone", "address", "medical_alerts", "referral_source", "created_at"],
    ...rows.map((r) => [r.id, r.first_name, r.last_name, r.date_of_birth, r.patient_gender, r.email, r.phone, r.address, r.medical_alerts, r.referral_source, r.created_at]),
  ]);
});

app.get("/api/export/appointments.csv", async (c) => {
  const rows = await query<Record<string, unknown>>(
    `SELECT a.id, a.start_time, a.end_time, a.status,
            p.first_name, p.last_name, tt.name AS treatment, pr.name AS practitioner, o.name AS operatory
     FROM appointments a
     LEFT JOIN patients p ON p.id = a.patient_id
     LEFT JOIN treatment_types tt ON tt.id = a.treatment_type_id
     LEFT JOIN practitioners pr ON pr.id = a.practitioner_id
     LEFT JOIN operatories o ON o.id = a.operatory_id
     WHERE a.kind = 'patient'
     ORDER BY a.start_time DESC`,
  );
  return csvResponse("appointments.csv", [
    ["id", "date", "start_time", "end_time", "status", "patient", "treatment", "practitioner", "operatory"],
    ...rows.map((r) => [
      r.id,
      String(r.start_time ?? "").slice(0, 10),
      String(r.start_time ?? "").slice(11, 16),
      String(r.end_time ?? "").slice(11, 16),
      r.status,
      [r.first_name, r.last_name].filter(Boolean).join(" "),
      r.treatment,
      r.practitioner,
      r.operatory,
    ]),
  ]);
});

app.get("/api/export/treatments.csv", async (c) => {
  const rows = await query<Record<string, unknown>>(
    `SELECT tpi.id, tpi.tooth, tpi.surface, tpi.fee, tpi.status, tpi.notes,
            tt.name AS treatment, p.first_name, p.last_name
     FROM treatment_plan_items tpi
     LEFT JOIN treatment_types tt ON tt.id = tpi.treatment_type_id
     LEFT JOIN patients p ON p.id = tpi.patient_id
     ORDER BY tpi.patient_id, tpi.sort_order, tpi.id`,
  );
  return csvResponse("treatments.csv", [
    ["id", "patient", "treatment", "tooth", "surface", "fee", "status", "notes"],
    ...rows.map((r) => [
      r.id,
      [r.first_name, r.last_name].filter(Boolean).join(" "),
      r.treatment,
      r.tooth,
      r.surface,
      r.fee,
      r.status,
      r.notes,
    ]),
  ]);
});

app.get("/api/export/invoices.csv", async (c) => {
  const rows = await query<Record<string, unknown>>(
    `SELECT i.id, i.issued_at, i.status, i.total, i.amount_paid, i.total - i.amount_paid AS balance,
            p.first_name, p.last_name
     FROM invoices i LEFT JOIN patients p ON p.id = i.patient_id ORDER BY i.id`,
  );
  return csvResponse("invoices.csv", [
    ["id", "issued_at", "status", "total", "amount_paid", "balance", "patient"],
    ...rows.map((r) => [r.id, r.issued_at, r.status, r.total, r.amount_paid, r.balance, `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim()]),
  ]);
});

app.post("/api/invoices", async (c) => {
  const parsed = await parseJson(c, InvoiceInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    "INSERT INTO invoices (patient_id, appointment_id, status, total, amount_paid, notes) VALUES (?, ?, ?, ?, ?, ?)",
    [d.patient_id, d.appointment_id ?? null, d.status ?? "open", d.total ?? 0, d.amount_paid ?? 0, d.notes ?? null],
  );
  const row = await get("SELECT * FROM invoices WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ invoice: row }, 201);
});

app.put("/api/invoices/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, InvoiceInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
  }
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE invoices SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get("SELECT * FROM invoices WHERE id = ?", [id]);
  return c.json({ invoice: row });
});

app.delete("/api/invoices/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM invoices WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Finance overview (FINANCE section of the sidebar) ─────────────
// One endpoint powering all three finance pages: the metric cards, and the
// per-invoice revenue table. 'Clinic name' on a row is the practice profile's
// clinic_name setting; 'Dr. name' the practitioner attached to the linked
// appointment, falling back to the profile doctor.

app.get("/api/finance/overview", async (c) => {
  const from = c.req.query("from"); // 'YYYY-MM-DD' inclusive
  const to = c.req.query("to"); // 'YYYY-MM-DD' inclusive

  // Date filter applies to invoices by issue date and to appointments by
  // their start date. Empty bounds = unbounded.
  const invFrom = from ? `${from}T00:00:00` : null;
  const invTo = to ? `${to}T23:59:59` : null;

  const invWhere: string[] = ["i.status != 'void'"];
  const invParams: unknown[] = [];
  if (invFrom) { invWhere.push("i.issued_at >= ?"); invParams.push(invFrom); }
  if (invTo) { invWhere.push("i.issued_at <= ?"); invParams.push(invTo); }

  const apptWhere: string[] = ["a.kind = 'patient'"];
  const apptParams: unknown[] = [];
  if (from) { apptWhere.push("substr(a.start_time, 1, 10) >= ?"); apptParams.push(from); }
  if (to) { apptWhere.push("substr(a.start_time, 1, 10) <= ?"); apptParams.push(to); }

  const settingsRows = await query<{ key: string; value: string }>("SELECT key, value FROM settings").catch(() => []);
  const settings = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));
  const clinicName = (settings.clinic_name ?? "").trim();
  const doctorName = (settings.doctor_name ?? "").trim();

  const stats = await get<{ appts: number; billed: number; paid: number }>(
    `SELECT
       (SELECT COUNT(*) FROM appointments a WHERE ${apptWhere.join(" AND ")}) AS appts,
       (SELECT COALESCE(SUM(i.total), 0) FROM invoices i WHERE ${invWhere.join(" AND ")}) AS billed,
       (SELECT COALESCE(SUM(i.amount_paid), 0) FROM invoices i WHERE ${invWhere.join(" AND ")}) AS paid`,
    [...apptParams, ...invParams, ...invParams],
  );

  const rows = await query<Record<string, unknown>>(
    `SELECT i.id,
            i.patient_id,
            i.issued_at,
            i.total,
            i.amount_paid,
            i.total - i.amount_paid AS balance,
            i.status,
            p.first_name || ' ' || p.last_name AS patient_name,
            COALESCE(tt.name, ii.description) AS service,
            pr.name AS doctor_name,
            i.appointment_id
     FROM invoices i
     LEFT JOIN patients p ON p.id = i.patient_id
     LEFT JOIN appointments a ON a.id = i.appointment_id
     LEFT JOIN practitioners pr ON pr.id = a.practitioner_id
     LEFT JOIN treatment_types tt ON tt.id = a.treatment_type_id
     LEFT JOIN (SELECT invoice_id, MIN(id) AS first_item_id FROM invoice_items GROUP BY invoice_id) ii2 ON ii2.invoice_id = i.id
     LEFT JOIN invoice_items ii ON ii.id = ii2.first_item_id
     WHERE ${invWhere.join(" AND ")}
     ORDER BY i.issued_at DESC, i.id DESC
     LIMIT 500`,
    invParams,
  );

  return c.json({
    stats: {
      total_appointments: stats?.appts ?? 0,
      total_revenue: Math.round((stats?.billed ?? 0) * 100) / 100,
      remaining_balance: Math.round(((stats?.billed ?? 0) - (stats?.paid ?? 0)) * 100) / 100,
    },
    clinic_name: clinicName,
    profile_doctor: doctorName,
    rows: rows.map((r) => ({
      ...r,
      doctor_name: (r.doctor_name as string) || doctorName || null,
    })),
  });
});

// ── Waiting list ───────────────────────────────────────────────────

const WaitingListInput = z.object({
  patient_id: z.number().int(),
  treatment_type_id: z.number().int().nullable().optional(),
  preferred_practitioner_id: z.number().int().nullable().optional(),
  duration_minutes: z.number().int().min(5).optional(),
  notes: z.string().optional().nullable(),
});

const WAITING_SELECT = `
  SELECT w.*, p.first_name, p.last_name, p.date_of_birth,
    tt.name as treatment_name, tt.color as treatment_color,
    pr.name as practitioner_name
  FROM waiting_list w
  LEFT JOIN patients p ON p.id = w.patient_id
  LEFT JOIN treatment_types tt ON tt.id = w.treatment_type_id
  LEFT JOIN practitioners pr ON pr.id = w.preferred_practitioner_id
`;

app.get("/api/waiting-list", async (c) => {
  const rows = await query(`${WAITING_SELECT} ORDER BY w.created_at DESC`);
  return c.json({ waiting: rows });
});

app.post("/api/waiting-list", async (c) => {
  const parsed = await parseJson(c, WaitingListInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    "INSERT INTO waiting_list (patient_id, treatment_type_id, preferred_practitioner_id, duration_minutes, notes) VALUES (?, ?, ?, ?, ?)",
    [d.patient_id, d.treatment_type_id ?? null, d.preferred_practitioner_id ?? null, d.duration_minutes ?? 30, d.notes ?? null],
  );
  const row = await get(`${WAITING_SELECT} WHERE w.id = ?`, [result.lastInsertRowid]);
  return c.json({ entry: row }, 201);
});

app.delete("/api/waiting-list/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM waiting_list WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Appointments to make ───────────────────────────────────────────

const ToMakeInput = z.object({
  patient_id: z.number().int(),
  treatment_type_id: z.number().int().nullable().optional(),
  due_after: z.string().optional().nullable(),
  source: z.enum(["reception", "patient", "system"]).optional(),
  notes: z.string().optional().nullable(),
  status: z.enum(["open", "scheduled", "cancelled"]).optional(),
});

const TO_MAKE_SELECT = `
  SELECT atm.*, p.first_name, p.last_name, p.date_of_birth,
    tt.name as treatment_name, tt.color as treatment_color
  FROM appointments_to_make atm
  LEFT JOIN patients p ON p.id = atm.patient_id
  LEFT JOIN treatment_types tt ON tt.id = atm.treatment_type_id
`;

app.get("/api/appointments-to-make", async (c) => {
  const source = c.req.query("source");
  const where = source ? " WHERE atm.source = ? AND atm.status = 'open'" : " WHERE atm.status = 'open'";
  const params = source ? [source] : [];
  const rows = await query(`${TO_MAKE_SELECT}${where} ORDER BY atm.created_at DESC`, params);
  return c.json({ to_make: rows });
});

app.post("/api/appointments-to-make", async (c) => {
  const parsed = await parseJson(c, ToMakeInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    "INSERT INTO appointments_to_make (patient_id, treatment_type_id, due_after, source, notes, status) VALUES (?, ?, ?, ?, ?, ?)",
    [d.patient_id, d.treatment_type_id ?? null, d.due_after ?? null, d.source ?? "reception", d.notes ?? null, d.status ?? "open"],
  );
  const row = await get(`${TO_MAKE_SELECT} WHERE atm.id = ?`, [result.lastInsertRowid]);
  return c.json({ entry: row }, 201);
});

app.put("/api/appointments-to-make/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, ToMakeInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
  }
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE appointments_to_make SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get(`${TO_MAKE_SELECT} WHERE atm.id = ?`, [id]);
  return c.json({ entry: row });
});

app.delete("/api/appointments-to-make/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM appointments_to_make WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Insurance plans ────────────────────────────────────────────────

const InsurancePlanInput = z.object({
  patient_id: z.number().int(),
  rank: z.enum(["primary", "secondary", "tertiary"]).optional(),
  carrier: z.string().min(1),
  member_id: z.string().optional().nullable(),
  group_id: z.string().optional().nullable(),
  subscriber_name: z.string().optional().nullable(),
  subscriber_dob: z.string().optional().nullable(),
  effective_date: z.string().optional().nullable(),
  term_date: z.string().optional().nullable(),
  copay: z.number().min(0).optional(),
  deductible_total: z.number().min(0).optional(),
  deductible_used: z.number().min(0).optional(),
  max_annual: z.number().min(0).optional(),
  max_used: z.number().min(0).optional(),
  notes: z.string().optional().nullable(),
});

app.get("/api/patients/:id/insurance", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  // Fall back to [] if the table doesn't exist yet (pre-migration dev DB).
  const rows = await query(
    "SELECT * FROM insurance_plans WHERE patient_id = ? ORDER BY CASE rank WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1 ELSE 2 END",
    [id],
  ).catch(() => []);
  return c.json({ plans: rows });
});

app.post("/api/insurance-plans", async (c) => {
  const parsed = await parseJson(c, InsurancePlanInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO insurance_plans
       (patient_id, rank, carrier, member_id, group_id, subscriber_name, subscriber_dob,
        effective_date, term_date, copay, deductible_total, deductible_used, max_annual, max_used, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      d.patient_id, d.rank ?? "primary", d.carrier,
      d.member_id ?? null, d.group_id ?? null, d.subscriber_name ?? null, d.subscriber_dob ?? null,
      d.effective_date ?? null, d.term_date ?? null,
      d.copay ?? 0, d.deductible_total ?? 0, d.deductible_used ?? 0, d.max_annual ?? 0, d.max_used ?? 0,
      d.notes ?? null,
    ],
  );
  const row = await get("SELECT * FROM insurance_plans WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ plan: row }, 201);
});

app.put("/api/insurance-plans/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, InsurancePlanInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
  }
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE insurance_plans SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get("SELECT * FROM insurance_plans WHERE id = ?", [id]);
  return c.json({ plan: row });
});

app.delete("/api/insurance-plans/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM insurance_plans WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── In-house membership plans ───────────────────────────────────
// A clinic-owned discount plan (BoomCloud/Pearly model): the patient pays a
// recurring fee and gets a standing percent off every invoice.

const MembershipPlanInput = z.object({
  name: z.string().min(1),
  monthly_fee: z.number().min(0),
  annual_fee: z.number().min(0).nullable().optional(),
  discount_percent: z.number().min(0).max(100),
  benefits: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

app.get("/api/membership-plans", async (c) => {
  const plans = await query(
    `SELECT mp.*, COUNT(pm.id) AS member_count
     FROM membership_plans mp
     LEFT JOIN patient_memberships pm ON pm.plan_id = mp.id AND pm.status = 'active'
     GROUP BY mp.id ORDER BY mp.name`,
  );
  return c.json({ plans });
});

app.post("/api/membership-plans", async (c) => {
  const parsed = await parseJson(c, MembershipPlanInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { name, monthly_fee, annual_fee, discount_percent, benefits, active } = parsed.data;
  const result = await run(
    "INSERT INTO membership_plans (name, monthly_fee, annual_fee, discount_percent, benefits, active) VALUES (?, ?, ?, ?, ?, ?)",
    [name, monthly_fee, annual_fee ?? null, discount_percent, benefits ?? null, active === false ? 0 : 1],
  );
  const row = await get("SELECT * FROM membership_plans WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ plan: row }, 201);
});

app.put("/api/membership-plans/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, MembershipPlanInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) {
      sets.push(`${k} = ?`);
      params.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
    }
  }
  if (!sets.length) return c.json({ error: "No fields to update" }, 400);
  const r = await run(`UPDATE membership_plans SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get("SELECT * FROM membership_plans WHERE id = ?", [id]);
  return c.json({ plan: row });
});

app.delete("/api/membership-plans/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM membership_plans WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

const MembershipEnrollmentInput = z.object({
  patient_id: z.number().int(),
  plan_id: z.number().int(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().nullable().optional(),
});

// Memberships for one patient (joined with the plan for display).
app.get("/api/patients/:id/membership", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const memberships = await query(
    `SELECT pm.*, mp.name AS plan_name, mp.monthly_fee, mp.annual_fee, mp.discount_percent, mp.benefits
     FROM patient_memberships pm JOIN membership_plans mp ON mp.id = pm.plan_id
     WHERE pm.patient_id = ? ORDER BY pm.status = 'active' DESC, pm.start_date DESC`,
    [id],
  );
  return c.json({ memberships });
});

app.post("/api/patient-memberships", async (c) => {
  const parsed = await parseJson(c, MembershipEnrollmentInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { patient_id, plan_id, start_date, notes } = parsed.data;
  const plan = await get("SELECT id FROM membership_plans WHERE id = ?", [plan_id]);
  if (!plan) return c.json({ error: "Plan not found" }, 404);
  // One active membership per patient: a new enrollment expires the old one.
  await run(
    "UPDATE patient_memberships SET status = 'expired', end_date = ? WHERE patient_id = ? AND status = 'active'",
    [start_date, patient_id],
  );
  const result = await run(
    "INSERT INTO patient_memberships (patient_id, plan_id, start_date, notes) VALUES (?, ?, ?, ?)",
    [patient_id, plan_id, start_date, notes ?? null],
  );
  const row = await get(
    `SELECT pm.*, mp.name AS plan_name, mp.discount_percent FROM patient_memberships pm
     JOIN membership_plans mp ON mp.id = pm.plan_id WHERE pm.id = ?`,
    [result.lastInsertRowid],
  );
  return c.json({ membership: row }, 201);
});

app.delete("/api/patient-memberships/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM patient_memberships WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Digital consent forms ───────────────────────────────────────

const ConsentTemplateInput = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  requires_guardian: z.boolean().optional(),
  active: z.boolean().optional(),
});

app.get("/api/consent-templates", async (c) => {
  const rows = await query("SELECT * FROM consent_templates ORDER BY active DESC, title");
  return c.json({ templates: rows });
});

app.post("/api/consent-templates", async (c) => {
  const parsed = await parseJson(c, ConsentTemplateInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { title, body, requires_guardian, active } = parsed.data;
  const result = await run(
    "INSERT INTO consent_templates (title, body, requires_guardian, active) VALUES (?, ?, ?, ?)",
    [title, body, requires_guardian === true ? 1 : 0, active === false ? 0 : 1],
  );
  const row = await get("SELECT * FROM consent_templates WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ template: row }, 201);
});

app.put("/api/consent-templates/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, ConsentTemplateInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) {
      sets.push(`${k} = ?`);
      params.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
    }
  }
  if (!sets.length) return c.json({ error: "No fields to update" }, 400);
  const r = await run(`UPDATE consent_templates SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get("SELECT * FROM consent_templates WHERE id = ?", [id]);
  return c.json({ template: row });
});

app.delete("/api/consent-templates/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM consent_templates WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

const ConsentSignatureInput = z.object({
  template_id: z.number().int(),
  patient_id: z.number().int(),
  appointment_id: z.number().int().nullable().optional(),
  signer_name: z.string().min(1),
  signer_role: z.enum(["patient", "guardian"]).optional(),
  signature_data: z.string().min(1),
});

app.get("/api/patients/:id/consents", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const rows = await query(
    `SELECT cs.*, ct.title AS template_title, ct.requires_guardian
     FROM consent_signatures cs JOIN consent_templates ct ON ct.id = cs.template_id
     WHERE cs.patient_id = ? ORDER BY cs.signed_at DESC`,
    [id],
  );
  return c.json({ consents: rows });
});

app.post("/api/consent-signatures", async (c) => {
  const parsed = await parseJson(c, ConsentSignatureInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { template_id, patient_id, appointment_id, signer_name, signer_role, signature_data } = parsed.data;
  const template = await get("SELECT id, requires_guardian FROM consent_templates WHERE id = ?", [template_id]);
  if (!template) return c.json({ error: "Template not found" }, 404);
  if ((template.requires_guardian as number) === 1 && (signer_role ?? "patient") !== "guardian") {
    return c.json({ error: "This form requires a parent or guardian signature" }, 400);
  }
  if (!signature_data.startsWith("data:image/png;base64,")) {
    return c.json({ error: "Signature must be a PNG data URL" }, 400);
  }
  const result = await run(
    "INSERT INTO consent_signatures (template_id, patient_id, appointment_id, signer_name, signer_role, signature_data) VALUES (?, ?, ?, ?, ?, ?)",
    [template_id, patient_id, appointment_id ?? null, signer_name, signer_role ?? "patient", signature_data],
  );
  const row = await get("SELECT * FROM consent_signatures WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ consent: row }, 201);
});

app.delete("/api/consent-signatures/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  // Signatures are legal records — delete only removes the canvas data, keeping
  // the audit row (who signed, when) intact.
  const r = await run("UPDATE consent_signatures SET signature_data = '' WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Lab cases ─────────────────────────────────────────────────────

const LabCaseInput = z.object({
  patient_id: z.number().int(),
  practitioner_id: z.number().int().nullable().optional(),
  treatment_type_id: z.number().int().nullable().optional(),
  lab_name: z.string().min(1),
  case_type: z.string().min(1),
  tooth: z.string().optional().nullable(),
  shade: z.string().optional().nullable(),
  fee: z.number().min(0).optional(),
  sent_at: z.string().optional().nullable(),
  due_at: z.string().optional().nullable(),
  received_at: z.string().optional().nullable(),
  seated_at: z.string().optional().nullable(),
  status: z.enum(["sent", "in_lab", "received", "seated", "cancelled"]).optional(),
  notes: z.string().optional().nullable(),
});

const LAB_SELECT = `
  SELECT lc.*,
    p.first_name, p.last_name,
    pr.name as practitioner_name,
    tt.code as treatment_code, tt.name as treatment_name
  FROM lab_cases lc
  LEFT JOIN patients p ON p.id = lc.patient_id
  LEFT JOIN practitioners pr ON pr.id = lc.practitioner_id
  LEFT JOIN treatment_types tt ON tt.id = lc.treatment_type_id
`;

app.get("/api/lab-cases", async (c) => {
  const status = c.req.query("status");
  const where = status ? "WHERE lc.status = ?" : "";
  const params = status ? [status] : [];
  // Fall back to [] if the table doesn't exist yet (pre-migration dev DB).
  const rows = await query(`${LAB_SELECT} ${where} ORDER BY lc.due_at ASC, lc.id DESC`, params)
    .catch(() => []);
  return c.json({ cases: rows });
});

app.post("/api/lab-cases", async (c) => {
  const parsed = await parseJson(c, LabCaseInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO lab_cases
       (patient_id, practitioner_id, treatment_type_id, lab_name, case_type, tooth, shade, fee,
        sent_at, due_at, received_at, seated_at, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      d.patient_id, d.practitioner_id ?? null, d.treatment_type_id ?? null,
      d.lab_name, d.case_type, d.tooth ?? null, d.shade ?? null, d.fee ?? 0,
      d.sent_at ?? null, d.due_at ?? null, d.received_at ?? null, d.seated_at ?? null,
      d.status ?? "sent", d.notes ?? null,
    ],
  );
  const row = await get(`${LAB_SELECT} WHERE lc.id = ?`, [result.lastInsertRowid]);
  return c.json({ case: row }, 201);
});

app.put("/api/lab-cases/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, LabCaseInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
  }
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE lab_cases SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get(`${LAB_SELECT} WHERE lc.id = ?`, [id]);
  return c.json({ case: row });
});

app.delete("/api/lab-cases/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM lab_cases WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Reports ───────────────────────────────────────────────────────

app.get("/api/reports/summary", async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const startOfMonth = `${today.slice(0, 8)}01`;
  const startOfWeek = (() => {
    const d = new Date(`${today}T00:00:00`);
    const dow = d.getDay();
    const diff = (dow + 6) % 7; // make Monday the start
    d.setDate(d.getDate() - diff);
    return d.toISOString().slice(0, 10);
  })();

  // Per-query .catch so a missing table/column on a partially-migrated dev DB
  // doesn't take down the whole report.
  const safeGet = <T,>(sql: string, params: unknown[] = [], fallback: T) =>
    get<T>(sql, params).catch(() => fallback as T | undefined).then((v) => v ?? fallback);
  const safeQuery = <T,>(sql: string, params: unknown[] = []): Promise<T[]> =>
    query<T>(sql, params).catch(() => [] as T[]);

  const [
    todayAppts,
    weekAppts,
    monthAppts,
    monthCompleted,
    monthNoShows,
    monthCancelled,
    byTreatmentRows,
    bySourceRows,
    planAccepted,
    planCompleted,
    planDeclined,
    planTotal,
    productionRow,
    paidRow,
    aged0_30,
    aged31_60,
    aged61_90,
    aged90,
    overdueLabs,
    waitingCount,
    chairRows,
    chairCapacity,
  ] = await Promise.all([
    safeGet<{ n: number }>("SELECT COUNT(*) as n FROM appointments WHERE substr(start_time, 1, 10) = ? AND kind = 'patient'", [today], { n: 0 }),
    safeGet<{ n: number }>("SELECT COUNT(*) as n FROM appointments WHERE substr(start_time, 1, 10) >= ? AND kind = 'patient'", [startOfWeek], { n: 0 }),
    safeGet<{ n: number }>("SELECT COUNT(*) as n FROM appointments WHERE substr(start_time, 1, 10) >= ? AND kind = 'patient'", [startOfMonth], { n: 0 }),
    safeGet<{ n: number }>("SELECT COUNT(*) as n FROM appointments WHERE substr(start_time, 1, 10) >= ? AND status = 'completed'", [startOfMonth], { n: 0 }),
    safeGet<{ n: number }>("SELECT COUNT(*) as n FROM appointments WHERE substr(start_time, 1, 10) >= ? AND status = 'no_show'", [startOfMonth], { n: 0 }),
    safeGet<{ n: number }>("SELECT COUNT(*) as n FROM appointments WHERE substr(start_time, 1, 10) >= ? AND status = 'cancelled'", [startOfMonth], { n: 0 }),
    safeQuery<{ name: string; n: number; total: number }>(
      `SELECT COALESCE(tt.name, 'Unspecified') as name, COUNT(*) as n, COALESCE(SUM(tt.default_fee), 0) as total
       FROM appointments a LEFT JOIN treatment_types tt ON tt.id = a.treatment_type_id
       WHERE substr(a.start_time, 1, 10) >= ? AND a.kind = 'patient'
       GROUP BY tt.id ORDER BY n DESC`,
      [startOfMonth],
    ),
    safeQuery<{ source: string; n: number }>(
      `SELECT COALESCE(NULLIF(referral_source, ''), 'Unknown') as source, COUNT(*) as n
       FROM patients GROUP BY source ORDER BY n DESC`,
    ),
    // Case-acceptance funnel: treatment plan items presented this month.
    // "Accepted" = accepted or already completed; declined counts losses.
    safeGet<{ n: number }>(
      "SELECT COUNT(*) as n FROM treatment_plan_items WHERE status IN ('accepted', 'completed') AND substr(created_at, 1, 10) >= ?",
      [startOfMonth], { n: 0 },
    ),
    safeGet<{ n: number }>(
      "SELECT COUNT(*) as n FROM treatment_plan_items WHERE status = 'completed' AND substr(created_at, 1, 10) >= ?",
      [startOfMonth], { n: 0 },
    ),
    safeGet<{ n: number }>(
      "SELECT COUNT(*) as n FROM treatment_plan_items WHERE status = 'declined' AND substr(created_at, 1, 10) >= ?",
      [startOfMonth], { n: 0 },
    ),
    safeGet<{ n: number }>(
      "SELECT COUNT(*) as n FROM treatment_plan_items WHERE substr(created_at, 1, 10) >= ?",
      [startOfMonth], { n: 0 },
    ),
    safeGet<{ total: number }>(
      "SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE substr(issued_at, 1, 10) >= ? AND status != 'void'",
      [startOfMonth], { total: 0 },
    ),
    safeGet<{ total: number }>(
      "SELECT COALESCE(SUM(amount_paid), 0) as total FROM invoices WHERE substr(issued_at, 1, 10) >= ? AND status != 'void'",
      [startOfMonth], { total: 0 },
    ),
    safeGet<{ total: number }>(
      `SELECT COALESCE(SUM(total - amount_paid), 0) as total FROM invoices
       WHERE status = 'open' AND julianday('now') - julianday(issued_at) <= 30`, [], { total: 0 },
    ),
    safeGet<{ total: number }>(
      `SELECT COALESCE(SUM(total - amount_paid), 0) as total FROM invoices
       WHERE status = 'open' AND julianday('now') - julianday(issued_at) > 30 AND julianday('now') - julianday(issued_at) <= 60`, [], { total: 0 },
    ),
    safeGet<{ total: number }>(
      `SELECT COALESCE(SUM(total - amount_paid), 0) as total FROM invoices
       WHERE status = 'open' AND julianday('now') - julianday(issued_at) > 60 AND julianday('now') - julianday(issued_at) <= 90`, [], { total: 0 },
    ),
    safeGet<{ total: number }>(
      `SELECT COALESCE(SUM(total - amount_paid), 0) as total FROM invoices
       WHERE status = 'open' AND julianday('now') - julianday(issued_at) > 90`, [], { total: 0 },
    ),
    safeGet<{ n: number }>(
      `SELECT COUNT(*) as n FROM lab_cases WHERE due_at < datetime('now') AND received_at IS NULL AND status NOT IN ('cancelled', 'received', 'seated')`,
      [], { n: 0 },
    ),
    safeGet<{ n: number }>("SELECT COUNT(*) as n FROM waiting_list", [], { n: 0 }),
    // Efficiency: completed visits this month that have check-in/chair stamps,
    // for wait-time math (per visit: arrival → chair).
    safeQuery<{
      checked_in_at: string; in_chair_at: string | null;
      start_time: string; end_time: string; operatory_id: number;
    }>(
      `SELECT checked_in_at, in_chair_at, start_time, end_time, operatory_id
       FROM appointments
       WHERE substr(start_time, 1, 10) >= ? AND status = 'completed' AND kind = 'patient'
         AND checked_in_at IS NOT NULL`,
      [startOfMonth],
    ),
    // Theoretical chair capacity MTD: open chairs × open hours × clinic days.
    safeQuery<{ days: number }>(
      `SELECT COUNT(DISTINCT substr(start_time, 1, 10)) as days
       FROM appointments WHERE substr(start_time, 1, 10) >= ? AND kind = 'patient'`,
      [startOfMonth],
    ),
  ]);

  return c.json({
    today_appointments: todayAppts.n ?? 0,
    week_appointments: weekAppts.n ?? 0,
    month_appointments: monthAppts.n ?? 0,
    month_completed: monthCompleted.n ?? 0,
    month_no_shows: monthNoShows.n ?? 0,
    month_cancelled: monthCancelled.n ?? 0,
    month_production: productionRow.total ?? 0,
    month_collections: paidRow.total ?? 0,
    by_treatment: byTreatmentRows,
    by_source: bySourceRows,
    aged_receivables: {
      "0-30": aged0_30.total ?? 0,
      "31-60": aged31_60.total ?? 0,
      "61-90": aged61_90.total ?? 0,
      "90+": aged90.total ?? 0,
    },
    overdue_lab_cases: overdueLabs.n ?? 0,
    waiting_list_count: waitingCount.n ?? 0,
    by_provider: await (async () => {
      // Production & collections attributed via the appointment that generated
      // each invoice (invoices.appointment_id), falling back to the patient's
      // most recent completed appointment's practitioner.
      try {
        return await query<{ name: string; production: number; collections: number; visits: number }>(
          `SELECT COALESCE(pr.name, 'Unassigned') as name,
                  COALESCE(SUM(i.total), 0) as production,
                  COALESCE(SUM(i.amount_paid), 0) as collections,
                  COUNT(DISTINCT i.appointment_id) as visits
           FROM invoices i
           LEFT JOIN appointments a ON a.id = i.appointment_id
           LEFT JOIN practitioners pr ON pr.id = a.practitioner_id
           WHERE substr(i.issued_at, 1, 10) >= ? AND i.status != 'void'
           GROUP BY pr.id ORDER BY production DESC`,
          [startOfMonth],
        );
      } catch {
        return [] as { name: string; production: number; collections: number; visits: number }[];
      }
    })(),
    case_acceptance: {
      presented: planTotal.n ?? 0,
      accepted: planAccepted.n ?? 0,
      completed: planCompleted.n ?? 0,
      declined: planDeclined.n ?? 0,
      // ADA benchmark: healthy practices accept 75–80% of presented cases.
      rate: (planTotal.n ?? 0) > 0 ? Math.round(((planAccepted.n ?? 0) / (planTotal.n ?? 1)) * 100) : null,
    },
    clinic_efficiency: await (async () => {
      // Wait time per visit: checked_in_at → in_chair_at (falls back to the
      // scheduled start when the chair stamp is missing — a conservative
      // lower bound, since arrival is always ≤ scheduled start in practice).
      const waits: number[] = [];
      const opBusy = new Map<number, number>(); // operatory → busy minutes
      for (const v of chairRows) {
        if (v.in_chair_at) {
          const waitMin = (new Date(v.in_chair_at).getTime() - new Date(v.checked_in_at).getTime()) / 60000;
          if (waitMin >= 0 && waitMin < 24 * 60) waits.push(waitMin);
        }
        const busy = (new Date(v.end_time).getTime() - new Date(v.start_time).getTime()) / 60000;
        opBusy.set(v.operatory_id, (opBusy.get(v.operatory_id) ?? 0) + Math.max(0, busy));
      }
      const avgWait = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null;
      const longestWait = waits.length ? Math.round(Math.max(...waits)) : null;
      // Chair utilization: busy minutes ÷ (chairs used × clinic days × 8h
      // working day). Only counts chairs actually used — an idle chair isn't
      // "wasted capacity" the report can meaningfully claim.
      const days = Math.max(1, chairCapacity[0]?.days ?? 1);
      const chairs = Math.max(1, opBusy.size);
      const busyMinutes = [...opBusy.values()].reduce((a, b) => a + b, 0);
      const capacityMinutes = chairs * days * 8 * 60;
      return {
        avg_wait_minutes: avgWait,
        longest_wait_minutes: longestWait,
        visits_with_checkin: waits.length,
        chair_utilization_pct: Math.min(100, Math.round((busyMinutes / capacityMinutes) * 100)),
        chairs_used: opBusy.size,
        clinic_days: days,
      };
    })(),
  });
});

// ── Follow-up worklists (unscheduled treatment + dormant patients) ──

/**
 * The two call lists every practice runs weekly (Dentrix's "Treatment
 * Manager" / "Unscheduled Treatment Plans" reports):
 *
 *  1. **Unscheduled treatment** — accepted plan items with no future
 *     appointment for that patient. These patients already said yes; a quick
 *     call converts them into production.
 *  2. **Dormant patients** — no visit at all in the last N months (default
 *     12), not deceased/archived (there's no such flag, so just visit-free).
 *     Recall/reactivation candidates.
 *
 * Both lists include phone/email so the UI can offer one-click outreach.
 */
app.get("/api/followups", async (c) => {
  const dormantMonths = Math.min(Math.max(parseInt(c.req.query("dormant_months") ?? "12", 10) || 12, 3), 36);

  const [unscheduled, dormant] = await Promise.all([
    // Accepted or completed plan items that are NOT completed yet, whose
    // patient has no upcoming appointment.
    query<{
      item_id: number; patient_id: number; tooth: string | null; fee: number; status: string;
      created_at: string; first_name: string | null; last_name: string | null;
      phone: string | null; email: string | null; treatment_name: string | null;
      next_appt: string | null;
    }>(
      `SELECT tpi.id as item_id, tpi.patient_id, tpi.tooth, tpi.fee, tpi.status, tpi.created_at,
              p.first_name, p.last_name, p.phone, p.email,
              tt.name as treatment_name,
              (SELECT MIN(a.start_time) FROM appointments a
               WHERE a.patient_id = tpi.patient_id AND a.start_time >= datetime('now')
                 AND a.status NOT IN ('cancelled', 'no_show')) as next_appt
       FROM treatment_plan_items tpi
       LEFT JOIN patients p ON p.id = tpi.patient_id
       LEFT JOIN treatment_types tt ON tt.id = tpi.treatment_type_id
       WHERE tpi.status = 'accepted'
         AND NOT EXISTS (
           SELECT 1 FROM appointments a
           WHERE a.patient_id = tpi.patient_id
             AND a.start_time >= datetime('now')
             AND a.status NOT IN ('cancelled', 'no_show')
         )
       ORDER BY tpi.created_at DESC
       LIMIT 100`,
    ).catch(() => []),

    query<{
      id: number; first_name: string | null; last_name: string | null;
      phone: string | null; email: string | null;
      last_visit: string | null; total_spent: number;
    }>(
      `SELECT p.id, p.first_name, p.last_name, p.phone, p.email,
              (SELECT MAX(substr(a.start_time, 1, 10)) FROM appointments a
               WHERE a.patient_id = p.id AND a.status = 'completed') as last_visit,
              COALESCE((SELECT SUM(i.total) FROM invoices i WHERE i.patient_id = p.id AND i.status != 'void'), 0) as total_spent
       FROM patients p
       WHERE NOT EXISTS (
         SELECT 1 FROM appointments a
         WHERE a.patient_id = p.id AND a.status NOT IN ('cancelled', 'no_show')
           AND a.start_time >= datetime('now', ?)
       )
       ORDER BY last_visit ASC NULLS FIRST
       LIMIT 100`,
      [`-${dormantMonths} months`],
    ).catch(() => []),
  ]);

  return c.json({
    unscheduled_treatment: unscheduled.filter((r) => !r.next_appt),
    dormant_patients: dormant,
    dormant_months: dormantMonths,
  });
});

// ── Appointment reminders: upcoming visits with contact info ──────

/**
 * Reminders work list: patient appointments in the next N days that haven't
 * been confirmed/cancelled yet, with phone + email for one-click outreach.
 * The browser generates the WhatsApp deep link; the server just needs to
 * track which appointments have been contacted (reminded_at).
 */
app.get("/api/appointments/reminders", async (c) => {
  const days = Math.min(Math.max(parseInt(c.req.query("days") ?? "2", 10) || 2, 1), 14);
  const today = new Date().toISOString().slice(0, 10);
  const end = new Date();
  end.setDate(end.getDate() + days);
  const rows = await query<{
    id: number; patient_id: number | null; start_time: string; status: string;
    first_name: string | null; last_name: string | null; phone: string | null;
    email: string | null; treatment_name: string | null; operatory_name: string | null;
    practitioner_name: string | null; reminded_at: string | null;
  }>(
    `SELECT a.id, a.patient_id, a.start_time, a.status,
            p.first_name, p.last_name, p.phone, p.email,
            tt.name as treatment_name, o.name as operatory_name, pr.name as practitioner_name,
            NULL as reminded_at
     FROM appointments a
     LEFT JOIN patients p ON p.id = a.patient_id
     LEFT JOIN treatment_types tt ON tt.id = a.treatment_type_id
     LEFT JOIN operatories o ON o.id = a.operatory_id
     LEFT JOIN practitioners pr ON pr.id = a.practitioner_id
     WHERE substr(a.start_time, 1, 10) >= ? AND substr(a.start_time, 1, 10) <= ?
       AND a.kind = 'patient' AND a.status = 'scheduled'
     ORDER BY a.start_time`,
    [today, end.toISOString().slice(0, 10)],
  ).catch(() => []);
  return c.json({ reminders: rows });
});

/**
 * Offer a waiting-list patient the next open slot: marks their entry and
 * returns a pre-filled WhatsApp message. The front desk confirms and books
 * through the normal register-and-book flow.
 */
app.post("/api/waiting-list/:id/offer", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const slot = c.req.query("slot") ?? ""; // ISO datetime of the offered slot
  if (!/^\d{4}-\d{2}-\d{2}T/.test(slot)) return c.json({ error: "slot must be an ISO datetime" }, 400);

  const entry = await get<{ id: number; patient_id: number; notes: string | null }>(
    "SELECT id, patient_id, notes FROM waiting_list WHERE id = ?",
    [id],
  );
  if (!entry) return c.json({ error: "Not found" }, 404);
  const patient = entry.patient_id
    ? await get<{ first_name: string | null; last_name: string | null; phone: string | null }>(
        "SELECT first_name, last_name, phone FROM patients WHERE id = ?",
        [entry.patient_id],
      )
    : null;
  if (!patient?.phone) return c.json({ error: "Patient has no phone number on file" }, 400);

  const offered = slot.slice(11, 16);
  const offeredDate = new Date(slot);
  const dateLabel = offeredDate.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  const message = `Hello ${patient.first_name ?? ""}! A slot just opened at our clinic on ${dateLabel} at ${offered}. You were on our waiting list — reply to confirm and we'll hold it for you.`;
  const waUrl = `https://wa.me/${patient.phone.replace(/[^\d]/g, "")}?text=${encodeURIComponent(message)}`;

  // Stamp the offer on the entry so the team can see who was contacted.
  const stamp = `${new Date().toISOString()} ${slot}`;
  await run("UPDATE waiting_list SET notes = COALESCE(notes, '') || ? WHERE id = ?", [
    `\n[offer ${stamp}]`, id,
  ]);

  return c.json({ ok: true, message, wa_url: waUrl });
});

// ── Review requests: patients whose visit just completed ─────────
// Google reviews are the #1 local-SEO channel for clinics. This worklist
// surfaces visits that completed in the last N days and haven't been asked
// for a review yet — the browser opens the WhatsApp deep link, the server
// stamps review_requested_at so each patient is only asked once.

app.get("/api/review-requests", async (c) => {
  const days = Math.min(Math.max(parseInt(c.req.query("days") ?? "7", 10) || 7, 1), 60);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const rows = await query<{
    id: number; patient_id: number | null; end_time: string; first_name: string | null;
    last_name: string | null; phone: string | null; treatment_name: string | null;
    practitioner_name: string | null; review_requested_at: string | null;
  }>(
    `SELECT a.id, a.patient_id, a.end_time, p.first_name, p.last_name, p.phone,
            tt.name as treatment_name, pr.name as practitioner_name, a.review_requested_at
     FROM appointments a
     LEFT JOIN patients p ON p.id = a.patient_id
     LEFT JOIN treatment_types tt ON tt.id = a.treatment_type_id
     LEFT JOIN practitioners pr ON pr.id = a.practitioner_id
     WHERE substr(a.end_time, 1, 10) >= ? AND a.status = 'completed' AND a.kind = 'patient'
       AND a.review_requested_at IS NULL AND p.id IS NOT NULL
     ORDER BY a.end_time DESC LIMIT 200`,
    [since.toISOString().slice(0, 10)],
  ).catch(() => []);
  return c.json({ requests: rows });
});

app.post("/api/appointments/:id/review-requested", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run(
    "UPDATE appointments SET review_requested_at = datetime('now') WHERE id = ? AND review_requested_at IS NULL",
    [id],
  );
  if (!r.changes) return c.json({ error: "Not found or already requested" }, 404);
  return c.json({ ok: true });
});

// ── Hygiene recall (continuing care) ─────────────────────────
// Open Dental's "Recall" / Dentrix's "Continuing Care": each patient gets a
// recall type (prophy, perio maintenance…) and an interval. Completing a
// recall appointment stamps last_completed and schedules the next due date
// as a system-generated "appointment to make".

const RecallConfigInput = z.object({
  recall_type_id: z.number().int().nullable().optional(),
  interval_months: z.number().int().min(1).max(24),
  last_completed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

function addMonths(isoDate: string, months: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0); // clamp Jan 31 + 1mo → Feb 28
  return d.toISOString().slice(0, 10);
}

app.get("/api/patients/:id/recall", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const config = await get(
    `SELECT rc.*, tt.name AS recall_type_name FROM patient_recall_config rc
     LEFT JOIN treatment_types tt ON tt.id = rc.recall_type_id WHERE rc.patient_id = ?`,
    [id],
  );
  return c.json({ recall: config ?? null });
});

app.put("/api/patients/:id/recall", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, RecallConfigInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const patient = await get("SELECT id FROM patients WHERE id = ?", [id]);
  if (!patient) return c.json({ error: "Patient not found" }, 404);
  const { recall_type_id, interval_months, last_completed } = parsed.data;
  await run(
    `INSERT INTO patient_recall_config (patient_id, recall_type_id, interval_months, last_completed)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(patient_id) DO UPDATE SET
       recall_type_id = excluded.recall_type_id,
       interval_months = excluded.interval_months,
       last_completed = COALESCE(excluded.last_completed, patient_recall_config.last_completed)`,
    [id, recall_type_id ?? null, interval_months, last_completed ?? null],
  );
  const row = await get("SELECT * FROM patient_recall_config WHERE patient_id = ?", [id]);
  return c.json({ recall: row });
});

/**
 * The recall due list: patients whose next due date has arrived (or passed)
 * and who have no scheduled recall appointment yet. Due dates are computed
 * as last_completed + interval, falling back to the due_after of the latest
 * system recall entry when no visit has been completed yet.
 */
app.get("/api/recalls/due", async (c) => {
  const rows = await query<{ id: number; patient_id: number; name: string; phone: string | null;
    email: string | null; recall_type: string | null; interval_months: number;
    due_date: string; days_overdue: number }>(
    `SELECT * FROM (
      SELECT atm.id, atm.patient_id, p.first_name || ' ' || p.last_name AS name, p.phone, p.email,
             tt.name AS recall_type, rc.interval_months,
             COALESCE(
               (SELECT date(rc2.last_completed, '+' || rc2.interval_months || ' months')
                FROM patient_recall_config rc2 WHERE rc2.patient_id = atm.patient_id),
               atm.due_after,
               date(atm.created_at)
             ) AS due_date
      FROM appointments_to_make atm
      JOIN patients p ON p.id = atm.patient_id
      LEFT JOIN treatment_types tt ON tt.id = atm.treatment_type_id
      LEFT JOIN patient_recall_config rc ON rc.patient_id = atm.patient_id
      WHERE atm.status = 'open' AND atm.source = 'system'
        AND COALESCE(
          (SELECT date(rc4.last_completed, '+' || rc4.interval_months || ' months')
           FROM patient_recall_config rc4 WHERE rc4.patient_id = atm.patient_id),
          atm.due_after, date(atm.created_at)
        ) <= date('now', '+30 days')
     )
     ORDER BY due_date ASC LIMIT 200`,
  ).then((rows) =>
    // days_overdue needs the computed due_date, so it's applied post-query.
    rows.map((r) => ({ ...r, days_overdue: Math.max(0, Math.round(Date.now() / 86400000 - new Date(`${r.due_date}T00:00:00Z`).getTime() / 86400000)) })),
  ).catch(() => []);
  return c.json({ recalls: rows });
});

/** Mark a recall as confirmed by the patient (front desk logs the call/text). */
app.post("/api/recalls/:id/confirm", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run(
    "UPDATE appointments_to_make SET confirmed_at = datetime('now') WHERE id = ? AND status = 'open'",
    [id],
  );
  if (!r.changes) return c.json({ error: "Not found or already scheduled" }, 404);
  return c.json({ ok: true });
});

/**
 * Auto-recall: when a patient appointment is completed, find (or create) the
 * patient's recall config, stamp last_completed, and reschedule the next
 * system "appointment to make" at interval months out. Only fires for
 * patient appointments that already have a system recall entry or a recall
 * config — one-off treatment visits don't invent recall schedules.
 */
async function processRecallOnCompletion(patientId: number, completedDate: string): Promise<void> {
  try {
    const config = await get<{ interval_months: number; recall_type_id: number | null }>(
      "SELECT interval_months, recall_type_id FROM patient_recall_config WHERE patient_id = ?",
      [patientId],
    );
    if (!config) return; // no recall schedule on file
    const nextDue = addMonths(completedDate, config.interval_months);
    await run("UPDATE patient_recall_config SET last_completed = ? WHERE patient_id = ?", [completedDate, patientId]);
    // Retire the currently-open system recall (it's now fulfilled) and create
    // the next cycle.
    await run(
      "UPDATE appointments_to_make SET status = 'scheduled' WHERE patient_id = ? AND source = 'system' AND status = 'open'",
      [patientId],
    );
    await run(
      "INSERT INTO appointments_to_make (patient_id, treatment_type_id, due_after, source, notes) VALUES (?, ?, ?, 'system', ?)",
      [patientId, config.recall_type_id, nextDue, `Auto-recall: ${config.interval_months}-month cycle`],
    );
  } catch {
    // recall processing must never break appointment completion
  }
}

// ── Self check-in kiosk ──────────────────────────────────────
// A tablet-facing page: the patient picks today's appointment, confirms their
// contact details, signs pending consent forms, and arrives themselves. The
// front desk sees the arrival in real time (the appointment flips to 'arrived'
// with checked_in_at stamped for wait-time tracking).

app.get("/api/kiosk/today", async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await query(
    `SELECT a.id, a.start_time, a.status, a.checked_in_at,
            p.id AS patient_id, p.first_name, p.last_name,
            tt.name AS treatment_name, pr.name AS practitioner_name
     FROM appointments a
     LEFT JOIN patients p ON p.id = a.patient_id
     LEFT JOIN treatment_types tt ON tt.id = a.treatment_type_id
     LEFT JOIN practitioners pr ON pr.id = a.practitioner_id
     WHERE substr(a.start_time, 1, 10) = ? AND a.kind = 'patient'
       AND a.status IN ('scheduled', 'confirmed')
     ORDER BY a.start_time`,
    [today],
  ).catch(() => []);
  return c.json({ appointments: rows });
});

// Unsigned-but-required consent templates for one patient (kiosk step 3).
app.get("/api/kiosk/pending-consents/:patientId", async (c) => {
  const patientId = intParam(c.req.param("patientId"));
  if (!patientId) return c.json({ error: "Invalid ID" }, 400);
  const rows = await query(
    `SELECT ct.* FROM consent_templates ct
     WHERE ct.active = 1 AND NOT EXISTS (
       SELECT 1 FROM consent_signatures cs
       WHERE cs.template_id = ct.id AND cs.patient_id = ?
         AND cs.signature_data != ''
     ) ORDER BY ct.title`,
    [patientId],
  ).catch(() => []);
  return c.json({ templates: rows });
});

/**
 * Kiosk check-in: stamps checked_in_at, flips the status to 'arrived', and
 * captures any demographic updates the patient made on the tablet. Idempotent
 * per appointment (a second check-in updates the details but not the stamp).
 */
app.post("/api/kiosk/check-in", async (c) => {
  const parsed = await parseJson(
    c,
    z.object({
      appointment_id: z.number().int(),
      phone: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      address: z.string().nullable().optional(),
    }),
  );
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { appointment_id, phone, email, address } = parsed.data;
  const appt = await get<{ id: number; patient_id: number | null; status: string; checked_in_at: string | null }>(
    "SELECT id, patient_id, status, checked_in_at FROM appointments WHERE id = ? AND kind = 'patient'",
    [appointment_id],
  );
  if (!appt) return c.json({ error: "Appointment not found" }, 404);
  if (!appt.patient_id) return c.json({ error: "Appointment has no patient" }, 400);

  // Demographic updates from the kiosk (only fields the patient actually edited).
  const updates: string[] = [];
  const params: unknown[] = [];
  if (phone) { updates.push("phone = ?"); params.push(phone); }
  if (email) { updates.push("email = ?"); params.push(email); }
  if (address) { updates.push("address = ?"); params.push(address); }
  if (updates.length) {
    await run(`UPDATE patients SET ${updates.join(", ")} WHERE id = ?`, [...params, appt.patient_id]);
  }

  if (!appt.checked_in_at) {
    await run(
      "UPDATE appointments SET checked_in_at = datetime('now'), in_chair_at = NULL, status = CASE WHEN status IN ('scheduled', 'confirmed') THEN 'arrived' ELSE status END WHERE id = ?",
      [appointment_id],
    );
  }
  const row = await get("SELECT id, status, checked_in_at FROM appointments WHERE id = ?", [appointment_id]);
  return c.json({ appointment: row });
});

// ── Payment plans (installments) ────────────────────────────────

const PaymentPlanInput = z.object({
  installment_count: z.number().int().min(2).max(24),
  interval: z.enum(["weekly", "monthly"]),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

function addInterval(isoDate: string, interval: "weekly" | "monthly", n: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (interval === "weekly") {
    d.setUTCDate(d.getUTCDate() + 7 * n);
  } else {
    const day = d.getUTCDate();
    d.setUTCMonth(d.getUTCMonth() + n);
    if (d.getUTCDate() < day) d.setUTCDate(0);
  }
  return d.toISOString().slice(0, 10);
}

app.get("/api/invoices/:id/payment-plan", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const plan = await get("SELECT * FROM invoice_payment_plans WHERE invoice_id = ? AND active = 1", [id]);
  if (!plan) return c.json({ plan: null });
  const schedule = [];
  for (let i = 0; i < (plan.installment_count as number); i++) {
    schedule.push({
      n: i + 1,
      due_date: addInterval(plan.start_date as string, plan.interval as "weekly" | "monthly", i),
      amount: plan.installment_amount as number,
    });
  }
  return c.json({ plan, schedule });
});

app.post("/api/invoices/:id/payment-plan", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, PaymentPlanInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const invoice = await get("SELECT id, total, amount_paid FROM invoices WHERE id = ?", [id]);
  if (!invoice) return c.json({ error: "Invoice not found" }, 404);
  const balance = Math.round(((invoice.total as number) - (invoice.amount_paid as number)) * 100) / 100;
  if (balance <= 0) return c.json({ error: "Invoice has no outstanding balance" }, 400);
  const { installment_count, interval, start_date } = parsed.data;
  // Replace any existing plan.
  await run("UPDATE invoice_payment_plans SET active = 0 WHERE invoice_id = ?", [id]);
  const amount = Math.floor((balance / installment_count) * 100) / 100;
  const result = await run(
    "INSERT INTO invoice_payment_plans (invoice_id, installment_count, interval, start_date, installment_amount) VALUES (?, ?, ?, ?, ?)",
    [id, installment_count, interval, start_date, amount],
  );
  const plan = await get("SELECT * FROM invoice_payment_plans WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ plan }, 201);
});

app.delete("/api/invoices/:id/payment-plan", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("UPDATE invoice_payment_plans SET active = 0 WHERE invoice_id = ? AND active = 1", [id]);
  if (!r.changes) return c.json({ error: "No active plan" }, 404);
  return c.json({ ok: true });
});

// ── Installment reminders: due installments across all active plans ──
// A worklist for the front desk: every unpaid installment that has come due
// (or is due within the `days` window), with the invoice's remaining balance.
// The browser opens the WhatsApp deep link; the server tracks which plan was
// last contacted (payment_plan_reminded_at) so each installment is asked once.

/** Days covered by each plan interval — one cycle ahead. */
function planIntervalDays(interval: string): number {
  return interval === "weekly" ? 7 : 31;
}

app.get("/api/payment-reminders", async (c) => {
  const days = Math.min(Math.max(parseInt(c.req.query("days") ?? "3", 10) || 3, 0), 60);
  const plans = await query<{
    id: number; invoice_id: number; installment_count: number; interval: string;
    start_date: string; installment_amount: number; payment_plan_reminded_at: string | null;
    patient_id: number; first_name: string | null; last_name: string | null;
    phone: string | null; invoice_total: number; amount_paid: number;
  }>(
    `SELECT ipp.*, i.patient_id, i.total AS invoice_total, i.amount_paid,
            p.first_name, p.last_name, p.phone
     FROM invoice_payment_plans ipp
     JOIN invoices i ON i.id = ipp.invoice_id
     LEFT JOIN patients p ON p.id = i.patient_id
     WHERE ipp.active = 1 AND i.status != 'void' AND i.total > i.amount_paid`,
  ).catch(() => []);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const horizon = new Date(today);
  horizon.setUTCDate(horizon.getUTCDate() + days);

  const reminders: Array<{
    plan_id: number; invoice_id: number; patient_id: number; installment_n: number;
    due_date: string; amount: number; days_until_due: number; overdue: boolean;
    balance: number; patient_name: string; phone: string | null;
    payment_plan_reminded_at: string | null;
  }> = [];
  for (const plan of plans) {
    // Find the next unpaid installment: the first whose due date is >= the
    // date the plan was last contacted (or the plan start for first contact).
    const startRef = plan.payment_plan_reminded_at?.slice(0, 10) ?? plan.start_date;
    for (let i = 0; i < plan.installment_count; i++) {
      const dueDate = addInterval(plan.start_date, plan.interval as "weekly" | "monthly", i);
      const due = new Date(`${dueDate}T00:00:00Z`);
      // Only installments due within the window (or already past) count.
      if (due > horizon) break;
      const balance = Math.round((plan.invoice_total - plan.amount_paid) * 100) / 100;
      if (balance <= 0) break; // fully paid — nothing to chase
      const daysUntil = Math.round((due.getTime() - today.getTime()) / 86400000);
      reminders.push({
        plan_id: plan.id,
        invoice_id: plan.invoice_id,
        patient_id: plan.patient_id,
        installment_n: i + 1,
        due_date: dueDate,
        amount: plan.installment_amount,
        days_until_due: daysUntil,
        overdue: daysUntil < 0,
        balance,
        patient_name: [plan.first_name, plan.last_name].filter(Boolean).join(" ") || "Unnamed",
        phone: plan.phone,
        payment_plan_reminded_at: plan.payment_plan_reminded_at,
      });
      void startRef;
    }
  }
  reminders.sort((a, b) => a.due_date.localeCompare(b.due_date));
  return c.json({ reminders });
});

/** Stamp a plan as contacted (the front desk sent the reminder). */
app.post("/api/payment-plans/:id/reminded", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run(
    "UPDATE invoice_payment_plans SET payment_plan_reminded_at = datetime('now') WHERE id = ?",
    [id],
  );
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Backups: export / import / snapshots / auto-backup schedule ───

const BackupSettingsInput = z.object({
  auto_backup_interval_minutes: z.number().int().min(0).max(10080).optional(), // 0 = off, max 1 week
  auto_backup_keep: z.number().int().min(1).max(100).optional(),
});

/** Backup filename used for both the local snapshot record and Drive. */
function backupFilename(stamp: string): string {
  return `dental-canvas-backup-${stamp}.json`;
}

/**
 * Push a backup payload to Google Drive (best-effort). Never throws: a Drive
 * outage must not fail the local snapshot — the outcome is recorded in
 * settings so the UI can show what happened.
 */
async function pushBackupToDrive(payload: BackupPayload, stamp: string): Promise<void> {
  // Push only the portable tables + image_files JSON — the byte payloads in
  // image_files are already real bytes and are NOT re-encoded, so Drive gets a
  // compact copy of the same file set.
  const compact = {
    format: payload.format,
    version: payload.version,
    created_at: payload.created_at,
    clinic_name: payload.clinic_name,
    tables: payload.tables,
    image_files: payload.image_files,
  };
  const json = JSON.stringify(compact);
  const d = await getDriveSettings();
  if (!d.enabled || !isDriveConfigured(d)) return;
  const r = await uploadJsonToDrive(backupFilename(stamp), json, d);
  await recordUploadResult(r.ok, r.error);
}

async function getSettingsForBackup() {
  const rows = await query<{ key: string; value: string }>(
    "SELECT key, value FROM settings WHERE key IN ('auto_backup_interval_minutes', 'auto_backup_keep')",
  ).catch(() => []);
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const interval = parseInt(map.auto_backup_interval_minutes ?? "0", 10);
  const keep = parseInt(map.auto_backup_keep ?? "10", 10);
  return {
    auto_backup_interval_minutes: Number.isFinite(interval) && interval >= 0 ? interval : 0,
    auto_backup_keep: Number.isFinite(keep) && keep >= 1 ? Math.min(keep, 100) : 10,
  };
}

// Read the auto-backup schedule (merged with defaults).
app.get("/api/backup/settings", async (c) => {
  const settings = await getSettingsForBackup();
  return c.json({ settings });
});

// Update the auto-backup schedule. Values are validated; 0 disables auto-backup.
app.put("/api/backup/settings", async (c) => {
  const parsed = await parseJson(c, BackupSettingsInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  if (d.auto_backup_interval_minutes === undefined && d.auto_backup_keep === undefined) {
    return c.json({ error: "No fields" }, 400);
  }
  const updates: [string, string][] = [];
  if (d.auto_backup_interval_minutes !== undefined) {
    updates.push(["auto_backup_interval_minutes", String(d.auto_backup_interval_minutes)]);
  }
  if (d.auto_backup_keep !== undefined) {
    updates.push(["auto_backup_keep", String(d.auto_backup_keep)]);
  }
  for (const [key, value] of updates) {
    await run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }
  const settings = await getSettingsForBackup();
  return c.json({ settings });
});

// Downloadable portable export of EVERY data table.
app.get("/api/backup/export", async (c) => {
  const payload = await dumpAllData();
  // Full export — image_files contains the real byte payloads.
  const json = JSON.stringify(payload, null, 2);
  const stamp = payload.created_at.slice(0, 10);
  return new Response(json, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="dental-canvas-backup-${stamp}.json"`,
      "Cache-Control": "no-store",
    },
  });
});

// Snapshot list + stats (payloads excluded — they can be megabytes).
app.get("/api/backup/snapshots", async (c) => {
  const [snapshots, stats] = await Promise.all([listSnapshots(50), snapshotsStats()]);
  return c.json({ snapshots, stats });
});

// Create a snapshot now (manual).
app.post("/api/backup/snapshots", async (c) => {
  const backupSettings = await getSettingsForBackup();
  const { snapshot, payload } = await createSnapshot("manual", "user", backupSettings.auto_backup_keep);
  // Snapshot stores the full export (real bytes in image_files); Drive gets the
  // portable tables+image_files copy so the mirror stays compact.
  await pushBackupToDrive(payload, snapshot.created_at);
  return c.json({ snapshot }, 201);
});

app.get("/api/backup/snapshots/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const payload = await getSnapshotPayload(id);
  if (!payload) return c.json({ error: "Not found" }, 404);
  const json = JSON.stringify(payload, null, 2);
  return new Response(json, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="dental-canvas-backup-${payload.created_at.slice(0, 10)}-id${id}.json"`,
      "Cache-Control": "no-store",
    },
  });
});

app.delete("/api/backup/snapshots/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const ok = await deleteSnapshot(id);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// Timer-driven auto backup — called by the client when its countdown fires.
app.post("/api/backup/auto", async (c) => {
  const backupSettings = await getSettingsForBackup();
  if (backupSettings.auto_backup_interval_minutes === 0) {
    return c.json({ skipped: true, reason: "auto-backup disabled" }, 200);
  }
  // Optional trigger reason: "timer" (the client countdown) or
  // "data_change" (a meaningful mutation just happened). Recorded on the
  // snapshot so the Settings list shows why it exists.
  let trigger: "timer" | "data_change" = "timer";
  const body = await c.req.json().catch(() => null);
  if (body && typeof body === "object" && (body as { reason?: unknown }).reason === "data_change") {
    trigger = "data_change";
  }
  const { snapshot, payload } = await createSnapshot("auto", trigger, backupSettings.auto_backup_keep);
  await pushBackupToDrive(payload, snapshot.created_at);
  return c.json({ snapshot }, 201);
});

// ── Google Drive backup destination ─────────────────────────────

/** Connection status + last upload outcome for the settings card. */
app.get("/api/backup/drive/status", async (c) => {
  const d = await getDriveSettings();
  return c.json({
    configured: isDriveConfigured(d),
    connected: isDriveConfigured(d),
    has_credentials: hasCredentials(d),
    enabled: d.enabled,
    folder_id: d.folder_id || null,
    last_upload_at: d.last_upload_at || null,
    last_upload_ok: d.last_upload_ok,
    last_upload_error: d.last_upload_error || null,
  });
});

/** Save the OAuth client credentials + optional folder id. */
const DriveConfigInput = z
  .object({
    client_id: z.string().trim().min(1).optional(),
    client_secret: z.string().trim().min(1).optional(),
    folder_id: z.string().trim().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

app.put("/api/backup/drive/config", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const parsed = DriveConfigInput.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid Drive configuration" }, 400);

  const updates: [string, string][] = [];
  if (parsed.data.client_id !== undefined) updates.push(["gdrive_client_id", parsed.data.client_id]);
  if (parsed.data.client_secret !== undefined) updates.push(["gdrive_client_secret", parsed.data.client_secret]);
  if (parsed.data.folder_id !== undefined) updates.push(["gdrive_folder_id", parsed.data.folder_id]);
  if (parsed.data.enabled !== undefined) updates.push(["gdrive_enabled", parsed.data.enabled ? "1" : "0"]);

  for (const [key, value] of updates) {
    await run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      [key, value],
    );
  }
  const d = await getDriveSettings();
  return c.json({
    configured: isDriveConfigured(d),
    connected: isDriveConfigured(d),
    has_credentials: hasCredentials(d),
    enabled: d.enabled,
    folder_id: d.folder_id || null,
  });
});

/**
 * Start the OAuth consent flow. The redirect URI must exactly match one
 * registered on the Google Cloud OAuth client, so it is derived from the
 * incoming request's own origin.
 */
app.get("/api/backup/drive/auth", async (c) => {
  const d = await getDriveSettings();
  if (!hasCredentials(d)) {
    return c.json({ error: "Save the Google OAuth client ID and secret first." }, 400);
  }
  const origin = new URL(c.req.url).origin;
  const redirectUri = `${origin}/api/backup/drive/callback`;
  return c.redirect(driveAuthUrl(d.client_id, redirectUri));
});

/**
 * OAuth redirect target. Exchanges the code, stores the refresh token, then
 * bounces the user's browser back to the settings page with a result flag.
 */
app.get("/api/backup/drive/callback", async (c) => {
  const origin = new URL(c.req.url).origin;
  const back = (flag: string, msg: string) =>
    c.redirect(`${origin}/settings?tab=backup&drive_${flag}=${encodeURIComponent(msg)}`);

  const error = c.req.query("error");
  if (error) return back("error", c.req.query("error_description") || error);

  const code = c.req.query("code");
  if (!code) return back("error", "Google did not return an authorization code");

  const d = await getDriveSettings();
  const redirectUri = `${origin}/api/backup/drive/callback`;
  const r = await exchangeCodeForTokens(d, code, redirectUri);
  if (!r.ok) return back("error", r.error);

  await run(
    `INSERT INTO settings (key, value, updated_at) VALUES ('gdrive_refresh_token', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [r.refresh_token],
  );
  return back("connected", "1");
});

/** Revoke + forget the stored tokens. */
app.post("/api/backup/drive/disconnect", async (c) => {
  const d = await getDriveSettings();
  if (d.refresh_token) {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: d.refresh_token }).toString(),
    }).catch(() => undefined); // best-effort; local credentials are cleared regardless
  }
  for (const key of ["gdrive_refresh_token", "gdrive_last_upload_at", "gdrive_last_upload_ok", "gdrive_last_upload_error"]) {
    await run("DELETE FROM settings WHERE key = ?", [key]);
  }
  await run("INSERT INTO settings (key, value) VALUES ('gdrive_enabled', '0') ON CONFLICT(key) DO UPDATE SET value = '0'");
  return c.json({ ok: true });
});

/** Push an existing stored snapshot to Drive right now. */
app.post("/api/backup/drive/upload/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const payload = await getSnapshotPayload(id);
  if (!payload) return c.json({ error: "Snapshot not found" }, 404);

  const d = await getDriveSettings();
  if (!isDriveConfigured(d)) return c.json({ error: "Google Drive is not connected yet." }, 400);

  const filename = backupFilename(`${payload.created_at.slice(0, 10)}-id${id}`);
  const json = JSON.stringify(payload);
  const r = await uploadJsonToDrive(filename, json, d);
  await recordUploadResult(r.ok, r.error);
  if (!r.ok) return c.json({ error: r.error }, 502);
  return c.json({ ok: true, file_id: r.file_id });
});

/** Connectivity probe: uploads a tiny test file. */
app.post("/api/backup/drive/test", async (c) => {
  const d = await getDriveSettings();
  if (!isDriveConfigured(d)) return c.json({ error: "Google Drive is not connected yet." }, 400);
  const r = await testDriveConnection(d);
  if (!r.ok) return c.json({ error: r.error }, 502);
  return c.json({ ok: true, file_id: r.file_id });
});

// Import: accept a portable backup JSON, safety-snapshot first, then replace.
app.post("/api/backup/import", async (c) => {
  let bodyText: string;
  try {
    bodyText = await c.req.text();
  } catch {
    return c.json({ error: "Could not read request body" }, 400);
  }
  if (isPayloadTooLarge(bodyText)) {
    return c.json({ error: `Backup file too large (limit ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB)` }, 413);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return c.json({ error: "Invalid JSON — is this a Dental Canvas backup file?" }, 400);
  }
  const validated = validateBackupPayload(raw);
  if (!validated.ok) return c.json({ error: validated.error }, 400);

  // Verify the real image bytes survived the round-trip: import restores every
  // file_key in image_files into patient_image_blobs (`restoreFromBackup` does
  // the decoding), so the portable tables only carry metadata. The snapshot +
  // Drive copy carry the full export.
  const keep = (await getSettingsForBackup()).auto_backup_keep;

  // Safety net: snapshot current state BEFORE destructive import so a bad
  // import can be undone.
  await createSnapshot("manual", "pre-import", keep);

  const payload = validated.data as BackupPayload;
  // Restore real image bytes first, then the portable tables (parents before
  // children, FK-safe) — both are handled inside restoreFromBackup, which
  // decodes image_files into patient_image_blobs before inserting rows.
  const counts = await restoreFromBackup(payload);

  return c.json({
    ok: true,
    restored: counts,
    imported_rows: Object.values(counts).reduce((a, b) => a + (b ?? 0), 0),
  });
});

// Restore from a stored snapshot by id.
app.post("/api/backup/snapshots/:id/restore", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const payload = await getSnapshotPayload(id);
  if (!payload) return c.json({ error: "Not found" }, 404);

  const keep = (await getSettingsForBackup()).auto_backup_keep;
  // Safety net before rolling back to the snapshot.
  await createSnapshot("manual", "pre-restore", keep);

  // restoreFromBackup decodes image_files into patient_image_blobs before
  // inserting the portable tables (parents before children, FK-safe).
  const counts = await restoreFromBackup(payload);
  return c.json({ ok: true, restored: counts });
});

// Dry-run inspection of an uploaded backup without importing anything.
app.post("/api/backup/inspect", async (c) => {
  let bodyText: string;
  try {
    bodyText = await c.req.text();
  } catch {
    return c.json({ error: "Could not read request body" }, 400);
  }
  if (isPayloadTooLarge(bodyText)) return c.json({ error: "Backup file too large (limit 512 MB)" }, 413);
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return c.json({ error: "Invalid JSON — is this a Dental Canvas backup file?" }, 400);
  }
  const validated = validateBackupPayload(raw);
  if (!validated.ok) return c.json({ error: validated.error }, 400);
  return c.json({
    ok: true,
    version: validated.data.version,
    created_at: validated.data.created_at,
    clinic_name: validated.data.clinic_name ?? null,
    counts: countRows(validated.data),
  });
});

// ── Dashboard ─────────────────────────────────────────────────────

app.get("/api/dashboard/summary", async (c) => {
  // "Today" is the clinic's calendar day, not UTC's. The Worker's clock is UTC,
  // so for any practice east or west of it the UTC date is a day off for part
  // of every day — at 09:00 in Dhaka (UTC+6) UTC still says yesterday, and the
  // headline card reported 0 visits while four were booked. The client sends
  // its own local date; an absent or malformed value falls back to UTC so the
  // endpoint still works for scripts and tests.
  const requestedToday = c.req.query("today");
  const today =
    requestedToday && /^\d{4}-\d{2}-\d{2}$/.test(requestedToday)
      ? requestedToday
      : new Date().toISOString().slice(0, 10);
  const startOfMonth = `${today.slice(0, 8)}01`;
  const prevMonthStart = (() => {
    const d = new Date(`${startOfMonth}T00:00:00`);
    d.setMonth(d.getMonth() - 1);
    return `${d.toISOString().slice(0, 8)}01`;
  })();

  const safeGet = <T,>(sql: string, params: unknown[] = [], fallback: T) =>
    get<T>(sql, params).catch(() => fallback as T | undefined).then((v) => v ?? fallback);

  const [
    totalToday,
    totalLastMonthSameDay,
    newPatients,
    newPatientsLastMonth,
    returningPatients,
    returningPatientsLastMonth,
    newPatientsToday,
    returningPatientsToday,
    upcoming,
  ] = await Promise.all([
    // All patient visits today (the dashboard's headline number). Cancelled
    // visits and no-shows never made it to the chair, so they don't count.
    safeGet<{ n: number }>(
      "SELECT COUNT(*) as n FROM appointments WHERE substr(start_time, 1, 10) = ? AND kind = 'patient' AND status NOT IN ('cancelled', 'no_show')",
      [today], { n: 0 },
    ),
    // Same-period figure for last month's first day, used for the delta badge.
    safeGet<{ n: number }>(
      "SELECT COUNT(*) as n FROM appointments WHERE substr(start_time, 1, 10) = ? AND kind = 'patient' AND status NOT IN ('cancelled', 'no_show')",
      [prevMonthStart], { n: 0 },
    ),
    // "New" = no prior completed/visited appointment before this month.
    safeGet<{ n: number }>(
      `SELECT COUNT(*) as n FROM patients p
       WHERE NOT EXISTS (
         SELECT 1 FROM appointments a
         WHERE a.patient_id = p.id AND a.status = 'completed'
           AND substr(a.start_time, 1, 10) < ?
       )`,
      [startOfMonth], { n: 0 },
    ),
    safeGet<{ n: number }>(
      `SELECT COUNT(*) as n FROM patients p
       WHERE NOT EXISTS (
         SELECT 1 FROM appointments a
         WHERE a.patient_id = p.id AND a.status = 'completed'
           AND substr(a.start_time, 1, 10) < ?
       )`,
      [prevMonthStart], { n: 0 },
    ),
    // "Returning" = everyone with at least one completed visit before this month.
    safeGet<{ n: number }>(
      `SELECT COUNT(DISTINCT a.patient_id) as n FROM appointments a
       WHERE a.patient_id IS NOT NULL AND a.status = 'completed'
         AND substr(a.start_time, 1, 10) < ?`,
      [startOfMonth], { n: 0 },
    ),
    safeGet<{ n: number }>(
      `SELECT COUNT(DISTINCT a.patient_id) as n FROM appointments a
       WHERE a.patient_id IS NOT NULL AND a.status = 'completed'
         AND substr(a.start_time, 1, 10) < ?`,
      [prevMonthStart], { n: 0 },
    ),
    // New patients *today*: in the chair today and never completed a visit
    // before today. The month-wide figures above count the whole patient base,
    // so they cannot measure a daily goal — the dashboard's new-patient ring
    // would sit at "hundreds of percent" for any practice with history.
    safeGet<{ n: number }>(
      `SELECT COUNT(*) as n FROM patients p
       WHERE EXISTS (
         SELECT 1 FROM appointments a
         WHERE a.patient_id = p.id AND substr(a.start_time, 1, 10) = ?
           AND a.kind = 'patient' AND a.status NOT IN ('cancelled', 'no_show')
       )
       AND NOT EXISTS (
         SELECT 1 FROM appointments c
         WHERE c.patient_id = p.id AND c.status = 'completed'
           AND substr(c.start_time, 1, 10) < ?
       )`,
      [today, today], { n: 0 },
    ),
    // Returning *today*: in the chair today with a completed visit before today.
    safeGet<{ n: number }>(
      `SELECT COUNT(DISTINCT p.id) as n FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       WHERE substr(a.start_time, 1, 10) = ? AND a.kind = 'patient'
         AND a.status NOT IN ('cancelled', 'no_show')
         AND EXISTS (
           SELECT 1 FROM appointments c
           WHERE c.patient_id = p.id AND c.status = 'completed'
             AND substr(c.start_time, 1, 10) < ?
         )`,
      [today, today], { n: 0 },
    ),
    // Next 5 upcoming events: future patient appointments + open recalls.
    (async () => {
      const [futureAppts, recalls] = await Promise.all([
        query<{
          id: number; kind: string; title: string | null; patient_id: number | null;
          start_time: string; first_name: string | null; last_name: string | null;
          treatment_name: string | null; treatment_color: string | null; status: string;
        }>(
          `SELECT a.id, a.kind, a.title, a.patient_id, a.start_time, a.status,
                  p.first_name, p.last_name, tt.name as treatment_name, tt.color as treatment_color
           FROM appointments a
           LEFT JOIN patients p ON p.id = a.patient_id
           LEFT JOIN treatment_types tt ON tt.id = a.treatment_type_id
           WHERE a.start_time >= ? AND a.status NOT IN ('cancelled', 'no_show') AND a.kind = 'patient'
           ORDER BY a.start_time LIMIT 5`,
          [`${today}T00:00:00`],
        ).catch(() => []),
        query<{ id: number; kind: string; title: string | null; patient_id: number | null; start_time: string; first_name: string | null; last_name: string | null; treatment_name: string | null; treatment_color: string | null; status: string }>(
          `SELECT atm.id, 'recall' as kind, tt.name as title, atm.patient_id,
                  COALESCE(atm.due_after, '') as start_time, 'scheduled' as status,
                  p.first_name, p.last_name, tt.name as treatment_name, tt.color as treatment_color
           FROM appointments_to_make atm
           LEFT JOIN patients p ON p.id = atm.patient_id
           LEFT JOIN treatment_types tt ON tt.id = atm.treatment_type_id
           WHERE atm.status = 'open' AND (atm.due_after IS NULL OR atm.due_after >= ?)
           ORDER BY atm.due_after LIMIT 5`,
          [today],
        ).catch(() => []),
      ]);
      return [...futureAppts, ...recalls]
        .sort((x, y) => x.start_time.localeCompare(y.start_time))
        .slice(0, 5);
    })(),
  ]);

  const pct = (cur: number, prev: number): number | null =>
    prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null;

  return c.json({
    total_visits: totalToday.n ?? 0,
    visits_delta_pct: pct(totalToday.n ?? 0, totalLastMonthSameDay.n ?? 0),
    new_patients: newPatients.n ?? 0,
    new_patients_delta_pct: pct(newPatients.n ?? 0, newPatientsLastMonth.n ?? 0),
    returning_patients: returningPatients.n ?? 0,
    returning_patients_delta_pct: pct(returningPatients.n ?? 0, returningPatientsLastMonth.n ?? 0),
    // Per-day figures, the ones the dashboard's goal rings are drawn from.
    new_patients_today: newPatientsToday.n ?? 0,
    returning_patients_today: returningPatientsToday.n ?? 0,
    upcoming,
  });
});

/**
 * Birthdays in a date window, for the dashboard's birthday board.
 * ?days=N looks N days ahead (including today, wrapping across the year end);
 * ?month=YYYY-MM lists a whole month. Age is computed as of this year's
 * birthday so the card can show "turning 34".
 */
app.get("/api/dashboard/birthdays", async (c) => {
  const days = Math.min(Math.max(parseInt(c.req.query("days") ?? "7", 10) || 7, 1), 60);
  const month = c.req.query("month"); // YYYY-MM, overrides ?days
  // The clinic's calendar day, as the dashboard summary does: a UTC "today"
  // pushed every birthday east of UTC a day out ("turns 37 tomorrow" on the
  // morning of the birthday). Parsed as UTC midnight so the getUTC* helpers
  // below read back the same calendar date either way.
  const requestedToday = c.req.query("today");
  const today =
    requestedToday && /^\d{4}-\d{2}-\d{2}$/.test(requestedToday)
      ? new Date(`${requestedToday}T00:00:00Z`)
      : new Date();

  const rows = await query<{
    id: number; first_name: string | null; last_name: string | null;
    date_of_birth: string | null; phone: string | null;
  }>(
    `SELECT id, first_name, last_name, date_of_birth, phone
     FROM patients
     WHERE date_of_birth IS NOT NULL AND date_of_birth != ''
     ORDER BY substr(date_of_birth, 6, 5)`,
  ).catch(() => []);

  const toMd = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const windowEnd = new Date(today.getTime() + (days - 1) * 86_400_000);
  const startMd = toMd(today);
  const endMd = toMd(windowEnd);

  const monthStr = month ?? "";
  const inWindow = (md: string) =>
    // Wrap-around window (e.g. Dec 28 → Jan 3) must match both tails.
    startMd <= endMd ? md >= startMd && md <= endMd : md >= startMd || md <= endMd;
  const inMonth = (md: string, m: string) => m === monthStr.slice(5, 7);

  const year = today.getUTCFullYear();
  const birthdays = rows
    .filter((r) => {
      const md = (r.date_of_birth ?? "").slice(5, 10);
      if (!/^\d{2}-\d{2}$/.test(md)) return false;
      // Feb 29 birthdays celebrate on Mar 1 in non-leap years.
      const shifted = md === "02-29" && !leap(year) ? "03-01" : md;
      return monthStr ? inMonth(shifted, monthStr) : inWindow(shifted);
    })
    .map((r) => {
      const md = (r.date_of_birth ?? "").slice(5, 10);
      const thisYearMd = md === "02-29" && !leap(year) ? "03-01" : md;
      const nextBirthday = new Date(`${year}-${thisYearMd}T00:00:00`);
      if (nextBirthday < new Date(`${today.toISOString().slice(0, 10)}T00:00:00`)) {
        nextBirthday.setFullYear(nextBirthday.getFullYear() + 1);
      }
      const age = year - parseInt((r.date_of_birth ?? "").slice(0, 4), 10);
      const daysAway = Math.round(
        (nextBirthday.getTime() - new Date(`${today.toISOString().slice(0, 10)}T00:00:00`).getTime()) / 86_400_000,
      );
      return {
        id: r.id,
        name: [r.first_name, r.last_name].filter(Boolean).join(" "),
        date_of_birth: r.date_of_birth,
        phone: r.phone,
        turning: age + (daysAway === 0 ? 0 : 1),
        days_away: daysAway,
        is_today: daysAway === 0,
      };
    })
    .sort((a, b) => a.days_away - b.days_away);

  return c.json({ birthdays, days: month ? null : days });
});

function leap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

app.get("/api/dashboard/consultation", async (c) => {
  const id = intParam(c.req.query("patient_id"));
  if (!id) return c.json({ error: "patient_id is required" }, 400);

  const patient = await get<{
    id: number; first_name: string; last_name: string; date_of_birth: string | null;
    patient_gender: string | null; medical_alerts: string | null;
  }>("SELECT id, first_name, last_name, date_of_birth, patient_gender, medical_alerts FROM patients WHERE id = ?", [id]);
  if (!patient) return c.json({ error: "Patient not found" }, 404);

  const [lastAppt, conditions] = await Promise.all([
    get<{
      last_checked: string | null; observation: string | null;
      prescription: string | null;
      last_prescribed: string | null;
    }>(
      `SELECT
         (SELECT MAX(substr(start_time, 1, 10)) FROM appointments
          WHERE patient_id = ? AND status = 'completed') as last_checked,
         (SELECT body FROM clinical_notes WHERE patient_id = ? ORDER BY note_date DESC LIMIT 1) as observation,
         (SELECT GROUP_CONCAT(DISTINCT tc.condition) FROM tooth_conditions tc WHERE tc.patient_id = ?) as prescription,
         (SELECT MAX(issued_date) FROM prescriptions WHERE patient_id = ?) as last_prescribed`,
      [id, id, id, id],
    ),
    query<{ condition: string; n: number }>(
      "SELECT condition, COUNT(*) as n FROM tooth_conditions WHERE patient_id = ? GROUP BY condition",
      [id],
    ).catch(() => []),
  ]);

  return c.json({
    patient,
    last_checked: lastAppt?.last_checked ?? null,
    observation: lastAppt?.observation ?? null,
    prescription: lastAppt?.prescription ?? null,
    last_prescribed: lastAppt?.last_prescribed ?? null,
    conditions,
  });
});

// ── Dentist notes ──────────────────────────────────────────────────

const DentistNoteInput = z.object({
  body: z.string().min(1),
  pinned: z.boolean().optional(),
});

app.get("/api/dentist-notes", async (c) => {
  const rows = await query("SELECT * FROM dentist_notes ORDER BY pinned DESC, created_at DESC, id DESC")
    .catch(() => []);
  return c.json({ notes: rows });
});

app.post("/api/dentist-notes", async (c) => {
  const parsed = await parseJson(c, DentistNoteInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { body, pinned } = parsed.data;
  const result = await run(
    "INSERT INTO dentist_notes (body, pinned) VALUES (?, ?)",
    [body, pinned ? 1 : 0],
  );
  const row = await get("SELECT * FROM dentist_notes WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ note: row }, 201);
});

app.put("/api/dentist-notes/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, DentistNoteInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const sets: string[] = [];
  const params: unknown[] = [];
  if (parsed.data.body !== undefined) { sets.push("body = ?"); params.push(parsed.data.body); }
  if (parsed.data.pinned !== undefined) { sets.push("pinned = ?"); params.push(parsed.data.pinned ? 1 : 0); }
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE dentist_notes SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get("SELECT * FROM dentist_notes WHERE id = ?", [id]);
  return c.json({ note: row });
});

app.delete("/api/dentist-notes/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("DELETE FROM dentist_notes WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

/**
 * Settings whose raw values must never reach the browser. The server reads the
 * real values from the settings table directly; responses show a non-empty
 * placeholder so UI code can still tell "configured ✓" from "empty".
 */
const SECRET_SETTINGS = new Set(["storage_secret_access_key", "email_api_key", "gdrive_client_secret"]);

function redactSettings(out: Record<string, string>): Record<string, string> {
  for (const key of SECRET_SETTINGS) {
    if (out[key]) out[key] = "••••••••";
  }
  return out;
}

app.get("/api/settings", async (c) => {
  const rows = await query<{ key: string; value: string }>(
    "SELECT key, value FROM settings",
  ).catch(() => []);
  const out: Record<string, string> = { ...DEFAULT_SETTINGS, ...DEFAULT_PROFILE_SETTINGS, ...DEFAULT_BACKUP_SETTINGS, ...DEFAULT_INVENTORY_SETTINGS, ...DEFAULT_STORAGE_SETTINGS, gdrive_client_id: "", gdrive_client_secret: "", gdrive_folder_id: "", gdrive_enabled: "0" };
  for (const r of rows) out[r.key] = r.value;
  return c.json({ settings: redactSettings(out) });
});

app.put("/api/settings", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  if (!body || typeof body !== "object") return c.json({ error: "Body must be an object" }, 400);
  const entries = Object.entries(body as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null);
  for (const [key, value] of entries) {
    // The logo is the one setting that could smuggle markup into printed
    // documents — enforce the data-URL shape (empty string clears it).
    if (key === "clinic_logo" && value !== "" && !isSafeLogoDataUrl(value)) {
      return c.json({ error: "Logo must be an image data URL under 400 KB" }, 400);
    }
    // The payment QR (bKash/Nagad/bank… image the doctor sets) is printed on
    // its own sheet — same safety rules as the logo.
    if (key === "payment_qr" && value !== "" && !isSafeLogoDataUrl(value)) {
      return c.json({ error: "Payment QR must be an image data URL under 400 KB" }, 400);
    }
    // Invoice style must be one of the known sheet ids; accent must be a hex
    // color (it is inlined into printed documents). Both fall back to the
    // defaults silently in the renderer, but rejecting here keeps junk out.
    if (key === "invoice_style" && !INVOICE_STYLE_IDS.includes(value as (typeof INVOICE_STYLE_IDS)[number])) {
      return c.json({ error: "Unknown invoice style" }, 400);
    }
    if (key === "invoice_accent" && !/^#[0-9a-fA-F]{6}$/.test(String(value))) {
      return c.json({ error: "Accent must be a hex color like #0e7490" }, 400);
    }
    await run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      [key, String(value)],
    );
  }  const rows = await query<{ key: string; value: string }>("SELECT key, value FROM settings");
  const out: Record<string, string> = { ...DEFAULT_SETTINGS, ...DEFAULT_PROFILE_SETTINGS, ...DEFAULT_BACKUP_SETTINGS, ...DEFAULT_INVENTORY_SETTINGS, ...DEFAULT_STORAGE_SETTINGS, gdrive_client_id: "", gdrive_client_secret: "", gdrive_folder_id: "", gdrive_enabled: "0" };
  for (const r of rows) out[r.key] = r.value;
  return c.json({ settings: redactSettings(out) });
});




// ── Images & object storage (S3/R2, presigned URLs) ──────────────

/** Parse the JSON image-id list stored on a prescription defensively. */
function parseImageIds(raw: unknown): number[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((n) => Number.isInteger(n)).map(Number) : [];
  } catch {
    return [];
  }
}

/** Resolve image rows (with display URLs) from ids, newest first, ignoring deleted. */
async function resolveImageRows(ids: number[]): Promise<Array<Record<string, unknown>>> {
  if (!ids.length) return [];
  const rows = await query(
    `SELECT id, patient_id, appointment_id, file_key, file_name, mime_type, size_bytes,
            kind, label, compare_group, uploaded_at
     FROM patient_images
     WHERE id IN (${ids.map(() => "?").join(",")}) AND deleted = 0
     ORDER BY uploaded_at DESC, id DESC`,
    ids,
  ).catch(() => [] as Array<Record<string, unknown>>);
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const attachedIds = ids.filter((id) => byId.has(id));
  // Keep the order the doctor chose.
  const out: Array<Record<string, unknown>> = [];
  for (const id of attachedIds) {
    const r = byId.get(id)!;
    out.push({ ...r, url: await storageUrlForFile(String(r.file_key)) });
  }
  return out;
}

/** Store (or clear) the images attached to a prescription. Only images that
 *  belong to the same patient are accepted — never attach another patient's
 *  PHI to a sheet. */
async function attachPrescriptionImages(rxId: number, patientId: number, imageIds: number[] | undefined): Promise<void> {
  if (imageIds === undefined) return;
  let ids: number[] = [...new Set(imageIds)];
  if (ids.length) {
    const rows = await query<{ id: number }>(
      `SELECT id FROM patient_images
       WHERE id IN (${ids.map(() => "?").join(",")}) AND patient_id = ? AND deleted = 0`,
      [...ids, patientId],
    ).catch(() => [] as { id: number }[]);
    const valid = new Set(rows.map((r) => r.id));
    ids = ids.filter((i) => valid.has(i));
  }
  await run("UPDATE prescriptions SET image_ids = ? WHERE id = ?", [ids.length ? JSON.stringify(ids) : null, rxId]);
}

/** The patient is required for every image route — records are scoped to them. */
async function requirePatient(c: Context, id: number): Promise<boolean> {
  if (!id) return false;
  const p = await get("SELECT id FROM patients WHERE id = ?", [id]);
  return Boolean(p);
}

const ImageUploadRequest = z.object({
  files: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        type: z.string().max(128),
        size: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(24),
});

const ImageFinalizeInput = z.object({
  files: z
    .array(
      z.object({
        key: z.string().min(1).max(512),
        file_name: z.string().max(255).optional().nullable(),
        mime_type: z.string().min(1).max(128),
        size_bytes: z.number().int().min(0),
        kind: z.enum(IMAGE_KINDS).default("photo"),
        label: z.string().max(200).optional().nullable(),
        appointment_id: z.number().int().nullable().optional(),
        compare_group: z.string().max(64).nullable().optional(),
      }),
    )
    .min(1)
    .max(24),
});

const ImagePatchInput = z.object({
  kind: z.enum(IMAGE_KINDS).optional(),
  label: z.string().max(200).nullable().optional(),
  appointment_id: z.number().int().nullable().optional(),
  compare_group: z.string().max(64).nullable().optional(),
});

/** Issue short-lived presigned PUT URLs the browser uploads straight into. */
app.post("/api/patients/:id/images/uploads", async (c) => {
  const pid = intParam(c.req.param("id"));
  if (!(await requirePatient(c, pid ?? 0)) || !pid) return c.json({ error: "Patient not found" }, 404);
  const parsed = await parseJson(c, ImageUploadRequest);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const settings = await readStorageSettings();
  if (!isStorageConfigured(settings)) {
    return c.json(
      { error: "Image storage is turned off. Enable the built-in database storage or configure a bucket in Settings → Storage." },
      400,
    );
  }
  const dbMode = isDbStorage(settings);
  const maxBytes = (dbMode ? DB_STORAGE_MAX_MB : settings.maxFileMb) * 1024 * 1024;
  for (const f of parsed.data.files) {
    if (!IMAGE_MIME_TYPES.has(f.type) && !f.type.startsWith("image/")) {
      return c.json({ error: `"${f.name}": unsupported file type "${f.type}". Use an image file or DICOM.` }, 400);
    }
    if (f.size > maxBytes) {
      const limit = dbMode ? DB_STORAGE_MAX_MB : settings.maxFileMb;
      return c.json(
        { error: `"${f.name}" is ${(f.size / 1024 / 1024).toFixed(1)} MB — the limit is ${limit} MB${dbMode ? " for built-in database storage (configure a bucket for bigger files)" : ""}.` },
        413,
      );
    }
  }

  const uploads: Array<{ key: string; upload_url: string; headers: Record<string, string>; expires_at: string }> = [];
  for (const f of parsed.data.files) {
    const key = newObjectKey(pid, f.name);
    const signed = await presignUpload(key);
    if (!signed) return c.json({ error: "Storage is not configured." }, 400);
    uploads.push({
      key,
      upload_url: signed.url,
      headers: signed.headers,
      expires_at: new Date(Date.now() + settings.expiryMinutes * 60_000).toISOString(),
    });
  }
  return c.json({ uploads });
});

/**
 * Built-in DB storage tier. The browser uploads the raw bytes here; the key is
 * the unguessable object key the uploads route issued (scoped to one patient).
 */
app.put("/api/image-file", async (c) => {
  const key = c.req.query("key") ?? "";
  if (!key || !key.startsWith("patients/")) return c.json({ error: "Invalid file key." }, 400);
  // The upload URL is only issued by /uploads when provider == "db", but let a
  // leftover db-mode upload target stay usable after a bucket is configured.
  const settings = await readStorageSettings();
  if (!isDbStorage(settings)) return c.json({ error: "DB storage is not the active provider." }, 405);

  const body = await c.req.arrayBuffer().catch(() => null);
  const bytes = body ? new Uint8Array(body) : null;
  if (!bytes || bytes.byteLength === 0) return c.json({ error: "Empty body." }, 400);
  const maxBytes = DB_STORAGE_MAX_MB * 1024 * 1024;
  if (bytes.byteLength > maxBytes) {
    return c.json(
      { error: `File is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — the limit for database storage is ${DB_STORAGE_MAX_MB} MB.` },
      413,
    );
  }
  const mime = (c.req.header("content-type") ?? "application/octet-stream").split(";")[0].trim();
  await run(
    `INSERT INTO patient_image_blobs (file_key, mime_type, data) VALUES (?, ?, ?)
     ON CONFLICT(file_key) DO UPDATE SET mime_type = excluded.mime_type, data = excluded.data, created_at = datetime('now')`,
    [key, mime, bytes],
  );
  return c.json({ ok: true }, 201);
});

/** Serve a blob stored in the database (same origin — safe for print/Pdf). */
app.get("/api/image-file", async (c) => {
  const key = c.req.query("key") ?? "";
  const row = await get<{ mime_type: string; data: ArrayBuffer | number[] }>(
    "SELECT mime_type, data FROM patient_image_blobs WHERE file_key = ?",
    [key],
  );
  if (!row) return c.json({ error: "Not found" }, 404);
  // Different runtimes materialize BLOB columns differently: production D1
  // returns an ArrayBuffer, Miniflare (tests / offline dev) returns a plain
  // number[]. Normalize both to a real byte body.
  const bytes = row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : Uint8Array.from(row.data);
  return new Response(bytes as BodyInit, {
    headers: {
      "Content-Type": row.mime_type,
      "Cache-Control": "private, max-age=3600",
    },
  });
});

/** Register the metadata for files the browser just uploaded. */
app.post("/api/patients/:id/images", async (c) => {
  const pid = intParam(c.req.param("id"));
  if (!(await requirePatient(c, pid ?? 0)) || !pid) return c.json({ error: "Patient not found" }, 404);
  const parsed = await parseJson(c, ImageFinalizeInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const created: Array<Record<string, unknown>> = [];
  for (const f of parsed.data.files) {
    if (!f.key.startsWith(`patients/${pid}/`)) {
      return c.json({ error: "Refusing a file key that isn't scoped to this patient." }, 400);
    }
    if (!IMAGE_MIME_TYPES.has(f.mime_type) && !f.mime_type.startsWith("image/")) {
      return c.json({ error: `Unsupported file type "${f.mime_type}".` }, 400);
    }
    const r = await run(
      `INSERT INTO patient_images
         (patient_id, appointment_id, file_key, file_name, mime_type, size_bytes, kind, label, compare_group, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'))`,
      [
        pid,
        f.appointment_id ?? null,
        f.key,
        f.file_name ?? null,
        f.mime_type,
        f.size_bytes,
        f.kind,
        f.label ?? null,
        f.compare_group ?? null,
      ],
    );
    const row = await get(
      `SELECT id, patient_id, appointment_id, file_key, file_name, mime_type, size_bytes,
              kind, label, compare_group, uploaded_at
       FROM patient_images WHERE id = ?`,
      [Number(r.lastInsertRowid)],
    );
    if (row) created.push({ ...row, url: await storageUrlForFile(String(row.file_key)) });
  }
  return c.json({ images: created }, 201);
});

app.get("/api/patients/:id/images", async (c) => {
  const pid = intParam(c.req.param("id"));
  if (!(await requirePatient(c, pid ?? 0)) || !pid) return c.json({ error: "Patient not found" }, 404);
  const kind = c.req.query("kind");
  const params: unknown[] = [pid];
  let kindClause = "";
  if (kind && IMAGE_KINDS.includes(kind as never)) {
    kindClause = "AND kind = ?";
    params.push(kind);
  }
  const rows = await query(
    `SELECT id, patient_id, appointment_id, file_key, file_name, mime_type, size_bytes,
            kind, label, compare_group, uploaded_at
     FROM patient_images
     WHERE patient_id = ? AND deleted = 0 ${kindClause}
     ORDER BY uploaded_at DESC, id DESC`,
    params,
  ).catch(() => [] as Array<Record<string, unknown>>);
  const settings = await readStorageSettings();
  const images = [];
  for (const r of rows) {
    images.push({ ...r, url: await storageUrlForFile(String(r.file_key)) });
  }
  return c.json({
    images,
    storage: {
      enabled: isStorageConfigured(settings),
      provider: settings.provider,
      max_file_mb: isDbStorage(settings) ? DB_STORAGE_MAX_MB : settings.maxFileMb,
    },
  });
});

app.patch("/api/images/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, ImagePatchInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const existing = await get("SELECT id FROM patient_images WHERE id = ? AND deleted = 0", [id]);
  if (!existing) return c.json({ error: "Not found" }, 404);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of ["kind", "label", "appointment_id", "compare_group"] as const) {
    if (d[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(d[key] ?? null);
    }
  }
  if (sets.length) {
    params.push(id);
    await run(`UPDATE patient_images SET ${sets.join(", ")} WHERE id = ?`, params);
  }
  const row = await get(
    `SELECT id, patient_id, appointment_id, file_key, file_name, mime_type, size_bytes,
            kind, label, compare_group, uploaded_at
     FROM patient_images WHERE id = ?`,
    [id],
  );
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ image: { ...row, url: await storageUrlForFile(String(row.file_key)) } });
});

/** Soft-delete: keeps the row (and anything referencing it) intact for audit. */
app.delete("/api/images/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("UPDATE patient_images SET deleted = 1 WHERE id = ? AND deleted = 0", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

/**
 * Auto-fill context for the prescription form: the tooth the patient is being
 * treated on right now (latest open plan item) and their recent X-ray images,
 * so the doctor can attach them without digging through the gallery.
 */
app.get("/api/patients/:id/prescription-context", async (c) => {
  const pid = intParam(c.req.param("id"));
  if (!(await requirePatient(c, pid ?? 0)) || !pid) return c.json({ error: "Patient not found" }, 404);

  const planned = await get<{ tooth: string }>(
    `SELECT tooth FROM treatment_plan_items
     WHERE patient_id = ? AND tooth IS NOT NULL AND tooth != '' AND status IN ('planned', 'accepted')
     ORDER BY id DESC LIMIT 1`,
    [pid],
  );
  const anyTooth = planned ?? (await get<{ tooth: string }>(
    `SELECT tooth FROM treatment_plan_items
     WHERE patient_id = ? AND tooth IS NOT NULL AND tooth != ''
     ORDER BY id DESC LIMIT 1`,
    [pid],
  ));

  const settings = await readStorageSettings();
  const rows = await query(
    `SELECT id, patient_id, appointment_id, file_key, file_name, mime_type, size_bytes,
            kind, label, compare_group, uploaded_at
     FROM patient_images
     WHERE patient_id = ? AND deleted = 0 AND kind != 'photo'
     ORDER BY uploaded_at DESC, id DESC LIMIT 8`,
    [pid],
  ).catch(() => [] as Array<Record<string, unknown>>);
  const images = [];
  for (const r of rows) {
    images.push({ ...r, url: await storageUrlForFile(String(r.file_key)) });
  }
  return c.json({ tooth: anyTooth?.tooth ?? null, images, storage: { enabled: isStorageConfigured(settings) } });
});

// ── Storage configuration (Settings → Storage) ────────────────────

app.get("/api/storage/config", async (c) => c.json(await storageStatus()));

const StorageInput = z.object({
  provider: z.enum(["none", "db", "s3", "r2"]),
  endpoint: z.string().max(512).optional(),
  region: z.string().max(64).optional(),
  bucket: z.string().max(255).optional(),
  access_key_id: z.string().max(255).optional(),
  // Empty / the masked placeholder = keep the stored secret.
  secret_access_key: z.string().max(512).optional(),
  keep_secret: z.boolean().optional(),
  public_base_url: z.string().max(512).optional().nullable(),
  expiry_minutes: z.number().int().min(1).max(60).optional(),
  max_file_mb: z.number().int().min(1).max(200).optional(),
});

app.put("/api/storage/config", async (c) => {
  const parsed = await parseJson(c, StorageInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const err = validateStorageInput({ ...d, keep_secret: d.keep_secret });
  if (err) return c.json({ error: err }, 400);

  const entries: Array<[string, string | null]> = [
    ["storage_provider", d.provider],
    ["storage_endpoint", d.endpoint ?? ""],
    ["storage_region", d.region ?? ""],
    ["storage_bucket", d.bucket ?? ""],
    ["storage_access_key_id", d.access_key_id ?? ""],
    ["storage_public_base_url", d.public_base_url ?? ""],
  ];
  if (d.expiry_minutes !== undefined) entries.push(["storage_expiry_minutes", String(d.expiry_minutes)]);
  if (d.max_file_mb !== undefined) entries.push(["storage_max_file_mb", String(d.max_file_mb)]);

  const secret = (d.secret_access_key ?? "").trim();
  if (secret && secret !== "••••••••") entries.push(["storage_secret_access_key", secret]);
  else if (d.provider === "none") entries.push(["storage_secret_access_key", ""]);

  for (const [key, value] of entries) {
    await run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      [key, value ?? ""],
    );
  }
  return c.json(await storageStatus());
});

// ── Inventory (stock control & supplier tracking) ────────────────

const InventoryItemInput = z.object({
  name: z.string().min(1),
  category: z.string().optional().nullable(),
  sku: z.string().optional().nullable(),
  unit: z.string().optional(),
  current_stock: z.number().int().min(0).optional(),
  min_threshold: z.number().int().min(0).optional(),
  reorder_quantity: z.number().int().min(1).optional().nullable(),
  supplier_name: z.string().optional().nullable(),
  supplier_contact: z.string().optional().nullable(),
  batch_number: z.string().optional().nullable(),
  expiry_date: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  unit_cost: z.number().min(0).optional(),
  notes: z.string().optional().nullable(),
});

// Fall back to [] when the inventory tables don't exist yet (pre-migration
// dev DB), the same way the insurance/lab routes do.
const safeQueryItems = <T,>(sql: string, params: unknown[] = []): Promise<T[]> =>
  query<T>(sql, params).catch(() => [] as T[]);

app.get("/api/inventory", async (c) => {
  const q = c.req.query("q")?.trim().toLowerCase();
  const status = c.req.query("status");
  const category = c.req.query("category");
  // TODO could be a query param later; every item with an expiry_date is checked.
  let where = "active = 1";
  const params: unknown[] = [];
  if (q) {
    // Filter the already-meterialized rows in JS — FTS handles the "did you
    // mean" global search already. A LIKE on a few hundred rows is fine.
    where += " AND (name LIKE ? OR sku LIKE ? OR supplier_name LIKE ? OR batch_number LIKE ? OR category LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  if (category) { where += " AND COALESCE(category,'') = ?"; params.push(category); }
  let rows = await safeQueryItems<InventoryItemRow>(
    `SELECT * FROM inventory_items WHERE ${where} ORDER BY name COLLATE NOCASE`,
    params,
  );
  // status filter in JS: today's date for the expiry window is fetched with the items.
  if (status) {
    const today = new Date().toISOString().slice(0, 10);
    const { expiryDays } = await getInventorySettings();
    const cutoff = datePlusDays(today, expiryDays);
    rows = rows.filter((it) => {
      if (status === "out_of_stock") return it.current_stock === 0;
      if (status === "low_stock") return it.current_stock > 0 && it.current_stock <= it.min_threshold;
      if (status === "expiring") return it.expiry_date != null && it.expiry_date > today && it.expiry_date <= cutoff;
      if (status === "expired") return it.expiry_date != null && it.expiry_date <= today;
      return true;
    });
  }
  return c.json({ items: rows, categories: INVENTORY_CATEGORIES });
});

// Registered before the /inventory/:id routes so the static segment wins.
app.get("/api/inventory/settings", async (c) => {
  const { expiryDays, alertEmail } = await getInventorySettings();
  return c.json({ settings: { inventory_expiry_alert_days: String(expiryDays), inventory_alert_email: alertEmail } });
});

app.put("/api/inventory/settings", async (c) => {
  const parsed = await parseJson(
    c,
    z.object({
      inventory_expiry_alert_days: z.number().int().min(0).max(3650).optional(),
      inventory_alert_email: z.string().email().optional().or(z.literal("")),
    }),
  );
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const updates: [string, string][] = [];
  if (parsed.data.inventory_expiry_alert_days !== undefined) updates.push(["inventory_expiry_alert_days", String(parsed.data.inventory_expiry_alert_days)]);
  if (parsed.data.inventory_alert_email !== undefined) updates.push(["inventory_alert_email", parsed.data.inventory_alert_email.trim()]);
  for (const [key, value] of updates) {
    await run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }
  const { expiryDays, alertEmail } = await getInventorySettings();
  return c.json({ settings: { inventory_expiry_alert_days: String(expiryDays), inventory_alert_email: alertEmail } });
});

app.post("/api/inventory", async (c) => {
  const parsed = await parseJson(c, InventoryItemInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const result = await run(
    `INSERT INTO inventory_items
       (name, category, sku, unit, current_stock, min_threshold, reorder_quantity,
        supplier_name, supplier_contact, batch_number, expiry_date, location, unit_cost, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      d.name.trim(), d.category?.trim() || null, d.sku?.trim() || null, d.unit ?? "piece",
      d.current_stock ?? 0, d.min_threshold ?? 0, d.reorder_quantity ?? null,
      d.supplier_name?.trim() || null, d.supplier_contact?.trim() || null, d.batch_number?.trim() || null,
      d.expiry_date || null, d.location?.trim() || null, d.unit_cost ?? 0, d.notes?.trim() || null,
    ],
  );
  const item = await get(
    "SELECT * FROM inventory_items WHERE id = ?", [result.lastInsertRowid],
  );
  return c.json({ item }, 201);
});

app.put("/api/inventory/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, InventoryItemInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    // Blank strings are cleared to NULL for the free-text fields.
    const normalized = ["category", "sku", "supplier_name", "supplier_contact", "batch_number", "expiry_date", "location", "notes", "unit"]
      .includes(k) && typeof v === "string" && v.trim() === "" ? null : v;
    sets.push(`${k} = ?`);
    params.push(normalized);
  }
  sets.push("updated_at = datetime('now')");
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  params.push(id);
  const r = await run(`UPDATE inventory_items SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const item = await get("SELECT * FROM inventory_items WHERE id = ?", [id]);
  return c.json({ item });
});

app.delete("/api/inventory/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run("UPDATE inventory_items SET active = 0, updated_at = datetime('now') WHERE id = ?", [id]);
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

/** Reports a stock movement and keeps `current_stock` in sync. */
async function applyMovement(
  id: number,
  type: "in" | "out" | "adjust",
  quantity: number,
  balanceAfter: number,
  opts: Record<string, unknown>,
): Promise<boolean> {
  const r = await run(
    `INSERT INTO inventory_movements (item_id, type, quantity, balance_after, unit_cost, reference, reason, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, type, quantity, balanceAfter, opts.unit_cost ?? null, opts.reference ?? null, opts.reason ?? null, opts.notes ?? null],
  );
  if (!r.changes) return false;
  await run("UPDATE inventory_items SET current_stock = ?, updated_at = datetime('now') WHERE id = ?", [balanceAfter, id]);
  return true;
}

const StockInInput = z.object({
  quantity: z.number().int().positive(),
  unit_cost: z.number().min(0).optional().nullable(),
  reference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const StockOutInput = z.object({
  quantity: z.number().int().positive(),
  reason: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  allow_negative: z.boolean().optional(),
  notes: z.string().optional().nullable(),
});

const AdjustInput = z.object({
  new_stock: z.number().int().min(0),
  reason: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

app.post("/api/inventory/:id/stock-in", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, StockInInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const item = await get<InventoryItemRow>("SELECT * FROM inventory_items WHERE id = ? AND active = 1", [id]);
  if (!item) return c.json({ error: "Item not found" }, 404);
  const qty = parsed.data.quantity;
  const balance = (item.current_stock ?? 0) + qty;
  // Restock also refreshes the unit cost used for valuation.
  if (parsed.data.unit_cost != null) {
    await run("UPDATE inventory_items SET unit_cost = ?, updated_at = datetime('now') WHERE id = ?", [parsed.data.unit_cost, id]);
  }
  await applyMovement(id, "in", qty, balance, parsed.data);
  const updated = await get("SELECT * FROM inventory_items WHERE id = ?", [id]);
  return c.json({ item: updated, movement: { item_id: id, type: "in", quantity: qty, balance_after: balance } }, 201);
});

app.post("/api/inventory/:id/stock-out", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, StockOutInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const item = await get<InventoryItemRow>("SELECT * FROM inventory_items WHERE id = ? AND active = 1", [id]);
  if (!item) return c.json({ error: "Item not found" }, 404);
  const qty = parsed.data.quantity;
  const balance = (item.current_stock ?? 0) - qty;
  if (balance < 0 && !parsed.data.allow_negative) {
    return c.json({ error: `Only ${item.current_stock} ${item.unit} in stock — can't issue ${qty}. Enable “allow negative” to oversell.` }, 400);
  }
  await applyMovement(id, "out", qty, balance, parsed.data);
  const updated = await get("SELECT * FROM inventory_items WHERE id = ?", [id]);
  return c.json({ item: updated, movement: { item_id: id, type: "out", quantity: qty, balance_after: balance } }, 201);
});

app.post("/api/inventory/:id/adjust", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, AdjustInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const item = await get<InventoryItemRow>("SELECT * FROM inventory_items WHERE id = ? AND active = 1", [id]);
  if (!item) return c.json({ error: "Item not found" }, 404);
  const delta = parsed.data.new_stock - (item.current_stock ?? 0);
  await applyMovement(id, "adjust", Math.abs(delta), parsed.data.new_stock, parsed.data);
  const updated = await get("SELECT * FROM inventory_items WHERE id = ?", [id]);
  return c.json({ item: updated }, 201);
});

app.get("/api/inventory/:id/movements", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const rows = await safeQueryItems<Record<string, unknown>>(
    "SELECT * FROM inventory_movements WHERE item_id = ? ORDER BY performed_at DESC, id DESC LIMIT 200",
    [id],
  );
  return c.json({ movements: rows });
});

// Open alerts (resolved = 0) joined with item names; lives before the :id rule
// is irrelevant — nested path, static segment wins.
app.get("/api/inventory/alerts", async (c) => {
  const rows = await safeQueryItems<Record<string, unknown>>(
    `SELECT a.*, i.name as item_name
     FROM inventory_alerts a LEFT JOIN inventory_items i ON i.id = a.item_id
     WHERE a.resolved = 0
     ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.id DESC`,
  );
  return c.json({ alerts: rows });
});

app.post("/api/inventory/alerts/:id/resolve", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const r = await run(
    "UPDATE inventory_alerts SET resolved = 1, resolved_at = datetime('now') WHERE id = ? AND resolved = 0",
    [id],
  );
  if (!r.changes) return c.json({ error: "Not found" }, 404);
  const row = await get(
    `SELECT a.*, i.name as item_name FROM inventory_alerts a LEFT JOIN inventory_items i ON i.id = a.item_id WHERE a.id = ?`,
    [id],
  );
  return c.json({ alert: row });
});

// The daily scan: rebuild the open-alert set from the current stock/expiry
// state. Client-orchestrated (see use-daily-inventory-scan), but also callable
// from a cron trigger later or the "Scan now" button.
app.post("/api/inventory/scan", async (c) => {
  const result = await runInventoryScan();
  return c.json(result, 200);
});

// ── Search ────────────────────────────────────────────────────────

app.get("/api/search", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  if (!q) return c.json({ hits: [], via: "fts5" });
  const limitParam = intParam(c.req.query("limit") ?? undefined);
  const limit = limitParam ? Math.min(limitParam, 100) : 60;
  const { hits, via } = await searchAll(q, limit);
  return c.json({ hits, via });
});

// Manual full rebuild of the search index (recovery from drift or corruption).
app.post("/api/search/reindex", async (c) => {
  const counts = await reindexSearchIndex();
  return c.json({ ok: true, counts });
});

// ── Health ─────────────────────────────────────────────────

app.get("/api/health", (c) => c.json({ ok: true }));

// ── Online booking (public self-scheduling) ─────────────────
//
// The practice issues booking links (with a random token); patients open
// the public page /book/<token>, pick a free slot from real availability,
// and the appointment lands on the agenda as 'scheduled' + a booking_request
// audit row. The token grants access ONLY to availability + booking — no
// patient list, no settings, nothing else.

function newBookingToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A prescription share token: 20 random bytes, hex-encoded (40 chars). Long
 * enough that guessing one is infeasible, short enough to paste into a text. */
function newPrescriptionShareToken(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const BookingLinkInput = z.object({
  label: z.string().min(1).max(80).optional(),
  practitioner_id: z.number().int().positive().nullable().optional(),
  treatment_type_id: z.number().int().positive().nullable().optional(),
  days_ahead: z.number().int().min(1).max(60).optional(),
  active: z.boolean().optional(),
});

app.get("/api/booking/links", async (c) => {
  await ensureMigrated();
  const rows = await query<{
    id: number; token: string; label: string; practitioner_id: number | null;
    practitioner_name: string | null; treatment_type_id: number | null;
    treatment_name: string | null; days_ahead: number; active: number; created_at: string;
  }>(
    `SELECT b.*, pr.name AS practitioner_name, tt.name AS treatment_name
     FROM booking_links b
     LEFT JOIN practitioners pr ON pr.id = b.practitioner_id
     LEFT JOIN treatment_types tt ON tt.id = b.treatment_type_id
     ORDER BY b.created_at DESC`,
  );
  return c.json({ links: rows });
});

app.post("/api/booking/links", async (c) => {
  await ensureMigrated();
  const parsed = await parseJson(c, BookingLinkInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const token = newBookingToken();
  const result = await run(
    `INSERT INTO booking_links (token, label, practitioner_id, treatment_type_id, days_ahead, active)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [token, d.label ?? "Online booking", d.practitioner_id ?? null, d.treatment_type_id ?? null, d.days_ahead ?? 14, d.active === false ? 0 : 1],
  );
  const row = await get("SELECT * FROM booking_links WHERE id = ?", [result.lastInsertRowid]);
  return c.json({ link: row }, 201);
});

app.put("/api/booking/links/:id", async (c) => {
  await ensureMigrated();
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  const parsed = await parseJson(c, BookingLinkInput.partial());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (v !== undefined) { sets.push(`${k} = ?`); params.push(typeof v === "boolean" ? (v ? 1 : 0) : v); }
  }
  if (!sets.length) return c.json({ error: "Nothing to update" }, 400);
  params.push(id);
  const res = await run(`UPDATE booking_links SET ${sets.join(", ")} WHERE id = ?`, params);
  if (res.changes === 0) return c.json({ error: "Not found" }, 404);
  const row = await get("SELECT * FROM booking_links WHERE id = ?", [id]);
  return c.json({ link: row });
});

app.delete("/api/booking/links/:id", async (c) => {
  await ensureMigrated();
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);
  await run("DELETE FROM booking_links WHERE id = ?", [id]);
  return c.json({ ok: true });
});

// ── Public booking API (token-authed, no patient data exposure) ──

interface BookingLinkRow {
  id: number; token: string; label: string; practitioner_id: number | null;
  treatment_type_id: number | null; days_ahead: number; active: number;
}

async function loadActiveBookingLink(token: string): Promise<BookingLinkRow | null> {
  return (await get<BookingLinkRow>("SELECT * FROM booking_links WHERE token = ? AND active = 1", [token])) ?? null;
}

app.get("/api/public/booking/:token", async (c) => {
  await ensureSeeded();
  const link = await loadActiveBookingLink(c.req.param("token"));
  if (!link) return c.json({ error: "This booking link is not available" }, 404);
  // Public page payload: clinic identity + bookable treatment menu only.
  const clinic = await get<{ clinic_name: string; clinic_address: string; doctor_name: string }>(
    `SELECT MAX(CASE WHEN key='clinic_name' THEN value END) AS clinic_name,
            MAX(CASE WHEN key='clinic_address' THEN value END) AS clinic_address,
            MAX(CASE WHEN key='doctor_name' THEN value END) AS doctor_name
     FROM settings`,
  );
  const treatments = await query<{ id: number; name: string; duration_minutes: number; default_fee: number }>(
    link.treatment_type_id
      ? "SELECT id, name, duration_minutes, default_fee FROM treatment_types WHERE id = ?"
      : "SELECT id, name, duration_minutes, default_fee FROM treatment_types ORDER BY name",
    link.treatment_type_id ? [link.treatment_type_id] : [],
  );
  return c.json({
    label: link.label,
    clinic_name: clinic?.clinic_name || "Dental Canvas",
    clinic_address: clinic?.clinic_address || "",
    doctor_name: clinic?.doctor_name || "",
    practitioner_name: link.practitioner_id
      ? (await get<{ name: string }>("SELECT name FROM practitioners WHERE id = ?", [link.practitioner_id]))?.name ?? null
      : null,
    treatments,
    days_ahead: link.days_ahead,
  });
});

/**
 * Free slots for a date: the practice's configured day window sliced into
 * slot steps, minus booked/blocked time in the target operatory. Operatory
 * choice: the link's practitioner's usual room, else the first operatory.
 */
app.get("/api/public/booking/:token/slots", async (c) => {
  await ensureSeeded();
  const link = await loadActiveBookingLink(c.req.param("token"));
  if (!link) return c.json({ error: "This booking link is not available" }, 404);
  const date = c.req.query("date") ?? "";
  const treatmentId = intParam(c.req.query("treatment_id") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "Invalid date" }, 400);

  const dayStart = new Date(Date.now()).toISOString().slice(0, 10);
  if (date < dayStart) return c.json({ slots: [] });
  const maxDate = new Date(Date.now() + link.days_ahead * 86_400_000).toISOString().slice(0, 10);
  if (date > maxDate) return c.json({ slots: [], past_window: true });

  const settingsRows = await query<{ key: string; value: string }>(
    "SELECT key, value FROM settings WHERE key IN ('day_start_minute','day_end_minute','slot_minutes')",
  );
  const setting = (k: string, dflt: number) => {
    const n = parseInt(settingsRows.find((r) => r.key === k)?.value ?? "", 10);
    return Number.isFinite(n) ? n : dflt;
  };
  const dayStartMin = setting("day_start_minute", 420);
  const dayEndMin = setting("day_end_minute", 1140);
  const slotMin = Math.max(5, setting("slot_minutes", 15));

  const treatment = treatmentId
    ? await get<{ duration_minutes: number }>("SELECT duration_minutes FROM treatment_types WHERE id = ?", [treatmentId])
    : null;
  const duration = Math.max(slotMin, treatment?.duration_minutes ?? 30);

  // Sunday = closed (0); Saturday uses the standard window.
  if (new Date(`${date}T12:00:00Z`).getUTCDay() === 0) return c.json({ slots: [] });

  const operatory = link.practitioner_id
    ? (await get<{ id: number }>(
        "SELECT o.id FROM operatories o LEFT JOIN practitioners p ON p.id = ? ORDER BY o.sort_order LIMIT 1",
        [link.practitioner_id],
      ) ?? (await get<{ id: number }>("SELECT id FROM operatories ORDER BY sort_order LIMIT 1")))
    : await get<{ id: number }>("SELECT id FROM operatories ORDER BY sort_order LIMIT 1");
  if (!operatory) return c.json({ error: "No operatory configured" }, 400);

  const busy = await query<{ start_time: string; end_time: string }>(
    `SELECT start_time, end_time FROM appointments
     WHERE operatory_id = ? AND substr(start_time, 1, 10) = ?
       AND status NOT IN ('cancelled', 'no_show')
     ORDER BY start_time`,
    [operatory.id, date],
  );

  const slots: { time: string; label: string }[] = [];
  for (let m = dayStartMin; m + duration <= dayEndMin; m += slotMin) {
    const start = `${date}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;
    const end = `${date}T${String(Math.floor((m + duration) / 60)).padStart(2, "0")}:${String((m + duration) % 60).padStart(2, "0")}:00`;
    const clash = busy.some((b) => start < b.end_time && end > b.start_time);
    if (!clash) {
      const h12 = ((Math.floor(m / 60) + 11) % 12) + 1;
      const ampm = Math.floor(m / 60) < 12 ? "am" : "pm";
      slots.push({ time: start, label: `${h12}:${String(m % 60).padStart(2, "0")} ${ampm}` });
    }
  }
  return c.json({ slots, operatory_id: operatory.id, duration });
});

const PublicBookingInput = z.object({
  first_name: z.string().min(1).max(60),
  last_name: z.string().min(1).max(60),
  phone: z.string().max(30).optional(),
  email: z.string().max(120).optional(),
  start_time: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
  treatment_type_id: z.number().int().positive().nullable().optional(),
  notes: z.string().max(500).optional(),
});

app.post("/api/public/booking/:token", async (c) => {
  await ensureSeeded();
  const link = await loadActiveBookingLink(c.req.param("token"));
  if (!link) return c.json({ error: "This booking link is not available" }, 404);
  const parsed = await parseJson(c, PublicBookingInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;

  // Slot re-validation happens against live conflicts below; opening-hours
  // checks run first so a bad submit fails fast.
  const settingsRows = await query<{ key: string; value: string }>(
    "SELECT key, value FROM settings WHERE key IN ('day_start_minute','day_end_minute')",
  );
  const dayStartMin = parseInt(settingsRows.find((r) => r.key === "day_start_minute")?.value ?? "420", 10) || 420;
  const dayEndMin = parseInt(settingsRows.find((r) => r.key === "day_end_minute")?.value ?? "1140", 10) || 1140;

  const treatment = d.treatment_type_id
    ? await get<{ duration_minutes: number }>("SELECT duration_minutes FROM treatment_types WHERE id = ?", [d.treatment_type_id])
    : null;
  const duration = treatment?.duration_minutes ?? 30;

  const startDate = d.start_time.slice(0, 10);
  const minutesOfDay = parseInt(d.start_time.slice(11, 13), 10) * 60 + parseInt(d.start_time.slice(14, 16), 10);
  if (d.start_time.slice(19) !== "" || minutesOfDay < dayStartMin || minutesOfDay + duration > dayEndMin) {
    return c.json({ error: "That time is outside opening hours" }, 400);
  }
  const endDate = `${startDate}T${String(Math.floor((minutesOfDay + duration) / 60)).padStart(2, "0")}:${String((minutesOfDay + duration) % 60).padStart(2, "0")}:00`;

  const operatory = link.practitioner_id
    ? ((await get<{ id: number }>(
        "SELECT o.id FROM operatories o ORDER BY o.sort_order LIMIT 1",
      )) ?? null)
    : (await get<{ id: number }>("SELECT id FROM operatories ORDER BY sort_order LIMIT 1")) ?? null;
  if (!operatory) return c.json({ error: "No operatory configured" }, 400);

  const conflict = await findAppointmentConflict(operatory.id, d.start_time, endDate, {
    practitionerId: link.practitioner_id,
    patientKind: true,
  });
  if (conflict) return c.json({ error: "Sorry, that slot was just taken — please pick another." }, 409);

  // Find or create the patient (match on phone, then email, then name).
  let patientId: number | null = null;
  if (d.phone) {
    const existing = await get<{ id: number }>("SELECT id FROM patients WHERE phone = ? LIMIT 1", [d.phone]);
    patientId = existing?.id ?? null;
  }
  if (!patientId && d.email) {
    const existing = await get<{ id: number }>("SELECT id FROM patients WHERE email = ? LIMIT 1", [d.email]);
    patientId = existing?.id ?? null;
  }
  if (!patientId) {
    const result = await run(
      "INSERT INTO patients (first_name, last_name, phone, email) VALUES (?, ?, ?, ?)",
      [d.first_name, d.last_name, d.phone ?? null, d.email ?? null],
    );
    patientId = Number(result.lastInsertRowid);
  }

  const appt = await run(
    `INSERT INTO appointments (patient_id, practitioner_id, operatory_id, treatment_type_id, start_time, end_time, status, kind, notes)
     VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 'patient', ?)`,
    [patientId, link.practitioner_id, operatory.id, d.treatment_type_id ?? link.treatment_type_id ?? null, d.start_time, endDate, d.notes ?? null],
  );
  await run(
    `INSERT INTO booking_requests (link_id, appointment_id, first_name, last_name, phone, email, start_time, treatment_type_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [link.id, appt.lastInsertRowid, d.first_name, d.last_name, d.phone ?? null, d.email ?? null, d.start_time, d.treatment_type_id ?? null],
  );
  return c.json({ ok: true, appointment_id: appt.lastInsertRowid }, 201);
});

// ── Cloud sync bookkeeping (see src/server/sync.ts) ─────────────────
// These endpoints expose the local outbox/snapshot/apply surface. They never
// talk to Supabase themselves: the browser owns the auth session and pushes
// with the anon key + RLS.

app.get("/api/sync/meta", async (c) => {
  return c.json(await getSyncMeta());
});

const ClaimInput = z.object({ user_id: z.string().min(10) });

app.post("/api/sync/claim", async (c) => {
  const parsed = await parseJson(c, ClaimInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const result = await claimSyncOwner(parsed.data.user_id);
  if (!result.ok) {
    return c.json(
      {
        error:
          "This device already holds data linked to a different account. Sign out and remove local data first, or use the original account.",
        code: result.reason,
        owner_user_id: result.owner_user_id,
      },
      409,
    );
  }
  return c.json(result);
});

app.post("/api/sync/release", async (c) => {
  await releaseSyncOwner();
  return c.json({ ok: true });
});

// Explicit account deletion only: unclaim the device while keeping its rows.
app.post("/api/sync/forget", async (c) => {
  await forgetSyncOwner();
  return c.json({ ok: true });
});

app.get("/api/sync/pending", async (c) => {
  const limit = Math.min(Math.max(intParam(c.req.query("limit")) ?? 250, 1), 1000);
  return c.json(await getPendingChanges(limit));
});

const AckInput = z.object({
  ids: z.array(z.number().int().nonnegative()).max(2000),
  pushed: z.boolean().optional(),
});

app.post("/api/sync/ack", async (c) => {
  const parsed = await parseJson(c, AckInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  await ackChanges(parsed.data.ids, parsed.data.pushed !== false);
  return c.json({ ok: true });
});

app.get("/api/sync/snapshot", async (c) => {
  const entity = c.req.query("entity") ?? "";
  if (!syncTable(entity)) return c.json({ error: `Unknown sync table: ${entity}` }, 400);
  const after = Math.max(intParam(c.req.query("after")) ?? 0, 0);
  const limit = Math.min(Math.max(intParam(c.req.query("limit")) ?? 250, 1), 1000);
  return c.json(await getSnapshotChunk(entity, after, limit));
});

const ApplyInput = z.object({
  changes: z
    .array(
      z.object({
        entity: z.string().min(1),
        op: z.enum(["upsert", "delete"]),
        row: z.record(z.unknown()).optional(),
      }),
    )
    .max(1000),
  push: z.boolean().optional(),
  cursors: z
    .record(
      z.object({
        updated_at: z.string().min(1),
        sync_id: z.string().nullable(),
      }),
    )
    .optional(),
});

app.post("/api/sync/apply", async (c) => {
  const parsed = await parseJson(c, ApplyInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const result = await applyRemoteChanges(parsed.data.changes, {
    push: parsed.data.push === true,
    cursors: parsed.data.cursors,
  });
  return c.json(result);
});

const ConflictInput = z.object({
  entity: z.string().min(1),
  sync_id: z.string().nullable(),
  resolution: z.string().min(1),
  local: z.unknown().optional(),
  remote: z.unknown().optional(),
});

app.post("/api/sync/conflict", async (c) => {
  const parsed = await parseJson(c, ConflictInput);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  if (!syncTable(parsed.data.entity)) return c.json({ error: "Unknown sync table" }, 400);
  await recordSyncConflict(
    parsed.data.entity,
    parsed.data.sync_id,
    parsed.data.resolution,
    parsed.data.local,
    parsed.data.remote,
  );
  return c.json({ ok: true });
});

app.get("/api/sync/conflicts", async (c) => {
  return c.json({ conflicts: await listConflicts(intParam(c.req.query("limit")) ?? 50) });
});

app.get("/api/sync/summary", async (c) => {
  return c.json(await getLocalDataSummary());
});

app.post("/api/sync/prepare-pull", async (c) => {
  return c.json(await prepareLocalForPull());
});

app.post("/api/sync/wipe", async (c) => {
  const parsed = await parseJson(c, z.object({ confirm: z.literal("DELETE") }));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  await wipeLocalData();
  return c.json({ ok: true });
});

/** Booking requests feed (for the front desk) — newest first. */
app.get("/api/booking/requests", async (c) => {
  await ensureMigrated();
  const rows = await query<{
    id: number; first_name: string; last_name: string; phone: string | null; email: string | null;
    start_time: string; status: string; created_at: string; appointment_id: number | null;
    treatment_name: string | null; link_label: string;
  }>(
    `SELECT br.*, tt.name AS treatment_name, bl.label AS link_label
     FROM booking_requests br
     LEFT JOIN treatment_types tt ON tt.id = br.treatment_type_id
     LEFT JOIN booking_links bl ON bl.id = br.link_id
     ORDER BY br.created_at DESC LIMIT 100`,
  );
  return c.json({ requests: rows });
});

export default app;

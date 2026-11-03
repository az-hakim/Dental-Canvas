/**
 * Sync table metadata — shared by the local Hono server (outbox/snapshot/apply)
 * and the browser sync engine (Supabase push/pull).
 *
 * The local store keeps its integer autoincrement primary keys and integer
 * foreign keys. Every syncable row also carries a `sync_id` (UUID) that is the
 * row identity in Supabase, and foreign keys are mirrored as `*_sync_id`
 * columns so a second device can rebuild the same relationships.
 *
 * Order matters: parents come before children. Initial upload and pull apply
 * both walk this list so a child's `*_sync_id` reference resolves to a local
 * row that already exists.
 */

export interface SyncTableSpec {
  /** Table name — identical locally and in Supabase. */
  name: string;
  /** Local integer primary key column. */
  pk: string;
  /** Local integer FK column → parent table. */
  fks: Record<string, string>;
  /** Counts as "the doctor typed something" for first-sync merge decisions. */
  userData?: boolean;
  /** Local columns that must never leave this device. */
  localOnlyColumns?: string[];
}

/** Cloud foreign-key column for a local FK column: `patient_id` → `patient_sync_id`. */
export function cloudFkColumn(localColumn: string): string {
  return localColumn.endsWith("_id")
    ? `${localColumn.slice(0, -3)}_sync_id`
    : `${localColumn}_sync_id`;
}

/** Suffix used by the client for every cloud FK column. */
export const CLOUD_FK_SUFFIX = "_sync_id";

export const SYNC_TABLES: SyncTableSpec[] = [
  // ── Lookups ──────────────────────────────────────────────────────
  { name: "operatories", pk: "id", fks: {} },
  { name: "practitioners", pk: "id", fks: {} },
  { name: "treatment_types", pk: "id", fks: {} },
  { name: "medicines", pk: "id", fks: {} },
  { name: "membership_plans", pk: "id", fks: {} },
  { name: "consent_templates", pk: "id", fks: {} },
  { name: "prescription_advice_presets", pk: "id", fks: {} },
  { name: "prescription_layouts", pk: "id", fks: {} },

  // ── People ───────────────────────────────────────────────────────
  { name: "patients", pk: "id", fks: {}, userData: true },

  // ── Scheduling / clinical ────────────────────────────────────────
  {
    name: "appointments",
    pk: "id",
    fks: {
      patient_id: "patients",
      practitioner_id: "practitioners",
      operatory_id: "operatories",
      treatment_type_id: "treatment_types",
    },
    userData: true,
  },
  {
    name: "treatment_plan_items",
    pk: "id",
    fks: { patient_id: "patients", treatment_type_id: "treatment_types" },
    userData: true,
  },
  {
    name: "tooth_conditions",
    pk: "id",
    fks: { patient_id: "patients" },
    userData: true,
  },
  {
    name: "clinical_notes",
    pk: "id",
    fks: { patient_id: "patients", practitioner_id: "practitioners" },
    userData: true,
  },
  {
    name: "lab_cases",
    pk: "id",
    fks: {
      patient_id: "patients",
      practitioner_id: "practitioners",
      treatment_type_id: "treatment_types",
    },
    userData: true,
  },
  {
    name: "insurance_plans",
    pk: "id",
    fks: { patient_id: "patients" },
    userData: true,
  },
  {
    name: "patient_memberships",
    pk: "id",
    fks: { patient_id: "patients", plan_id: "membership_plans" },
    userData: true,
  },
  {
    name: "consent_signatures",
    pk: "id",
    fks: {
      template_id: "consent_templates",
      patient_id: "patients",
      appointment_id: "appointments",
    },
    userData: true,
  },

  // ── Billing ──────────────────────────────────────────────────────
  {
    name: "invoices",
    pk: "id",
    fks: { patient_id: "patients", appointment_id: "appointments" },
    userData: true,
  },
  {
    name: "invoice_items",
    pk: "id",
    fks: {
      invoice_id: "invoices",
      treatment_type_id: "treatment_types",
      treatment_plan_item_id: "treatment_plan_items",
    },
    userData: true,
  },
  {
    name: "invoice_payments",
    pk: "id",
    fks: { invoice_id: "invoices" },
    userData: true,
  },
  {
    name: "invoice_payment_plans",
    pk: "id",
    fks: { invoice_id: "invoices" },
    userData: true,
  },

  // ── Worklists ────────────────────────────────────────────────────
  {
    name: "waiting_list",
    pk: "id",
    fks: {
      patient_id: "patients",
      treatment_type_id: "treatment_types",
      preferred_practitioner_id: "practitioners",
    },
    userData: true,
  },
  {
    name: "appointments_to_make",
    pk: "id",
    fks: { patient_id: "patients", treatment_type_id: "treatment_types" },
    userData: true,
  },
  {
    name: "patient_recall_config",
    pk: "patient_id",
    fks: { patient_id: "patients", recall_type_id: "treatment_types" },
    userData: true,
  },

  // ── Prescriptions ────────────────────────────────────────────────
  {
    name: "prescriptions",
    pk: "id",
    fks: {
      patient_id: "patients",
      practitioner_id: "practitioners",
      plan_item_id: "treatment_plan_items",
    },
    userData: true,
    // Attached image ids are local `patient_images` integers; sending them
    // raw would point at different rows on another device.
    localOnlyColumns: ["image_ids"],
  },
  {
    name: "prescription_items",
    pk: "id",
    fks: { prescription_id: "prescriptions" },
    userData: true,
  },
  { name: "prescription_templates", pk: "id", fks: {} },

  // ── Notes ────────────────────────────────────────────────────────
  { name: "dentist_notes", pk: "id", fks: {} },

  // ── Inventory ───────────────────────────────────────────────────
  { name: "inventory_items", pk: "id", fks: {} },
  {
    name: "inventory_movements",
    pk: "id",
    fks: { item_id: "inventory_items" },
  },
  {
    name: "inventory_alerts",
    pk: "id",
    fks: { item_id: "inventory_items" },
  },

  // ── Images (metadata only — bytes stay in the device/storage bucket) ──
  {
    name: "patient_images",
    pk: "id",
    fks: {
      patient_id: "patients",
      appointment_id: "appointments",
      uploaded_by: "practitioners",
    },
  },

  // ── Online booking ──────────────────────────────────────────────
  {
    name: "booking_links",
    pk: "id",
    fks: { practitioner_id: "practitioners", treatment_type_id: "treatment_types" },
  },
  {
    name: "booking_requests",
    pk: "id",
    fks: {
      link_id: "booking_links",
      appointment_id: "appointments",
      treatment_type_id: "treatment_types",
    },
  },
];

export const SYNC_TABLE_NAMES = SYNC_TABLES.map((t) => t.name);

const BY_NAME = new Map(SYNC_TABLES.map((t) => [t.name, t]));

export function syncTable(name: string): SyncTableSpec | undefined {
  return BY_NAME.get(name);
}

/** Tables whose rows mean the practice actually used this device. */
export function userDataTables(): string[] {
  return SYNC_TABLES.filter((t) => t.userData).map((t) => t.name);
}

/**
 * Local tables that are deliberately NOT synced:
 *  - settings      → may hold SMTP/S3/Drive credentials; device-specific.
 *  - backups       → device snapshots, not practice data.
 *  - blobs/search  → binary/derived data.
 *  - sync_*        → the sync bookkeeping itself.
 */
export const LOCAL_ONLY_TABLES = [
  "settings",
  "backups",
  "patient_image_blobs",
  "search_index",
  "sync_state",
  "sync_outbox",
  "sync_tombstones",
  "sync_cursors",
  "sync_conflicts",
] as const;

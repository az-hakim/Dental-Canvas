// AUTO-GENERATED from src/server/schema.sql — do not edit by hand.
// Regenerate with: npm run schema:generate
//
// The hosted (Vercel/Node) runtime applies this DDL to each clinic's table
// namespace, where a `?raw` import of schema.sql is not available.
export const SCHEMA_SQL = `-- ── Practice settings (key/value) ───────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Defaults (day_start_minute 420, day_end_minute 1140, slot_minutes 15) are
-- inserted by the app on first run — see \`ensureSeeded\` in src/server/index.ts.
-- This file is applied as DDL only, so it must contain no INSERT statements.

-- ── Operatories (treatment rooms / chairs) ──────────────────────
CREATE TABLE IF NOT EXISTS operatories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'sky',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Practitioners (dentists, hygienists, assistants) ────────────
CREATE TABLE IF NOT EXISTS practitioners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'dentist', -- 'dentist' | 'hygienist' | 'assistant'
  color TEXT NOT NULL DEFAULT 'teal',
  email TEXT,
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Treatment types (procedures) ────────────────────────────────
CREATE TABLE IF NOT EXISTS treatment_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,                   -- e.g. 'D1110' (ADA code) or short label
  name TEXT NOT NULL,                   -- e.g. 'Adult Prophylaxis'
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  default_fee REAL NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT 'sky',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Patients ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  date_of_birth TEXT,                   -- ISO date 'YYYY-MM-DD'
  patient_gender TEXT,                  -- M/F/Other, blank when not recorded
  email TEXT,
  phone TEXT,
  address TEXT,
  medical_alerts TEXT,                  -- comma-separated tags: 'allergy:penicillin,heart-condition'
  notes TEXT,
  referral_source TEXT,                 -- e.g. 'Google', 'Facebook', 'Yelp', 'Friend', 'Walk-in', 'Other'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(last_name, first_name);

-- ── Appointments ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  practitioner_id INTEGER REFERENCES practitioners(id) ON DELETE SET NULL,
  operatory_id INTEGER NOT NULL REFERENCES operatories(id) ON DELETE CASCADE,
  treatment_type_id INTEGER REFERENCES treatment_types(id) ON DELETE SET NULL,
  start_time TEXT NOT NULL,             -- ISO datetime 'YYYY-MM-DDTHH:MM:SS'
  end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled', -- 'scheduled' | 'confirmed' | 'arrived' | 'in_chair' | 'completed' | 'no_show' | 'cancelled'
  kind TEXT NOT NULL DEFAULT 'patient',     -- 'patient' | 'break' | 'lunch' | 'block'
  title TEXT,                           -- override title (used for break/lunch/block)
  notes TEXT,
  review_requested_at TEXT,             -- set when a Google review was requested after this visit
  checked_in_at TEXT,                   -- when the patient physically arrived (kiosk/front-desk check-in)
  in_chair_at TEXT,                     -- when the patient actually got into the chair (wait ends)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_appointments_start ON appointments(start_time);
CREATE INDEX IF NOT EXISTS idx_appointments_op_start ON appointments(operatory_id, start_time);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id);

-- ── Treatment plans ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS treatment_plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  treatment_type_id INTEGER REFERENCES treatment_types(id) ON DELETE SET NULL,
  tooth TEXT,                           -- e.g. '14' (FDI) or '#3' (Universal)
  surface TEXT,                         -- 'M' | 'O' | 'D' | 'B' | 'L' | combinations
  fee REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planned', -- 'planned' | 'accepted' | 'completed' | 'declined'
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plan_patient ON treatment_plan_items(patient_id);

-- ── Clinical notes ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinical_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  practitioner_id INTEGER REFERENCES practitioners(id) ON DELETE SET NULL,
  note_date TEXT NOT NULL DEFAULT (datetime('now')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notes_patient ON clinical_notes(patient_id, note_date DESC);

-- ── Tooth chart conditions ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS tooth_conditions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  tooth TEXT NOT NULL,                  -- '11'..'48' (FDI) or '1'..'32' (Universal)
  surface TEXT,                         -- 'M' | 'O' | 'D' | 'B' | 'L' | NULL for whole-tooth
  condition TEXT NOT NULL,              -- 'caries' | 'restoration' | 'crown' | 'missing' | 'implant' | 'endo'
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tooth_patient ON tooth_conditions(patient_id);

-- ── Invoices ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'paid' | 'void'
  total REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_invoices_patient ON invoices(patient_id);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  treatment_type_id INTEGER REFERENCES treatment_types(id) ON DELETE SET NULL,
  -- The treatment-plan item this line came from (auto-billing); null when typed manually.
  treatment_plan_item_id INTEGER REFERENCES treatment_plan_items(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);

-- ── Invoice payments ────────────────────────────────────────────
-- Partial-payment ledger. \`invoices.amount_paid\` is derived: kept in sync by
-- the payments API (sum of a payment rows), never written directly.
CREATE TABLE IF NOT EXISTS invoice_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash', -- 'cash' | 'card' | 'transfer' | 'insurance' | 'other'
  paid_at TEXT NOT NULL DEFAULT (datetime('now')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments(invoice_id);

-- ── Payment plans (installments for one invoice) ───────────────
CREATE TABLE IF NOT EXISTS invoice_payment_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  installment_count INTEGER NOT NULL,
  interval TEXT NOT NULL DEFAULT 'monthly', -- 'weekly' | 'monthly'
  start_date TEXT NOT NULL,
  installment_amount REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  payment_plan_reminded_at TEXT,        -- when the front desk last sent an installment reminder
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Waiting list ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS waiting_list (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  treatment_type_id INTEGER REFERENCES treatment_types(id) ON DELETE SET NULL,
  preferred_practitioner_id INTEGER REFERENCES practitioners(id) ON DELETE SET NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── In-house membership plans (plan catalog) ───────────────────
CREATE TABLE IF NOT EXISTS membership_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  monthly_fee REAL NOT NULL DEFAULT 0,
  annual_fee REAL,
  discount_percent REAL NOT NULL DEFAULT 0,
  benefits TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Patient memberships (a patient enrolled in a plan) ─────────
CREATE TABLE IF NOT EXISTS patient_memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES membership_plans(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired')),
  last_billed_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_patient_membership ON patient_memberships(patient_id, status);
CREATE INDEX IF NOT EXISTS idx_membership_plan ON patient_memberships(plan_id);

-- ── Digital consent forms (reusable templates) ─────────────────
CREATE TABLE IF NOT EXISTS consent_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  requires_guardian INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Captured consent signatures (canvas data-URL) ──────────────
CREATE TABLE IF NOT EXISTS consent_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES consent_templates(id) ON DELETE CASCADE,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  signer_name TEXT NOT NULL,
  signer_role TEXT NOT NULL DEFAULT 'patient',
  signature_data TEXT NOT NULL,
  signed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_consent_patient ON consent_signatures(patient_id, signed_at DESC);

-- ── Insurance plans ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insurance_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  rank TEXT NOT NULL DEFAULT 'primary', -- 'primary' | 'secondary' | 'tertiary'
  carrier TEXT NOT NULL,
  member_id TEXT,
  group_id TEXT,
  subscriber_name TEXT,
  subscriber_dob TEXT,                  -- ISO 'YYYY-MM-DD'
  effective_date TEXT,
  term_date TEXT,
  copay REAL NOT NULL DEFAULT 0,
  deductible_total REAL NOT NULL DEFAULT 0,
  deductible_used REAL NOT NULL DEFAULT 0,
  max_annual REAL NOT NULL DEFAULT 0,
  max_used REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_insurance_patient ON insurance_plans(patient_id);

-- ── Lab cases (outbound lab work — crowns, dentures, aligners) ──
CREATE TABLE IF NOT EXISTS lab_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  practitioner_id INTEGER REFERENCES practitioners(id) ON DELETE SET NULL,
  treatment_type_id INTEGER REFERENCES treatment_types(id) ON DELETE SET NULL,
  lab_name TEXT NOT NULL,
  case_type TEXT NOT NULL,              -- e.g. 'Crown', 'Bridge', 'Denture', 'Aligner', 'Night Guard'
  tooth TEXT,                           -- e.g. '14' or 'multiple'
  shade TEXT,                           -- VITA shade, e.g. 'A2'
  fee REAL NOT NULL DEFAULT 0,
  sent_at TEXT,                         -- ISO datetime
  due_at TEXT,                          -- promised return date
  received_at TEXT,                     -- when it came back
  seated_at TEXT,                       -- when it was placed in the patient
  status TEXT NOT NULL DEFAULT 'sent',  -- 'sent' | 'in_lab' | 'received' | 'seated' | 'cancelled'
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lab_patient ON lab_cases(patient_id);
CREATE INDEX IF NOT EXISTS idx_lab_status ON lab_cases(status);

-- ── Appointments to make (recall reminders) ────────────────────
CREATE TABLE IF NOT EXISTS appointments_to_make (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  treatment_type_id INTEGER REFERENCES treatment_types(id) ON DELETE SET NULL,
  due_after TEXT,                       -- ISO date 'YYYY-MM-DD'
  source TEXT NOT NULL DEFAULT 'reception', -- 'reception' | 'patient' | 'system'
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'scheduled' | 'cancelled'
  confirmed_at TEXT,                    -- set when the patient confirmed this recall
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Hygiene recall configuration (per patient, Dentrix-style) ──
CREATE TABLE IF NOT EXISTS patient_recall_config (
  patient_id INTEGER PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
  recall_type_id INTEGER REFERENCES treatment_types(id) ON DELETE SET NULL,
  interval_months INTEGER NOT NULL DEFAULT 6,
  last_completed TEXT                   -- ISO date of the last completed recall visit
);

-- ── Dentist notes (dashboard sticky notes) ─────────────────────
CREATE TABLE IF NOT EXISTS dentist_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Backups (portable snapshots of every data table) ───────────
-- Each row stores a complete JSON export of the practice data. \`kind\`
-- distinguishes timer-driven auto backups from manual ones; \`trigger\` records
-- what started it (timer, user, or a pre-import/pre-restore safety copy).
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'auto',    -- 'auto' | 'manual'
  trigger TEXT NOT NULL DEFAULT 'timer',-- 'timer' | 'user' | 'pre-import' | 'pre-restore'
  payload TEXT NOT NULL,                -- full JSON export (see src/server/backup.ts)
  table_counts TEXT,                    -- JSON map of table name → row count
  size_bytes INTEGER,                   -- approximate payload size
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Prescriptions ──────────────────────────────────────────────
-- A prescription is a named document owned by a patient, written by a
-- practitioner, carrying a one-time share token for a public read-only view.
CREATE TABLE IF NOT EXISTS prescriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  practitioner_id INTEGER REFERENCES practitioners(id) ON DELETE SET NULL,
  issued_date TEXT NOT NULL DEFAULT (date('now')),
  template TEXT NOT NULL DEFAULT 'chamber', -- see PrescriptionTemplate in src/client/types.ts
  large_print INTEGER NOT NULL DEFAULT 0, -- 1 = enlarged type for visually impaired patients
  tooth TEXT,                           -- tooth the prescription relates to, e.g. '14'
  plan_item_id INTEGER REFERENCES treatment_plan_items(id) ON DELETE SET NULL, -- linked planned procedure
  diagnosis TEXT,                       -- C/C (chief complaint / diagnosis) on the Chamber sidebar
  on_examination TEXT,                  -- O/E (findings on examination) on the Chamber sidebar
  history TEXT,                         -- H/O (history of presenting illness) on the Chamber sidebar
  advice TEXT,                          -- general instructions to the patient
  follow_up TEXT,                       -- e.g. 'Recheck in 2 weeks'
  follow_up_date TEXT,                  -- ISO date auto-computed from the follow-up picker
  patient_gender TEXT,                  -- M/F/Other snapshot at issue time (patients stays source of truth)
  complaints TEXT,                      -- JSON {items:[{label,duration?,site?}]} chief-complaint chips
  vitals TEXT,                          -- JSON {bp?, temperature?, pulse?, spo2?} on-examination vitals
  investigations TEXT,                  -- JSON {items:[...]} ordered lab tests
  share_token TEXT UNIQUE,              -- null = not shared
  share_revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rx_patient ON prescriptions(patient_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rx_token ON prescriptions(share_token) WHERE share_token IS NOT NULL;

-- Medication rows. Dosing is free-text (e.g. '1 tab TDS x 5 days') because
-- dental regimens vary too much for rigid dose/frequency columns.
CREATE TABLE IF NOT EXISTS prescription_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prescription_id INTEGER NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  drug_name TEXT NOT NULL,
  generic_name TEXT,                    -- generic / salt name shown in parentheses on the sheet
  dosage TEXT,                          -- e.g. '500 mg'
  frequency TEXT,                       -- e.g. '3x daily', 'every 8 h' (free-text fallback)
  schedule TEXT,                        -- structured dosing schedule, e.g. '1+1+1', '1+0+1', '0+0+1'
  meal_relation TEXT,                   -- e.g. 'after meals', 'before meals', 'empty stomach', 'with food'
  duration TEXT,                        -- e.g. '5 days'
  instructions TEXT,                    -- e.g. 'after meals'
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rx_items_prescription ON prescription_items(prescription_id);

-- The practice's editable medicine list (see the Lab page's Medicines tab).
-- Seeded from the built-in dental presets on first run; the practice can add,
-- edit and remove freely. Feeds the prescription editor's drug autocomplete.
CREATE TABLE IF NOT EXISTS medicines (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_medicines_name ON medicines (name);

-- ── Inventory (dental supplies & stock control) ─────────────────
CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                   -- e.g. 'Filtek Z250 Composite (A2)'
  category TEXT,                        -- e.g. 'Restorative', 'Sterilization', 'PPE'
  sku TEXT,                             -- catalog / internal code
  unit TEXT NOT NULL DEFAULT 'piece',   -- 'piece' | 'box' | 'pack' | 'cartridge' | 'ml' | 'pair' ...
  current_stock INTEGER NOT NULL DEFAULT 0,
  min_threshold INTEGER NOT NULL DEFAULT 0,   -- reorder point
  reorder_quantity INTEGER,             -- suggested order amount when below threshold
  supplier_name TEXT,
  supplier_contact TEXT,                -- phone / email of the supplier
  batch_number TEXT,
  expiry_date TEXT,                     -- ISO date 'YYYY-MM-DD'
  location TEXT,                        -- shelf / store room
  unit_cost REAL NOT NULL DEFAULT 0,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,    -- soft delete: keeps the movement history
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_name ON inventory_items(name);
CREATE INDEX IF NOT EXISTS idx_inventory_category ON inventory_items(category);
CREATE INDEX IF NOT EXISTS idx_inventory_expiry ON inventory_items(expiry_date);

-- Stock ledger. Every stock-in / stock-out / count-adjustment is a row here and
-- \`inventory_items.current_stock\` is kept in sync by the API. \`balance_after\`
-- snapshots the running count for audit history.
CREATE TABLE IF NOT EXISTS inventory_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                   -- 'in' | 'out' | 'adjust'
  quantity INTEGER NOT NULL,            -- positive magnitude (type carries the sign)
  balance_after INTEGER NOT NULL,
  unit_cost REAL,                       -- cost captured at restock time
  reference TEXT,                       -- e.g. 'PO-1042', patient name, '#12 invoice'
  reason TEXT,
  notes TEXT,
  performed_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inv_mov_item ON inventory_movements(item_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_inv_mov_type ON inventory_movements(type);

-- Alerts minted by the daily scan (POST /api/inventory/scan): low stock,
-- out of stock, expiring or expired items. Open alerts drive the dashboard's
-- inventory notification panel; resolved rows stay as history.
CREATE TABLE IF NOT EXISTS inventory_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                   -- 'out_of_stock' | 'low_stock' | 'expiring' | 'expired'
  severity TEXT NOT NULL,               -- 'critical' | 'warning' | 'info'
  message TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inv_alerts_open ON inventory_alerts(item_id, resolved);

-- ── Patient images & X-rays ────────────────────────────────────
-- Metadata only — the binary lives in object storage (S3/R2), configured
-- under Settings → Storage and reached through short-lived presigned URLs
-- (HTTPS, AES-256 at rest). \`file_key\` is namespaced under the patient and
-- unguessable; the row itself is soft-deleted so prescriptions keep rendering.
CREATE TABLE IF NOT EXISTS patient_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  file_key TEXT NOT NULL UNIQUE,         -- object key in the bucket, e.g. 'patients/7/2026/09/<uuid>.jpg'
  file_name TEXT,                        -- original filename (kept for downloads)
  mime_type TEXT NOT NULL,               -- 'image/jpeg' | 'image/png' | ... | 'application/dicom'
  size_bytes INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'photo',    -- 'xray' | 'intraoral' | 'panoramic' | 'photo'
  label TEXT,                            -- free-text caption
  compare_group TEXT,                    -- shared key joining before/after pairs
  uploaded_by INTEGER REFERENCES practitioners(id) ON DELETE SET NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_img_patient ON patient_images(patient_id, deleted, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_img_appointment ON patient_images(appointment_id);
CREATE INDEX IF NOT EXISTS idx_img_compare ON patient_images(patient_id, compare_group);

-- Byte payloads for the built-in database storage provider ("db" — the default
-- until a bucket is configured in Settings → Storage). Blobs are keyed by the
-- same unguessable \`file_key\` used with a bucket, so switching to S3/R2 later
-- leaves metadata untouched and only changes where the bytes live. Served back
-- by GET /api/image-file; capped at DB_STORAGE_MAX_MB (5 MB) per image.
-- No FK to patient_images: bytes land here first and metadata is registered
-- afterwards, so the upload order must not depend on the metadata row existing.
CREATE TABLE IF NOT EXISTS patient_image_blobs (
  file_key TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Full-text search (FTS5) ────────────────────────────────────
-- One inverted index across every searchable entity. \`title\` and \`body\` are the
-- searchable columns (snippet() reads column 4 = body); entity_type/entity_id/
-- patient_id are UNINDEXED metadata used to join back to source tables.
-- Rows are kept in sync by the triggers below; pre-existing data is backfilled
-- once by \`ensureSearchIndex\` in src/server/search.ts (INSERTs cannot live in
-- this file — a Clawnify deploy applies it as DDL only).
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  entity_type UNINDEXED,
  entity_id UNINDEXED,
  patient_id UNINDEXED,
  title,
  body,
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS search_patients_ai AFTER INSERT ON patients BEGIN
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('patients', NEW.id, NEW.id, NEW.last_name || ', ' || NEW.first_name,
    TRIM(COALESCE(NEW.email,'') || ' ' || COALESCE(NEW.phone,'') || ' ' || COALESCE(NEW.address,'') || ' ' || COALESCE(NEW.medical_alerts,'') || ' ' || COALESCE(NEW.notes,'') || ' ' || COALESCE(NEW.referral_source,'')));
END;
CREATE TRIGGER IF NOT EXISTS search_patients_ad AFTER DELETE ON patients BEGIN
  DELETE FROM search_index WHERE entity_type = 'patients' AND entity_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS search_patients_au AFTER UPDATE ON patients BEGIN
  DELETE FROM search_index WHERE entity_type = 'patients' AND entity_id = OLD.id;
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('patients', NEW.id, NEW.id, NEW.last_name || ', ' || NEW.first_name,
    TRIM(COALESCE(NEW.email,'') || ' ' || COALESCE(NEW.phone,'') || ' ' || COALESCE(NEW.address,'') || ' ' || COALESCE(NEW.medical_alerts,'') || ' ' || COALESCE(NEW.notes,'') || ' ' || COALESCE(NEW.referral_source,'')));
END;

CREATE TRIGGER IF NOT EXISTS search_appointments_ai AFTER INSERT ON appointments BEGIN
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('appointments', NEW.id, NEW.patient_id,
    COALESCE(NULLIF(NEW.title,''), (SELECT tt.name FROM treatment_types tt WHERE tt.id = NEW.treatment_type_id), 'Appointment'),
    TRIM(COALESCE(NEW.notes,'') || ' ' || COALESCE((SELECT p.first_name || ' ' || p.last_name FROM patients p WHERE p.id = NEW.patient_id), '')));
END;
CREATE TRIGGER IF NOT EXISTS search_appointments_ad AFTER DELETE ON appointments BEGIN
  DELETE FROM search_index WHERE entity_type = 'appointments' AND entity_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS search_appointments_au AFTER UPDATE ON appointments BEGIN
  DELETE FROM search_index WHERE entity_type = 'appointments' AND entity_id = OLD.id;
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('appointments', NEW.id, NEW.patient_id,
    COALESCE(NULLIF(NEW.title,''), (SELECT tt.name FROM treatment_types tt WHERE tt.id = NEW.treatment_type_id), 'Appointment'),
    TRIM(COALESCE(NEW.notes,'') || ' ' || COALESCE((SELECT p.first_name || ' ' || p.last_name FROM patients p WHERE p.id = NEW.patient_id), '')));
END;

CREATE TRIGGER IF NOT EXISTS search_treatment_plan_items_ai AFTER INSERT ON treatment_plan_items BEGIN
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('treatment_plan_items', NEW.id, NEW.patient_id,
    COALESCE((SELECT tt.name FROM treatment_types tt WHERE tt.id = NEW.treatment_type_id), 'Treatment') || CASE WHEN NEW.tooth IS NOT NULL THEN ' - tooth ' || NEW.tooth ELSE '' END,
    COALESCE(NEW.notes,''));
END;
CREATE TRIGGER IF NOT EXISTS search_treatment_plan_items_ad AFTER DELETE ON treatment_plan_items BEGIN
  DELETE FROM search_index WHERE entity_type = 'treatment_plan_items' AND entity_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS search_treatment_plan_items_au AFTER UPDATE ON treatment_plan_items BEGIN
  DELETE FROM search_index WHERE entity_type = 'treatment_plan_items' AND entity_id = OLD.id;
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('treatment_plan_items', NEW.id, NEW.patient_id,
    COALESCE((SELECT tt.name FROM treatment_types tt WHERE tt.id = NEW.treatment_type_id), 'Treatment') || CASE WHEN NEW.tooth IS NOT NULL THEN ' - tooth ' || NEW.tooth ELSE '' END,
    COALESCE(NEW.notes,''));
END;

CREATE TRIGGER IF NOT EXISTS search_clinical_notes_ai AFTER INSERT ON clinical_notes BEGIN
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('clinical_notes', NEW.id, NEW.patient_id, NEW.note_date,
    TRIM(NEW.body || ' ' || COALESCE((SELECT p.first_name || ' ' || p.last_name FROM patients p WHERE p.id = NEW.patient_id), '')));
END;
CREATE TRIGGER IF NOT EXISTS search_clinical_notes_ad AFTER DELETE ON clinical_notes BEGIN
  DELETE FROM search_index WHERE entity_type = 'clinical_notes' AND entity_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS search_clinical_notes_au AFTER UPDATE ON clinical_notes BEGIN
  DELETE FROM search_index WHERE entity_type = 'clinical_notes' AND entity_id = OLD.id;
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('clinical_notes', NEW.id, NEW.patient_id, NEW.note_date,
    TRIM(NEW.body || ' ' || COALESCE((SELECT p.first_name || ' ' || p.last_name FROM patients p WHERE p.id = NEW.patient_id), '')));
END;

CREATE TRIGGER IF NOT EXISTS search_invoices_ai AFTER INSERT ON invoices BEGIN
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('invoices', NEW.id, NEW.patient_id, 'Invoice #' || NEW.id, COALESCE(NEW.notes,''));
END;
CREATE TRIGGER IF NOT EXISTS search_invoices_ad AFTER DELETE ON invoices BEGIN
  DELETE FROM search_index WHERE entity_type = 'invoices' AND entity_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS search_invoices_au AFTER UPDATE ON invoices BEGIN
  DELETE FROM search_index WHERE entity_type = 'invoices' AND entity_id = OLD.id;
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('invoices', NEW.id, NEW.patient_id, 'Invoice #' || NEW.id, COALESCE(NEW.notes,''));
END;

CREATE TRIGGER IF NOT EXISTS search_invoice_items_ai AFTER INSERT ON invoice_items BEGIN
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('invoice_items', NEW.id,
    (SELECT patient_id FROM invoices WHERE id = NEW.invoice_id), NEW.description, '');
END;
CREATE TRIGGER IF NOT EXISTS search_invoice_items_ad AFTER DELETE ON invoice_items BEGIN
  DELETE FROM search_index WHERE entity_type = 'invoice_items' AND entity_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS search_invoice_items_au AFTER UPDATE ON invoice_items BEGIN
  DELETE FROM search_index WHERE entity_type = 'invoice_items' AND entity_id = OLD.id;
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('invoice_items', NEW.id,
    (SELECT patient_id FROM invoices WHERE id = NEW.invoice_id), NEW.description, '');
END;

CREATE TRIGGER IF NOT EXISTS search_insurance_plans_ai AFTER INSERT ON insurance_plans BEGIN
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('insurance_plans', NEW.id, NEW.patient_id, NEW.carrier,
    TRIM(COALESCE(NEW.member_id,'') || ' ' || COALESCE(NEW.group_id,'') || ' ' || COALESCE(NEW.subscriber_name,'') || ' ' || COALESCE(NEW.notes,'')));
END;
CREATE TRIGGER IF NOT EXISTS search_insurance_plans_ad AFTER DELETE ON insurance_plans BEGIN
  DELETE FROM search_index WHERE entity_type = 'insurance_plans' AND entity_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS search_insurance_plans_au AFTER UPDATE ON insurance_plans BEGIN
  DELETE FROM search_index WHERE entity_type = 'insurance_plans' AND entity_id = OLD.id;
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('insurance_plans', NEW.id, NEW.patient_id, NEW.carrier,
    TRIM(COALESCE(NEW.member_id,'') || ' ' || COALESCE(NEW.group_id,'') || ' ' || COALESCE(NEW.subscriber_name,'') || ' ' || COALESCE(NEW.notes,'')));
END;

CREATE TRIGGER IF NOT EXISTS search_lab_cases_ai AFTER INSERT ON lab_cases BEGIN
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('lab_cases', NEW.id, NEW.patient_id, NEW.case_type || ' - ' || NEW.lab_name,
    TRIM(COALESCE(NEW.tooth,'') || ' ' || COALESCE(NEW.shade,'') || ' ' || COALESCE(NEW.notes,'')));
END;
CREATE TRIGGER IF NOT EXISTS search_lab_cases_ad AFTER DELETE ON lab_cases BEGIN
  DELETE FROM search_index WHERE entity_type = 'lab_cases' AND entity_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS search_lab_cases_au AFTER UPDATE ON lab_cases BEGIN
  DELETE FROM search_index WHERE entity_type = 'lab_cases' AND entity_id = OLD.id;
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('lab_cases', NEW.id, NEW.patient_id, NEW.case_type || ' - ' || NEW.lab_name,
    TRIM(COALESCE(NEW.tooth,'') || ' ' || COALESCE(NEW.shade,'') || ' ' || COALESCE(NEW.notes,'')));
END;

CREATE TRIGGER IF NOT EXISTS search_waiting_list_ai AFTER INSERT ON waiting_list BEGIN
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('waiting_list', NEW.id, NEW.patient_id,
    COALESCE((SELECT tt.name FROM treatment_types tt WHERE tt.id = NEW.treatment_type_id), 'Waiting list'), COALESCE(NEW.notes,''));
END;
CREATE TRIGGER IF NOT EXISTS search_waiting_list_ad AFTER DELETE ON waiting_list BEGIN
  DELETE FROM search_index WHERE entity_type = 'waiting_list' AND entity_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS search_waiting_list_au AFTER UPDATE ON waiting_list BEGIN
  DELETE FROM search_index WHERE entity_type = 'waiting_list' AND entity_id = OLD.id;
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('waiting_list', NEW.id, NEW.patient_id,
    COALESCE((SELECT tt.name FROM treatment_types tt WHERE tt.id = NEW.treatment_type_id), 'Waiting list'), COALESCE(NEW.notes,''));
END;

CREATE TRIGGER IF NOT EXISTS search_appointments_to_make_ai AFTER INSERT ON appointments_to_make BEGIN
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('appointments_to_make', NEW.id, NEW.patient_id,
    COALESCE((SELECT tt.name FROM treatment_types tt WHERE tt.id = NEW.treatment_type_id), 'Appointment to make'), COALESCE(NEW.notes,''));
END;
CREATE TRIGGER IF NOT EXISTS search_appointments_to_make_ad AFTER DELETE ON appointments_to_make BEGIN
  DELETE FROM search_index WHERE entity_type = 'appointments_to_make' AND entity_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS search_appointments_to_make_au AFTER UPDATE ON appointments_to_make BEGIN
  DELETE FROM search_index WHERE entity_type = 'appointments_to_make' AND entity_id = OLD.id;
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('appointments_to_make', NEW.id, NEW.patient_id,
    COALESCE((SELECT tt.name FROM treatment_types tt WHERE tt.id = NEW.treatment_type_id), 'Appointment to make'), COALESCE(NEW.notes,''));
END;

CREATE TRIGGER IF NOT EXISTS search_tooth_conditions_ai AFTER INSERT ON tooth_conditions BEGIN
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('tooth_conditions', NEW.id, NEW.patient_id, 'Tooth ' || NEW.tooth, NEW.condition);
END;
CREATE TRIGGER IF NOT EXISTS search_tooth_conditions_ad AFTER DELETE ON tooth_conditions BEGIN
  DELETE FROM search_index WHERE entity_type = 'tooth_conditions' AND entity_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS search_tooth_conditions_au AFTER UPDATE ON tooth_conditions BEGIN
  DELETE FROM search_index WHERE entity_type = 'tooth_conditions' AND entity_id = OLD.id;
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('tooth_conditions', NEW.id, NEW.patient_id, 'Tooth ' || NEW.tooth, NEW.condition);
END;

CREATE TRIGGER IF NOT EXISTS search_operatories_ai AFTER INSERT ON operatories BEGIN
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('operatories', NEW.id, NULL, NEW.name, '');
END;
CREATE TRIGGER IF NOT EXISTS search_operatories_ad AFTER DELETE ON operatories BEGIN
  DELETE FROM search_index WHERE entity_type = 'operatories' AND entity_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS search_operatories_au AFTER UPDATE ON operatories BEGIN
  DELETE FROM search_index WHERE entity_type = 'operatories' AND entity_id = OLD.id;
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('operatories', NEW.id, NULL, NEW.name, '');
END;

CREATE TRIGGER IF NOT EXISTS search_practitioners_ai AFTER INSERT ON practitioners BEGIN
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('practitioners', NEW.id, NULL, NEW.name,
    TRIM(COALESCE(NEW.email,'') || ' ' || COALESCE(NEW.phone,'')));
END;
CREATE TRIGGER IF NOT EXISTS search_practitioners_ad AFTER DELETE ON practitioners BEGIN
  DELETE FROM search_index WHERE entity_type = 'practitioners' AND entity_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS search_practitioners_au AFTER UPDATE ON practitioners BEGIN
  DELETE FROM search_index WHERE entity_type = 'practitioners' AND entity_id = OLD.id;
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('practitioners', NEW.id, NULL, NEW.name,
    TRIM(COALESCE(NEW.email,'') || ' ' || COALESCE(NEW.phone,'')));
END;

CREATE TRIGGER IF NOT EXISTS search_treatment_types_ai AFTER INSERT ON treatment_types BEGIN
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('treatment_types', NEW.id, NULL, NEW.code || ' ' || NEW.name, '');
END;
CREATE TRIGGER IF NOT EXISTS search_treatment_types_ad AFTER DELETE ON treatment_types BEGIN
  DELETE FROM search_index WHERE entity_type = 'treatment_types' AND entity_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS search_treatment_types_au AFTER UPDATE ON treatment_types BEGIN
  DELETE FROM search_index WHERE entity_type = 'treatment_types' AND entity_id = OLD.id;
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('treatment_types', NEW.id, NULL, NEW.code || ' ' || NEW.name, '');
END;

CREATE TRIGGER IF NOT EXISTS search_inventory_items_ai AFTER INSERT ON inventory_items BEGIN
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('inventory_items', NEW.id, NULL, NEW.name,
    TRIM(COALESCE(NEW.category,'') || ' ' || COALESCE(NEW.sku,'') || ' ' || COALESCE(NEW.supplier_name,'') || ' ' || COALESCE(NEW.batch_number,'')));
END;
CREATE TRIGGER IF NOT EXISTS search_inventory_items_ad AFTER DELETE ON inventory_items BEGIN
  DELETE FROM search_index WHERE entity_type = 'inventory_items' AND entity_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS search_inventory_items_au AFTER UPDATE ON inventory_items BEGIN
  DELETE FROM search_index WHERE entity_type = 'inventory_items' AND entity_id = OLD.id;
  INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES ('inventory_items', NEW.id, NULL, NEW.name,
    TRIM(COALESCE(NEW.category,'') || ' ' || COALESCE(NEW.sku,'') || ' ' || COALESCE(NEW.supplier_name,'') || ' ' || COALESCE(NEW.batch_number,'')));
END;

-- ── Online booking links (public self-scheduling) ───────────────
-- A practice can issue booking links (per practitioner or practice-wide).
-- Each link is a random token; the public booking page uses it to read
-- availability and create appointments WITHOUT any other API access.
CREATE TABLE IF NOT EXISTS booking_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT 'Online booking',
  practitioner_id INTEGER REFERENCES practitioners(id) ON DELETE CASCADE,
  treatment_type_id INTEGER REFERENCES treatment_types(id) ON DELETE SET NULL,
  days_ahead INTEGER NOT NULL DEFAULT 14,      -- how far out patients can book
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS booking_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES booking_links(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  start_time TEXT NOT NULL,
  treatment_type_id INTEGER REFERENCES treatment_types(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'booked',   -- 'booked' | 'cancelled'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Prescription clinical templates & advice presets ──────────────────
-- Reusable bundles a clinician can save from a finished prescription and
-- reload later to pre-fill a new prescription's clinical fields + medication
-- skeleton. Stored as JSON so the shape can evolve without migrations.
CREATE TABLE IF NOT EXISTS prescription_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  diagnosis TEXT,                   -- C/C text captured on the saved Rx
  on_examination TEXT,              -- O/E text
  history TEXT,                     -- H/O text
  complaints TEXT,                  -- JSON RxComplaints
  vitals TEXT,                      -- JSON RxVitals
  investigations TEXT,              -- JSON RxInvestigations
  advice TEXT,                      -- reusable advice text
  items TEXT,                       -- JSON PrescriptionItem[] skeleton (drug_name + optional preset fields)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_prescription_templates_name ON prescription_templates(name);

-- Practice-defined prescription template skins (Settings → Rx templates).
-- \`config\` is JSON (RxTemplateConfig: layout, palette, typography, sections);
-- the sheet id stored on a prescription is "custom-" || id.
CREATE TABLE IF NOT EXISTS prescription_layouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base TEXT NOT NULL DEFAULT 'chamber',  -- built-in template it started from
  config TEXT NOT NULL,                  -- JSON RxTemplateConfig
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_prescription_layouts_name ON prescription_layouts(name);

-- Reusable advice snippets surfaced as chips in the editor's advice picker.
CREATE TABLE IF NOT EXISTS prescription_advice_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

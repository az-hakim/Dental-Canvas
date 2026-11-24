import { currentTenantKey, query, get, run } from "./db";

/**
 * Cross-entity full-text search over the FTS5 `search_index` table
 * (schema.sql). Rows are maintained by sync triggers; pre-existing data is
 * backfilled once by `ensureSearchIndex` (INSERTs can't live in schema.sql —
 * a Clawnify deploy applies it as DDL only).
 */

export type SearchEntityType =
  | "patients"
  | "appointments"
  | "treatment_plan_items"
  | "clinical_notes"
  | "invoices"
  | "invoice_items"
  | "insurance_plans"
  | "lab_cases"
  | "waiting_list"
  | "appointments_to_make"
  | "tooth_conditions"
  | "operatories"
  | "practitioners"
  | "treatment_types"
  | "inventory_items";

export interface SearchHit {
  entity_type: SearchEntityType;
  id: number;
  patient_id: number | null;
  title: string;
  snippet: string;
  /** Internal ranking score — exposed for debugging/tests, ignored by the UI. */
  rank: number | null;
}

export interface SearchResponse {
  hits: SearchHit[];
  /** Set when the FTS5 path failed and a plain LIKE fallback was served. */
  via: "fts5" | "like";
}

// ── One-time backfill ──────────────────────────────────────────────

// Per clinic: each tenant has its own search_index table and settings marker.
const backfilledClinics = new Set<string>();
const backfillingByClinic = new Map<string, Promise<void>>();

const BACKFILL_SQLS: [SearchEntityType, string][] = [
  ["patients", `SELECT id AS c0, id AS c1, (last_name || ', ' || first_name) AS c2,
      TRIM(COALESCE(email,'') || ' ' || COALESCE(phone,'') || ' ' || COALESCE(address,'') || ' '
        || COALESCE(medical_alerts,'') || ' ' || COALESCE(notes,'') || ' ' || COALESCE(referral_source,'')) AS c3
     FROM patients`],
  ["appointments", `SELECT id AS c0, patient_id AS c1,
      COALESCE(NULLIF(title,''), (SELECT tt.name FROM treatment_types tt WHERE tt.id = appointments.treatment_type_id), 'Appointment') AS c2,
      TRIM(COALESCE(notes,'') || ' ' || COALESCE((SELECT p.first_name || ' ' || p.last_name FROM patients p WHERE p.id = appointments.patient_id), '')) AS c3
     FROM appointments`],
  ["treatment_plan_items", `SELECT id AS c0, patient_id AS c1,
      (COALESCE((SELECT tt.name FROM treatment_types tt WHERE tt.id = treatment_plan_items.treatment_type_id), 'Treatment')
        || CASE WHEN tooth IS NOT NULL THEN ' - tooth ' || tooth ELSE '' END) AS c2,
      COALESCE(notes,'') AS c3
     FROM treatment_plan_items`],
  ["clinical_notes", `SELECT id AS c0, patient_id AS c1, note_date AS c2,
      TRIM(body || ' ' || COALESCE((SELECT p.first_name || ' ' || p.last_name FROM patients p WHERE p.id = clinical_notes.patient_id), '')) AS c3
     FROM clinical_notes`],
  ["invoices", `SELECT id AS c0, patient_id AS c1, ('Invoice #' || id) AS c2, COALESCE(notes,'') AS c3 FROM invoices`],
  ["invoice_items", `SELECT invoice_items.id AS c0,
      (SELECT patient_id FROM invoices WHERE invoices.id = invoice_items.invoice_id) AS c1,
      description AS c2, '' AS c3
     FROM invoice_items`],
  ["insurance_plans", `SELECT id AS c0, patient_id AS c1, carrier AS c2,
      TRIM(COALESCE(member_id,'') || ' ' || COALESCE(group_id,'') || ' ' || COALESCE(subscriber_name,'') || ' ' || COALESCE(notes,'')) AS c3
     FROM insurance_plans`],
  ["lab_cases", `SELECT id AS c0, patient_id AS c1, (case_type || ' - ' || lab_name) AS c2,
      TRIM(COALESCE(tooth,'') || ' ' || COALESCE(shade,'') || ' ' || COALESCE(notes,'')) AS c3
     FROM lab_cases`],
  ["waiting_list", `SELECT id AS c0, patient_id AS c1,
      COALESCE((SELECT tt.name FROM treatment_types tt WHERE tt.id = waiting_list.treatment_type_id), 'Waiting list') AS c2,
      COALESCE(notes,'') AS c3
     FROM waiting_list`],
  ["appointments_to_make", `SELECT id AS c0, patient_id AS c1,
      COALESCE((SELECT tt.name FROM treatment_types tt WHERE tt.id = appointments_to_make.treatment_type_id), 'Appointment to make') AS c2,
      COALESCE(notes,'') AS c3
     FROM appointments_to_make`],
  ["tooth_conditions", `SELECT id AS c0, patient_id AS c1, ('Tooth ' || tooth) AS c2, condition AS c3 FROM tooth_conditions`],
  ["operatories", `SELECT id AS c0, NULL AS c1, name AS c2, '' AS c3 FROM operatories`],
  ["practitioners", `SELECT id AS c0, NULL AS c1, name AS c2, TRIM(COALESCE(email,'') || ' ' || COALESCE(phone,'')) AS c3 FROM practitioners`],
  ["treatment_types", `SELECT id AS c0, NULL AS c1, (code || ' ' || name) AS c2, '' AS c3 FROM treatment_types`],
  ["inventory_items", `SELECT id AS c0, NULL AS c1, name AS c2,
      TRIM(COALESCE(category,'') || ' ' || COALESCE(sku,'') || ' ' || COALESCE(supplier_name,'') || ' ' || COALESCE(batch_number,'')) AS c3
     FROM inventory_items`],
];

/** Clear one entity type's index rows and re-read them from the source table. */
async function rebuildType(type: SearchEntityType, sql: string): Promise<number> {
  // Clear first so the rebuild is idempotent even when triggers have already
  // indexed some rows (which would otherwise duplicate them).
  await run("DELETE FROM search_index WHERE entity_type = ?", [type]);
  const rows = await query<{ c0: unknown; c1: unknown; c2: unknown; c3: unknown }>(
    `SELECT * FROM (${sql})`,
  );
  for (const r of rows) {
    // The projection's first column is always the source-table id.
    const id = Number(r.c0);
    if (!Number.isFinite(id)) continue;
    await run(
      "INSERT INTO search_index (entity_type, entity_id, patient_id, title, body) VALUES (?, ?, ?, ?, ?)",
      [type, id, r.c1 == null ? null : Number(r.c1), String(r.c2 ?? ""), String(r.c3 ?? "")],
    );
  }
  return rows.length;
}

/**
 * Force the next search to rebuild the index. Used after a backup import
 * replaces every row: clearing the DB marker alone is not enough because the
 * per-isolate `backfilled` flag would still short-circuit the lazy backfill.
 */
export async function invalidateSearchIndex(): Promise<void> {
  const clinic = currentTenantKey();
  backfilledClinics.delete(clinic);
  backfillingByClinic.delete(clinic);
  await run("DELETE FROM settings WHERE key = 'search_backfilled_v1'").catch(() => undefined);
}

async function backfillSearchIndex(): Promise<void> {
  for (const [type, sql] of BACKFILL_SQLS) {
    try {
      await rebuildType(type, sql);
    } catch {
      // Table missing on a pre-migration dev DB — skip it.
    }
  }
}

/** Idempotent, runs at most once per isolate; must never fail a request. */
export async function ensureSearchIndex(): Promise<void> {
  const clinic = currentTenantKey();
  if (backfilledClinics.has(clinic)) return;
  try {
    let backfilling = backfillingByClinic.get(clinic);
    if (!backfilling) {
      backfilling = (async () => {
      // Cheap total of the biggest source tables; 0 rows means a fresh DB with
      // nothing to backfill (triggers will index new rows from the start).
      const row = await get<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM patients) + (SELECT COUNT(*) FROM appointments)
           + (SELECT COUNT(*) FROM clinical_notes) AS n`,
      ).catch(() => ({ n: 0 }));
      if ((row?.n ?? 0) > 0) {
        const marker = await get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM settings WHERE key = 'search_backfilled_v1'",
        ).catch(() => ({ n: 1 }));
        if ((marker?.n ?? 1) === 0) {
          await backfillSearchIndex();
          await run(
            "INSERT INTO settings (key, value) VALUES ('search_backfilled_v1', datetime('now'))" +
              " ON CONFLICT(key) DO NOTHING",
          );
        }
      }
      })();
      backfillingByClinic.set(clinic, backfilling);
    }
    await backfilling;
    backfilledClinics.add(clinic);
  } catch {
    backfilledClinics.delete(clinic);
    backfillingByClinic.delete(clinic);
  }
}

/**
 * Full manual rebuild: wipes the index and re-reads every source table.
 * Used by POST /api/search/reindex to recover from drift or corruption.
 */
export async function reindexSearchIndex(): Promise<Record<SearchEntityType, number>> {
  await run("DELETE FROM search_index");
  const counts = {} as Record<SearchEntityType, number>;
  for (const [type, sql] of BACKFILL_SQLS) {
    try {
      counts[type] = await rebuildType(type, sql);
    } catch {
      counts[type] = 0; // table missing on a pre-migration dev DB
    }
  }
  // The rebuild has exactly reproduced the backfill — mark it done either way.
  await run(
    "INSERT INTO settings (key, value) VALUES ('search_backfilled_v1', datetime('now'))" +
      " ON CONFLICT(key) DO NOTHING",
  );
  return counts;
}

// ── Querying ───────────────────────────────────────────────────────

/** Escape a term for use inside an FTS5 double-quoted string. */
function ftsQuote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * Build a safe FTS5 MATCH expression: each whitespace-separated token becomes
 * a quoted prefix term. Prevents raw input like `patient OR (` from being
 * parsed as FTS5 query syntax.
 */
export function buildMatchExpression(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .map((t) => `${ftsQuote(t)}*`)
    .join(" ");
}

/** Case-insensitive containment match over the same rows, via LIKE. */
function likePattern(raw: string): string {
  return `%${raw.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
}

function buildSnippet(title: string, body: string, q: string): string {
  const text = body || title;
  const idx = text.toLowerCase().indexOf(q.trim().toLowerCase());
  if (idx === -1) return text.slice(0, 120);
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + q.trim().length + 80);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Mark query terms inside a snippet with [ ] so the UI can highlight them. */
function highlight(snippet: string, q: string): string {
  const terms = q.trim().split(/\s+/).filter((t) => t.length > 0);
  if (!terms.length) return snippet;
  const re = new RegExp(
    `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  return snippet.replace(re, "[$1]");
}

export async function searchAll(rawQuery: string, limit = 60): Promise<SearchResponse> {
  const q = rawQuery.trim();
  if (!q) return { hits: [], via: "fts5" };

  await ensureSearchIndex();
  const capped = Math.min(Math.max(limit, 1), 100);

  // Preferred path: FTS5 prefix matching, ranked by relevance.
  try {
    const match = buildMatchExpression(q);
    const rows = await query<{
      entity_type: SearchEntityType;
      entity_id: unknown;
      patient_id: unknown;
      title: string;
      body: string;
      rank: number | null;
    }>(
      `SELECT entity_type, entity_id, patient_id, title, body, rank
       FROM search_index WHERE search_index MATCH ?
       ORDER BY rank LIMIT ?`,
      [match, capped],
    );
    return {
      via: "fts5",
      hits: rows.map((r) => ({
        entity_type: r.entity_type,
        id: Number(r.entity_id),
        patient_id: r.patient_id == null ? null : Number(r.patient_id),
        title: r.title,
        snippet: highlight(buildSnippet(r.title, r.body, q), q),
        rank: r.rank,
      })),
    };
  } catch {
    // Fall through to LIKE (malformed MATCH is impossible after
    // buildMatchExpression, but an empty/missing index lands here too).
  }

  // Fallback path: substring matching over the indexed text.
  try {
    const pattern = likePattern(q);
    const rows = await query<{
      entity_type: SearchEntityType;
      entity_id: unknown;
      patient_id: unknown;
      title: string;
      body: string;
    }>(
      `SELECT entity_type, entity_id, patient_id, title, body
       FROM search_index
       WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'
       ORDER BY entity_id DESC LIMIT ?`,
      [pattern, pattern, capped],
    );
    return {
      via: "like",
      hits: rows.map((r) => ({
        entity_type: r.entity_type,
        id: Number(r.entity_id),
        patient_id: r.patient_id == null ? null : Number(r.patient_id),
        title: r.title,
        snippet: highlight(buildSnippet(r.title, r.body, q), q),
        rank: null,
      })),
    };
  } catch {
    // Index table missing entirely (pre-migration dev DB) — degrade to empty.
    return { hits: [], via: "like" };
  }
}

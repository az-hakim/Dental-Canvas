/**
 * Merging two patient records into one.
 *
 * Bulk import creates the situation this exists for: the same person can be on
 * file twice — once as the full record carried over from the old system, once
 * as the quick registration the front desk typed while the patient was in the
 * chair. Deleting one of them would take its appointments, invoices and notes
 * with it (every child table cascades), so a merge moves those rows to the
 * surviving record first and only then removes the other.
 *
 * The table list is explicit rather than discovered: a new child table has to
 * be added here, which is the reminder to decide what a merge should do with it.
 */

import { get, run } from "./db";

/** Tables whose rows belong to exactly one patient and should follow them. */
export const MERGE_CHILD_TABLES = [
  { table: "appointments", label: "appointments" },
  { table: "clinical_notes", label: "clinical notes" },
  { table: "invoices", label: "invoices" },
  { table: "prescriptions", label: "prescriptions" },
  { table: "treatment_plan_items", label: "treatment plan items" },
  { table: "tooth_conditions", label: "tooth chart entries" },
  { table: "patient_images", label: "images" },
  { table: "lab_cases", label: "lab cases" },
  { table: "waiting_list", label: "waiting list entries" },
  { table: "patient_memberships", label: "memberships" },
  { table: "consent_signatures", label: "signed consents" },
  { table: "insurance_plans", label: "insurance plans" },
  { table: "appointments_to_make", label: "recall items" },
] as const;

export type MergeCounts = Record<string, number>;

export interface MergePatientRow {
  id: number;
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  patient_gender: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  medical_alerts: string | null;
  notes: string | null;
  referral_source: string | null;
}

function filled(value: unknown): string {
  return String(value ?? "").trim();
}

/**
 * The survivor keeps what it already has; the other record only fills blanks.
 * Alerts are the exception — they are a list, so they are united: losing
 * "allergy:penicillin" because the other record happened to be the one that
 * carried it is the kind of thing a merge must never do.
 */
export function mergePatientFields(
  keep: MergePatientRow,
  other: MergePatientRow,
): { updates: Partial<Record<keyof MergePatientRow, string>>; alerts: string[] } {
  const updates: Partial<Record<keyof MergePatientRow, string>> = {};
  const fields = [
    "date_of_birth",
    "patient_gender",
    "email",
    "phone",
    "address",
    "notes",
    "referral_source",
  ] as const;
  for (const field of fields) {
    if (!filled(keep[field]) && filled(other[field])) updates[field] = filled(other[field]);
  }

  const alerts = unionAlerts([keep.medical_alerts, other.medical_alerts]);
  if (alerts.join(",") !== (keep.medical_alerts ?? "")) {
    updates.medical_alerts = alerts.join(",");
  }
  return { updates, alerts };
}

/** Comma-separated tags, de-duplicated case-insensitively, first spelling kept. */
export function unionAlerts(values: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const part of (value ?? "").split(",")) {
      const tag = part.trim();
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}

/**
 * One statement counting every child table for one patient. Exported so a test
 * can check it survives the hosted deployment's table renaming.
 */
export function patientRowCountSql(): string {
  return `SELECT ${MERGE_CHILD_TABLES.map(
    ({ table }, index) => `(SELECT COUNT(*) FROM ${table} WHERE patient_id = ?) AS c${index}`,
  ).join(", ")}`;
}

/** How much history each record holds — shown before a merge is confirmed. */
export async function countPatientRows(patientId: number): Promise<MergeCounts> {
  // Scalar subqueries, not a UNION: SQLite caps a compound SELECT at a handful
  // of terms ("too many terms in compound SELECT"), and this one statement
  // keeps the preview to a single round trip on a remote database.
  //
  // The aliases are positional (`c0`, `c1`, …) on purpose: a hosted deployment
  // renames every tenant *table* identifier on its way to the driver, so
  // `AS appointments` came back as `t_<clinic>_appointments` and every count
  // read as zero. Aliases that are not table names cannot be rewritten.
  const row = await get<Record<string, number>>(
    patientRowCountSql(),
    MERGE_CHILD_TABLES.map(() => patientId),
  );
  const counts: MergeCounts = {};
  MERGE_CHILD_TABLES.forEach(({ table }, index) => {
    counts[table] = Number(row?.[`c${index}`] ?? 0);
  });
  return counts;
}

/**
 * Moves every child row from `mergeId` to `keepId` and deletes `mergeId`.
 *
 * There is no transaction across these statements (the hosted driver exposes
 * none), so the delete is deliberately last: a failure part-way leaves both
 * records in place with some history already on the survivor, which is
 * recoverable, instead of a deleted record whose rows went nowhere.
 */
export async function mergePatients(
  keepId: number,
  mergeId: number,
): Promise<
  | { patient: MergePatientRow; moved: MergeCounts; removed_id: number }
  | { error: string; status: 400 | 404 }
> {
  if (keepId === mergeId) return { error: "Choose two different records to merge.", status: 400 };

  const keep = await get<MergePatientRow>("SELECT * FROM patients WHERE id = ?", [keepId]);
  if (!keep) return { error: "Patient not found", status: 404 };
  const other = await get<MergePatientRow>("SELECT * FROM patients WHERE id = ?", [mergeId]);
  if (!other) return { error: "The other patient no longer exists", status: 404 };

  const { updates } = mergePatientFields(keep, other);
  const columns = Object.keys(updates) as (keyof MergePatientRow)[];
  if (columns.length > 0) {
    await run(
      `UPDATE patients SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`,
      [...columns.map((column) => updates[column]), keepId],
    );
  }

  // Recall configuration is one row per patient (patient_id is its key), so it
  // moves only when the survivor has none.
  const keepRecall = await get("SELECT patient_id FROM patient_recall_config WHERE patient_id = ?", [keepId]);
  const otherRecall = await get("SELECT patient_id FROM patient_recall_config WHERE patient_id = ?", [mergeId]);
  if (otherRecall && keepRecall) {
    await run("DELETE FROM patient_recall_config WHERE patient_id = ?", [mergeId]);
  } else if (otherRecall) {
    await run("UPDATE patient_recall_config SET patient_id = ? WHERE patient_id = ?", [keepId, mergeId]);
  }

  // Counted up front: `changes` from D1 includes the rows the search-index
  // triggers rewrite, so it is not the number of records that moved.
  const moved = await countPatientRows(mergeId);
  for (const { table } of MERGE_CHILD_TABLES) {
    await run(`UPDATE ${table} SET patient_id = ? WHERE patient_id = ?`, [keepId, mergeId]);
  }

  await run("DELETE FROM patients WHERE id = ?", [mergeId]);

  const patient = await get<MergePatientRow>("SELECT * FROM patients WHERE id = ?", [keepId]);
  return { patient: patient as MergePatientRow, moved, removed_id: mergeId };
}

/**
 * Human-facing grouping of the syncable tables, used by Settings → Cloud sync
 * to show exactly what leaves this device.
 *
 * Every entry in `SYNC_TABLES` must appear in exactly one category
 * (tests/sync-categories.test.ts enforces it), so adding a table to the sync
 * schema without telling the doctor about it fails the build.
 */
import { SYNC_TABLES } from "./sync-schema";

export interface SyncCategory {
  label: string;
  description: string;
  tables: string[];
}

export const SYNC_CATEGORIES: SyncCategory[] = [
  {
    label: "Clinic setup",
    description: "Operatories, practitioners, treatment types, memberships, consent forms, medicines and note templates.",
    tables: [
      "operatories",
      "practitioners",
      "treatment_types",
      "medicines",
      "membership_plans",
      "consent_templates",
      "prescription_advice_presets",
      "prescription_layouts",
      "prescription_templates",
      "dentist_notes",
    ],
  },
  {
    label: "Patients & clinical records",
    description: "Patient files, appointments, charting, clinical notes, lab cases, insurance, signed consents and prescriptions.",
    tables: [
      "patients",
      "appointments",
      "treatment_plan_items",
      "tooth_conditions",
      "clinical_notes",
      "lab_cases",
      "insurance_plans",
      "patient_memberships",
      "consent_signatures",
      "prescriptions",
      "prescription_items",
    ],
  },
  {
    label: "Billing",
    description: "Invoices, line items, payments and instalment plans.",
    tables: ["invoices", "invoice_items", "invoice_payments", "invoice_payment_plans"],
  },
  {
    label: "Worklists & recalls",
    description: "The waiting list, appointments still to book, and per-patient recall settings.",
    tables: ["waiting_list", "appointments_to_make", "patient_recall_config"],
  },
  {
    label: "Inventory",
    description: "Stock items, movements and low-stock alerts.",
    tables: ["inventory_items", "inventory_movements", "inventory_alerts"],
  },
  {
    label: "Image records",
    description: "Image details and captions. The picture files themselves stay on the device that uploaded them.",
    tables: ["patient_images"],
  },
  {
    label: "Online booking",
    description: "Booking links and the requests patients submit through them.",
    tables: ["booking_links", "booking_requests"],
  },
];

/** Every table name covered by a category, in sync-schema order. */
export function categorisedTables(): string[] {
  const known = new Set(SYNC_CATEGORIES.flatMap((c) => c.tables));
  return SYNC_TABLES.map((t) => t.name).filter((name) => known.has(name));
}

/** Syncable tables that no category mentions (should stay empty). */
export function uncategorisedTables(): string[] {
  const known = new Set(SYNC_CATEGORIES.flatMap((c) => c.tables));
  return SYNC_TABLES.map((t) => t.name).filter((name) => !known.has(name));
}

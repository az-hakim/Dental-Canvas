import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, freshApp, jsonRequest, type TestContext } from "./helpers";
import {
  mergePatientFields,
  patientRowCountSql,
  unionAlerts,
  type MergePatientRow,
} from "../src/server/patient-merge";
import { rewriteSql } from "../src/server/tenant/sql-prefix";

let ctx: TestContext;
let app: Awaited<ReturnType<typeof freshApp>>;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  await ctx.resetDb();
  app = await freshApp();
  await app.request("/api/health", undefined, { DB: ctx.db });
});

async function post(path: string, body: unknown) {
  const { path: url, init } = jsonRequest("POST", path, body);
  const res = await app.request(url, init, { DB: ctx.db });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function createPatient(body: Record<string, unknown>): Promise<number> {
  const res = await post("/api/patients", body);
  expect(res.status).toBe(201);
  return (res.body.patient as { id: number }).id;
}

async function patient(id: number) {
  const res = await app.request(`/api/patients/${id}`, undefined, { DB: ctx.db });
  return { status: res.status, body: (await res.json()) as { patient?: Record<string, unknown> } };
}

async function firstOperatory(): Promise<number> {
  const res = await app.request("/api/operatories", undefined, { DB: ctx.db });
  const { operatories } = (await res.json()) as { operatories: { id: number }[] };
  return operatories[0]!.id;
}

async function bookAppointment(patientId: number, start: string): Promise<void> {
  const operatory_id = await firstOperatory();
  const res = await post("/api/appointments", {
    patient_id: patientId,
    operatory_id,
    start_time: `${start}T09:00:00`,
    end_time: `${start}T09:30:00`,
  });
  expect(res.status).toBe(201);
}

async function appointmentCount(patientId: number): Promise<number> {
  const res = await app.request(`/api/appointments?patient_id=${patientId}`, undefined, { DB: ctx.db });
  const { appointments } = (await res.json()) as { appointments: unknown[] };
  return appointments.length;
}

describe("merging two records for one person", () => {
  it("moves appointments, invoices and clinical notes, then removes the duplicate", async () => {
    const keep = await createPatient({ first_name: "Nadia", last_name: "Ferro", phone: "555-0100" });
    const dupe = await createPatient({ first_name: "Nadia", last_name: "Ferro", phone: "555-0199" });

    await bookAppointment(keep, "2026-03-02");
    await bookAppointment(dupe, "2026-03-03");
    await bookAppointment(dupe, "2026-03-04");
    expect((await post("/api/clinical-notes", { patient_id: dupe, body: "Bridge on 46 reviewed" })).status).toBe(201);
    expect((await post("/api/invoices", { patient_id: dupe })).status).toBe(201);

    const res = await post("/api/patients/merge", { keep_id: keep, merge_id: dupe });
    expect(res.status).toBe(200);
    expect(res.body.moved).toMatchObject({ appointments: 2, clinical_notes: 1, invoices: 1 });
    expect(res.body.removed_id).toBe(dupe);

    expect(await appointmentCount(keep)).toBe(3);
    expect(await appointmentCount(dupe)).toBe(0);

    const notes = await app.request(`/api/patients/${keep}/notes`, undefined, { DB: ctx.db });
    const noteBody = (await notes.json()) as { notes: { body: string }[] };
    expect(noteBody.notes.map((n) => n.body)).toContain("Bridge on 46 reviewed");

    const invoices = await app.request(`/api/patients/${keep}/invoices`, undefined, { DB: ctx.db });
    const invoiceBody = (await invoices.json()) as { invoices: unknown[] };
    expect(invoiceBody.invoices).toHaveLength(1);

    // The duplicate is gone.
    expect((await patient(dupe)).status).toBe(404);
    expect((await patient(keep)).status).toBe(200);
  });

  it("keeps the surviving record's own details and fills only its blanks", async () => {
    const keep = await createPatient({
      first_name: "Owen",
      last_name: "Priest",
      phone: "555-0111",
      email: "owen@example.com",
    });
    const dupe = await createPatient({
      first_name: "Owen",
      last_name: "Priest",
      phone: "555-0222",
      email: "old@example.com",
      date_of_birth: "1975-11-02",
      address: "9 Mill Lane",
    });

    const res = await post("/api/patients/merge", { keep_id: keep, merge_id: dupe });
    expect(res.status).toBe(200);

    const merged = (await patient(keep)).body.patient;
    expect(merged?.phone).toBe("555-0111"); // the survivor's number wins
    expect(merged?.email).toBe("owen@example.com");
    expect(merged?.date_of_birth).toBe("1975-11-02"); // was blank, so it is filled
    expect(merged?.address).toBe("9 Mill Lane");
  });

  it("unites the medical alerts of both records", async () => {
    const keep = await createPatient({
      first_name: "Zelda",
      last_name: "Quarrington",
      medical_alerts: "allergy:penicillin",
    });
    const dupe = await createPatient({
      first_name: "Zelda",
      last_name: "Quarrington",
      medical_alerts: "allergy:latex,allergy:penicillin",
    });

    await post("/api/patients/merge", { keep_id: keep, merge_id: dupe });

    const merged = (await patient(keep)).body.patient;
    expect(merged?.medical_alerts).toBe("allergy:penicillin,allergy:latex");
  });

  it("can keep the other record instead", async () => {
    const current = await createPatient({ first_name: "Marcus", last_name: "Hale" });
    const other = await createPatient({ first_name: "Marcus", last_name: "Hale", email: "marcus@example.com" });
    await bookAppointment(current, "2026-04-01");

    const res = await post("/api/patients/merge", { keep_id: other, merge_id: current });
    expect(res.status).toBe(200);
    expect((res.body.patient as { id: number; email: string }).id).toBe(other);
    expect((res.body.patient as { email: string }).email).toBe("marcus@example.com");
    expect(await appointmentCount(other)).toBe(1);
    expect((await patient(current)).status).toBe(404);
  });

  it("reports what will move before anything moves", async () => {
    const keep = await createPatient({ first_name: "Ada", last_name: "Merge" });
    const dupe = await createPatient({ first_name: "Ada", last_name: "Merge" });
    await bookAppointment(dupe, "2026-05-01");
    await post("/api/clinical-notes", { patient_id: dupe, body: "Fissure sealants 16, 26" });

    const res = await app.request(
      `/api/patients/${keep}/merge-preview?other_id=${dupe}`,
      undefined,
      { DB: ctx.db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, number>; kept: Record<string, number> };
    expect(body.counts.appointments).toBe(1);
    expect(body.counts.clinical_notes).toBe(1);
    expect(body.kept.appointments).toBe(0);

    // A preview writes nothing.
    expect(await appointmentCount(dupe)).toBe(1);
    expect((await patient(dupe)).status).toBe(200);
  });

  it("keeps one recall configuration, the surviving record's", async () => {
    const keep = await createPatient({ first_name: "Iris", last_name: "Recall" });
    const dupe = await createPatient({ first_name: "Iris", last_name: "Recall" });
    expect((await put(`/api/patients/${keep}/recall`, { interval_months: 12 })).status).toBe(200);
    expect((await put(`/api/patients/${dupe}/recall`, { interval_months: 3 })).status).toBe(200);

    const res = await post("/api/patients/merge", { keep_id: keep, merge_id: dupe });
    expect(res.status).toBe(200);

    const recall = await app.request(`/api/patients/${keep}/recall`, undefined, { DB: ctx.db });
    const { recall: config } = (await recall.json()) as { recall: { interval_months: number } | null };
    expect(config?.interval_months).toBe(12);
  });

  it("moves the recall configuration when only the duplicate has one", async () => {
    const keep = await createPatient({ first_name: "Hugo", last_name: "Recall" });
    const dupe = await createPatient({ first_name: "Hugo", last_name: "Recall" });
    await put(`/api/patients/${dupe}/recall`, { interval_months: 9 });

    await post("/api/patients/merge", { keep_id: keep, merge_id: dupe });

    const recall = await app.request(`/api/patients/${keep}/recall`, undefined, { DB: ctx.db });
    const { recall: config } = (await recall.json()) as { recall: { interval_months: number } | null };
    expect(config?.interval_months).toBe(9);
  });

  it("refuses to merge a record into itself", async () => {
    const id = await createPatient({ first_name: "Solo", last_name: "Record" });
    const res = await post("/api/patients/merge", { keep_id: id, merge_id: id });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("two different records");
    expect((await patient(id)).status).toBe(200);
  });

  it("404s when one of the records is gone", async () => {
    const keep = await createPatient({ first_name: "Ghost", last_name: "One" });
    const res = await post("/api/patients/merge", { keep_id: keep, merge_id: keep + 999 });
    expect(res.status).toBe(404);
    expect((await patient(keep)).status).toBe(200);
  });
});

async function put(path: string, body: unknown) {
  const { path: url, init } = jsonRequest("PUT", path, body);
  const res = await app.request(url, init, { DB: ctx.db });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ── The field rules on their own ──────────────────────────────────

function row(over: Partial<MergePatientRow> = {}): MergePatientRow {
  return {
    id: 1,
    first_name: "Jane",
    last_name: "Cooper",
    date_of_birth: null,
    patient_gender: null,
    email: null,
    phone: null,
    address: null,
    medical_alerts: null,
    notes: null,
    referral_source: null,
    ...over,
  };
}

describe("merge field rules", () => {
  it("never overwrites a value the survivor already has", () => {
    const { updates } = mergePatientFields(row({ phone: "555-0100" }), row({ id: 2, phone: "555-0999" }));
    expect(updates.phone).toBeUndefined();
  });

  it("fills a blank from the other record", () => {
    const { updates } = mergePatientFields(row(), row({ id: 2, email: "jane@example.com" }));
    expect(updates.email).toBe("jane@example.com");
  });

  it("unites alert tags without repeating them", () => {
    expect(unionAlerts(["allergy:penicillin", "allergy:latex, allergy:Penicillin"])).toEqual([
      "allergy:penicillin",
      "allergy:latex",
    ]);
  });

  it("survives the hosted deployment's table renaming", () => {
    // A clinic's tables are physically renamed on the way to the driver. A
    // count aliased after its table (`AS appointments`) was renamed too, so the
    // preview read every column as undefined and promised "no history" for a
    // record full of it — on production only.
    const rewritten = rewriteSql(patientRowCountSql(), "t_clinic1234_");
    expect(rewritten).toContain("AS c0");
    expect(rewritten).toContain("FROM t_clinic1234_appointments");
    expect(rewritten).not.toMatch(/AS t_clinic1234_/);
  });

  it("leaves alerts alone when only one record has them", () => {
    const { updates } = mergePatientFields(row({ medical_alerts: "allergy:penicillin" }), row({ id: 2 }));
    expect(updates.medical_alerts).toBeUndefined();
  });
});

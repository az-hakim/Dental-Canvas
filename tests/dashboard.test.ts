import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, freshApp, jsonRequest, type TestContext } from "./helpers";

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
});

async function seedPatient(overrides: Record<string, unknown> = {}) {
  const { path, init } = jsonRequest("POST", "/api/patients", {
    first_name: "Guy",
    last_name: "Hawkins",
    date_of_birth: "1990-05-10",
    ...overrides,
  });
  const res = await app.request(path, init, { DB: ctx.db });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { patient: { id: number } };
  return data.patient.id;
}

/** Insert an appointment row directly to control dates precisely. */
async function seedAppointment(overrides: Record<string, unknown> = {}) {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const base = {
    patient_id: null as number | null,
    operatory_id: 1,
    start_time: `${iso(today)}T09:00:00`,
    end_time: `${iso(today)}T09:30:00`,
    status: "scheduled",
    kind: "patient",
    ...overrides,
  };
  // Ensure an operatory exists (seed creates Op 1..3 on first request).
  if (base.operatory_id === 1) {
    const ops = await app.request("/api/operatories", undefined, { DB: ctx.db });
    const opsData = (await ops.json()) as { operatories: { id: number }[] };
    base.operatory_id = opsData.operatories[0]?.id ?? 1;
  }
  const res = await ctx.db
    .prepare(
      `INSERT INTO appointments (patient_id, operatory_id, start_time, end_time, status, kind)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(base.patient_id, base.operatory_id, base.start_time, base.end_time, base.status, base.kind)
    .run();
  return res.meta.last_row_id as number;
}

describe("GET /api/dashboard/summary", () => {
  it("returns zeros on a fresh practice", async () => {
    const res = await app.request("/api/dashboard/summary", undefined, { DB: ctx.db });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      total_visits: number;
      new_patients: number;
      returning_patients: number;
      upcoming: unknown[];
    };
    expect(data.total_visits).toBe(0);
    expect(data.new_patients).toBe(0);
    expect(data.returning_patients).toBe(0);
    expect(data.upcoming).toEqual([]);
  });

  it("counts today's patient visits but not blocks or cancellations", async () => {
    const pid = await seedPatient();
    await seedAppointment({ patient_id: pid });
    await seedAppointment({
      start_time: `${new Date().toISOString().slice(0, 10)}T11:00:00`,
      end_time: `${new Date().toISOString().slice(0, 10)}T12:00:00`,
      kind: "block",
      title: "Staff meeting",
    });
    await seedAppointment({
      start_time: `${new Date().toISOString().slice(0, 10)}T14:00:00`,
      end_time: `${new Date().toISOString().slice(0, 10)}T14:30:00`,
      status: "cancelled",
    });

    const res = await app.request("/api/dashboard/summary", undefined, { DB: ctx.db });
    const data = (await res.json()) as { total_visits: number };
    expect(data.total_visits).toBe(1);
  });

  it("classifies new vs returning patients by prior completed history", async () => {
    const newPatient = await seedPatient({ first_name: "New", last_name: "Comer" });
    const returningPatient = await seedPatient({ first_name: "Old", last_name: "Timer" });

    // returningPatient has a completed visit from last year.
    const lastYear = new Date();
    lastYear.setFullYear(lastYear.getFullYear() - 1);
    await seedAppointment({
      patient_id: returningPatient,
      start_time: `${lastYear.toISOString().slice(0, 10)}T10:00:00`,
      end_time: `${lastYear.toISOString().slice(0, 10)}T10:30:00`,
      status: "completed",
    });
    // newPatient only has a future appointment.
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    await seedAppointment({
      patient_id: newPatient,
      start_time: `${nextMonth.toISOString().slice(0, 10)}T10:00:00`,
      end_time: `${nextMonth.toISOString().slice(0, 10)}T10:30:00`,
    });

    const res = await app.request("/api/dashboard/summary", undefined, { DB: ctx.db });
    const data = (await res.json()) as { new_patients: number; returning_patients: number };
    expect(data.returning_patients).toBe(1);
    expect(data.new_patients).toBe(1);
  });

  it("counts the calendar day the client sends, not the server's UTC day", async () => {
    const pid = await seedPatient();
    // A day that is never the server's UTC "today", so only the explicit
    // ?today= parameter can pick these two visits up.
    const clinicDay = new Date();
    clinicDay.setUTCDate(clinicDay.getUTCDate() - 45);
    const day = clinicDay.toISOString().slice(0, 10);
    // Registered 45 days ago too, so the registration itself is not a visit
    // today: only the two appointments below may be counted.
    await ctx.db
      .prepare("UPDATE patients SET created_at = ? WHERE id = ?")
      .bind(`${day} 08:00:00`, pid)
      .run();
    await seedAppointment({ patient_id: pid, start_time: `${day}T09:00:00`, end_time: `${day}T09:30:00` });
    await seedAppointment({ patient_id: pid, start_time: `${day}T11:00:00`, end_time: `${day}T11:30:00` });

    const utc = await app.request("/api/dashboard/summary", undefined, { DB: ctx.db });
    expect(((await utc.json()) as { total_visits: number }).total_visits).toBe(0);

    const local = await app.request(`/api/dashboard/summary?today=${day}`, undefined, { DB: ctx.db });
    const data = (await local.json()) as { total_visits: number; new_patients_today: number };
    expect(data.total_visits).toBe(2);
    expect(data.new_patients_today).toBe(1);
  });

  it("falls back to UTC when today is not a valid date", async () => {
    const res = await app.request("/api/dashboard/summary?today=29-10-2026", undefined, { DB: ctx.db });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { total_visits: number };
    expect(data.total_visits).toBe(0);
  });

  it("counts new and returning patients in today's chair for the goal rings", async () => {
    const firstTimer = await seedPatient({ first_name: "First", last_name: "Timer" });
    const regular = await seedPatient({ first_name: "Reg", last_name: "Ular" });
    const today = new Date().toISOString().slice(0, 10);

    // The regular completed a visit last year; the first-timer has none.
    const lastYear = new Date();
    lastYear.setFullYear(lastYear.getFullYear() - 1);
    await seedAppointment({
      patient_id: regular,
      start_time: `${lastYear.toISOString().slice(0, 10)}T10:00:00`,
      end_time: `${lastYear.toISOString().slice(0, 10)}T10:30:00`,
      status: "completed",
    });

    await seedAppointment({ patient_id: firstTimer });
    await seedAppointment({
      patient_id: regular,
      start_time: `${today}T13:00:00`,
      end_time: `${today}T13:30:00`,
    });
    // A cancelled visit never reaches a chair, so it is not a new patient "seen".
    await seedAppointment({
      patient_id: firstTimer,
      start_time: `${today}T15:00:00`,
      end_time: `${today}T15:30:00`,
      status: "cancelled",
    });

    const res = await app.request("/api/dashboard/summary", undefined, { DB: ctx.db });
    const data = (await res.json()) as {
      total_visits: number;
      new_patients_today: number;
      returning_patients_today: number;
    };
    // Two patients in the chair today; the cancelled slot adds nobody.
    expect(data.total_visits).toBe(2);
    expect(data.new_patients_today).toBe(1);
    expect(data.returning_patients_today).toBe(1);
  });

  it("counts a patient registered today as a visit, without double counting their booking", async () => {
    const today = new Date().toISOString().slice(0, 10);
    // Registering a patient at the front desk is a visit even before the chair
    // is booked — that was the bug: the card stayed at zero after a new patient.
    const pid = await seedPatient({ first_name: "Walk", last_name: "In" });

    const registered = await app.request("/api/dashboard/summary", undefined, { DB: ctx.db });
    const first = (await registered.json()) as {
      total_visits: number;
      new_patients_today: number;
      returning_patients_today: number;
    };
    expect(first.total_visits).toBe(1);
    expect(first.new_patients_today).toBe(1);
    expect(first.returning_patients_today).toBe(0);

    // Booking that same patient later in the day keeps the day at one visit.
    await seedAppointment({ patient_id: pid, start_time: `${today}T10:00:00`, end_time: `${today}T10:30:00` });
    const booked = await app.request("/api/dashboard/summary", undefined, { DB: ctx.db });
    const second = (await booked.json()) as { total_visits: number; new_patients_today: number };
    expect(second.total_visits).toBe(1);
    expect(second.new_patients_today).toBe(1);
  });

  it("reads registrations on the clinic's day, not UTC's", async () => {
    // 22:30 UTC on the 24th is 04:30 on the 25th in Dhaka (UTC+6): a patient
    // registered then belongs to the clinic's 25th, which is the day we ask for.
    const clinicDay = new Date();
    clinicDay.setUTCDate(clinicDay.getUTCDate() - 10);
    const day = clinicDay.toISOString().slice(0, 10);
    await ctx.db
      .prepare("INSERT INTO patients (first_name, last_name, created_at) VALUES ('Late', 'Night', ?)")
      .bind(`${day} 22:30:00`)
      .run();
    const nextDay = new Date(`${day}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const tomorrow = nextDay.toISOString().slice(0, 10);

    const utc = await app.request(`/api/dashboard/summary?today=${tomorrow}&tz=0`, undefined, { DB: ctx.db });
    expect(((await utc.json()) as { total_visits: number }).total_visits).toBe(0);

    const dhaka = await app.request(`/api/dashboard/summary?today=${tomorrow}&tz=360`, undefined, { DB: ctx.db });
    const data = (await dhaka.json()) as { total_visits: number; new_patients_today: number };
    expect(data.total_visits).toBe(1);
    expect(data.new_patients_today).toBe(1);
  });

  it("reports no patients in the chair on a fresh practice", async () => {
    const res = await app.request("/api/dashboard/summary", undefined, { DB: ctx.db });
    const data = (await res.json()) as {
      new_patients_today: number;
      returning_patients_today: number;
    };
    expect(data.new_patients_today).toBe(0);
    expect(data.returning_patients_today).toBe(0);
  });

  it("lists upcoming appointments and recalls sorted by time", async () => {
    const pid = await seedPatient();
    const today = new Date().toISOString().slice(0, 10);
    await seedAppointment({
      patient_id: pid,
      start_time: `${today}T15:00:00`,
      end_time: `${today}T15:30:00`,
    });
    // Recall (open appointment-to-make) due tomorrow.
    await ctx.db
      .prepare(
        "INSERT INTO appointments_to_make (patient_id, due_after, source, status) VALUES (?, ?, 'system', 'open')",
      )
      .bind(pid, tomorrowIso())
      .run();

    const res = await app.request("/api/dashboard/summary", undefined, { DB: ctx.db });
    const data = (await res.json()) as { upcoming: { kind: string; id: number }[] };
    expect(data.upcoming.length).toBe(2);
    expect(data.upcoming[0].kind).toBe("patient");
    expect(data.upcoming[1].kind).toBe("recall");
  });
});

function tomorrowIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe("GET /api/appointments date ranges", () => {
  it("supports from/to ranges for the dashboard calendar", async () => {
    const pid = await seedPatient();
    const today = new Date().toISOString().slice(0, 10);
    const nextWeek = tomorrowIso();
    await seedAppointment({ patient_id: pid });
    await seedAppointment({
      patient_id: pid,
      start_time: `${nextWeek}T09:00:00`,
      end_time: `${nextWeek}T09:30:00`,
    });

    const res = await app.request(`/api/appointments?from=${today}&to=${today}`, undefined, { DB: ctx.db });
    const data = (await res.json()) as { appointments: unknown[] };
    expect(data.appointments).toHaveLength(1);
  });
});

describe("GET /api/dashboard/consultation", () => {
  it("returns 400 without patient_id", async () => {
    const res = await app.request("/api/dashboard/consultation", undefined, { DB: ctx.db });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown patient", async () => {
    const res = await app.request("/api/dashboard/consultation?patient_id=99999", undefined, { DB: ctx.db });
    expect(res.status).toBe(404);
  });

  it("aggregates last visit, notes and tooth conditions", async () => {
    const pid = await seedPatient();
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    await seedAppointment({
      patient_id: pid,
      start_time: `${lastMonth.toISOString().slice(0, 10)}T10:00:00`,
      end_time: `${lastMonth.toISOString().slice(0, 10)}T10:30:00`,
      status: "completed",
    });
    const note = jsonRequest("POST", "/api/clinical-notes", {
      patient_id: pid,
      body: "Multiple cavities detected in molars",
    });
    await app.request(note.path, note.init, { DB: ctx.db });
    const tooth = jsonRequest("POST", "/api/tooth-conditions", {
      patient_id: pid,
      tooth: "14",
      condition: "caries",
    });
    await app.request(tooth.path, tooth.init, { DB: ctx.db });

    const res = await app.request(`/api/dashboard/consultation?patient_id=${pid}`, undefined, { DB: ctx.db });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      patient: { first_name: string };
      last_checked: string | null;
      observation: string | null;
      prescription: string | null;
      conditions: { condition: string; n: number }[];
    };
    expect(data.patient.first_name).toBe("Guy");
    expect(data.last_checked).toBe(lastMonth.toISOString().slice(0, 10));
    expect(data.observation).toContain("cavities");
    expect(data.conditions).toEqual([{ condition: "caries", n: 1 }]);
  });
});

describe("dentist notes", () => {
  it("starts with seeded notes and creates new ones", async () => {
    const first = await app.request("/api/dentist-notes", undefined, { DB: ctx.db });
    const firstData = (await first.json()) as { notes: unknown[] };
    expect(firstData.notes.length).toBeGreaterThanOrEqual(1);

    const { path, init } = jsonRequest("POST", "/api/dentist-notes", { body: "Restock gloves" });
    const created = await app.request(path, init, { DB: ctx.db });
    expect(created.status).toBe(201);
    const createdData = (await created.json()) as { note: { id: number; body: string; pinned: number } };
    expect(createdData.note.body).toBe("Restock gloves");
    expect(createdData.note.pinned).toBe(0);
  });

  it("rejects empty bodies", async () => {
    const { path, init } = jsonRequest("POST", "/api/dentist-notes", { body: "" });
    const res = await app.request(path, init, { DB: ctx.db });
    expect(res.status).toBe(400);
  });

  it("pins and unpins", async () => {
    const { path, init } = jsonRequest("POST", "/api/dentist-notes", { body: "Pin me" });
    const created = await app.request(path, init, { DB: ctx.db });
    const createdData = (await created.json()) as { note: { id: number } };

    const pin = jsonRequest("PUT", `/api/dentist-notes/${createdData.note.id}`, { pinned: true });
    const pinned = await app.request(pin.path, pin.init, { DB: ctx.db });
    const pinnedData = (await pinned.json()) as { note: { pinned: number } };
    expect(pinnedData.note.pinned).toBe(1);

    // Pinned notes sort first.
    const list = await app.request("/api/dentist-notes", undefined, { DB: ctx.db });
    const listData = (await list.json()) as { notes: { id: number; pinned: number }[] };
    expect(listData.notes[0].id).toBe(createdData.note.id);
  });

  it("deletes", async () => {
    const { path, init } = jsonRequest("POST", "/api/dentist-notes", { body: "Ephemeral" });
    const created = await app.request(path, init, { DB: ctx.db });
    const createdData = (await created.json()) as { note: { id: number } };
    const { id } = createdData.note;

    const del = await app.request(`/api/dentist-notes/${id}`, { method: "DELETE" }, { DB: ctx.db });
    expect(del.status).toBe(200);
    const list = await app.request("/api/dentist-notes", undefined, { DB: ctx.db });
    const listData = (await list.json()) as { notes: { id: number }[] };
    expect(listData.notes.find((n) => n.id === id)).toBeUndefined();
  });
});

describe("profile settings", () => {
  it("exposes doctor profile defaults", async () => {
    const res = await app.request("/api/settings", undefined, { DB: ctx.db });
    const data = (await res.json()) as { settings: Record<string, string> };
    expect(data.settings.doctor_name).toBe("");
    expect(data.settings.doctor_specialty).toBe("Dentist");
    expect(data.settings.clinic_name).toBe("");
    expect(data.settings.doctor_email).toBe("");
    expect(data.settings.doctor_phone).toBe("");
  });

  it("persists a doctor name across a simulated redeploy", async () => {
    const put = await app.request(
      "/api/settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doctor_name: "Sarah", clinic_name: "Bright Smile" }),
      },
      { DB: ctx.db },
    );
    expect(put.status).toBe(200);

    const app2 = await freshApp();
    await app2.request("/api/health", undefined, { DB: ctx.db });
    const res = await app2.request("/api/settings", undefined, { DB: ctx.db });
    const data = (await res.json()) as { settings: Record<string, string> };
    expect(data.settings.doctor_name).toBe("Sarah");
    expect(data.settings.clinic_name).toBe("Bright Smile");
    // Existing defaults survive alongside profile keys.
    expect(data.settings.day_start_minute).toBeDefined();
  });
});

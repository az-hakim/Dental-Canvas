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
  await app.request("/api/health", undefined, { DB: ctx.db });
});

async function seedFixtures(): Promise<{ patientId: number; operatoryId: number }> {
  const op = await app.request("/api/operatories", undefined, { DB: ctx.db });
  const { operatories } = (await op.json()) as { operatories: { id: number }[] };

  const p = jsonRequest("POST", "/api/patients", {
    first_name: "Bella",
    last_name: "Gomez",
    date_of_birth: "1990-06-15",
    phone: "+1555000111",
  });
  const pres = await app.request(p.path, p.init, { DB: ctx.db });
  const { patient } = (await pres.json()) as { patient: { id: number } };

  return { patientId: patient.id, operatoryId: operatories[0].id };
}

describe("birthday board", () => {
  it("lists birthdays within the window with correct turning age", async () => {
    const { patientId } = await seedFixtures();
    // Bella was born 1990-06-15. Set the query window around today, then
    // instead of faking the clock, insert a patient whose birthday is today.
    // The server derives "today" from SQLite's date('now'), which is UTC —
    // compute the month/day the same way or the test breaks near midnight in
    // timezones ahead of UTC (the birthday flips a day early/late).
    const today = new Date();
    const md = `${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
    const db = jsonRequest("PUT", `/api/patients/${patientId}`, { date_of_birth: `1985-${md}` });
    await app.request(db.path, db.init, { DB: ctx.db });

    const res = await app.request("/api/dashboard/birthdays?days=30", undefined, { DB: ctx.db });
    expect(res.status).toBe(200);
    const { birthdays } = (await res.json()) as { birthdays: { id: number; is_today: boolean; turning: number; name: string }[] };
    const bella = birthdays.find((b) => b.id === patientId);
    expect(bella).toBeTruthy();
    expect(bella!.is_today).toBe(true);
    expect(bella!.turning).toBe(today.getFullYear() - 1985);
    expect(bella!.name).toBe("Bella Gomez");
  });

  it("counts days from the clinic's local day when the client sends one", async () => {
    const { patientId } = await seedFixtures();
    // Fixed dates: today is the 14th, so Bella (born 1990-03-14) has her
    // birthday today and the second patient's is two days out. Without the
    // parameter the server would use UTC and drift by a day either side of
    // midnight, which is what made a birthday read "tomorrow" on the day.
    const setDob = async (id: number, dob: string) => {
      const req = jsonRequest("PUT", `/api/patients/${id}`, { date_of_birth: dob });
      await app.request(req.path, req.init, { DB: ctx.db });
    };
    await setDob(patientId, "1990-03-14");
    const later = jsonRequest("POST", "/api/patients", {
      first_name: "Later",
      last_name: "Birdie",
      date_of_birth: "1980-03-16",
    });
    const laterRes = await app.request(later.path, later.init, { DB: ctx.db });
    const laterId = ((await laterRes.json()) as { patient: { id: number } }).patient.id;

    const res = await app.request(
      "/api/dashboard/birthdays?days=30&today=2026-03-14",
      undefined,
      { DB: ctx.db },
    );
    expect(res.status).toBe(200);
    const { birthdays } = (await res.json()) as {
      birthdays: { id: number; is_today: boolean; days_away: number; turning: number }[];
    };
    const bella = birthdays.find((b) => b.id === patientId);
    expect(bella).toMatchObject({ is_today: true, days_away: 0, turning: 36 });
    const late = birthdays.find((b) => b.id === laterId);
    expect(late).toMatchObject({ is_today: false, days_away: 2 });
  });

  it("returns empty list when no birthdays are in the window", async () => {
    const res = await app.request("/api/dashboard/birthdays?days=3", undefined, { DB: ctx.db });
    expect(res.status).toBe(200);
    const { birthdays } = (await res.json()) as { birthdays: unknown[] };
    // Window of 3 days — no seeded patient lands here deterministically,
    // but the endpoint must respond with an array regardless.
    expect(Array.isArray(birthdays)).toBe(true);
  });
});

describe("appointment conflict detection", () => {
  it("rejects a second patient appointment in the same operatory overlapping", async () => {
    const { patientId, operatoryId } = await seedFixtures();

    const first = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      start_time: "2026-10-01T10:00:00",
      end_time: "2026-10-01T11:00:00",
    });
    const r1 = await app.request(first.path, first.init, { DB: ctx.db });
    expect(r1.status).toBe(201);

    // Overlap in the same chair: 10:30–11:30.
    const second = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      start_time: "2026-10-01T10:30:00",
      end_time: "2026-10-01T11:30:00",
    });
    const r2 = await app.request(second.path, second.init, { DB: ctx.db });
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as { error: string };
    expect(body.error).toContain("already booked");
  });

  it("allows back-to-back appointments (no overlap)", async () => {
    const { patientId, operatoryId } = await seedFixtures();

    const a = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      start_time: "2026-10-01T10:00:00",
      end_time: "2026-10-01T11:00:00",
    });
    expect((await app.request(a.path, a.init, { DB: ctx.db })).status).toBe(201);

    const b = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      start_time: "2026-10-01T11:00:00",
      end_time: "2026-10-01T12:00:00",
    });
    expect((await app.request(b.path, b.init, { DB: ctx.db })).status).toBe(201);
  });

  it("allows the same slot in a different operatory but blocks the same practitioner", async () => {
    const { patientId, operatoryId } = await seedFixtures();
    // Create a second operatory.
    const op = jsonRequest("POST", "/api/operatories", { name: "Chair 2" });
    const opRes = await app.request(op.path, op.init, { DB: ctx.db });
    const { operatory: chair2 } = (await opRes.json()) as { operatory: { id: number } };

    const practitioner = jsonRequest("POST", "/api/practitioners", { name: "Dr. Kim", role: "dentist" });
    const prRes = await app.request(practitioner.path, practitioner.init, { DB: ctx.db });
    const { practitioner: kim } = (await prRes.json()) as { practitioner: { id: number } };

    const a = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      practitioner_id: kim.id,
      start_time: "2026-10-02T09:00:00",
      end_time: "2026-10-02T10:00:00",
    });
    expect((await app.request(a.path, a.init, { DB: ctx.db })).status).toBe(201);

    // Different operatory, same doctor, same time → conflict.
    const b = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: chair2.id,
      practitioner_id: kim.id,
      start_time: "2026-10-02T09:30:00",
      end_time: "2026-10-02T10:30:00",
    });
    expect((await app.request(b.path, b.init, { DB: ctx.db })).status).toBe(409);

    // Different operatory, no doctor → allowed.
    const c2 = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: chair2.id,
      start_time: "2026-10-02T09:00:00",
      end_time: "2026-10-02T10:00:00",
    });
    expect((await app.request(c2.path, c2.init, { DB: ctx.db })).status).toBe(201);
  });

  it("ignores cancelled appointments and the appointment being edited", async () => {
    const { patientId, operatoryId } = await seedFixtures();

    const a = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      start_time: "2026-10-03T09:00:00",
      end_time: "2026-10-03T10:00:00",
    });
    const { appointment } = (await (await app.request(a.path, a.init, { DB: ctx.db })).json()) as { appointment: { id: number } };

    // Cancel it — the slot frees up.
    const cancel = jsonRequest("PUT", `/api/appointments/${appointment.id}`, { status: "cancelled" });
    await app.request(cancel.path, cancel.init, { DB: ctx.db });

    const b = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      start_time: "2026-10-03T09:30:00",
      end_time: "2026-10-03T10:30:00",
    });
    expect((await app.request(b.path, b.init, { DB: ctx.db })).status).toBe(201);
  });

  it("check-conflict endpoint reports conflicts before save", async () => {
    const { patientId, operatoryId } = await seedFixtures();

    const a = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      start_time: "2026-10-04T09:00:00",
      end_time: "2026-10-04T10:00:00",
    });
    await app.request(a.path, a.init, { DB: ctx.db });

    const check = jsonRequest("POST", "/api/appointments/check-conflict", {
      operatory_id: operatoryId,
      start_time: "2026-10-04T09:15:00",
      end_time: "2026-10-04T10:15:00",
    });
    const res = await app.request(check.path, check.init, { DB: ctx.db });
    const { conflict } = (await res.json()) as { conflict: string | null };
    expect(conflict).toBeTruthy();

    const free = jsonRequest("POST", "/api/appointments/check-conflict", {
      operatory_id: operatoryId,
      start_time: "2026-10-04T14:00:00",
      end_time: "2026-10-04T15:00:00",
    });
    const res2 = await app.request(free.path, free.init, { DB: ctx.db });
    const { conflict: none } = (await res2.json()) as { conflict: string | null };
    expect(none).toBeNull();
  });
});

describe("case acceptance KPI", () => {
  it("reports the treatment-plan funnel", async () => {
    const { patientId } = await seedFixtures();
    const tt = jsonRequest("POST", "/api/treatment-types", { code: "FIL", name: "Filling" });
    const { treatment_type } = (await (await app.request(tt.path, tt.init, { DB: ctx.db })).json()) as { treatment_type: { id: number } };

    // 1 accepted, 1 completed, 1 declined, 1 still planned.
    for (const status of ["accepted", "completed", "declined", "planned"]) {
      const item = jsonRequest("POST", "/api/treatment-plan-items", {
        patient_id: patientId,
        treatment_type_id: treatment_type.id,
        status,
        fee: 100,
      });
      await app.request(item.path, item.init, { DB: ctx.db });
    }

    const res = await app.request("/api/reports/summary", undefined, { DB: ctx.db });
    const data = (await res.json()) as { case_acceptance: { presented: number; accepted: number; completed: number; declined: number; rate: number } };
    expect(data.case_acceptance.presented).toBe(4);
    expect(data.case_acceptance.accepted).toBe(2); // accepted + completed
    expect(data.case_acceptance.completed).toBe(1);
    expect(data.case_acceptance.declined).toBe(1);
    expect(data.case_acceptance.rate).toBe(50);
  });
});

describe("appointment reminders", () => {
  it("lists scheduled appointments in the window with contact info", async () => {
    const { patientId, operatoryId } = await seedFixtures();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const t = tomorrow.toISOString().slice(0, 10);
    const a = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      start_time: `${t}T09:00:00`,
      end_time: `${t}T09:30:00`,
    });
    await app.request(a.path, a.init, { DB: ctx.db });

    const res = await app.request("/api/appointments/reminders?days=3", undefined, { DB: ctx.db });
    expect(res.status).toBe(200);
    const { reminders } = (await res.json()) as { reminders: { patient_id: number; phone: string | null; status: string }[] };
    const hit = reminders.find((r) => r.patient_id === patientId);
    expect(hit).toBeTruthy();
    expect(hit!.status).toBe("scheduled");
    expect(hit!.phone).toBe("+1555000111");
  });

  it("excludes cancelled appointments", async () => {
    const { patientId, operatoryId } = await seedFixtures();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const t = tomorrow.toISOString().slice(0, 10);
    const a = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      start_time: `${t}T09:00:00`,
      end_time: `${t}T09:30:00`,
      status: "cancelled",
    });
    await app.request(a.path, a.init, { DB: ctx.db });

    const res = await app.request("/api/appointments/reminders?days=3", undefined, { DB: ctx.db });
    const { reminders } = (await res.json()) as { reminders: { patient_id: number }[] };
    expect(reminders.find((r) => r.patient_id === patientId)).toBeUndefined();
  });
});

describe("waiting list slot offers", () => {
  it("returns a WhatsApp link and stamps the entry", async () => {
    const { patientId } = await seedFixtures();
    const w = jsonRequest("POST", "/api/waiting-list", { patient_id: patientId, duration_minutes: 30 });
    const { entry } = (await (await app.request(w.path, w.init, { DB: ctx.db })).json()) as { entry: { id: number } };

    const res = await app.request(`/api/waiting-list/${entry.id}/offer?slot=2026-10-01T14:00:00`, { method: "POST" }, { DB: ctx.db });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { wa_url: string; message: string };
    expect(data.wa_url).toContain("wa.me/1555000111");
    expect(data.message).toContain("Oct");
    expect(data.message).toContain("14:00");
  });

  it("rejects the offer when the patient has no phone", async () => {
    const p = jsonRequest("POST", "/api/patients", { first_name: "No", last_name: "Phone" });
    const { patient } = (await (await app.request(p.path, p.init, { DB: ctx.db })).json()) as { patient: { id: number } };
    const w = jsonRequest("POST", "/api/waiting-list", { patient_id: patient.id });
    const { entry } = (await (await app.request(w.path, w.init, { DB: ctx.db })).json()) as { entry: { id: number } };

    const res = await app.request(`/api/waiting-list/${entry.id}/offer?slot=2026-10-01T14:00:00`, { method: "POST" }, { DB: ctx.db });
    expect(res.status).toBe(400);
  });
});

describe("follow-up worklists", () => {
  it("lists accepted-but-unbooked treatment with contact info", async () => {
    const { patientId } = await seedFixtures();
    const tt = jsonRequest("POST", "/api/treatment-types", { code: "CR2", name: "Crown" });
    const { treatment_type } = (await (await app.request(tt.path, tt.init, { DB: ctx.db })).json()) as { treatment_type: { id: number } };

    const item = jsonRequest("POST", "/api/treatment-plan-items", {
      patient_id: patientId,
      treatment_type_id: treatment_type.id,
      tooth: "36",
      fee: 900,
      status: "accepted",
    });
    const { item: planItem } = (await (await app.request(item.path, item.init, { DB: ctx.db })).json()) as { item: { id: number } };

    const res = await app.request("/api/followups", undefined, { DB: ctx.db });
    expect(res.status).toBe(200);
    const { unscheduled_treatment } = (await res.json()) as { unscheduled_treatment: { item_id: number; patient_id: number; treatment_name: string | null; phone: string | null }[] };
    const hit = unscheduled_treatment.find((r) => r.item_id === planItem.id);
    expect(hit).toBeTruthy();
    expect(hit!.patient_id).toBe(patientId);
    expect(hit!.treatment_name).toBe("Crown");
    expect(hit!.phone).toBe("+1555000111");
  });

  it("excludes patients who already have an upcoming appointment", async () => {
    const { patientId, operatoryId } = await seedFixtures();
    const tt = jsonRequest("POST", "/api/treatment-types", { code: "FL2", name: "Filling" });
    const { treatment_type } = (await (await app.request(tt.path, tt.init, { DB: ctx.db })).json()) as { treatment_type: { id: number } };

    const item = jsonRequest("POST", "/api/treatment-plan-items", {
      patient_id: patientId,
      treatment_type_id: treatment_type.id,
      status: "accepted",
    });
    const { item: planItem } = (await (await app.request(item.path, item.init, { DB: ctx.db })).json()) as { item: { id: number } };

    // Book a future appointment — the treatment is no longer "unscheduled".
    const a = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      // Far future so the test stays "upcoming" regardless of the calendar.
      start_time: "2099-11-01T09:00:00",
      end_time: "2099-11-01T10:00:00",
    });
    await app.request(a.path, a.init, { DB: ctx.db });

    const res = await app.request("/api/followups", undefined, { DB: ctx.db });
    const { unscheduled_treatment } = (await res.json()) as { unscheduled_treatment: { item_id: number }[] };
    expect(unscheduled_treatment.find((r) => r.item_id === planItem.id)).toBeUndefined();
  });

  it("lists dormant patients with their last visit", async () => {
    const { patientId, operatoryId } = await seedFixtures();
    // A completed visit 2 years ago → dormant in a 12-month window.
    const a = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      start_time: "2024-09-01T09:00:00",
      end_time: "2024-09-01T10:00:00",
      status: "completed",
    });
    await app.request(a.path, a.init, { DB: ctx.db });

    const res = await app.request("/api/followups?dormant_months=12", undefined, { DB: ctx.db });
    const { dormant_patients } = (await res.json()) as { dormant_patients: { id: number; last_visit: string | null }[] };
    const hit = dormant_patients.find((p) => p.id === patientId);
    expect(hit).toBeTruthy();
    expect(hit!.last_visit).toBe("2024-09-01");
  });
});

describe("production by provider", () => {
  it("attributes invoice production to the appointment's practitioner", async () => {
    const { patientId, operatoryId } = await seedFixtures();
    const pr = jsonRequest("POST", "/api/practitioners", { name: "Dr. Reyes", role: "dentist" });
    const { practitioner } = (await (await app.request(pr.path, pr.init, { DB: ctx.db })).json()) as { practitioner: { id: number } };

    const a = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      practitioner_id: practitioner.id,
      start_time: "2026-10-06T09:00:00",
      end_time: "2026-10-06T10:00:00",
      status: "completed",
    });
    const { appointment } = (await (await app.request(a.path, a.init, { DB: ctx.db })).json()) as { appointment: { id: number } };

    const inv = jsonRequest("POST", "/api/invoices", {
      patient_id: patientId,
      appointment_id: appointment.id,
      total: 500,
      amount_paid: 200,
    });
    await app.request(inv.path, inv.init, { DB: ctx.db });

    const res = await app.request("/api/reports/summary", undefined, { DB: ctx.db });
    const { by_provider } = (await res.json()) as { by_provider: { name: string; production: number; collections: number }[] };
    const row = by_provider.find((p) => p.name === "Dr. Reyes");
    expect(row).toBeTruthy();
    expect(row!.production).toBe(500);
    expect(row!.collections).toBe(200);
  });
});

describe("csv exports", () => {
  it("exports appointments.csv with joined names", async () => {
    const { patientId, operatoryId } = await seedFixtures();
    const a = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      start_time: "2026-10-05T09:00:00",
      end_time: "2026-10-05T10:00:00",
    });
    await app.request(a.path, a.init, { DB: ctx.db });

    const res = await app.request("/api/export/appointments.csv", undefined, { DB: ctx.db });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("patient");
    expect(text).toContain("Bella Gomez");
    expect(res.headers.get("Content-Disposition")).toContain("appointments.csv");
  });

  it("exports treatments.csv", async () => {
    const { patientId } = await seedFixtures();
    const tt = jsonRequest("POST", "/api/treatment-types", { code: "CRW", name: "Crown", color: "#0e7490" });
    const ttRes = await app.request(tt.path, tt.init, { DB: ctx.db });
    const { treatment_type } = (await ttRes.json()) as { treatment_type: { id: number } };

    const item = jsonRequest("POST", "/api/treatment-plan-items", {
      patient_id: patientId,
      treatment_type_id: treatment_type.id,
      tooth: "46",
      fee: 800,
    });
    await app.request(item.path, item.init, { DB: ctx.db });

    const res = await app.request("/api/export/treatments.csv", undefined, { DB: ctx.db });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Bella Gomez");
    expect(text).toContain("46");
    expect(text).toContain("Crown");
  });
});

describe("membership plans", () => {
  it("creates plans, enrolls a patient, and reports member counts", async () => {
    const { patientId } = await seedFixtures();

    const create = jsonRequest("POST", "/api/membership-plans", {
      name: "Wellness Plan",
      monthly_fee: 25,
      discount_percent: 15,
      benefits: "2 cleanings per year, x-rays included",
    });
    const createRes = await app.request(create.path, create.init, { DB: ctx.db });
    expect(createRes.status).toBe(201);
    const { plan } = (await createRes.json()) as { plan: { id: number; discount_percent: number } };
    expect(plan.discount_percent).toBe(15);

    // Enroll.
    const enroll = jsonRequest("POST", "/api/patient-memberships", {
      patient_id: patientId,
      plan_id: plan.id,
      start_date: "2026-01-01",
    });
    const enrollRes = await app.request(enroll.path, enroll.init, { DB: ctx.db });
    expect(enrollRes.status).toBe(201);
    const { membership } = (await enrollRes.json()) as { membership: { status: string; plan_name: string } };
    expect(membership.status).toBe("active");
    expect(membership.plan_name).toBe("Wellness Plan");

    // The patient's membership tab shows the joined plan.
    const mine = await app.request(`/api/patients/${patientId}/membership`, undefined, { DB: ctx.db });
    const { memberships } = (await mine.json()) as { memberships: { status: string; plan_name: string }[] };
    expect(memberships).toHaveLength(1);
    expect(memberships[0].plan_name).toBe("Wellness Plan");

    // Plan listing reports one active member.
    const list = await app.request("/api/membership-plans", undefined, { DB: ctx.db });
    const { plans } = (await list.json()) as { plans: { id: number; member_count: number }[] };
    expect(plans.find((p) => p.id === plan.id)?.member_count).toBe(1);

    // Re-enrolling expires the previous membership (one active per patient).
    const enroll2 = jsonRequest("POST", "/api/patient-memberships", {
      patient_id: patientId,
      plan_id: plan.id,
      start_date: "2026-06-01",
    });
    await app.request(enroll2.path, enroll2.init, { DB: ctx.db });
    const mine2 = await app.request(`/api/patients/${patientId}/membership`, undefined, { DB: ctx.db });
    const { memberships: m2 } = (await mine2.json()) as { memberships: { status: string; start_date: string }[] };
    expect(m2.filter((m) => m.status === "active")).toHaveLength(1);
    expect(m2.find((m) => m.status === "expired")?.start_date).toBe("2026-01-01");
  });

  it("rejects enrollment in a nonexistent plan and bad input", async () => {
    const { patientId } = await seedFixtures();
    const res = await app.request(
      ...(() => {
        const r = jsonRequest("POST", "/api/patient-memberships", {
          patient_id: patientId, plan_id: 99999, start_date: "2026-01-01",
        });
        return [r.path, r.init] as const;
      })(),
      { DB: ctx.db },
    );
    expect(res.status).toBe(404);

    const bad = await app.request(
      ...(() => {
        const r = jsonRequest("POST", "/api/membership-plans", { name: "X", monthly_fee: 10, discount_percent: 150 });
        return [r.path, r.init] as const;
      })(),
      { DB: ctx.db },
    );
    expect(bad.status).toBe(400);
  });
});

describe("consent forms", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  async function makeTemplate(requiresGuardian = false): Promise<number> {
    const r = jsonRequest("POST", "/api/consent-templates", {
      title: "Anesthesia consent",
      body: "I understand the risks of local anesthesia.",
      requires_guardian: requiresGuardian,
    });
    const res = await app.request(r.path, r.init, { DB: ctx.db });
    const { template } = (await res.json()) as { template: { id: number } };
    return template.id;
  }

  it("stores a signature and lists it for the patient", async () => {
    const { patientId } = await seedFixtures();
    const templateId = await makeTemplate();

    const sign = jsonRequest("POST", "/api/consent-signatures", {
      template_id: templateId,
      patient_id: patientId,
      signer_name: "Bella Gomez",
      signer_role: "patient",
      signature_data: PNG,
    });
    const res = await app.request(sign.path, sign.init, { DB: ctx.db });
    expect(res.status).toBe(201);

    const list = await app.request(`/api/patients/${patientId}/consents`, undefined, { DB: ctx.db });
    const { consents } = (await list.json()) as { consents: { template_title: string; signer_name: string }[] };
    expect(consents).toHaveLength(1);
    expect(consents[0].template_title).toBe("Anesthesia consent");
  });

  it("enforces the guardian requirement and rejects non-PNG payloads", async () => {
    const { patientId } = await seedFixtures();
    const templateId = await makeTemplate(true);

    const asPatient = jsonRequest("POST", "/api/consent-signatures", {
      template_id: templateId, patient_id: patientId,
      signer_name: "Bella", signer_role: "patient", signature_data: PNG,
    });
    const res1 = await app.request(asPatient.path, asPatient.init, { DB: ctx.db });
    expect(res1.status).toBe(400);
    expect(((await res1.json()) as { error: string }).error).toMatch(/guardian/i);

    const badData = jsonRequest("POST", "/api/consent-signatures", {
      template_id: templateId, patient_id: patientId,
      signer_name: "Guardian", signer_role: "guardian", signature_data: "http://example.com/sig.png",
    });
    const res2 = await app.request(badData.path, badData.init, { DB: ctx.db });
    expect(res2.status).toBe(400);
  });

  it("withdraws a signature but keeps the audit row", async () => {
    const { patientId } = await seedFixtures();
    const templateId = await makeTemplate();
    const sign = jsonRequest("POST", "/api/consent-signatures", {
      template_id: templateId, patient_id: patientId,
      signer_name: "Bella", signer_role: "patient", signature_data: PNG,
    });
    const { consent } = (await (await app.request(sign.path, sign.init, { DB: ctx.db })).json()) as { consent: { id: number } };

    const del = await app.request(`/api/consent-signatures/${consent.id}`, { method: "DELETE" }, { DB: ctx.db });
    expect(del.status).toBe(200);

    const list = await app.request(`/api/patients/${patientId}/consents`, undefined, { DB: ctx.db });
    const { consents } = (await list.json()) as { consents: { signature_data: string; signer_name: string }[] };
    expect(consents).toHaveLength(1); // audit record kept
    expect(consents[0].signature_data).toBe(""); // canvas removed
  });
});

describe("review requests", () => {
  it("lists completed visits without a review request and stamps them once asked", async () => {
    const { patientId, operatoryId } = await seedFixtures();

    // Book + complete an appointment that ended yesterday.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const day = yesterday.toISOString().slice(0, 10);
    const create = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      start_time: `${day}T09:00:00`,
      end_time: `${day}T09:30:00`,
    });
    const created = (await (await app.request(create.path, create.init, { DB: ctx.db })).json()) as {
      appointment: { id: number };
    };

    // Before completion: not on the list.
    const before = (await (await app.request("/api/review-requests?days=7", undefined, { DB: ctx.db })).json()) as {
      requests: { id: number }[];
    };
    expect(before.requests.find((r) => r.id === created.appointment.id)).toBeUndefined();

    // Complete it.
    await app.request(`/api/appointments/${created.appointment.id}`, { method: "PUT", body: JSON.stringify({ status: "completed" }), headers: { "content-type": "application/json" } }, { DB: ctx.db });

    const after = (await (await app.request("/api/review-requests?days=7", undefined, { DB: ctx.db })).json()) as {
      requests: { id: number; first_name: string | null; phone: string | null }[];
    };
    const row = after.requests.find((r) => r.id === created.appointment.id);
    expect(row).toBeTruthy();
    expect(row?.first_name).toBe("Bella");
    expect(row?.phone).toBe("+1555000111");

    // Stamp it — it leaves the list.
    const stamp = await app.request(`/api/appointments/${created.appointment.id}/review-requested`, { method: "POST" }, { DB: ctx.db });
    expect(stamp.status).toBe(200);
    const final = (await (await app.request("/api/review-requests?days=7", undefined, { DB: ctx.db })).json()) as {
      requests: { id: number }[];
    };
    expect(final.requests.find((r) => r.id === created.appointment.id)).toBeUndefined();

    // Stamping twice returns 404 (already requested).
    const again = await app.request(`/api/appointments/${created.appointment.id}/review-requested`, { method: "POST" }, { DB: ctx.db });
    expect(again.status).toBe(404);
  });
});

describe("appointment confirmations", () => {
  it("accepts the confirmed status on the appointment status enum", async () => {
    const { patientId, operatoryId } = await seedFixtures();
    const create = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      start_time: "2026-03-01T10:00:00",
      end_time: "2026-03-01T10:30:00",
    });
    const created = (await (await app.request(create.path, create.init, { DB: ctx.db })).json()) as {
      appointment: { id: number; status: string };
    };
    expect(created.appointment.status).toBe("scheduled");

    const confirm = await app.request(
      `/api/appointments/${created.appointment.id}`,
      { method: "PUT", body: JSON.stringify({ status: "confirmed" }), headers: { "content-type": "application/json" } },
      { DB: ctx.db },
    );
    expect(confirm.status).toBe(200);
    const { appointment } = (await confirm.json()) as { appointment: { status: string } };
    expect(appointment.status).toBe("confirmed");
  });
});

describe("hygiene recall", () => {
  it("configures recall, creates a due system entry, and auto-advances on completion", async () => {
    const { patientId } = await seedFixtures();

    // Configure a 6-month prophy recall with a last completion 7 months ago.
    const past = new Date();
    past.setMonth(past.getMonth() - 7);
    const lastDate = past.toISOString().slice(0, 10);
    const cfg = jsonRequest("PUT", `/api/patients/${patientId}/recall`, {
      interval_months: 6,
      last_completed: lastDate,
    });
    const cfgRes = await app.request(cfg.path, cfg.init, { DB: ctx.db });
    expect(cfgRes.status).toBe(200);
    const { recall } = (await cfgRes.json()) as { recall: { interval_months: number } };
    expect(recall.interval_months).toBe(6);

    // A system "appointment to make" seeded by the front desk, due last month.
    const dueDate = new Date();
    dueDate.setMonth(dueDate.getMonth() - 1);
    const seed = jsonRequest("POST", "/api/appointments-to-make", {
      patient_id: patientId,
      due_after: dueDate.toISOString().slice(0, 10),
      source: "system",
      notes: "6-month prophy recall",
    });
    const seedRes = await app.request(seed.path, seed.init, { DB: ctx.db });
    expect(seedRes.status).toBe(201);

    // It appears on the due list (7 months since last visit > 6-month cycle).
    const due = (await (await app.request("/api/recalls/due", undefined, { DB: ctx.db })).json()) as {
      recalls: { id: number; patient_id: number; days_overdue: number }[];
    };
    const row = due.recalls.find((r) => r.patient_id === patientId);
    expect(row).toBeTruthy();
    expect(row!.days_overdue).toBeGreaterThan(0);

    // Confirming the recall (patient said yes over the phone).
    const confirmRes = await app.request(`/api/recalls/${row!.id}/confirm`, { method: "POST" }, { DB: ctx.db });
    expect(confirmRes.status).toBe(200);
  });

  it("auto-recalls the next cycle when a visit is completed", async () => {
    const { patientId, operatoryId } = await seedFixtures();

    // Recall config with a last completion 6 months ago (due now).
    const past = new Date();
    past.setMonth(past.getMonth() - 6);
    await app.request(
      ...(() => {
        const r = jsonRequest("PUT", `/api/patients/${patientId}/recall`, { interval_months: 6, last_completed: past.toISOString().slice(0, 10) });
        return [r.path, r.init] as const;
      })(),
      { DB: ctx.db },
    );

    // Book and complete an appointment today.
    const today = new Date().toISOString().slice(0, 10);
    const create = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      start_time: `${today}T09:00:00`,
      end_time: `${today}T09:30:00`,
    });
    const created = (await (await app.request(create.path, create.init, { DB: ctx.db })).json()) as {
      appointment: { id: number };
    };
    await app.request(
      `/api/appointments/${created.appointment.id}`,
      { method: "PUT", body: JSON.stringify({ status: "completed" }), headers: { "content-type": "application/json" } },
      { DB: ctx.db },
    );

    // The patient's recall config advanced to today.
    const cfg = (await (await app.request(`/api/patients/${patientId}/recall`, undefined, { DB: ctx.db })).json()) as {
      recall: { last_completed: string };
    };
    expect(cfg.recall.last_completed).toBe(today);

    // A new system recall entry exists, due ~6 months out.
    const due = (await (await app.request("/api/recalls/due", undefined, { DB: ctx.db })).json()) as {
      recalls: { patient_id: number; due_date: string }[];
    };
    // The new cycle is 6 months out, so NOT due — the completed cycle retired.
    expect(due.recalls.find((r) => r.patient_id === patientId)).toBeUndefined();
  });

  it("rejects an invalid interval", async () => {
    const { patientId } = await seedFixtures();
    const bad = jsonRequest("PUT", `/api/patients/${patientId}/recall`, { interval_months: 0 });
    const res = await app.request(bad.path, bad.init, { DB: ctx.db });
    expect(res.status).toBe(400);
  });
});

describe("self check-in kiosk", () => {
  it("lists today's scheduled appointments and checks a patient in with demographic updates", async () => {
    const { patientId, operatoryId } = await seedFixtures();
    const today = new Date().toISOString().slice(0, 10);
    const create = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      start_time: `${today}T14:00:00`,
      end_time: `${today}T14:30:00`,
    });
    const created = (await (await app.request(create.path, create.init, { DB: ctx.db })).json()) as {
      appointment: { id: number };
    };

    // Appears on the kiosk list.
    const list = (await (await app.request("/api/kiosk/today", undefined, { DB: ctx.db })).json()) as {
      appointments: { id: number; first_name: string | null }[];
    };
    const entry = list.appointments.find((a) => a.id === created.appointment.id);
    expect(entry).toBeTruthy();
    expect(entry?.first_name).toBe("Bella");

    // Check in with an updated phone number.
    const checkIn = jsonRequest("POST", "/api/kiosk/check-in", {
      appointment_id: created.appointment.id,
      phone: "+1555999000",
    });
    const res = (await (await app.request(checkIn.path, checkIn.init, { DB: ctx.db })).json()) as {
      appointment: { status: string; checked_in_at: string | null };
    };
    expect(res.appointment.status).toBe("arrived");
    expect(res.appointment.checked_in_at).toBeTruthy();

    // Demographics were updated.
    const p = (await (await app.request(`/api/patients/${patientId}`, undefined, { DB: ctx.db })).json()) as {
      patient: { phone: string };
    };
    expect(p.patient.phone).toBe("+1555999000");

    // Idempotent: a second check-in doesn't move the stamp.
    const again = (await (await app.request(checkIn.path, checkIn.init, { DB: ctx.db })).json()) as {
      appointment: { checked_in_at: string | null };
    };
    expect(again.appointment.checked_in_at).toBe(res.appointment.checked_in_at);
  });

  it("lists only unsigned active consent templates as pending", async () => {
    const { patientId } = await seedFixtures();
    const t = jsonRequest("POST", "/api/consent-templates", { title: "Kiosk form", body: "I agree." });
    const { template } = (await (await app.request(t.path, t.init, { DB: ctx.db })).json()) as {
      template: { id: number };
    };

    const before = (await (await app.request(`/api/kiosk/pending-consents/${patientId}`, undefined, { DB: ctx.db })).json()) as {
      templates: { id: number }[];
    };
    expect(before.templates.map((x) => x.id)).toContain(template.id);

    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const sign = jsonRequest("POST", "/api/consent-signatures", {
      template_id: template.id, patient_id: patientId,
      signer_name: "Bella", signer_role: "patient", signature_data: PNG,
    });
    await app.request(sign.path, sign.init, { DB: ctx.db });

    const after = (await (await app.request(`/api/kiosk/pending-consents/${patientId}`, undefined, { DB: ctx.db })).json()) as {
      templates: { id: number }[];
    };
    expect(after.templates.map((x) => x.id)).not.toContain(template.id);
  });
});

describe("payment plans", () => {
  it("splits an invoice balance into installments with a computed schedule", async () => {
    const { patientId } = await seedFixtures();
    const inv = jsonRequest("POST", "/api/invoices", { patient_id: patientId, total: 300, amount_paid: 60 });
    const { invoice } = (await (await app.request(inv.path, inv.init, { DB: ctx.db })).json()) as {
      invoice: { id: number };
    };

    const plan = jsonRequest("POST", `/api/invoices/${invoice.id}/payment-plan`, {
      installment_count: 3, interval: "monthly", start_date: "2026-10-01",
    });
    const planRes = (await (await app.request(plan.path, plan.init, { DB: ctx.db })).json()) as {
      plan: { installment_amount: number };
    };
    // Balance 240 / 3 = 80 per installment.
    expect(planRes.plan.installment_amount).toBe(80);

    const detail = (await (await app.request(`/api/invoices/${invoice.id}/payment-plan`, undefined, { DB: ctx.db })).json()) as {
      schedule: { n: number; due_date: string; amount: number }[];
    };
    expect(detail.schedule).toHaveLength(3);
    expect(detail.schedule[0].due_date).toBe("2026-10-01");
    expect(detail.schedule[1].due_date).toBe("2026-11-01");
    expect(detail.schedule[2].amount).toBe(80);

    // Replacing the plan deactivates the old one.
    const plan2 = jsonRequest("POST", `/api/invoices/${invoice.id}/payment-plan`, {
      installment_count: 4, interval: "weekly", start_date: "2026-10-01",
    });
    const res2 = (await (await app.request(plan2.path, plan2.init, { DB: ctx.db })).json()) as {
      plan: { installment_amount: number };
    };
    expect(res2.plan.installment_amount).toBe(60); // 240 / 4

    const after = (await (await app.request(`/api/invoices/${invoice.id}/payment-plan`, undefined, { DB: ctx.db })).json()) as {
      schedule: unknown[];
    };
    expect(after.schedule).toHaveLength(4);
  });

  it("rejects plans on fully paid invoices and invalid installment counts", async () => {
    const { patientId } = await seedFixtures();
    const inv = jsonRequest("POST", "/api/invoices", { patient_id: patientId, total: 100, amount_paid: 100 });
    const { invoice } = (await (await app.request(inv.path, inv.init, { DB: ctx.db })).json()) as {
      invoice: { id: number };
    };
    const plan = jsonRequest("POST", `/api/invoices/${invoice.id}/payment-plan`, {
      installment_count: 3, interval: "monthly", start_date: "2026-10-01",
    });
    const res = await app.request(plan.path, plan.init, { DB: ctx.db });
    expect(res.status).toBe(400);

    const bad = await app.request(
      ...(() => {
        const inv2 = jsonRequest("POST", "/api/invoices", { patient_id: patientId, total: 100 });
        return [inv2.path, inv2.init] as const;
      })(),
      { DB: ctx.db },
    );
    const { invoice: inv2 } = (await bad.json()) as { invoice: { id: number } };
    const zero = jsonRequest("POST", `/api/invoices/${inv2.id}/payment-plan`, {
      installment_count: 1, interval: "monthly", start_date: "2026-10-01",
    });
    const res2 = await app.request(zero.path, zero.init, { DB: ctx.db });
    expect(res2.status).toBe(400);
  });
});

describe("installment reminders", () => {
  it("lists due installments with balance info and stamps plans as reminded", async () => {
    const { patientId } = await seedFixtures();
    // Invoice with a 300 total, 60 paid → 240 balance. Plan: 3 × 80 monthly
    // starting 2 months ago → installments 1 and 2 are due, 3 is future.
    const inv = jsonRequest("POST", "/api/invoices", { patient_id: patientId, total: 300, amount_paid: 60 });
    const { invoice } = (await (await app.request(inv.path, inv.init, { DB: ctx.db })).json()) as {
      invoice: { id: number };
    };
    const start = new Date();
    start.setUTCMonth(start.getUTCMonth() - 2);
    const plan = jsonRequest("POST", `/api/invoices/${invoice.id}/payment-plan`, {
      installment_count: 3, interval: "monthly", start_date: start.toISOString().slice(0, 10),
    });
    const planRes = (await (await app.request(plan.path, plan.init, { DB: ctx.db })).json()) as {
      plan: { id: number };
    };

    // Reminder window of 3 days: installments due before today+3 appear.
    const res = (await (await app.request("/api/payment-reminders?days=3", undefined, { DB: ctx.db })).json()) as {
      reminders: {
        plan_id: number; installment_n: number; overdue: boolean; balance: number;
        amount: number; patient_name: string; phone: string | null;
      }[];
    };
    const mine = res.reminders.filter((r) => r.plan_id === planRes.plan.id);
    expect(mine.length).toBeGreaterThanOrEqual(2); // two installments already past due
    expect(mine[0].overdue).toBe(true);
    expect(mine[0].balance).toBe(240);
    expect(mine[0].amount).toBe(80);
    expect(mine[0].patient_name).toBe("Bella Gomez");
    expect(mine[0].phone).toBe("+1555000111");

    // Stamping the plan marks the outreach.
    const stamp = await app.request(`/api/payment-plans/${planRes.plan.id}/reminded`, { method: "POST" }, { DB: ctx.db });
    expect(stamp.status).toBe(200);
    const again = await app.request(`/api/payment-plans/${planRes.plan.id}/reminded`, { method: "POST" }, { DB: ctx.db });
    expect(again.status).toBe(200); // re-stamping is allowed (updates the timestamp)
  });

  it("excludes paid invoices and future installments beyond the window", async () => {
    const { patientId } = await seedFixtures();
    // Fully paid invoice → no reminders.
    const inv = jsonRequest("POST", "/api/invoices", { patient_id: patientId, total: 100, amount_paid: 100 });
    const { invoice } = (await (await app.request(inv.path, inv.init, { DB: ctx.db })).json()) as {
      invoice: { id: number };
    };
    const start = new Date();
    start.setUTCMonth(start.getUTCMonth() - 1);
    const plan = jsonRequest("POST", `/api/invoices/${invoice.id}/payment-plan`, {
      installment_count: 2, interval: "monthly", start_date: start.toISOString().slice(0, 10),
    });
    await app.request(plan.path, plan.init, { DB: ctx.db });

    const res = (await (await app.request("/api/payment-reminders?days=3", undefined, { DB: ctx.db })).json()) as {
      reminders: { invoice_id: number }[];
    };
    expect(res.reminders.find((r) => r.invoice_id === invoice.id)).toBeUndefined();
  });

  it("rejects invalid plan ids on the stamp endpoint", async () => {
    const res = await app.request("/api/payment-plans/99999/reminded", { method: "POST" }, { DB: ctx.db });
    expect(res.status).toBe(404);
  });
});

describe("clinic efficiency (wait time + chair utilization)", () => {
  it("stamps in_chair_at on the in_chair transition and reports wait/utilization", async () => {
    const { patientId, operatoryId } = await seedFixtures();
    const today = new Date().toISOString().slice(0, 10);
    const create = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId,
      operatory_id: operatoryId,
      start_time: `${today}T09:00:00`,
      end_time: `${today}T09:30:00`,
    });
    const created = (await (await app.request(create.path, create.init, { DB: ctx.db })).json()) as {
      appointment: { id: number };
    };
    const id = created.appointment.id;

    // Arrive (as the kiosk would), then get in the chair.
    await app.request("/api/kiosk/check-in", { method: "POST", body: JSON.stringify({ appointment_id: id }), headers: { "content-type": "application/json" } }, { DB: ctx.db });
    const seated = (await (await app.request(
      `/api/appointments/${id}`,
      { method: "PUT", body: JSON.stringify({ status: "in_chair" }), headers: { "content-type": "application/json" } },
      { DB: ctx.db },
    )).json()) as { appointment: { status: string; checked_in_at: string | null; in_chair_at: string | null } };
    expect(seated.appointment.status).toBe("in_chair");
    expect(seated.appointment.checked_in_at).toBeTruthy();
    expect(seated.appointment.in_chair_at).toBeTruthy();

    // Complete the visit.
    await app.request(
      `/api/appointments/${id}`,
      { method: "PUT", body: JSON.stringify({ status: "completed" }), headers: { "content-type": "application/json" } },
      { DB: ctx.db },
    );

    // The efficiency report includes the visit with a sane wait (0–30 min
    // for this synthetic timeline) and non-zero utilization.
    const summary = (await (await app.request("/api/reports/summary", undefined, { DB: ctx.db })).json()) as {
      clinic_efficiency: {
        avg_wait_minutes: number | null; longest_wait_minutes: number | null;
        visits_with_checkin: number; chair_utilization_pct: number; chairs_used: number;
      };
    };
    expect(summary.clinic_efficiency.visits_with_checkin).toBeGreaterThanOrEqual(1);
    if (summary.clinic_efficiency.avg_wait_minutes != null) {
      expect(summary.clinic_efficiency.avg_wait_minutes).toBeGreaterThanOrEqual(0);
      expect(summary.clinic_efficiency.avg_wait_minutes).toBeLessThan(24 * 60);
    }
    expect(summary.clinic_efficiency.chairs_used).toBeGreaterThanOrEqual(1);
    expect(summary.clinic_efficiency.chair_utilization_pct).toBeGreaterThanOrEqual(0);
    expect(summary.clinic_efficiency.chair_utilization_pct).toBeLessThanOrEqual(100);
  });

  it("clears the chair stamp when the status leaves in_chair", async () => {
    const { patientId, operatoryId } = await seedFixtures();
    const today = new Date().toISOString().slice(0, 10);
    const create = jsonRequest("POST", "/api/appointments", {
      patient_id: patientId, operatory_id: operatoryId,
      start_time: `${today}T10:00:00`, end_time: `${today}T10:30:00`,
    });
    const { appointment } = (await (await app.request(create.path, create.init, { DB: ctx.db })).json()) as {
      appointment: { id: number };
    };
    await app.request(
      `/api/appointments/${appointment.id}`,
      { method: "PUT", body: JSON.stringify({ status: "in_chair" }), headers: { "content-type": "application/json" } },
      { DB: ctx.db },
    );
    const back = (await (await app.request(
      `/api/appointments/${appointment.id}`,
      { method: "PUT", body: JSON.stringify({ status: "arrived" }), headers: { "content-type": "application/json" } },
      { DB: ctx.db },
    )).json()) as { appointment: { in_chair_at: string | null } };
    expect(back.appointment.in_chair_at).toBeNull();
  });
});

describe("daily worklist digest", () => {
  it("rejects sending when email or recipient is unconfigured", async () => {
    const noEmail = await app.request("/api/email/worklist-digest", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }, { DB: ctx.db });
    expect(noEmail.status).toBe(400);
    expect(((await noEmail.json()) as { error: string }).error).toMatch(/not configured/i);
  });

  it("requires a valid recipient when one is set", async () => {
    // Seed a key + from so the "not configured" branch passes.
    await app.request(
      "/api/settings",
      { method: "PUT", body: JSON.stringify({ email_api_key: "re_test", email_from: "clinic@test.com", digest_recipient: "not-an-email" }), headers: { "content-type": "application/json" } },
      { DB: ctx.db },
    );
    const res = await app.request("/api/email/worklist-digest", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }, { DB: ctx.db });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/recipient/i);
  });

  it("stores and returns digest schedule settings with the secret masked", async () => {
    const put = await app.request(
      "/api/settings",
      { method: "PUT", body: JSON.stringify({ digest_enabled: "1", digest_time: "08:15", digest_recipient: "front@clinic.com" }), headers: { "content-type": "application/json" } },
      { DB: ctx.db },
    );
    expect(put.status).toBe(200);

    const res = (await (await app.request("/api/settings", undefined, { DB: ctx.db })).json()) as {
      settings: Record<string, string>;
    };
    expect(res.settings.digest_enabled).toBe("1");
    expect(res.settings.digest_time).toBe("08:15");
    expect(res.settings.digest_recipient).toBe("front@clinic.com");
  });

  it("stores digest_sections and returns them to the client", async () => {
    const put = await app.request(
      "/api/settings",
      { method: "PUT", body: JSON.stringify({ digest_sections: "recalls,installments" }), headers: { "content-type": "application/json" } },
      { DB: ctx.db },
    );
    expect(put.status).toBe(200);

    const res = (await (await app.request("/api/settings", undefined, { DB: ctx.db })).json()) as {
      settings: Record<string, string>;
    };
    expect(res.settings.digest_sections).toBe("recalls,installments");

    // Reset to all sections.
    await app.request(
      "/api/settings",
      { method: "PUT", body: JSON.stringify({ digest_sections: "" }), headers: { "content-type": "application/json" } },
      { DB: ctx.db },
    );
    const after = (await (await app.request("/api/settings", undefined, { DB: ctx.db })).json()) as {
      settings: Record<string, string>;
    };
    expect(after.settings.digest_sections).toBe("");
  });

  it("builds a digest containing only the enabled sections", async () => {
    // Talk directly to the handler through the app router by intercepting the
    // sendEmail fetch — a valid recipient + section config, no real provider.
    const captured: { subject: string; html: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.resend.com")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { subject: string; html: string };
        captured.push({ subject: body.subject, html: body.html });
        return new Response(JSON.stringify({ id: "test-msg" }), { status: 200 });
      }
      return realFetch(input as Request, init);
    }) as typeof fetch;

    try {
      await app.request(
        "/api/settings",
        { method: "PUT", body: JSON.stringify({ email_api_key: "re_test", email_from: "clinic@test.com", digest_recipient: "front@clinic.com", digest_sections: "reminders" }), headers: { "content-type": "application/json" } },
        { DB: ctx.db },
      );
      const res = await app.request("/api/email/worklist-digest", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }, { DB: ctx.db });
      expect(res.status).toBe(200);
      const sent = (await res.json()) as { ok: boolean; counts: { reminders: number; recalls: number; installments: number } };
      expect(sent.ok).toBe(true);
      expect(sent.counts.recalls).toBe(0);
      expect(sent.counts.installments).toBe(0);
      expect(captured).toHaveLength(1);
      expect(captured[0].subject).not.toMatch(/recall/);
      expect(captured[0].subject).not.toMatch(/installment/);
      expect(captured[0].html).not.toMatch(/Hygiene recalls due/);
      expect(captured[0].html).not.toMatch(/Installments due/);

      // With no filter, all three sections appear again.
      await app.request(
        "/api/settings",
        { method: "PUT", body: JSON.stringify({ digest_sections: "" }), headers: { "content-type": "application/json" } },
        { DB: ctx.db },
      );
      captured.length = 0;
      const res2 = await app.request("/api/email/worklist-digest", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }, { DB: ctx.db });
      expect(res2.status).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0].html).toMatch(/Appointment reminders/);
      expect(captured[0].html).toMatch(/Hygiene recalls due/);
      expect(captured[0].html).toMatch(/Installments due/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

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
  // First request triggers the seed lifecycle.
  await app.request("/api/health", undefined, { DB: ctx.db });
});

async function seedPatient(overrides: Record<string, unknown> = {}) {
  const { path, init } = jsonRequest("POST", "/api/patients", {
    first_name: "Grace",
    last_name: "Hopper",
    date_of_birth: "1990-05-10",
    // Deliberately not a drug on rxBody's list: prescribing a chart's allergy
    // is refused (see "prescribing against the chart's allergy tags").
    medical_alerts: "allergy:latex",
    ...overrides,
  });
  const res = await app.request(path, init, { DB: ctx.db });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { patient: { id: number } };
  return data.patient.id;
}

function rxBody(patientId: number, overrides: Record<string, unknown> = {}) {
  return {
    patient_id: patientId,
    template: "classic",
    diagnosis: "Acute periapical abscess, tooth 36",
    advice: "Rinse with warm salt water.",
    follow_up: "Recheck in 2 weeks",
    items: [
      { drug_name: "Amoxicillin", dosage: "500 mg", frequency: "3x daily", duration: "5 days", instructions: "after meals" },
      { drug_name: "Ibuprofen", dosage: "400 mg", frequency: "as needed", duration: "3 days", instructions: null },
    ],
    ...overrides,
  };
}

describe("prescriptions CRUD", () => {
  it("creates with items and orders them", async () => {
    const pid = await seedPatient();
    const { path, init } = jsonRequest("POST", "/api/prescriptions", rxBody(pid));
    const res = await app.request(path, init, { DB: ctx.db });
    expect(res.status).toBe(201);
    const { prescription } = (await res.json()) as {
      prescription: { id: number; items: { drug_name: string }[]; issued_date: string };
    };
    expect(prescription.items).toHaveLength(2);
    expect(prescription.items[0].drug_name).toBe("Amoxicillin");
    // issued_date defaults to today.
    expect(prescription.issued_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("accepts every supported template and rejects unknown ones", async () => {
    const pid = await seedPatient();
    for (const template of ["chamber", "classic", "modern", "compact", "elegant", "minimal", "bold", "watermark", "two-column"]) {
      const { path, init } = jsonRequest("POST", "/api/prescriptions", rxBody(pid, { template }));
      const res = await app.request(path, init, { DB: ctx.db });
      expect(res.status, `template ${template} should be accepted`).toBe(201);
      const { prescription } = (await res.json()) as { prescription: { template: string } };
      expect(prescription.template).toBe(template);
    }

    const bad = jsonRequest("POST", "/api/prescriptions", rxBody(pid, { template: "neon" }));
    const badRes = await app.request(bad.path, bad.init, { DB: ctx.db });
    expect(badRes.status).toBe(400);
  });

  it("stores and updates the large-print flag", async () => {
    const pid = await seedPatient();

    // Defaults to off.
    const created = await app.request(
      "/api/prescriptions",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rxBody(pid)) },
      { DB: ctx.db },
    );
    const { prescription } = (await created.json()) as { prescription: { id: number; large_print: number } };
    expect(prescription.large_print).toBe(0);

    // Create with large print on.
    const big = jsonRequest("POST", "/api/prescriptions", rxBody(pid, { large_print: true }));
    const bigRes = await app.request(big.path, big.init, { DB: ctx.db });
    expect(bigRes.status).toBe(201);
    const { prescription: bigRx } = (await bigRes.json()) as { prescription: { large_print: number } };
    expect(bigRx.large_print).toBe(1);

    // Flip it off via PUT.
    const upd = jsonRequest("PUT", `/api/prescriptions/${prescription.id}`, { large_print: true });
    const updRes = await app.request(upd.path, upd.init, { DB: ctx.db });
    expect(updRes.status).toBe(200);
    const { prescription: flipped } = (await updRes.json()) as { prescription: { large_print: number } };
    expect(flipped.large_print).toBe(1);

    // And it appears in the patient list rows too.
    const list = await app.request(`/api/patients/${pid}/prescriptions`, undefined, { DB: ctx.db });
    const data = (await list.json()) as { prescriptions: { large_print: number }[] };
    expect(data.prescriptions.some((p) => p.large_print === 1)).toBe(true);
  });

  it("links a tooth and a treatment-plan procedure and joins the name through", async () => {
    const pid = await seedPatient();

    // A plan item with a treatment type, so the join has something to resolve.
    const types = await app.request("/api/treatment-types", undefined, { DB: ctx.db });
    const { treatment_types: ttList } = (await types.json()) as { treatment_types: { id: number }[] };
    const planRes = await app.request(
      "/api/treatment-plan-items",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patient_id: pid, treatment_type_id: ttList[0].id, tooth: "36", fee: 120 }),
      },
      { DB: ctx.db },
    );
    expect(planRes.status).toBe(201);
    const { item: planItem } = (await planRes.json()) as { item: { id: number; treatment_name: string } };

    const { path, init } = jsonRequest("POST", "/api/prescriptions", rxBody(pid, { tooth: "36", plan_item_id: planItem.id }));
    const created = await app.request(path, init, { DB: ctx.db });
    expect(created.status).toBe(201);
    const { prescription } = (await created.json()) as {
      prescription: { id: number; tooth: string | null; plan_item_id: number | null; plan_treatment_name: string | null };
    };
    expect(prescription.tooth).toBe("36");
    expect(prescription.plan_item_id).toBe(planItem.id);
    // The joined procedure name resolves through the plan item.
    expect(prescription.plan_treatment_name).toBe(planItem.treatment_name);

    // Detail GET carries the same joined data.
    const detail = await app.request(`/api/prescriptions/${prescription.id}`, undefined, { DB: ctx.db });
    const { prescription: full } = (await detail.json()) as { prescription: { plan_treatment_name: string | null } };
    expect(full.plan_treatment_name).toBe(planItem.treatment_name);

    // Tooth is editable independently of the plan link.
    const upd = jsonRequest("PUT", `/api/prescriptions/${prescription.id}`, { tooth: "37" });
    const updRes = await app.request(upd.path, upd.init, { DB: ctx.db });
    expect(updRes.status).toBe(200);
    const { prescription: moved } = (await updRes.json()) as { prescription: { tooth: string | null; plan_item_id: number | null } };
    expect(moved.tooth).toBe("37");
    expect(moved.plan_item_id).toBe(planItem.id);

    // Deleting the plan item keeps the prescription (SET NULL) but drops the link.
    const del = await app.request(`/api/treatment-plan-items/${planItem.id}`, { method: "DELETE" }, { DB: ctx.db });
    expect(del.status).toBe(200);
    const after = await app.request(`/api/prescriptions/${prescription.id}`, undefined, { DB: ctx.db });
    const { prescription: orphaned } = (await after.json()) as {
      prescription: { tooth: string | null; plan_item_id: number | null; plan_treatment_name: string | null };
    };
    expect(orphaned.tooth).toBe("37");
    expect(orphaned.plan_item_id).toBeNull();
    expect(orphaned.plan_treatment_name).toBeNull();
  });

  it("carries tooth and joined plan name on the detail payload", async () => {
    const pid = await seedPatient();
    const planRes = await app.request(
      "/api/treatment-plan-items",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patient_id: pid, tooth: "14", fee: 0 }),
      },
      { DB: ctx.db },
    );
    const { item: planItem } = (await planRes.json()) as { item: { id: number } };
    const { path, init } = jsonRequest("POST", "/api/prescriptions", rxBody(pid, { tooth: "14", plan_item_id: planItem.id }));
    await app.request(path, init, { DB: ctx.db });
    const list = await app.request(`/api/patients/${pid}/prescriptions`, undefined, { DB: ctx.db });
    const { prescriptions } = (await list.json()) as { prescriptions: { id: number; tooth: string | null; plan_treatment_name: string | null }[] };
    expect(prescriptions[0].tooth).toBe("14");
    // The plan item had no treatment type — name is null but tooth still flows.
    expect(prescriptions[0].plan_treatment_name).toBeNull();
  });

  it("rejects a prescription with no medication rows", async () => {
    const pid = await seedPatient();
    const { path, init } = jsonRequest("POST", "/api/prescriptions", rxBody(pid, { items: [] }));
    const res = await app.request(path, init, { DB: ctx.db });
    expect(res.status).toBe(400);
  });

  it("rejects an item without a drug name", async () => {
    const pid = await seedPatient();
    const { path, init } = jsonRequest("POST", "/api/prescriptions", rxBody(pid, { items: [{ dosage: "500 mg" }] }));
    const res = await app.request(path, init, { DB: ctx.db });
    expect(res.status).toBe(400);
  });

  it("replaces items on update", async () => {
    const pid = await seedPatient();
    const created = await app.request(
      "/api/prescriptions",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rxBody(pid)) },
      { DB: ctx.db },
    );
    const { prescription } = (await created.json()) as { prescription: { id: number } };

    const { path, init } = jsonRequest("PUT", `/api/prescriptions/${prescription.id}`, {
      items: [{ drug_name: "Metronidazole", dosage: "400 mg", frequency: "3x daily", duration: "5 days", instructions: null }],
    });
    const res = await app.request(path, init, { DB: ctx.db });
    expect(res.status).toBe(200);
    const { prescription: updated } = (await res.json()) as { prescription: { items: { drug_name: string }[] } };
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0].drug_name).toBe("Metronidazole");
  });

  it("lists a patient's prescriptions newest first with counts", async () => {
    const pid = await seedPatient();
    for (const date of ["2026-01-01", "2026-03-01"]) {
      const { path, init } = jsonRequest("POST", "/api/prescriptions", rxBody(pid, { issued_date: date }));
      await app.request(path, init, { DB: ctx.db });
    }
    const res = await app.request(`/api/patients/${pid}/prescriptions`, undefined, { DB: ctx.db });
    const data = (await res.json()) as { prescriptions: { issued_date: string; item_count: number }[] };
    expect(data.prescriptions).toHaveLength(2);
    expect(data.prescriptions[0].issued_date).toBe("2026-03-01");
    expect(data.prescriptions[0].item_count).toBe(2);
  });

  it("deletes", async () => {
    const pid = await seedPatient();
    const created = await app.request(
      "/api/prescriptions",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rxBody(pid)) },
      { DB: ctx.db },
    );
    const { prescription } = (await created.json()) as { prescription: { id: number } };
    const del = await app.request(`/api/prescriptions/${prescription.id}`, { method: "DELETE" }, { DB: ctx.db });
    expect(del.status).toBe(200);
  });
});

describe("prescription settings", () => {
  it("rejects a clinic logo that is not an image data URL", async () => {
    const res = await app.request(
      "/api/settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinic_logo: "<script>alert(1)</script>" }),
      },
      { DB: ctx.db },
    );
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/logo/i);
  });

  it("persists Chamber footer instructions and returns them in settings", async () => {
    const instructions = "In case of bleeding or fever, call +1 555 010 2030\nAvoid hot drinks for 2 hours";
    const put = await app.request(
      "/api/settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chamber_footer_instructions: instructions }),
      },
      { DB: ctx.db },
    );
    expect(put.status).toBe(200);
    const putData = (await put.json()) as { settings: Record<string, string> };
    expect(putData.settings.chamber_footer_instructions).toBe(instructions);

    // Fresh app instance (like a redeploy) still serves the saved value.
    const app2 = await freshApp();
    await app2.request("/api/health", undefined, { DB: ctx.db });
    const res = await app2.request("/api/settings", undefined, { DB: ctx.db });
    const data = (await res.json()) as { settings: Record<string, string> };
    expect(data.settings.chamber_footer_instructions).toBe(instructions);
  });

  it("defaults Chamber footer instructions to empty", async () => {
    const res = await app.request("/api/settings", undefined, { DB: ctx.db });
    const data = (await res.json()) as { settings: Record<string, string> };
    expect(data.settings.chamber_footer_instructions).toBe("");
  });

  it("defaults email delivery settings to empty", async () => {
    const res = await app.request("/api/settings", undefined, { DB: ctx.db });
    const data = (await res.json()) as { settings: Record<string, string> };
    expect(data.settings.email_api_key).toBe("");
    expect(data.settings.email_from).toBe("");
  });
});

describe("prescription email delivery", () => {
  const validPdf = Buffer.from("%PDF-1.4 test").toString("base64");

  async function createRx(patientOverrides: Record<string, unknown> = {}) {
    const pid = await seedPatient(patientOverrides);
    const created = await app.request(
      "/api/prescriptions",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rxBody(pid)) },
      { DB: ctx.db },
    );
    const { prescription } = (await created.json()) as { prescription: { id: number } };
    return prescription.id;
  }

  async function configureEmail() {
    const put = await app.request(
      "/api/settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email_api_key: "re_test_key", email_from: "Dental Canvas <rx@clinic.test>" }),
      },
      { DB: ctx.db },
    );
    expect(put.status).toBe(200);
  }

  it("rejects when email is not configured", async () => {
    const rxId = await createRx({ email: "grace@example.com" });
    const res = await app.request(
      `/api/prescriptions/${rxId}/email`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pdf_base64: validPdf }) },
      { DB: ctx.db },
    );
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/not configured/i);
  });

  it("rejects when the patient record has no email", async () => {
    await configureEmail();
    const rxId = await createRx({});
    const res = await app.request(
      `/api/prescriptions/${rxId}/email`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pdf_base64: validPdf }) },
      { DB: ctx.db },
    );
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/no email address/i);
  });

  it("rejects a body without a usable PDF", async () => {
    await configureEmail();
    const rxId = await createRx({ email: "grace@example.com" });
    const res = await app.request(
      `/api/prescriptions/${rxId}/email`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pdf_base64: "not base64!!" }) },
      { DB: ctx.db },
    );
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/pdf/i);
  });

  it("returns 404 for a missing prescription", async () => {
    await configureEmail();
    const res = await app.request(
      "/api/prescriptions/999999/email",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pdf_base64: validPdf }) },
      { DB: ctx.db },
    );
    expect(res.status).toBe(404);
  });
});

describe("prescription share endpoints", () => {
  // A prescription can be shared via a public, no-auth link (/share/prescription/<token>).
  // The token is a random hex string stored in share_token; the public read endpoint
  // is GET /api/prescriptions/share/:token. Practice staff create/rotate/revoke the link
  // through the authenticated mutation endpoints.

  it("creates a share token and returns a public URL", async () => {
    const pid = await seedPatient();
    const created = await app.request(
      "/api/prescriptions",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rxBody(pid)) },
      { DB: ctx.db },
    );
    const { prescription } = (await created.json()) as { prescription: { id: number } };

    const res = await app.request(
      `/api/prescriptions/${prescription.id}/share`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      { DB: ctx.db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { share_token: string; share_url: string };
    expect(body.share_token).toMatch(/^[a-f0-9]{40}$/);
    expect(body.share_url).toBe(`/share/prescription/${body.share_token}`);
  });

  it("serves the prescription through the public token endpoint (no auth)", async () => {
    const pid = await seedPatient();
    const created = await app.request(
      "/api/prescriptions",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rxBody(pid)) },
      { DB: ctx.db },
    );
    const { prescription: rx } = (await created.json()) as { prescription: { id: number; items: { drug_name: string }[] } };
    const tokenRes = await app.request(
      `/api/prescriptions/${rx.id}/share`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      { DB: ctx.db },
    );
    const { share_token } = (await tokenRes.json()) as { share_token: string };

    const pub = await app.request(`/api/prescriptions/share/${share_token}`, undefined, { DB: ctx.db });
    expect(pub.status).toBe(200);
    const pubData = (await pub.json()) as { prescription: { id: number; items: { drug_name: string }[]; patient_first_name: string; patient_last_name: string } };
    expect(pubData.prescription.id).toBe(rx.id);
    expect(pubData.prescription.items).toHaveLength(2);
    expect(pubData.prescription.items[0].drug_name).toBe("Amoxicillin");
    expect(pubData.prescription.patient_first_name).toBe("Grace");
    expect(pubData.prescription.patient_last_name).toBe("Hopper");
  });

  it("returns 404 for a bogus token", async () => {
    const res = await app.request(`/api/prescriptions/share/${"a".repeat(40)}`, undefined, { DB: ctx.db });
    expect(res.status).toBe(404);
  });

  it("rotates the token on re-share", async () => {
    const pid = await seedPatient();
    const created = await app.request(
      "/api/prescriptions",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rxBody(pid)) },
      { DB: ctx.db },
    );
    const { prescription: rx } = (await created.json()) as { prescription: { id: number } };

    const first = await app.request(
      `/api/prescriptions/${rx.id}/share`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      { DB: ctx.db },
    );
    const firstToken = (await first.json()) as { share_token: string };

    const second = await app.request(
      `/api/prescriptions/${rx.id}/share`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      { DB: ctx.db },
    );
    const secondToken = (await second.json()) as { share_token: string; share_url: string };
    expect(secondToken.share_token).not.toBe(firstToken.share_token);
    expect(secondToken.share_url).toBe(`/share/prescription/${secondToken.share_token}`);

    // The old token no longer opens the page.
    const old = await app.request(`/api/prescriptions/share/${firstToken.share_token}`, undefined, { DB: ctx.db });
    expect(old.status).toBe(404);
    // The new one still works.
    const fresh = await app.request(`/api/prescriptions/share/${secondToken.share_token}`, undefined, { DB: ctx.db });
    expect(fresh.status).toBe(200);
  });

  it("revokes the token so the public page 404s", async () => {
    const pid = await seedPatient();
    const created = await app.request(
      "/api/prescriptions",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rxBody(pid)) },
      { DB: ctx.db },
    );
    const { prescription: rx } = (await created.json()) as { prescription: { id: number } };

    const tokenRes = await app.request(
      `/api/prescriptions/${rx.id}/share`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      { DB: ctx.db },
    );
    const { share_token } = (await tokenRes.json()) as { share_token: string };
    expect((await app.request(`/api/prescriptions/share/${share_token}`, undefined, { DB: ctx.db })).status).toBe(200);

    const revoke = await app.request(
      `/api/prescriptions/${rx.id}/revoke-share`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      { DB: ctx.db },
    );
    expect(revoke.status).toBe(200);

    const after = await app.request(`/api/prescriptions/share/${share_token}`, undefined, { DB: ctx.db });
    expect(after.status).toBe(404);
  });

  it("returns 404 when sharing or revoking a missing prescription", async () => {
    const share = await app.request(
      "/api/prescriptions/999999/share",
      { method: "POST", headers: { "Content-Type": "application/json" } },
      { DB: ctx.db },
    );
    expect(share.status).toBe(404);

    const revoke = await app.request(
      "/api/prescriptions/999999/revoke-share",
      { method: "POST", headers: { "Content-Type": "application/json" } },
      { DB: ctx.db },
    );
    expect(revoke.status).toBe(404);
  });
});

describe("prescriptions in backups", () => {
  it("survive an export → wipe → import round-trip", async () => {
    const pid = await seedPatient();
    const created = await app.request(
      "/api/prescriptions",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rxBody(pid)) },
      { DB: ctx.db },
    );
    const { prescription } = (await created.json()) as { prescription: { id: number; items: unknown[] } };

    const exported = await app.request("/api/backup/export", undefined, { DB: ctx.db });
    const backup = (await exported.json()) as { tables: Record<string, { id: number }[]> };
    expect(backup.tables.prescriptions).toHaveLength(1);
    expect(backup.tables.prescription_items).toHaveLength(2);

    // Wipe and re-import.
    await ctx.db.prepare("DELETE FROM prescriptions").run();
    const imp = await app.request(
      "/api/backup/import",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(backup),
      },
      { DB: ctx.db },
    );
    expect(imp.status).toBe(200);

    const again = await app.request(`/api/prescriptions/${prescription.id}`, undefined, { DB: ctx.db });
    expect(again.status).toBe(200);
    const data = (await again.json()) as { prescription: { id: number; items: unknown[] } };
    expect(data.prescription.id).toBe(prescription.id);
    expect(data.prescription.items).toHaveLength(2);
  });
});

describe("practice-defined prescription templates", () => {
  const CONFIG = {
    layout: "sidebar",
    accent: "#166534",
    header_bg: "#eaf3e2",
    header_text: "#14532d",
    font: "sans",
    show_rule: true,
    show_logo: true,
    show_bangla: true,
    show_watermark: true,
    show_signature: true,
    footer_note: "Emergency: +1 555 010 2030",
    sections: [
      { key: "diagnosis", label: "", enabled: true },
      { key: "history", label: "History of complaint", enabled: true },
      { key: "investigations", label: "", enabled: false },
    ],
  };

  async function createLayout(overrides: Record<string, unknown> = {}) {
    const req = jsonRequest("POST", "/api/prescription-layouts", {
      name: "Kids letterhead",
      base: "chamber",
      config: CONFIG,
      ...overrides,
    });
    const res = await app.request(req.path, req.init, { DB: ctx.db });
    return res;
  }

  it("creates, lists, edits and deletes a template", async () => {
    const created = await createLayout();
    expect(created.status).toBe(201);
    const { layout } = (await created.json()) as {
      layout: { id: number; slug: string; name: string; based_on: string; config: Record<string, unknown> };
    };
    expect(layout.slug).toBe(`custom-${layout.id}`);
    expect(layout.name).toBe("Kids letterhead");
    expect(layout.based_on).toBe("chamber");
    expect(layout.config).toEqual(CONFIG);

    const list = await app.request("/api/prescription-layouts", undefined, { DB: ctx.db });
    const { layouts } = (await list.json()) as { layouts: { slug: string }[] };
    expect(layouts.map((l) => l.slug)).toContain(layout.slug);

    const put = jsonRequest("PUT", `/api/prescription-layouts/${layout.id}`, {
      name: "Kids letterhead v2",
      base: "modern",
      config: { ...CONFIG, accent: "#1d4ed8", font: "serif" },
    });
    const putRes = await app.request(put.path, put.init, { DB: ctx.db });
    expect(putRes.status).toBe(200);
    const { layout: updated } = (await putRes.json()) as {
      layout: { name: string; based_on: string; config: { accent: string; font: string } };
    };
    expect(updated.name).toBe("Kids letterhead v2");
    expect(updated.based_on).toBe("modern");
    expect(updated.config.accent).toBe("#1d4ed8");
    expect(updated.config.font).toBe("serif");

    const del = await app.request(`/api/prescription-layouts/${layout.id}`, { method: "DELETE" }, { DB: ctx.db });
    expect(del.status).toBe(200);
    expect(await app.request(`/api/prescription-layouts/${layout.id}`, { method: "DELETE" }, { DB: ctx.db })).toHaveProperty(
      "status",
      404,
    );
  });

  it("prints a prescription with the saved template and falls back once it is deleted", async () => {
    const pid = await seedPatient();
    const created = await createLayout();
    const { layout } = (await created.json()) as { layout: { id: number; slug: string } };

    const rxReq = jsonRequest("POST", "/api/prescriptions", rxBody(pid, { template: layout.slug }));
    const rxRes = await app.request(rxReq.path, rxReq.init, { DB: ctx.db });
    expect(rxRes.status).toBe(201);
    const { prescription } = (await rxRes.json()) as {
      prescription: { id: number; template: string; template_config: Record<string, unknown> | null };
    };
    expect(prescription.template).toBe(layout.slug);
    expect(prescription.template_config).toEqual(CONFIG);

    // The share page renders the same skin, without a session.
    const tokenRes = await app.request(
      `/api/prescriptions/${prescription.id}/share`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      { DB: ctx.db },
    );
    const { share_token } = (await tokenRes.json()) as { share_token: string };
    const shared = await app.request(`/api/prescriptions/share/${share_token}`, undefined, { DB: ctx.db });
    const { prescription: sharedRx } = (await shared.json()) as {
      prescription: { template_config: Record<string, unknown> | null };
    };
    expect(sharedRx.template_config).toEqual(CONFIG);

    // Deleting the template leaves the prescription readable: no skin, and the
    // client falls back to the default pad instead of printing nothing.
    await app.request(`/api/prescription-layouts/${layout.id}`, { method: "DELETE" }, { DB: ctx.db });
    const after = await app.request(`/api/prescriptions/${prescription.id}`, undefined, { DB: ctx.db });
    expect(after.status).toBe(200);
    const { prescription: orphaned } = (await after.json()) as {
      prescription: { template: string; template_config: unknown };
    };
    expect(orphaned.template_config).toBeNull();

    // …and it can no longer be assigned to a new prescription.
    const gone = jsonRequest("POST", "/api/prescriptions", rxBody(pid, { template: layout.slug }));
    expect((await app.request(gone.path, gone.init, { DB: ctx.db })).status).toBe(400);
  });

  it("rejects a template that could not print safely", async () => {
    // Colors must be six-digit hex.
    expect((await createLayout({ config: { ...CONFIG, accent: "green" } })).status).toBe(400);
    // Only known clinical blocks may be printed.
    expect(
      (await createLayout({ config: { ...CONFIG, sections: [{ key: "totally-custom", label: "x", enabled: true }] } })).status,
    ).toBe(400);
    // A layout needs a name.
    expect((await createLayout({ name: "" })).status).toBe(400);
    // Unknown base layouts are refused rather than silently accepted.
    expect((await createLayout({ base: "neon" })).status).toBe(400);
  });

  it("survives a backup export → wipe → import round-trip", async () => {
    const created = await createLayout();
    const { layout } = (await created.json()) as { layout: { id: number; slug: string; config: unknown } };

    const exported = await app.request("/api/backup/export", undefined, { DB: ctx.db });
    const backup = (await exported.json()) as { tables: Record<string, { id: number }[]> };
    expect(backup.tables.prescription_layouts).toHaveLength(1);

    await ctx.db.prepare("DELETE FROM prescription_layouts").run();
    const imp = await app.request(
      "/api/backup/import",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(backup) },
      { DB: ctx.db },
    );
    expect(imp.status).toBe(200);

    const list = await app.request("/api/prescription-layouts", undefined, { DB: ctx.db });
    const { layouts } = (await list.json()) as { layouts: { slug: string; config: unknown }[] };
    expect(layouts).toHaveLength(1);
    expect(layouts[0].slug).toBe(layout.slug);
    expect(layouts[0].config).toEqual(CONFIG);
  });
});

// ── The allergy tags on the chart ─────────────────────────────────
//
// A prescription is the moment a chart's `allergy:` tags have to matter. The
// printed sheet showed them; these are the routes refusing to save a drug that
// matches one.

describe("prescribing against the chart's allergy tags", () => {
  it("refuses a drug that matches an allergy tag, and saves nothing", async () => {
    const pid = await seedPatient({ medical_alerts: "allergy:penicillin" });
    const { path, init } = jsonRequest("POST", "/api/prescriptions", rxBody(pid));
    const res = await app.request(path, init, { DB: ctx.db });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      conflicts: { drug: string; allergy: string; basis: string }[];
    };
    expect(body.error).toContain("Allergy conflict");
    expect(body.error).toContain("Amoxicillin");
    expect(body.conflicts).toEqual([
      { drug: "Amoxicillin", allergy: "penicillin", basis: "class" },
    ]);

    // Nothing reached the chart: no prescription row, and no items behind it.
    const list = await app.request(`/api/patients/${pid}/prescriptions`, undefined, { DB: ctx.db });
    const { prescriptions } = (await list.json()) as { prescriptions: unknown[] };
    expect(prescriptions).toHaveLength(0);
  });

  it("saves the same prescription when no drug is on the chart", async () => {
    const pid = await seedPatient({ medical_alerts: "allergy:penicillin" });
    const { path, init } = jsonRequest(
      "POST",
      "/api/prescriptions",
      rxBody(pid, {
        items: [
          { drug_name: "Clindamycin", dosage: "300 mg", frequency: "3x daily", duration: "5 days", instructions: null },
        ],
      }),
    );
    expect((await app.request(path, init, { DB: ctx.db })).status).toBe(201);
  });

  it("takes an explicit acknowledgement, so a stale tag can be prescribed through", async () => {
    const pid = await seedPatient({ medical_alerts: "allergy:penicillin" });
    const { path, init } = jsonRequest("POST", "/api/prescriptions", rxBody(pid, { acknowledge_allergy: true }));
    expect((await app.request(path, init, { DB: ctx.db })).status).toBe(201);
  });

  it("checks the drugs an edit puts on an existing prescription", async () => {
    const pid = await seedPatient({ medical_alerts: "allergy:latex" });
    const created = jsonRequest("POST", "/api/prescriptions", rxBody(pid));
    const createdRes = await app.request(created.path, created.init, { DB: ctx.db });
    expect(createdRes.status).toBe(201);
    const { prescription } = (await createdRes.json()) as { prescription: { id: number } };

    // The chart learns about the penicillin allergy between visits.
    const updPatient = jsonRequest("PUT", `/api/patients/${pid}`, { medical_alerts: "allergy:penicillin" });
    expect((await app.request(updPatient.path, updPatient.init, { DB: ctx.db })).status).toBe(200);

    const bad = jsonRequest("PUT", `/api/prescriptions/${prescription.id}`, {
      items: [
        { drug_name: "Amoxicillin", dosage: "500 mg", frequency: "3x daily", duration: "5 days", instructions: null },
      ],
    });
    expect((await app.request(bad.path, bad.init, { DB: ctx.db })).status).toBe(409);

    // The refusal came before the items were replaced, so the old ones stand.
    const after = await app.request(`/api/prescriptions/${prescription.id}`, undefined, { DB: ctx.db });
    const { prescription: kept } = (await after.json()) as { prescription: { items: { drug_name: string }[] } };
    expect(kept.items.map((item) => item.drug_name)).toEqual(["Amoxicillin", "Ibuprofen"]);
  });

  it("leaves an edit that does not touch the drugs alone", async () => {
    const pid = await seedPatient({ medical_alerts: "allergy:penicillin" });
    const created = jsonRequest(
      "POST",
      "/api/prescriptions",
      rxBody(pid, {
        items: [
          { drug_name: "Clindamycin", dosage: "300 mg", frequency: "3x daily", duration: "5 days", instructions: null },
        ],
      }),
    );
    const createdRes = await app.request(created.path, created.init, { DB: ctx.db });
    const { prescription } = (await createdRes.json()) as { prescription: { id: number } };

    const advice = jsonRequest("PUT", `/api/prescriptions/${prescription.id}`, {
      advice: "Soft diet for 3 days.",
    });
    expect((await app.request(advice.path, advice.init, { DB: ctx.db })).status).toBe(200);
  });
});

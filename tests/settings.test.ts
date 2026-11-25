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

describe("settings", () => {
  it("validates invoice customization settings", async () => {
    // Valid style + accent save fine.
    const good = jsonRequest("PUT", "/api/settings", {
      invoice_style: "modern",
      invoice_accent: "#b91c1c",
      invoice_payment_terms: "Due in 14 days",
      invoice_footer_note: "Thank you!",
      invoice_show_payments: "0",
    });
    const ok = await app.request(good.path, good.init, { DB: ctx.db });
    expect(ok.status).toBe(200);

    const res = await app.request("/api/settings", undefined, { DB: ctx.db });
    const { settings } = (await res.json()) as { settings: Record<string, string> };
    expect(settings.invoice_style).toBe("modern");
    expect(settings.invoice_accent).toBe("#b91c1c");
    expect(settings.invoice_show_payments).toBe("0");

    // Unknown style rejected.
    const badStyle = jsonRequest("PUT", "/api/settings", { invoice_style: "neon" });
    const bad1 = await app.request(badStyle.path, badStyle.init, { DB: ctx.db });
    expect(bad1.status).toBe(400);

    // Non-hex accent rejected.
    const badAccent = jsonRequest("PUT", "/api/settings", { invoice_accent: "red" });
    const bad2 = await app.request(badAccent.path, badAccent.init, { DB: ctx.db });
    expect(bad2.status).toBe(400);
  });

  it("no longer offers the Google Drive backup destination", async () => {
    // A web deployment keeps the practice in its own database; the Drive mirror
    // was a duplicate second backup path and has been removed.
    const res = await app.request("/api/backup/drive/status", undefined, { DB: ctx.db });
    expect(res.status).toBe(404);

    const settings = await app.request("/api/settings", undefined, { DB: ctx.db });
    const { settings: values } = (await settings.json()) as { settings: Record<string, string> };
    expect(Object.keys(values).some((k) => k.startsWith("gdrive_"))).toBe(false);
  });
});

describe("practice wipe (hosted account deletion)", () => {
  it("requires the DELETE confirmation", async () => {
    const req = jsonRequest("POST", "/api/practice/wipe", { confirm: "yes" });
    const res = await app.request(req.path, req.init, { DB: ctx.db });
    expect(res.status).toBe(400);
  });

  it("deletes the practice records but keeps the clinic profile", async () => {
    const created = jsonRequest("POST", "/api/patients", {
      first_name: "Wipe",
      last_name: "Me",
    });
    const patient = await app.request(created.path, created.init, { DB: ctx.db });
    expect(patient.status).toBe(201);

    const before = await app.request("/api/sync/summary", undefined, { DB: ctx.db });
    expect(((await before.json()) as { has_user_data: boolean }).has_user_data).toBe(true);

    const wipe = jsonRequest("POST", "/api/practice/wipe", { confirm: "DELETE" });
    const res = await app.request(wipe.path, wipe.init, { DB: ctx.db });
    expect(res.status).toBe(200);

    const after = await app.request("/api/sync/summary", undefined, { DB: ctx.db });
    const summary = (await after.json()) as {
      has_user_data: boolean;
      counts: Record<string, number>;
    };
    expect(summary.has_user_data).toBe(false);
    expect(summary.counts.patients).toBe(0);

    // The clinic's own settings identify the practice and are kept.
    const settings = await app.request("/api/settings", undefined, { DB: ctx.db });
    expect(settings.status).toBe(200);
  });
});

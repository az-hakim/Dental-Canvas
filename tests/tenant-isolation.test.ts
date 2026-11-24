/**
 * Multi-tenant isolation for the hosted (Vercel/Node) runtime.
 *
 * Each clinic gets its own physical tables, so a request scoped to one clinic
 * must never see — or be able to touch — another clinic's rows, even though
 * the application code issues bare `SELECT * FROM patients`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rewriteSql, tenantPrefix } from "../src/server/tenant/sql-prefix";

const dir = mkdtempSync(path.join(tmpdir(), "dc-tenant-"));
process.env.DENTAL_CANVAS_LOCAL_DB = `file:${path.join(dir, "test.db")}`;

const CLINIC_A = "aaaaaaaa-1111-4111-8111-111111111111";
const CLINIC_B = "bbbbbbbb-2222-4222-8222-222222222222";

let withClinic: typeof import("../src/server/tenant/runtime").withClinic;
let resolveClinic: typeof import("../src/server/tenant/runtime").resolveClinic;
let clinicForPublicToken: typeof import("../src/server/tenant/runtime").clinicForPublicToken;
let app: { fetch: (request: Request, env: unknown) => Promise<Response> };

beforeAll(async () => {
  const runtime = await import("../src/server/tenant/runtime");
  const facade = await import("../src/server/tenant/d1-facade");
  const server = await import("../src/server/index");
  runtime.installTenantRuntime();
  withClinic = runtime.withClinic;
  resolveClinic = runtime.resolveClinic;
  clinicForPublicToken = runtime.clinicForPublicToken;
  app = server.default as unknown as typeof app;
  (globalThis as { __dcFacade?: unknown }).__dcFacade = facade.createD1Facade();
});

async function request(clinicId: string, method: string, url: string, body?: unknown) {
  return withClinic(clinicId, async () => {
    const init: RequestInit = { method, headers: {} };
    if (body !== undefined) {
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return app.fetch(new Request(`http://localhost${url}`, init), {
      DB: (globalThis as { __dcFacade?: unknown }).__dcFacade,
    });
  });
}

describe("rewriteSql", () => {
  const prefix = tenantPrefix(CLINIC_A);

  it("namespaces table identifiers", () => {
    expect(rewriteSql("SELECT * FROM patients WHERE id = ?", prefix)).toContain(
      `FROM ${prefix}patients`,
    );
    expect(rewriteSql('SELECT * FROM "treatment_types"', prefix)).toContain(
      `"${prefix}treatment_types"`,
    );
  });

  it("namespaces indexes and sync triggers", () => {
    const sql = `CREATE UNIQUE INDEX IF NOT EXISTS idx_${"patients"}_sync_id ON "patients"(sync_id)`;
    const out = rewriteSql(sql, prefix);
    expect(out).toContain(`${prefix}idx_patients_sync_id`);
    expect(out).toContain(`"${prefix}patients"`);

    const trigger = rewriteSql('CREATE TRIGGER "patients_sync_ai" AFTER INSERT ON "patients"', prefix);
    expect(trigger).toContain(`"${prefix}patients_sync_ai"`);
    expect(trigger).toContain(`ON "${prefix}patients"`);
  });

  it("leaves string literals (data) alone", () => {
    const sql = "SELECT * FROM search_index WHERE entity_type = 'patients' AND title LIKE '%invoices%'";
    const out = rewriteSql(sql, prefix);
    expect(out).toContain("'patients'");
    expect(out).toContain("'%invoices%'");
    expect(out).toContain(`${prefix}search_index`);
  });

  it("does nothing for the single-tenant prefix", () => {
    expect(rewriteSql("SELECT * FROM patients", "")).toBe("SELECT * FROM patients");
  });
});

describe("clinic provisioning", () => {
  it("gives a first-time user their own clinic and reuses it afterwards", async () => {
    const first = await resolveClinic({
      id: "user-owner-1",
      email: "owner@clinic.example",
      clinicName: "Bright Smiles",
    });
    expect(first.name).toBe("Bright Smiles");

    const again = await resolveClinic({ id: "user-owner-1", email: "owner@clinic.example", clinicName: "Bright Smiles" });
    expect(again.id).toBe(first.id);

    const other = await resolveClinic({ id: "user-owner-2", email: "two@clinic.example", clinicName: "" });
    expect(other.id).not.toBe(first.id);

    // The second sign-in resolved to the same membership rather than minting one.
    expect(again.name).toBe("Bright Smiles");
  });

  it("routes a public token to the clinic that minted it", async () => {
    const registry = await import("../src/server/tenant/token-registry");
    const clinic = await resolveClinic({
      id: "user-token-1",
      email: "tokens@clinic.example",
      clinicName: "Token Clinic",
    });
    // Mint inside a clinic scope the way the booking/prescription routes do.
    await withClinic(clinic.id, async () => {
      registry.registerPublicToken("token-abc-123", "booking");
    });
    // Registration is fire-and-forget; give it a tick to land.
    await new Promise((r) => setTimeout(r, 300));
    expect(await clinicForPublicToken("token-abc-123")).toBe(clinic.id);
    expect(await clinicForPublicToken("unknown-token")).toBeNull();
  });
});

describe("clinic data isolation", () => {
  it("creates a patient for one clinic and hides it from another", async () => {
    const created = await request(CLINIC_A, "POST", "/api/patients", {
      first_name: "Ada",
      last_name: "Lovelace",
      phone: "5550100",
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { patient: { id: number } };
    expect(createdBody.patient.id).toBeGreaterThan(0);

    const listA = await request(CLINIC_A, "GET", "/api/patients");
    const bodyA = (await listA.json()) as { patients: { last_name: string }[] };
    expect(bodyA.patients.map((p) => p.last_name)).toContain("Lovelace");

    const listB = await request(CLINIC_B, "GET", "/api/patients");
    const bodyB = (await listB.json()) as { patients: { last_name: string }[] };
    expect(bodyB.patients).toHaveLength(0);

    // The other clinic cannot address clinic A's row by id either.
    const foreign = await request(CLINIC_B, "GET", `/api/patients/${createdBody.patient.id}`);
    expect(foreign.status).toBe(404);
  });

  it("provisions each clinic's own default rows", async () => {
    const a = await request(CLINIC_A, "GET", "/api/operatories");
    const b = await request(CLINIC_B, "GET", "/api/operatories");
    const bodyA = (await a.json()) as { operatories: unknown[] };
    const bodyB = (await b.json()) as { operatories: unknown[] };
    expect(bodyA.operatories.length).toBeGreaterThan(0);
    expect(bodyB.operatories.length).toBeGreaterThan(0);
  });

  it("reports a newly registered patient on that clinic's dashboard", async () => {
    const res = await request(CLINIC_A, "GET", "/api/dashboard/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recent_patients?: { first_name: string; last_name: string }[];
    };
    expect(body.recent_patients?.some((p) => p.last_name === "Lovelace")).toBe(true);
  });
});

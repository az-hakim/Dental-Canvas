import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createTestContext, freshApp, jsonRequest, type TestContext } from "./helpers";

/**
 * Local half of cloud sync: the migration that adds sync ids, the trigger-fed
 * outbox, snapshots, and the apply path used for pulls/push echoes.
 */

let ctx: TestContext;
let app: Awaited<ReturnType<typeof freshApp>>;

async function call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const req = jsonRequest(method, path, body);
  const res = await app.fetch(new Request(`http://local${req.path}`, req.init), { DB: ctx.db } as never);
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${res.status}`);
  return json;
}

async function sql<T = Record<string, unknown>>(queryText: string, params: unknown[] = []): Promise<T[]> {
  const res = await ctx.db.prepare(queryText).bind(...params).all<T>();
  return res.results ?? [];
}

beforeEach(async () => {
  ctx = await createTestContext();
  await ctx.resetDb();
  app = await freshApp();
  // The middleware migrates synchronously on the first request.
  await call("GET", "/api/sync/meta");
});

afterEach(async () => {
  await ctx.dispose();
});

describe("local sync migration", () => {
  it("gives every seeded row a unique sync id and a timestamp", async () => {
    const rows = await sql<{ sync_id: string | null; updated_at: string }>(
      "SELECT sync_id, updated_at FROM operatories",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.sync_id)).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.sync_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.updated_at).not.toBe("1970-01-01T00:00:00.000Z");
    }
  });

  it("queues inserts, updates and deletes in the outbox", async () => {
    const created = await call<{ operatory: { id: number } }>("POST", "/api/operatories", {
      name: "Sync room",
    });
    let outbox = await sql<{ op: string }>("SELECT op FROM sync_outbox WHERE entity = 'operatories'");
    expect(outbox.map((r) => r.op)).toContain("upsert");

    await call("PUT", `/api/operatories/${created.operatory.id}`, { name: "Renamed room" });
    outbox = await sql<{ op: string }>("SELECT op FROM sync_outbox WHERE entity = 'operatories'");
    expect(outbox.some((r) => r.op === "upsert")).toBe(true);

    await call("DELETE", `/api/operatories/${created.operatory.id}`);
    const deletes = await sql<{ sync_id: string }>(
      "SELECT sync_id FROM sync_outbox WHERE entity = 'operatories' AND op = 'delete'",
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0].sync_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("coalesces repeated edits and exposes the current row in pending changes", async () => {
    const created = await call<{ patient: { id: number } }>("POST", "/api/patients", {
      first_name: "Mira",
      last_name: "Hasan",
      phone: "555",
    });
    await call("PUT", `/api/patients/${created.patient.id}`, { phone: "556" });
    await call("PUT", `/api/patients/${created.patient.id}`, { phone: "557" });

    const pending = await call<{
      changes: { entity: string; op: string; payload?: Record<string, unknown>; outbox_ids: number[] }[];
    }>("GET", "/api/sync/pending");
    const patient = pending.changes.find((c) => c.entity === "patients");
    expect(patient?.op).toBe("upsert");
    expect(patient?.payload?.phone).toBe("557");
    expect(patient?.payload?.sync_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(patient?.outbox_ids.length).toBeGreaterThan(1);
  });

  it("only clears a device whose lookup tables are untouched seeds", async () => {
    // A fresh install: seeds only, no user data → safe to clear before pull.
    const seedOnly = await call<{ ok: boolean }>("POST", "/api/sync/prepare-pull");
    expect(seedOnly.ok).toBe(true);
    expect(await sql("SELECT id FROM operatories")).toHaveLength(0);

    // Now the doctor customizes a lookup but has no patients yet. That is real
    // work, so prepare-pull must refuse and the engine will merge instead.
    await call("POST", "/api/operatories", { name: "My custom chair" });
    const custom = await call<{ ok: boolean; reason?: string }>("POST", "/api/sync/prepare-pull");
    expect(custom.ok).toBe(false);
    expect(custom.reason).toBe("device_has_custom_lookups");
    expect(await sql("SELECT id FROM operatories WHERE name = 'My custom chair'")).toHaveLength(1);
  });

  it("propagates a remote soft delete and blocks a stale resurrection", async () => {
    const created = await call<{ patient: { id: number } }>("POST", "/api/patients", {
      first_name: "Delete",
      last_name: "Me",
    });
    const [row] = await sql<{ sync_id: string }>("SELECT sync_id FROM patients WHERE id = ?", [
      created.patient.id,
    ]);
    const now = new Date().toISOString();

    const del = await call<{ applied: number }>("POST", "/api/sync/apply", {
      changes: [
        { entity: "patients", op: "delete", row: { sync_id: row.sync_id, updated_at: now, deleted_at: now } },
      ],
    });
    expect(del.applied).toBe(1);
    expect(await sql("SELECT id FROM patients WHERE id = ?", [created.patient.id])).toHaveLength(0);
    const tombstones = await sql("SELECT sync_id FROM sync_tombstones WHERE sync_id = ?", [row.sync_id]);
    expect(tombstones).toHaveLength(1);

    // A device that missed the delete pushes the old row back. The tombstone
    // is newer, so it must not resurrect locally.
    await call("POST", "/api/sync/apply", {
      changes: [
        {
          entity: "patients",
          op: "upsert",
          row: {
            sync_id: row.sync_id,
            first_name: "Zombie",
            last_name: "Row",
            updated_at: "2020-01-01T00:00:00.000Z",
            deleted_at: null,
          },
        },
      ],
    });
    expect(await sql("SELECT id FROM patients WHERE id = ?", [created.patient.id])).toHaveLength(0);
  });

  it("resolves a conflict with last-write-wins and records the loser", async () => {
    const created = await call<{ patient: { id: number } }>("POST", "/api/patients", {
      first_name: "Local",
      last_name: "Edit",
    });
    await call("PUT", `/api/patients/${created.patient.id}`, { first_name: "Local newer" });
    const [row] = await sql<{ sync_id: string }>("SELECT sync_id FROM patients WHERE id = ?", [
      created.patient.id,
    ]);

    // Remote edit older than the queued local edit → local stays, conflict logged.
    const older = await call<{ applied: number; skipped: number; conflicts: number }>(
      "POST",
      "/api/sync/apply",
      {
        changes: [
          {
            entity: "patients",
            op: "upsert",
            row: {
              sync_id: row.sync_id,
              first_name: "Remote older",
              updated_at: "2020-01-01T00:00:00.000Z",
            },
          },
        ],
      },
    );
    expect(older.skipped).toBe(1);
    const [kept] = await sql<{ first_name: string }>("SELECT first_name FROM patients WHERE id = ?", [
      created.patient.id,
    ]);
    expect(kept.first_name).toBe("Local newer");
    expect(await sql("SELECT id FROM sync_outbox WHERE entity = 'patients'")).not.toHaveLength(0);
    expect((await sql("SELECT resolution FROM sync_conflicts"))[0]?.resolution).toBe("local_edit_kept");

    // Remote edit in the future → remote wins, the queued local edit is cleared
    // only after the conflict (with both versions) is recorded.
    const newer = await call<{ applied: number }>("POST", "/api/sync/apply", {
      changes: [
        {
          entity: "patients",
          op: "upsert",
          row: {
            sync_id: row.sync_id,
            first_name: "Remote wins",
            updated_at: "2099-01-01T00:00:00.000Z",
          },
        },
      ],
    });
    expect(newer.applied).toBe(1);
    const [current] = await sql<{ first_name: string }>("SELECT first_name FROM patients WHERE id = ?", [
      created.patient.id,
    ]);
    expect(current.first_name).toBe("Remote wins");
    expect(await sql("SELECT id FROM sync_outbox WHERE entity = 'patients'")).toHaveLength(0);
    const resolutions = (await sql<{ resolution: string }>("SELECT resolution FROM sync_conflicts ORDER BY id"))
      .map((r) => r.resolution);
    expect(resolutions).toContain("remote_edit_won");
  });

  it("rebuilds cloud foreign keys into local integer ids and defers orphans", async () => {
    const op = await call<{ operatory: { id: number } }>("POST", "/api/operatories", { name: "FK room" });
    const patient = await call<{ patient: { id: number } }>("POST", "/api/patients", {
      first_name: "FK",
      last_name: "Patient",
    });
    const [opSync] = await sql<{ sync_id: string }>("SELECT sync_id FROM operatories WHERE id = ?", [op.operatory.id]);
    const [patSync] = await sql<{ sync_id: string }>("SELECT sync_id FROM patients WHERE id = ?", [patient.patient.id]);

    await call("POST", "/api/sync/apply", {
      changes: [
        {
          entity: "appointments",
          op: "upsert",
          row: {
            sync_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
            operatory_sync_id: opSync.sync_id,
            patient_sync_id: patSync.sync_id,
            start_time: "2027-01-04T09:00:00",
            end_time: "2027-01-04T09:30:00",
            status: "scheduled",
            kind: "patient",
            updated_at: new Date().toISOString(),
          },
        },
      ],
    });

    const [appt] = await sql<{ operatory_id: number; patient_id: number }>(
      "SELECT operatory_id, patient_id FROM appointments WHERE sync_id = ?",
      ["aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"],
    );
    expect(appt.operatory_id).toBe(op.operatory.id);
    expect(appt.patient_id).toBe(patient.patient.id);

    // A child whose operatory has not arrived yet is deferred, not guessed.
    const deferred = await call<{ deferred: number }>("POST", "/api/sync/apply", {
      changes: [
        {
          entity: "appointments",
          op: "upsert",
          row: {
            sync_id: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb",
            operatory_sync_id: "cccccccc-1111-4111-8111-cccccccccccc",
            start_time: "2027-01-04T10:00:00",
            end_time: "2027-01-04T10:30:00",
            updated_at: new Date().toISOString(),
          },
        },
      ],
    });
    expect(deferred.deferred).toBe(1);
    expect(
      await sql("SELECT id FROM appointments WHERE sync_id = ?", ["bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb"]),
    ).toHaveLength(0);
  });

  it("returns a resumable snapshot page per table", async () => {
    await call("POST", "/api/patients", { first_name: "A", last_name: "One" });
    await call("POST", "/api/patients", { first_name: "B", last_name: "Two" });
    const first = await call<{ rows: Record<string, unknown>[]; next_after: number | null }>(
      "GET",
      "/api/sync/snapshot?entity=patients&limit=1",
    );
    expect(first.rows).toHaveLength(1);
    expect(first.next_after).toBeTypeOf("number");
    const second = await call<{ rows: Record<string, unknown>[]; next_after: number | null }>(
      "GET",
      `/api/sync/snapshot?entity=patients&limit=1&after=${first.next_after}`,
    );
    expect(second.rows).toHaveLength(1);
    expect(second.next_after).toBeNull();
    expect(second.rows[0].sync_id).not.toBe(first.rows[0].sync_id);
  });
});

describe("device account claim", () => {
  const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
  const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";

  async function owner(): Promise<string | null> {
    const rows = await sql<{ owner_user_id: string | null }>(
      "SELECT owner_user_id FROM sync_state WHERE id = 1",
    );
    return rows[0]?.owner_user_id ?? null;
  }

  it("sign-out keeps the claim and queued edits so another account cannot adopt them", async () => {
    await call("POST", "/api/sync/claim", { user_id: ACCOUNT_A });
    await call("POST", "/api/operatories", { name: "Claimed room" });

    await call("POST", "/api/sync/release");

    expect(await owner()).toBe(ACCOUNT_A);
    const outbox = await sql("SELECT id FROM sync_outbox");
    expect(outbox.length).toBeGreaterThan(0);
    const operatory = await sql("SELECT name FROM operatories WHERE name = 'Claimed room'");
    expect(operatory).toHaveLength(1);

    // The second account is refused rather than uploading practice A's rows.
    await expect(call("POST", "/api/sync/claim", { user_id: ACCOUNT_B })).rejects.toThrow(
      /different account/,
    );
  });

  it("account deletion unclaims the device but keeps local rows", async () => {
    await call("POST", "/api/sync/claim", { user_id: ACCOUNT_A });
    const created = await call<{ operatory: { id: number } }>("POST", "/api/operatories", {
      name: "Kept room",
    });

    await call("POST", "/api/sync/forget");

    expect(await owner()).toBeNull();
    expect(await sql("SELECT id FROM sync_outbox")).toHaveLength(0);
    expect(
      await sql("SELECT id FROM operatories WHERE id = ?", [created.operatory.id]),
    ).toHaveLength(1);

    const next = await call<{ ok: boolean; owner_user_id: string }>("POST", "/api/sync/claim", {
      user_id: ACCOUNT_B,
    });
    expect(next).toMatchObject({ ok: true, owner_user_id: ACCOUNT_B });
  });
});

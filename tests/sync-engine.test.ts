import { describe, expect, it } from "vitest";
import { createSyncEngine, type StorageLike } from "../src/client/lib/sync/engine";
import type {
  ApplyResult,
  ClaimResult,
  CloudRow,
  CloudSyncAdapter,
  LocalConflict,
  LocalDataSummary,
  LocalSyncApi,
  LocalSyncMeta,
  PendingChange,
  RemoteChange,
  SnapshotChunk,
  SyncCursor,
} from "../src/client/lib/sync/types";

/** In-memory device store that behaves like the server's sync endpoints. */
class FakeLocal implements LocalSyncApi {
  owner: string | null = null;
  rows = new Map<string, Record<string, unknown>[]>();
  outbox: PendingChange[] = [];
  cursors: Record<string, SyncCursor> = {};
  conflicts: LocalConflict[] = [];
  prepared = 0;
  released = 0;
  forgotten = 0;

  meta(): Promise<LocalSyncMeta> {
    return Promise.resolve({
      owner_user_id: this.owner,
      last_pull_at: null,
      last_push_at: null,
      pending_changes: this.outbox.length,
      conflicts: this.conflicts.length,
      cursors: this.cursors,
    });
  }

  claim(userId: string): Promise<ClaimResult> {
    if (this.owner && this.owner !== userId) {
      return Promise.resolve({ ok: false, reason: "different_account", owner_user_id: this.owner });
    }
    this.owner = userId;
    return Promise.resolve({ ok: true, owner_user_id: userId });
  }

  release(): Promise<void> {
    // The real endpoint keeps the owner and queue; only an explicit account
    // deletion (forgetAccount) unclaims the device.
    this.released += 1;
    return Promise.resolve();
  }

  forgetAccount(): Promise<void> {
    this.owner = null;
    this.outbox = [];
    this.cursors = {};
    this.forgotten += 1;
    return Promise.resolve();
  }

  pending(): Promise<{ changes: PendingChange[]; hasMore: boolean }> {
    return Promise.resolve({ changes: [...this.outbox], hasMore: false });
  }

  ack(ids: number[]): Promise<void> {
    const set = new Set(ids);
    this.outbox = this.outbox.filter((c) => !c.outbox_ids.some((id) => set.has(id)));
    return Promise.resolve();
  }

  snapshot(entity: string, after: number, limit = 250): Promise<SnapshotChunk> {
    const all = this.rows.get(entity) ?? [];
    const page = all.slice(after, after + limit);
    const next = after + limit < all.length ? after + limit : null;
    return Promise.resolve({ entity, rows: page, next_after: next });
  }

  apply(changes: RemoteChange[], opts: { cursors?: Record<string, SyncCursor> } = {}): Promise<ApplyResult> {
    let applied = 0;
    for (const change of changes) {
      const list = this.rows.get(change.entity) ?? [];
      const syncId = change.row?.sync_id;
      const idx = list.findIndex((r) => r.sync_id === syncId);
      if (change.op === "delete" || change.row?.deleted_at) {
        if (idx >= 0) list.splice(idx, 1);
      } else if (idx >= 0) {
        list[idx] = { ...list[idx], ...change.row };
      } else {
        list.push({ ...change.row });
      }
      this.rows.set(change.entity, list);
      applied += 1;
    }
    if (opts.cursors) Object.assign(this.cursors, opts.cursors);
    return Promise.resolve({ applied, skipped: 0, deferred: 0, conflicts: 0 });
  }

  summary(): Promise<LocalDataSummary> {
    const counts: Record<string, number> = {};
    let has = false;
    for (const [table, rows] of this.rows) {
      counts[table] = rows.length;
      if (rows.length > 0) has = true;
    }
    return Promise.resolve({ has_user_data: has, counts });
  }

  preparePull(): Promise<{ ok: boolean }> {
    this.prepared += 1;
    this.rows.clear();
    return Promise.resolve({ ok: true });
  }

  wipe(): Promise<void> {
    this.rows.clear();
    return Promise.resolve();
  }

  conflict(input: LocalConflict): Promise<void> {
    this.conflicts.push(input);
    return Promise.resolve();
  }
}

class FakeCloud implements CloudSyncAdapter {
  userId: string;
  initialized = false;
  rows = new Map<string, Map<string, CloudRow>>();
  pushCalls = 0;
  private clock = Date.parse("2026-01-01T00:00:00.000Z");

  constructor(userId: string) {
    this.userId = userId;
  }

  private nextTimestamp(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  isAccountInitialized(): Promise<boolean> {
    return Promise.resolve(this.initialized);
  }

  markAccountInitialized(): Promise<void> {
    this.initialized = true;
    return Promise.resolve();
  }

  pushUpserts(entity: string, rows: Record<string, unknown>[]): Promise<CloudRow[]> {
    this.pushCalls += 1;
    const table = this.rows.get(entity) ?? new Map<string, CloudRow>();
    const echo: CloudRow[] = [];
    for (const row of rows) {
      const syncId = String(row.sync_id);
      const next: CloudRow = {
        ...(table.get(syncId) ?? {}),
        ...row,
        sync_id: syncId,
        user_id: this.userId,
        updated_at: this.nextTimestamp(),
        deleted_at: table.get(syncId)?.deleted_at ?? null,
      };
      table.set(syncId, next);
      echo.push({ ...next });
    }
    this.rows.set(entity, table);
    return Promise.resolve(echo);
  }

  softDelete(entity: string, syncIds: string[]): Promise<CloudRow[]> {
    const table = this.rows.get(entity) ?? new Map<string, CloudRow>();
    const echo: CloudRow[] = [];
    for (const syncId of syncIds) {
      const current = table.get(syncId);
      if (!current) continue;
      const next = { ...current, deleted_at: this.nextTimestamp(), updated_at: this.nextTimestamp() };
      table.set(syncId, next);
      echo.push({ ...next });
    }
    this.rows.set(entity, table);
    return Promise.resolve(echo);
  }

  pull(entity: string, cursor: SyncCursor | null, limit = 500): Promise<CloudRow[]> {
    const all = [...(this.rows.get(entity)?.values() ?? [])]
      .filter((r) => (cursor ? r.updated_at > cursor.updated_at : true))
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.sync_id.localeCompare(b.sync_id));
    return Promise.resolve(all.slice(0, limit));
  }

  remoteTimestamps(
    entity: string,
    syncIds: string[],
  ): Promise<{ sync_id: string; updated_at: string; deleted_at: string | null }[]> {
    const table = this.rows.get(entity) ?? new Map<string, CloudRow>();
    return Promise.resolve(
      syncIds
        .map((id) => table.get(id))
        .filter((r): r is CloudRow => Boolean(r))
        .map((r) => ({ sync_id: r.sync_id, updated_at: r.updated_at, deleted_at: r.deleted_at ?? null })),
    );
  }

  subscribe(): () => void {
    return () => undefined;
  }

  /** Test helper: apply a remote row without going through the client. */
  seed(entity: string, row: Partial<CloudRow> & { sync_id: string }): void {
    const table = this.rows.get(entity) ?? new Map<string, CloudRow>();
    table.set(row.sync_id, {
      ...row,
      user_id: this.userId,
      updated_at: row.updated_at ?? this.nextTimestamp(),
      deleted_at: row.deleted_at ?? null,
    } as CloudRow);
    this.rows.set(entity, table);
  }
}

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function initializedStorage(userId: string) {
  const storage = memoryStorage();
  storage.setItem(`dental-canvas:sync-initialized:${userId}`, "1");
  return storage;
}

function noopTimers() {
  return {
    setTimeoutFn: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimeoutFn: () => undefined,
  };
}

const USER = "11111111-1111-4111-8111-111111111111";

describe("sync engine", () => {
  it("uploads existing local data once and never duplicates it", async () => {
    const local = new FakeLocal();
    local.rows.set("patients", [
      { sync_id: "p1", first_name: "Mira", last_name: "Hasan" },
    ]);
    const cloud = new FakeCloud(USER);

    const first = createSyncEngine({ userId: USER, local, cloud, storage: memoryStorage(), ...noopTimers() });
    first.start();
    await first.syncNow();

    expect(cloud.initialized).toBe(true);
    expect(cloud.rows.get("patients")?.size).toBe(1);
    expect(first.getStatus().phase).toBe("idle");
    first.stop();

    // Simulate the same device signing in again with a cleared device flag:
    // the snapshot is re-uploaded but upserts by sync_id, so nothing duplicates.
    const second = createSyncEngine({
      userId: USER,
      local,
      cloud,
      storage: memoryStorage(),
      ...noopTimers(),
    });
    second.start();
    await second.syncNow();
    expect(cloud.rows.get("patients")?.size).toBe(1);
    const row = cloud.rows.get("patients")?.get("p1");
    expect(row?.first_name).toBe("Mira");
    second.stop();
  });

  it("propagates a soft delete to a second device and does not resurrect it", async () => {
    const cloud = new FakeCloud(USER);
    const deviceA = new FakeLocal();
    deviceA.rows.set("patients", [{ sync_id: "p1", first_name: "Old", last_name: "Row" }]);

    const engineA = createSyncEngine({ userId: USER, local: deviceA, cloud, storage: memoryStorage(), ...noopTimers() });
    engineA.start();
    await engineA.syncNow();

    // Doctor deletes the patient locally: hard delete + queued delete.
    deviceA.rows.set("patients", []);
    deviceA.outbox.push({
      entity: "patients",
      op: "delete",
      sync_id: "p1",
      outbox_ids: [1],
      base_updated_at: null,
    });
    await engineA.syncNow();
    expect(cloud.rows.get("patients")?.get("p1")?.deleted_at).toBeTruthy();
    engineA.stop();

    const deviceB = new FakeLocal();
    const engineB = createSyncEngine({ userId: USER, local: deviceB, cloud, storage: memoryStorage(), ...noopTimers() });
    engineB.start();
    await engineB.syncNow();
    expect(deviceB.rows.get("patients") ?? []).toHaveLength(0);
    engineB.stop();
  });

  it("logs a conflict when a push overwrites a newer remote edit", async () => {
    const local = new FakeLocal();
    local.owner = USER;
    const cloud = new FakeCloud(USER);
    cloud.initialized = true; // account exists; avoid the initial-upload path
    cloud.seed("patients", {
      sync_id: "p1",
      first_name: "Remote newer",
      last_name: "Row",
      updated_at: "2026-02-01T00:00:00.000Z",
    });

    local.rows.set("patients", [{ sync_id: "p1", first_name: "Local", last_name: "Row" }]);
    local.outbox.push({
      entity: "patients",
      op: "upsert",
      sync_id: "p1",
      outbox_ids: [7],
      base_updated_at: "2026-01-01T00:00:00.000Z",
      payload: { sync_id: "p1", first_name: "Local", last_name: "Row" },
    });

    const engine = createSyncEngine({
      userId: USER,
      local,
      cloud,
      storage: initializedStorage(USER),
      ...noopTimers(),
    });
    engine.start();
    await engine.syncNow();

    expect(local.conflicts).toHaveLength(1);
    expect(local.conflicts[0].resolution).toBe("push_won_over_remote");
    // The push is the last writer, so the cloud now holds the local version.
    expect(cloud.rows.get("patients")?.get("p1")?.first_name).toBe("Local");
    engine.stop();
  });

  it("clears only starter rows on a fresh device before pulling an existing account", async () => {
    const local = new FakeLocal();
    const cloud = new FakeCloud(USER);
    cloud.initialized = true;
    cloud.seed("operatories", { sync_id: "op-cloud", name: "Cloud chair" });

    // A fresh install has the seeded defaults but no user-entered data.
    local.rows.set("operatories", [{ sync_id: "op-seed", name: "Op 1" }]);
    local.summary = async () => ({ has_user_data: false, counts: { operatories: 1 } });

    const engine = createSyncEngine({ userId: USER, local, cloud, storage: memoryStorage(), ...noopTimers() });
    engine.start();
    await engine.syncNow();

    expect(local.prepared).toBe(1);
    expect(local.rows.get("operatories")?.map((r) => r.sync_id)).toEqual(["op-cloud"]);
    expect(cloud.rows.get("operatories")?.size).toBe(1); // nothing was uploaded
    engine.stop();
  });

  it("records a cloud unique conflict without blocking the rest of the queue", async () => {
    const local = new FakeLocal();
    local.owner = USER;
    const cloud = new FakeCloud(USER);
    cloud.initialized = true;
    let fails = 1;
    const original = cloud.pushUpserts.bind(cloud);
    cloud.pushUpserts = (entity, rows) => {
      if (fails > 0) {
        fails -= 1;
        return Promise.reject(
          new Error("duplicate key value violates unique constraint \"medicines_user_id_name_key\""),
        );
      }
      return original(entity, rows);
    };

    local.outbox.push(
      {
        entity: "medicines",
        op: "upsert",
        sync_id: "m1",
        outbox_ids: [1],
        base_updated_at: null,
        payload: { sync_id: "m1", name: "Amoxicillin" },
      },
      {
        entity: "operatories",
        op: "upsert",
        sync_id: "op1",
        outbox_ids: [2],
        base_updated_at: null,
        payload: { sync_id: "op1", name: "Chair 1" },
      },
    );

    const engine = createSyncEngine({
      userId: USER,
      local,
      cloud,
      storage: initializedStorage(USER),
      ...noopTimers(),
    });
    engine.start();
    await engine.syncNow();

    expect(local.conflicts[0]?.resolution).toBe("cloud_unique_conflict");
    expect(cloud.rows.get("operatories")?.has("op1")).toBe(true);
    expect(local.outbox).toHaveLength(0);
    engine.stop();
  });

  it("refuses to sync when this device belongs to a different account", async () => {
    const local = new FakeLocal();
    local.owner = "22222222-2222-4222-8222-222222222222";
    const cloud = new FakeCloud(USER);
    const engine = createSyncEngine({ userId: USER, local, cloud, storage: memoryStorage(), ...noopTimers() });
    engine.start();
    await engine.syncNow();

    expect(engine.getStatus().phase).toBe("error");
    expect(engine.getStatus().error).toContain("different account");
    expect(cloud.pushCalls).toBe(0);
    engine.stop();
  });

  it("signs out without deleting local rows or unclaiming the device", async () => {
    const local = new FakeLocal();
    local.owner = USER;
    local.rows.set("patients", [{ sync_id: "p1", first_name: "Kept", last_name: "Row" }]);
    local.outbox.push({
      entity: "patients",
      op: "upsert",
      sync_id: "p1",
      outbox_ids: [1],
      base_updated_at: null,
      payload: { sync_id: "p1", first_name: "Kept", last_name: "Row" },
    });
    const cloud = new FakeCloud(USER);
    const engine = createSyncEngine({ userId: USER, local, cloud, storage: memoryStorage(), ...noopTimers() });
    engine.start();
    await engine.release();

    expect(local.released).toBe(1);
    expect(local.rows.get("patients")).toHaveLength(1);
    // Unsynced edits survive sign-out and are still claimed by this account,
    // so another doctor signing in on this machine cannot upload them.
    expect(local.outbox).toHaveLength(1);
    expect(local.owner).toBe(USER);
    expect(engine.getStatus().phase).toBe("signed-out");
  });
});

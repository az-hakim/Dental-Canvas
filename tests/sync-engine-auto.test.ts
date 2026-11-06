import { describe, expect, it } from "vitest";
import { createSyncEngine } from "../src/client/lib/sync/engine";
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

/** Silent local store: empty, always claimable. */
class EmptyLocal implements LocalSyncApi {
  owner: string | null = null;

  meta(): Promise<LocalSyncMeta> {
    return Promise.resolve({
      owner_user_id: this.owner,
      last_pull_at: null,
      last_push_at: null,
      pending_changes: 0,
      conflicts: 0,
      cursors: {},
    });
  }
  claim(userId: string): Promise<ClaimResult> {
    this.owner = userId;
    return Promise.resolve({ ok: true, owner_user_id: userId });
  }
  release(): Promise<void> {
    return Promise.resolve();
  }
  forgetAccount(): Promise<void> {
    this.owner = null;
    return Promise.resolve();
  }
  pending(): Promise<{ changes: PendingChange[]; hasMore: boolean }> {
    return Promise.resolve({ changes: [], hasMore: false });
  }
  ack(): Promise<void> {
    return Promise.resolve();
  }
  snapshot(entity: string): Promise<SnapshotChunk> {
    return Promise.resolve({ entity, rows: [], next_after: null });
  }
  apply(changes: RemoteChange[], opts: { cursors?: Record<string, SyncCursor> } = {}): Promise<ApplyResult> {
    void changes;
    void opts;
    return Promise.resolve({ applied: 0, skipped: 0, deferred: 0, conflicts: 0 });
  }
  summary(): Promise<LocalDataSummary> {
    return Promise.resolve({ has_user_data: false, counts: {} });
  }
  preparePull(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }
  wipe(): Promise<void> {
    return Promise.resolve();
  }
  conflict(input: LocalConflict): Promise<void> {
    void input;
    return Promise.resolve();
  }
}

/** Cloud double that counts pull requests (one per table per cycle). */
class CountingCloud implements CloudSyncAdapter {
  userId = "user-1";
  pulls = 0;

  isAccountInitialized(): Promise<boolean> {
    return Promise.resolve(true);
  }
  markAccountInitialized(): Promise<void> {
    return Promise.resolve();
  }
  pushUpserts(entity: string, rows: Record<string, unknown>[]): Promise<CloudRow[]> {
    void entity;
    void rows;
    return Promise.resolve([]);
  }
  softDelete(entity: string, ids: string[]): Promise<CloudRow[]> {
    void entity;
    void ids;
    return Promise.resolve([]);
  }
  pull(entity: string): Promise<CloudRow[]> {
    void entity;
    this.pulls += 1;
    return Promise.resolve([]);
  }
  remoteTimestamps(
    entity: string,
    ids: string[],
  ): Promise<{ sync_id: string; updated_at: string; deleted_at: string | null }[]> {
    void entity;
    void ids;
    return Promise.resolve([]);
  }
  subscribe(): () => void {
    return () => undefined;
  }
}

const settle = (ms = 60) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("automatic sync switch", () => {
  it("still performs the sign-in sync when automatic sync is off", async () => {
    const cloud = new CountingCloud();
    const engine = createSyncEngine({
      userId: cloud.userId,
      local: new EmptyLocal(),
      cloud,
      storage: null,
      isOnline: () => true,
      autoSync: () => false,
    });

    engine.start();
    await settle();
    expect(cloud.pulls).toBeGreaterThan(0);
    engine.stop();
  });

  it("ignores background requests but honours an explicit Sync now", async () => {
    let auto = false;
    const cloud = new CountingCloud();
    const engine = createSyncEngine({
      userId: cloud.userId,
      local: new EmptyLocal(),
      cloud,
      storage: null,
      isOnline: () => true,
      autoSync: () => auto,
    });

    engine.start();
    await settle();
    const afterStart = cloud.pulls;

    engine.requestSync(0);
    await settle();
    expect(cloud.pulls).toBe(afterStart);

    await engine.syncNow("manual");
    const afterManual = cloud.pulls;
    expect(afterManual).toBeGreaterThan(afterStart);

    auto = true;
    engine.requestSync(0);
    await settle();
    expect(cloud.pulls).toBeGreaterThan(afterManual);

    engine.stop();
  });

  it("does not schedule a background retry while automatic sync is off", async () => {
    const cloud = new CountingCloud();
    const flaky: CloudSyncAdapter = {
      userId: cloud.userId,
      isAccountInitialized: () => cloud.isAccountInitialized(),
      markAccountInitialized: () => cloud.markAccountInitialized(),
      pushUpserts: (entity, rows) => cloud.pushUpserts(entity, rows),
      softDelete: (entity, ids) => cloud.softDelete(entity, ids),
      pull: () => Promise.reject(new Error("network down")),
      remoteTimestamps: (entity, ids) => cloud.remoteTimestamps(entity, ids),
      subscribe: () => cloud.subscribe(),
    };

    const engine = createSyncEngine({
      userId: cloud.userId,
      local: new EmptyLocal(),
      cloud: flaky,
      storage: null,
      isOnline: () => true,
      autoSync: () => false,
    });

    engine.start();
    await settle(120);
    expect(engine.getStatus().phase).toBe("error");

    // With automatic sync off the failure must not arm a retry timer, so the
    // status stays exactly as it was instead of cycling in the background.
    const failed = engine.getStatus();
    await settle(1_400); // longer than the first backoff (~1s)
    expect(engine.getStatus()).toBe(failed);

    engine.stop();
  });
});

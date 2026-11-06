/**
 * Local-first sync engine.
 *
 * The UI never waits on this: every cycle is serialized behind a promise chain
 * and every failure is surfaced as a small status indicator plus a retry with
 * exponential backoff. The engine only orchestrates; data lives in the local
 * Hono/D1 store (`LocalSyncApi`) and in Supabase (`CloudSyncAdapter`).
 *
 * Conflict policy (also documented in src/server/sync.ts):
 *   - the cloud stamps `updated_at` on every write and that timestamp wins;
 *   - a push that lands on a row another device changed since our last sync is
 *     logged as a conflict before the push (last writer wins);
 *   - a pull that meets a local row with unsynced edits compares the remote
 *     timestamp with the local edit time; the loser is kept in
 *     `sync_conflicts` on this device.
 */
import { SYNC_TABLES } from "../../../shared/sync-schema";
import { cursorFromRow } from "./cloud";
import type {
  CloudSyncAdapter,
  LocalSyncApi,
  SyncCursor,
  SyncPhase,
  SyncStatus,
} from "./types";

const DEVICE_FLAG_PREFIX = "dental-canvas:sync-initialized:";
const MAX_PUSH_PAGES = 40;
const MAX_PULL_PAGES = 200;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SyncEngineOptions {
  userId: string;
  local: LocalSyncApi;
  cloud: CloudSyncAdapter;
  isOnline?: () => boolean;
  /** Background-sync switch (Settings → Cloud sync). `syncNow` ignores it. */
  autoSync?: () => boolean;
  storage?: StorageLike | null;
  now?: () => number;
  /** Injectable for tests; production uses window.setTimeout. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface SyncEngine {
  start(): void;
  stop(): void;
  /** Manual "Sync now" — resolves when this cycle finished (never throws). */
  syncNow(reason?: string): Promise<void>;
  /** Debounced request, used after local writes / realtime nudges. */
  requestSync(delayMs?: number): void;
  /** Sign-out: stop syncing but keep local data, queued edits and the claim. */
  release(): Promise<void>;
  getStatus(): SyncStatus;
  subscribe(listener: () => void): () => void;
}

export class SyncAccountMismatchError extends Error {
  constructor() {
    super(
      "This device's data is linked to a different account. Sign out and remove local data first, then sign in here.",
    );
    this.name = "SyncAccountMismatchError";
  }
}

function defaultOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function friendlySyncError(err: unknown): string {
  if (err instanceof SyncAccountMismatchError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|network|load failed|offline/i.test(message)) {
    return "Can't reach the cloud right now. Your data is safe on this device.";
  }
  if (/jwt|token|refresh/i.test(message)) return "Cloud sign-in expired. Sign in again to resume sync.";
  return message || "Sync failed. It will retry automatically.";
}

export function createSyncEngine(opts: SyncEngineOptions): SyncEngine {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const now = opts.now ?? (() => Date.now());
  const online = opts.isOnline ?? defaultOnline;
  const setTimer = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimeoutFn ?? ((h) => clearTimeout(h));
  const deviceKey = `${DEVICE_FLAG_PREFIX}${opts.userId}`;
  const autoSync = opts.autoSync ?? (() => true);

  let status: SyncStatus = { phase: "idle", lastSyncAt: null, pending: 0, error: null };
  const listeners = new Set<() => void>();
  let chain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retry = 0;
  let stopped = false;
  let unsubscribeRealtime: (() => void) | null = null;
  let started = false;

  function setStatus(patch: Partial<SyncStatus>): void {
    status = { ...status, ...patch };
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* a broken subscriber must not break sync */
      }
    }
  }

  function deviceInitialized(): boolean {
    try {
      return storage?.getItem(deviceKey) === "1";
    } catch {
      return false;
    }
  }

  function markDeviceInitialized(value: boolean): void {
    try {
      if (value) storage?.setItem(deviceKey, "1");
      else storage?.removeItem(deviceKey);
    } catch {
      /* private mode — the initial sync is idempotent, so re-running is safe */
    }
  }

  async function uploadSnapshot(): Promise<void> {
    for (const spec of SYNC_TABLES) {
      let after = 0;
      for (;;) {
        const page = await opts.local.snapshot(spec.name, after, 250);
        if (page.rows.length > 0) {
          const echo = await opts.cloud.pushUpserts(spec.name, page.rows);
          if (echo.length > 0) {
            await opts.local.apply(
              echo.map((row) => ({ entity: spec.name, op: "upsert" as const, row })),
              { push: true },
            );
          }
        }
        if (page.next_after === null) break;
        after = page.next_after;
      }
    }
  }

  /** First sync for this account/device: upload, pull, or merge. */
  async function ensureInitialized(): Promise<void> {
    const meta = await opts.local.meta();
    if (meta.owner_user_id && meta.owner_user_id !== opts.userId) {
      throw new SyncAccountMismatchError();
    }
    if (!meta.owner_user_id) {
      const claim = await opts.local.claim(opts.userId);
      if (!claim.ok) throw new SyncAccountMismatchError();
    }
    if (deviceInitialized()) return;

    const accountReady = await opts.cloud.isAccountInitialized();
    const summary = await opts.local.summary();

    if (!accountReady) {
      // First device for this account: everything local becomes the cloud
      // baseline (including the practice's starter lookups).
      await uploadSnapshot();
      await opts.cloud.markAccountInitialized();
      await pullAll(true);
    } else if (summary.has_user_data) {
      // This device has practice data that was created offline. Merge it by
      // upserting every row by sync_id, then pull the account's other rows.
      await uploadSnapshot();
      await pullAll(true);
    } else {
      // Fresh device: local rows are only first-run seeds. Clear them before
      // pulling so the account's operatories/patients are not duplicated.
      const prepared = await opts.local.preparePull();
      if (!prepared.ok) {
        // The doctor typed something while we checked — merge instead of wipe.
        await uploadSnapshot();
      }
      await pullAll(true);
    }
    markDeviceInitialized(true);
  }

  async function pushPending(): Promise<void> {
    for (let page = 0; page < MAX_PUSH_PAGES; page++) {
      const { changes, hasMore } = await opts.local.pending(250);
      if (changes.length === 0) return;

      for (const change of changes) {
        const ids = change.outbox_ids;
        if (change.op === "delete") {
          if (!change.sync_id) {
            await opts.local.ack(ids, false);
            continue;
          }
          const echo = await opts.cloud.softDelete(change.entity, [change.sync_id]);
          if (echo.length > 0) {
            await opts.local.apply(
              echo.map((row) => ({ entity: change.entity, op: "delete" as const, row })),
              { push: true },
            );
          }
          await opts.local.ack(ids, true);
          continue;
        }

        if (!change.payload || !change.sync_id) {
          await opts.local.ack(ids, false);
          continue;
        }

        // Detect (and record) an edit another device made since our baseline.
        if (change.base_updated_at) {
          const remote = await opts.cloud.remoteTimestamps(change.entity, [change.sync_id]);
          const latest = remote[0];
          if (
            latest &&
            Date.parse(latest.updated_at) > Date.parse(change.base_updated_at)
          ) {
            await opts.local.conflict({
              entity: change.entity,
              sync_id: change.sync_id,
              resolution: "push_won_over_remote",
              local: change.payload,
              remote: latest,
            });
          }
        }

        let echo;
        try {
          echo = await opts.cloud.pushUpserts(change.entity, [change.payload]);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // A per-user unique index (e.g. medicines by name) can collide when
          // two devices created the same value offline. Keep the local row,
          // record the conflict, and let the rest of the queue proceed instead
          // of blocking every future sync on one row.
          if (/duplicate key|23505|unique constraint/i.test(message)) {
            await opts.local.conflict({
              entity: change.entity,
              sync_id: change.sync_id,
              resolution: "cloud_unique_conflict",
              local: change.payload,
              remote: { message },
            });
            await opts.local.ack(ids, false);
            continue;
          }
          throw err;
        }
        if (echo.length > 0) {
          await opts.local.apply(
            echo.map((row) => ({ entity: change.entity, op: "upsert" as const, row })),
            { push: true },
          );
        }
        await opts.local.ack(ids, true);
      }

      if (!hasMore) return;
    }
  }

  /** Pull every table, incrementally unless `full` is requested. */
  async function pullAll(full: boolean): Promise<void> {
    const meta = await opts.local.meta();
    for (const spec of SYNC_TABLES) {
      let cursor: SyncCursor | null = full ? null : (meta.cursors[spec.name] ?? null);
      for (let page = 0; page < MAX_PULL_PAGES; page++) {
        const rows = await opts.cloud.pull(spec.name, cursor, 500);
        if (rows.length === 0) break;
        const last = rows[rows.length - 1];
        const nextCursor = cursorFromRow(last);
        const result = await opts.local.apply(
          rows.map((row) => ({
            entity: spec.name,
            op: row.deleted_at ? ("delete" as const) : ("upsert" as const),
            row,
          })),
          { cursors: { [spec.name]: nextCursor } },
        );
        if (result.deferred > 0) {
          // Keep the cursor at the previous page; parents will be present on
          // the next cycle because tables are pulled in dependency order.
          break;
        }
        cursor = nextCursor;
        if (rows.length < 500) break;
      }
    }
  }

  async function cycle(): Promise<void> {
    if (stopped) return;
    if (!online()) {
      setStatus({ phase: "offline", error: null });
      return;
    }
    setStatus({ phase: "syncing", error: null });
    try {
      await ensureInitialized();
      await pushPending();
      await pullAll(false);
      const meta = await opts.local.meta();
      setStatus({
        phase: "idle",
        lastSyncAt: now(),
        pending: meta.pending_changes,
        error: null,
      });
      retry = 0;
    } catch (err) {
      const message = friendlySyncError(err);
      setStatus({ phase: online() ? "error" : "offline", error: message });
      scheduleRetry();
    }
  }

  function scheduleRetry(): void {
    if (stopped || !autoSync()) return;
    const base = Math.min(60_000, 1_000 * 2 ** Math.min(retry, 6));
    retry += 1;
    const delay = base + Math.floor(Math.random() * 250);
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void syncNow("retry");
    }, delay);
  }

  function syncNow(_reason?: string): Promise<void> {
    if (stopped) return Promise.resolve();
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    chain = chain.then(cycle).catch(() => undefined);
    return chain;
  }

  function requestSync(delayMs = 1_500): void {
    if (stopped || !autoSync()) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void syncNow("scheduled");
    }, Math.max(0, delayMs));
  }

  return {
    start() {
      if (started) return;
      started = true;
      stopped = false;
      if (!opts.cloud) {
        setStatus({ phase: "unavailable" });
        return;
      }
      setStatus({ phase: online() ? "idle" : "offline" });
      // Restore the persisted last-sync time so the panel doesn't say "never"
      // after a restart even though the outbox was already flushed.
      void opts.local
        .meta()
        .then((meta) => {
          const at = Math.max(
            Date.parse(meta.last_pull_at ?? "") || 0,
            Date.parse(meta.last_push_at ?? "") || 0,
          );
          if (at > 0) setStatus({ lastSyncAt: at, pending: meta.pending_changes });
        })
        .catch(() => undefined);
      unsubscribeRealtime = opts.cloud.subscribe(() => {
        if (autoSync()) requestSync(750);
      });
      void syncNow("start");
    },

    stop() {
      stopped = true;
      started = false;
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      unsubscribeRealtime?.();
      unsubscribeRealtime = null;
    },

    syncNow,

    requestSync,

    async release() {
      stopped = true;
      started = false;
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      unsubscribeRealtime?.();
      unsubscribeRealtime = null;
      // Let an in-flight apply finish before an explicit wipe can run, but
      // never hang sign-out on a stalled network request.
      await Promise.race([
        chain.catch(() => undefined),
        new Promise<void>((resolve) => setTimer(resolve, 5_000)),
      ]);
      // Keep the "this device is initialized for this account" flag: the local
      // rows, the outbox and the account claim all stay, so signing back in as
      // the same doctor resumes instead of re-uploading the whole practice.
      await opts.local.release();
      setStatus({ phase: "signed-out", lastSyncAt: null, pending: 0, error: null });
    },

    getStatus: () => status,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Phases that mean "no cloud account in use". */
export function isSignedOutPhase(phase: SyncPhase): boolean {
  return phase === "signed-out" || phase === "unavailable";
}

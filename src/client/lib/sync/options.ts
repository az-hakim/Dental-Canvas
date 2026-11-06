/**
 * Doctor-controlled sync preferences (Settings → Cloud sync).
 *
 * These are per-device, not per-account: they describe how *this* install
 * talks to the cloud, so they are kept in localStorage and never synced.
 * Turning automatic sync off never loses work — local writes stay queued in
 * the outbox and "Sync now" still pushes them.
 */

export interface SyncOptions {
  /** Background push/pull: after edits, Realtime nudges and the poll. */
  autoSync: boolean;
  /** How often the background poll runs while the app is open. */
  intervalMinutes: number;
}

export interface SyncOptionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const SYNC_OPTIONS_KEY = "dental-canvas:sync-options";

/** Poll cadences offered in Settings. The 1-minute default matches the old fixed poll. */
export const SYNC_INTERVAL_CHOICES = [1, 5, 15, 30, 60] as const;

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  autoSync: true,
  intervalMinutes: 1,
};

function defaultStorage(): SyncOptionStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Coerce anything (old value, hand-edited JSON) into valid options. */
export function normalizeSyncOptions(raw: unknown): SyncOptions {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const autoSync = typeof input.autoSync === "boolean" ? input.autoSync : DEFAULT_SYNC_OPTIONS.autoSync;
  const interval = Number(input.intervalMinutes);
  const intervalMinutes = (SYNC_INTERVAL_CHOICES as readonly number[]).includes(interval)
    ? interval
    : DEFAULT_SYNC_OPTIONS.intervalMinutes;
  return { autoSync, intervalMinutes };
}

export function readSyncOptions(storage?: SyncOptionStorage | null): SyncOptions {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return { ...DEFAULT_SYNC_OPTIONS };
  try {
    const raw = store.getItem(SYNC_OPTIONS_KEY);
    if (!raw) return { ...DEFAULT_SYNC_OPTIONS };
    return normalizeSyncOptions(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SYNC_OPTIONS };
  }
}

// ── Live store (useSyncExternalStore needs a stable snapshot) ─────────

const listeners = new Set<() => void>();
let snapshot: SyncOptions | null = null;

export function getSyncOptions(): SyncOptions {
  if (!snapshot) snapshot = readSyncOptions();
  return snapshot;
}

export function writeSyncOptions(
  patch: Partial<SyncOptions>,
  storage?: SyncOptionStorage | null,
): SyncOptions {
  const next = normalizeSyncOptions({ ...getSyncOptions(), ...patch });
  snapshot = next;
  const store = storage === undefined ? defaultStorage() : storage;
  try {
    store?.setItem(SYNC_OPTIONS_KEY, JSON.stringify(next));
  } catch {
    /* private mode — the choice still holds for this session */
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* a broken subscriber must not break the toggle */
    }
  }
  return next;
}

export function subscribeSyncOptions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: forget the cached snapshot so the next read hits storage again. */
export function resetSyncOptionsCache(): void {
  snapshot = null;
}

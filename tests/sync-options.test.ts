import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SYNC_OPTIONS,
  SYNC_OPTIONS_KEY,
  getSyncOptions,
  normalizeSyncOptions,
  readSyncOptions,
  resetSyncOptionsCache,
  subscribeSyncOptions,
  writeSyncOptions,
} from "../src/client/lib/sync/options";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("sync options", () => {
  beforeEach(() => resetSyncOptionsCache());

  it("defaults to automatic sync every minute", () => {
    expect(readSyncOptions(memoryStorage())).toEqual(DEFAULT_SYNC_OPTIONS);
    expect(DEFAULT_SYNC_OPTIONS).toEqual({ autoSync: true, intervalMinutes: 1 });
  });

  it("round-trips through storage", () => {
    const storage = memoryStorage();
    writeSyncOptions({ autoSync: false, intervalMinutes: 15 }, storage);
    expect(JSON.parse(storage.map.get(SYNC_OPTIONS_KEY) ?? "{}")).toEqual({
      autoSync: false,
      intervalMinutes: 15,
    });
    resetSyncOptionsCache();
    expect(readSyncOptions(storage)).toEqual({ autoSync: false, intervalMinutes: 15 });
  });

  it("falls back to defaults for corrupt JSON and unknown values", () => {
    expect(readSyncOptions(memoryStorage({ [SYNC_OPTIONS_KEY]: "{nope" }))).toEqual(
      DEFAULT_SYNC_OPTIONS,
    );
    expect(
      readSyncOptions(
        memoryStorage({ [SYNC_OPTIONS_KEY]: JSON.stringify({ autoSync: "yes", intervalMinutes: 7 }) }),
      ),
    ).toEqual(DEFAULT_SYNC_OPTIONS);
  });

  it("only accepts the intervals Settings offers", () => {
    expect(normalizeSyncOptions({ intervalMinutes: 5 }).intervalMinutes).toBe(5);
    expect(normalizeSyncOptions({ intervalMinutes: 999 }).intervalMinutes).toBe(1);
    expect(normalizeSyncOptions({ intervalMinutes: -5 }).intervalMinutes).toBe(1);
    // Writing an unsupported value is clamped rather than stored.
    expect(writeSyncOptions({ intervalMinutes: 999 }, memoryStorage()).intervalMinutes).toBe(1);
  });

  it("notifies subscribers until they unsubscribe", () => {
    const storage = memoryStorage();
    let calls = 0;
    const off = subscribeSyncOptions(() => {
      calls += 1;
    });
    writeSyncOptions({ autoSync: false }, storage);
    expect(calls).toBe(1);
    off();
    writeSyncOptions({ autoSync: true }, storage);
    expect(calls).toBe(1);
  });

  it("keeps one stable snapshot for useSyncExternalStore", () => {
    expect(getSyncOptions()).toBe(getSyncOptions());
    const next = writeSyncOptions({ intervalMinutes: 30 }, memoryStorage());
    expect(getSyncOptions()).toBe(next);
  });
});

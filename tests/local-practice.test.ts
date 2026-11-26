import { afterEach, describe, expect, it } from "vitest";
import { apiBaseUrl, setApiBaseUrl } from "../src/client/lib/api-base";
import {
  LOCAL_DB_NAME,
  hasLocalPracticeDatabase,
  useThisComputer,
} from "../src/client/lib/local-practice";

const STORAGE_KEY = "dental-canvas:api-base";

/** A localStorage good enough for the module under test. */
function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
      setItem: (key: string, value: string) => void map.set(key, String(value)),
      removeItem: (key: string) => void map.delete(key),
    },
  };
  return map;
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

// ── The way back to the local database ────────────────────────────
//
// The installers are built with VITE_API_BASE_URL pointing at the hosted
// practice. "Use this computer" therefore cannot clear the override — clearing
// it falls back to that build-time URL, and the clinic stays stuck on the
// sign-in gate with its records unreachable. These cover the override itself.

describe("choosing this computer's own database", () => {
  it("remembers the local choice as an override, not by deleting one", () => {
    const store = installStorage();
    useThisComputer();
    // A deleted key would fall back to the hosted URL baked into the installer;
    // an empty override is what makes the shell boot its own backend again.
    expect(store.has(STORAGE_KEY)).toBe(true);
    expect(store.get(STORAGE_KEY)).toBe("");
    expect(apiBaseUrl()).toBe("");
  });

  it("still saves a hosted server URL, trimmed", () => {
    const store = installStorage();
    setApiBaseUrl("https://clinic.example/");
    expect(apiBaseUrl()).toBe("https://clinic.example");
    expect(store.get(STORAGE_KEY)).toBe("https://clinic.example");
  });

  it("forgets an override only when asked to", () => {
    const store = installStorage();
    setApiBaseUrl("https://clinic.example");
    setApiBaseUrl(null);
    expect(store.has(STORAGE_KEY)).toBe(false);
  });
});

// ── Finding the database an earlier install left behind ───────────
//
// The offline backend persists one SQLite image in IndexedDB (see
// src/server/offline/sqlite-adapter.ts). No real IndexedDB exists in this test
// run, so the probe takes the factory — the same calls, faked.

interface FakeOptions {
  known?: string[];
  image?: Uint8Array;
  failOpen?: boolean;
  noDatabasesApi?: boolean;
}

function fakeIndexedDb(options: FakeOptions) {
  const db = {
    close: () => undefined,
    objectStoreNames: { contains: () => true },
    transaction: () => ({
      objectStore: () => ({
        get: () => {
          const request: Record<string, unknown> = {};
          setTimeout(() => {
            request.result = options.image;
            (request.onsuccess as (() => void) | undefined)?.();
          }, 0);
          return request;
        },
      }),
    }),
  };
  const factory: Record<string, unknown> = {
    open: () => {
      const request: Record<string, unknown> = {};
      setTimeout(() => {
        if (options.failOpen) {
          request.error = new Error("open failed");
          (request.onerror as (() => void) | undefined)?.();
        } else {
          request.result = db;
          (request.onsuccess as (() => void) | undefined)?.();
        }
      }, 0);
      return request;
    },
  };
  if (!options.noDatabasesApi) {
    factory.databases = async () => (options.known ?? []).map((name) => ({ name, version: 1 }));
  }
  return factory;
}

describe("spotting a practice database from an earlier install", () => {
  it("is false where there is no IndexedDB at all", async () => {
    expect(await hasLocalPracticeDatabase(null)).toBe(false);
  });

  it("is true when the offline image is there", async () => {
    const factory = fakeIndexedDb({ known: [LOCAL_DB_NAME], image: new Uint8Array([1, 2, 3]) });
    expect(await hasLocalPracticeDatabase(factory as never)).toBe(true);
  });

  it("is false on a machine that never stored one", async () => {
    const factory = fakeIndexedDb({ known: ["some-other-database"], image: new Uint8Array([1]) });
    expect(await hasLocalPracticeDatabase(factory as never)).toBe(false);
  });

  it("is false when the database exists but holds no image", async () => {
    const factory = fakeIndexedDb({ known: [LOCAL_DB_NAME] });
    expect(await hasLocalPracticeDatabase(factory as never)).toBe(false);
  });

  it("opens the database when the browser has no databases() listing", async () => {
    const factory = fakeIndexedDb({
      image: new Uint8Array([1]),
      noDatabasesApi: true,
    });
    expect(await hasLocalPracticeDatabase(factory as never)).toBe(true);
  });

  it("treats an unreadable store as no practice rather than failing the gate", async () => {
    const factory = fakeIndexedDb({ known: [LOCAL_DB_NAME], failOpen: true });
    expect(await hasLocalPracticeDatabase(factory as never)).toBe(false);
  });
});

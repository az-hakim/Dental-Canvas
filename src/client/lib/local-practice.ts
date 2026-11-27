/**
 * The practice database that an earlier install kept on this computer.
 *
 * Until v1.5.0 every desktop install ran its own backend and stored the whole
 * practice in one SQLite image inside IndexedDB (see
 * src/server/offline/sqlite-adapter.ts). The installers now ship pointed at the
 * hosted practice, so a clinic that updates boots into the sign-in gate with
 * that database still sitting on disk and no way to reach it from the UI.
 *
 * `hasLocalPracticeDatabase()` answers, cheaply and before anything boots,
 * whether such an image exists; the sign-in gate uses it to offer the one
 * button that matters — "use this computer's records" — and
 * `useThisComputer()` puts the app back on its own backend, which is how the
 * install behaved before the update.
 */

import { setApiBaseUrl } from "./api-base";

/** Same names the offline adapter persists under. */
export const LOCAL_DB_NAME = "dental-canvas-offline";
export const LOCAL_DB_STORE = "db-image";
export const LOCAL_DB_KEY = "sqlite";

type IdbFactoryLike = Pick<IDBFactory, "open"> & Partial<Pick<IDBFactory, "databases">>;

/** IndexedDB, or null where there is none (the browser-less test run). */
function idbFactory(): IdbFactoryLike | null {
  return typeof indexedDB !== "undefined" ? (indexedDB as IdbFactoryLike) : null;
}

function openDatabase(factory: IdbFactoryLike): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(LOCAL_DB_NAME, 1);
    // Creating the same empty store the adapter creates keeps a later open by
    // the adapter from being an upgrade-less no-op on a store-less database.
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOCAL_DB_STORE)) db.createObjectStore(LOCAL_DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function readImage(db: IDBDatabase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_DB_STORE, "readonly");
    const request = tx.objectStore(LOCAL_DB_STORE).get(LOCAL_DB_KEY);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB get failed"));
  });
}

/**
 * True when this computer holds a saved practice image.
 *
 * `indexedDB.databases()` is asked first where it exists: it answers without
 * creating anything, so a machine that never ran a local install is not left
 * with an empty database behind it.
 */
export async function hasLocalPracticeDatabase(factory: IdbFactoryLike | null = idbFactory()): Promise<boolean> {
  if (!factory) return false;
  let db: IDBDatabase | null = null;
  try {
    if (factory.databases) {
      const known = await factory.databases();
      if (!known.some((entry) => entry.name === LOCAL_DB_NAME)) return false;
    }
    db = await openDatabase(factory);
    const image = await readImage(db);
    // An empty image is a database that was created but never written.
    return ((image as Uint8Array | undefined)?.byteLength ?? 0) > 0;
  } catch {
    // A corrupt or unreadable store is not evidence of a practice to rescue.
    return false;
  } finally {
    db?.close();
  }
}

/**
 * Point this install back at its own backend — the same switch Settings →
 * Account offers, reachable from the sign-in gate. Caller reloads, because the
 * shell picks its backend at boot.
 */
export function useThisComputer(): void {
  setApiBaseUrl("");
}

/**
 * Point this install at a hosted practice — the other half of the same choice.
 * Returns false and changes nothing unless `url` is an http(s) address, so a
 * typo cannot leave the shell pointed at something that is not a server at all.
 * Caller reloads, because the shell picks its backend at boot.
 */
export function useHostedPractice(url: string): boolean {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/i.test(trimmed)) return false;
  setApiBaseUrl(trimmed);
  return true;
}

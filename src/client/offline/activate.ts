/**
 * Offline-mode activation.
 *
 * Called once from main.tsx BEFORE the React app mounts. The rule:
 *   - Tauri desktop (window.__TAURI_INTERNALS__ present) → offline mode ON.
 *     Register /sw.js and wait until the in-worker server answers /api/health,
 *     because the UI's first data fetch races the server otherwise.
 *   - Plain browser → never register; the Cloudflare Worker serves /api.
 *
 * The service worker intercepts fetch()es, so no other code path changes:
 * `api.ts` keeps issuing same-origin /api requests and works against either
 * backend transparently.
 */

export function isTauriDesktop(): boolean {
  // Android's WebView cannot register a service worker for the tauri.localhost
  // virtual origin (no SW storage on custom-scheme origins), so mobile must
  // NOT take the desktop offline path — it uses the in-page server instead
  // (see in-page-server.ts). Desktop UAs never contain "Android".
  // (Kept for callers that gate desktop-only features; boot routing lives in
  // main.tsx and treats every Tauri shell as offline-capable.)
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window &&
    !/Android/i.test(navigator.userAgent)
  );
}

/** True once the offline server has answered a health probe (SW active). */
let offlineReady = false;

export function isOfflineReady(): boolean {
  return offlineReady;
}

/**
 * Ask the service worker to persist any pending DB writes right now. Called
 * from main.tsx on pagehide/visibilitychange so a hard kill (Alt+F4, Windows
 * shutdown) can't lose the last 400ms of writes that the debounced saver
 * hasn't flushed yet. Fire-and-forget safe: if the SW isn't there yet, or is
 * gone with the page, nothing can be done anyway.
 */
export function flushDatabase(): void {
  navigator.serviceWorker?.controller?.postMessage("dental-canvas:flush-db");
}

/**
 * Flush and wait for the worker to confirm it wrote the database image.
 *
 * The plain `flushDatabase()` is fine when the page is merely closing — a
 * message that never arrives costs nothing. An update install is different:
 * the Tauri plugin launches the NSIS installer and then hard-exits this
 * process on Windows, so the last debounced writes would be lost unless the
 * flush has completed first. Resolves on the worker's acknowledgement or after
 * `timeoutMs`, whichever comes first, so a hung worker cannot block the
 * install for long.
 */
export function flushDatabaseAndWait(timeoutMs = 3000): Promise<void> {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) {
    flushDatabase();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const channel = new MessageChannel();
    const finish = () => {
      if (settled) return;
      settled = true;
      channel.port1.close();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      finish();
    };
    try {
      controller.postMessage("dental-canvas:flush-db", [channel.port2]);
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

export interface OfflineDbStatus {
  /** Epoch ms of the last successful DB-image persistence (0 = never). */
  lastSavedAt: number;
  /** Whether the in-worker server has initialized. */
  serverReady: boolean;
}

/**
 * Ask the service worker when the offline database last persisted. Resolves
 * null when there's no SW (browser mode) or it doesn't answer in time.
 */
export function getOfflineDbStatus(timeoutMs = 2000): Promise<OfflineDbStatus | null> {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return Promise.resolve(null);
  const sw = navigator.serviceWorker;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sw.removeEventListener("message", onMsg);
      resolve(null);
    }, timeoutMs);
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type !== "dental-canvas:status") return;
      clearTimeout(timer);
      sw.removeEventListener("message", onMsg);
      resolve({ lastSavedAt: e.data.lastSavedAt ?? 0, serverReady: !!e.data.serverReady });
    };
    sw.addEventListener("message", onMsg);
    controller.postMessage("dental-canvas:get-status");
  });
}

import {
  isInPageOfflineMode,
  flushInPageDatabase,
  startInPageOfflineMode,
  isInPageServerLive,
} from "./in-page-server";
import { apiBaseUrl } from "@/lib/api-base";

/**
 * True when this install talks to a hosted practice (the web app) rather than
 * to a backend bundled on this machine.
 *
 * The desktop installers are built with `VITE_API_BASE_URL` pointing at the
 * deployment (see .github/workflows/build-packages.yml), which makes the same
 * binary a native shell over the web app: identical records, identical
 * sign-in, nothing to back up locally. Settings → Account can still point an
 * install back at its own backend, and this flips with it.
 */
export function usesHostedServer(): boolean {
  return apiBaseUrl() !== "";
}

export async function activateOfflineMode(): Promise<void> {
  // Every Tauri shell (desktop AND mobile) runs the offline backend. On
  // desktop that's the service worker; on mobile the SW API exists but
  // registration fails on the tauri.localhost origin, so we fall through to
  // the in-page server instead of failing boot.
  if (!("__TAURI_INTERNALS__" in window)) return;

  // Hosted shell: every request already goes to the practice's server (see
  // lib/api-base), so there is no local database to start. Booting the
  // in-worker SQLite server here only delayed the first paint, seeded a
  // database nothing reads, and left the data-safety cards reporting on a
  // device store that is not in use.
  if (usesHostedServer()) return;

  try {
    if (!isTauriDesktop() || !("serviceWorker" in navigator)) {
      // Mobile (or a desktop without SW support): run the backend in-page.
      // Do NOT try register() first — on Android it throws the
      // "Failed to register a ServiceWorker" error the fatal screen shows.
      await startInPageOfflineMode();
      offlineReady = true;
      return;
    }

    // The SW is registered at scope "/" so it owns both /api and the shell.
    // Module worker: the Vite bundle is ESM (it code-splits shared helpers).
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/", type: "module" });

    // An in-app update replaces the exe between runs. The freshly booted page
    // may still be controlled by the OLD worker (or an old cached shell), so
    // probe for a newer registration on every boot: if one installs, its
    // activate wipes the version-stamped shell cache and claims the page;
    // the controllerchange reload below then loads the new UI.
    try {
      await reg.update();
      if (reg.waiting || reg.installing) {
        reg.waiting?.postMessage("skip-waiting");
        // Wait briefly for the new worker to take over before continuing.
        await Promise.race([
          navigator.serviceWorker.ready.then(() => undefined),
          new Promise((r) => setTimeout(r, 5_000)),
        ]);
      }
    } catch {
      // A failed update probe must not block boot — the old shell still runs.
    }

    // If the worker is already active, wait for it to control this page.
    // Otherwise the activate handler finishes initializing the server.
    await navigator.serviceWorker.ready;

    // Probe until the in-worker server answers — seed+migrations run during
    // activate, and sql.js WASM compilation takes a moment.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        const j = (await r.json()) as { ok?: boolean };
        if (j.ok) {
          offlineReady = true;
          return;
        }
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error("Offline server did not become ready within 30s");
  } catch (err) {
    // Last-resort fallback: if the service worker path fails for ANY reason
    // (registration refused, stale/corrupt cache, update probe timeout), run
    // the backend in-page instead of showing the fatal screen. The in-page
    // server is the same Hono app, so the UI works identically. Never fall
    // back twice — if the in-page server itself fails, surface the error.
    if (!isInPageServerLive()) {
      try {
        await startInPageOfflineMode();
        offlineReady = true;
        return;
      } catch (fallbackErr) {
        (window as unknown as { __OFFLINE_ERROR__?: string }).__OFFLINE_ERROR__ =
          `Offline backend failed (worker: ${(err as Error).message}; in-page: ${(fallbackErr as Error).message})`;
        throw fallbackErr;
      }
    }
    (window as unknown as { __OFFLINE_ERROR__?: string }).__OFFLINE_ERROR__ =
      (err as Error).message;
    throw err;
  }
}

/**
 * Watch for a newer service worker taking over (an app update installed
 * while this window is open, or the first boot after an in-place update)
 * and reload once so the UI matches the worker. `skipWaiting` +
 * `clients.claim` in the SW make the takeover instant; the reload here
 * replaces the old shell assets with the new ones.
 */
export function watchForUpdates(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // Reload when a DIFFERENT worker takes control than the one this page
    // booted with. The sessionStorage flag persists per app run, so the very
    // first boot after an update (new exe, old SW from the previous version
    // still controlling) also reloads into the new shell.
    if (sessionStorage.getItem("dental-canvas:had-controller") === "1") {
      window.location.reload();
    }
    sessionStorage.setItem("dental-canvas:had-controller", "1");
  });
  // A waiting worker may ask to skip waiting (see activateOfflineMode).
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data === "dental-canvas:sw-skip-waiting") {
      navigator.serviceWorker.controller?.postMessage("skip-waiting");
    }
  });
}

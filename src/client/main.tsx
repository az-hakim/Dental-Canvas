import { createRoot } from "react-dom/client";
import { App } from "./app";
import { AuthProvider } from "./auth";
import { activateOfflineMode, isTauriDesktop, flushDatabase, watchForUpdates } from "./offline/activate";
import {
  isInPageOfflineMode,
  flushInPageDatabase,
  startInPageOfflineMode,
} from "./offline/in-page-server";
import { installGlobalCrashGuards } from "./lib/crash-guards";
import "./styles.css";

/**
 * Mount order matters in desktop/offline mode: the service worker (which IS
 * the backend) must be answering /api before React fires its first fetch.
 * In the browser this is a no-op and mounts immediately.
 *
 * Desktop hardening (the .exe must never show a silent blank screen):
 *   - boot failures render a diagnostic screen with a Retry button,
 *   - global error handlers catch renderer crashes into the same screen,
 *   - pagehide/visibilitychange flush pending DB writes before shutdown.
 */

const appEl = document.getElementById("app")!;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Full-screen diagnostic panel (boot failure / renderer crash). */
function showFatalScreen(title: string, detail: string, showRetry: boolean): void {
  appEl.innerHTML =
    `<div style="font-family:system-ui,sans-serif;padding:2rem;max-width:34rem;margin:4rem auto;color:#1f2937;">` +
    `<h1 style="font-size:1.15rem;margin-bottom:.75rem;">${esc(title)}</h1>` +
    `<p style="color:#4b5563;font-size:.9rem;line-height:1.5;white-space:pre-wrap;">${esc(detail)}</p>` +
    `<p style="color:#6b7280;font-size:.8rem;margin-top:1rem;">` +
    `Your data is stored safely on this computer and is <b>not</b> lost.</p>` +
    (showRetry
      ? `<button id="retry-btn" style="margin-top:1.25rem;padding:.5rem 1.25rem;font-size:.9rem;border:1px solid #d1d5db;border-radius:.5rem;background:#fff;cursor:pointer;">Retry</button>`
      : "") +
    `</div>`;
  const btn = document.getElementById("retry-btn");
  btn?.addEventListener("click", () => window.location.reload());
}

const mount = () => {
  createRoot(appEl).render(
    <AuthProvider>
      <App />
    </AuthProvider>,
  );
};

if (isTauriDesktop()) {
  // ── Desktop: service worker IS the backend ─────────────────
  // Reload once when a newer service worker takes over (app update), so the
  // UI assets always match the running backend.
  watchForUpdates();

  // Flush the offline DB whenever the window is being hidden or closed —
  // covers Alt+F4, Windows shutdown, and force-kill within the debounce window.
  const onFlush = () => void flushDatabase();
  window.addEventListener("pagehide", onFlush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") onFlush();
  });

  // Any uncaught error or rejected promise becomes a readable screen, never a
  // blank window.
  installGlobalCrashGuards((title, detail) => showFatalScreen(title, detail, false));

  activateOfflineMode()
    .then(mount)
    .catch((err: Error) => {
      showFatalScreen(
        "Dental Canvas could not start",
        `${err.message}\n\nIf this keeps happening: fully quit the app (check the taskbar tray) and reopen it, or reinstall. ` +
          `If the problem persists, use Settings → Backup on your previous install to export a backup file.`,
        true,
      );
    });
} else if (isInPageOfflineMode()) {
  // ── Android (Tauri mobile): the WebView cannot host a service worker,
  // so the same Hono server runs in-page behind a fetch shim. Boot fails
  // visibly with the same diagnostic screen if the backend can't start.
  installGlobalCrashGuards((title, detail) => showFatalScreen(title, detail, false));
  const onFlush = () => void flushInPageDatabase();
  window.addEventListener("pagehide", onFlush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") onFlush();
  });

  startInPageOfflineMode()
    .then(mount)
    .catch((err: Error) => {
      showFatalScreen(
        "Dental Canvas could not start",
        `${err.message}\n\nIf this keeps happening: fully close the app and reopen it, or reinstall. ` +
          `Your data is stored safely on this device and is not lost.`,
        true,
      );
    });
} else {
  mount();
}

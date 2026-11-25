import { useEffect } from "react";
import { api } from "../api";

/**
 * Daily inventory scan trigger.
 *
 * The scan itself (low-stock / out-of-stock / expiry pass) lives server-side —
 * `runInventoryScan` in `src/server/inventory.ts` — but like auto-backup, this
 * app is serverless, so the "daily call" is orchestrated from the browser:
 * once per day (checked against a localStorage date), the app shell fires
 * POST /api/inventory/scan. The Inventory page's "Scan now" button and the
 * dashboard alert panel share the same endpoint and the same semantics —
 * open alerts are rebuilt to match the current stock state.
 *
 * Mirrors use-auto-backup's structure, so a real Cloudflare Cron trigger can
 * replace it later without touching the server logic.
 */

const LAST_SCAN_KEY = "dental-canvas:last-inventory-scan";

/**
 * `enabled` false means no session yet (hosted sign-in gate): the scan is a
 * tenant API call, so it must wait. The stored date is only written after a
 * successful scan, so signing in later still runs today's once-per-day pass.
 */
export function useDailyInventoryScan(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const today = new Date().toISOString().slice(0, 10);
    try {
      if (window.localStorage.getItem(LAST_SCAN_KEY) === today) return;
    } catch {
      /* private mode — just scan */
    }
    api("POST", "/api/inventory/scan")
      .catch(() => undefined)
      .then(() => {
        try {
          window.localStorage.setItem(LAST_SCAN_KEY, today);
        } catch { /* ignore */ }
        // Let the dashboard alert panel and any open Inventory page refresh.
        window.dispatchEvent(new Event("dental-canvas:inventory-scan"));
      });
  }, [enabled]);
}
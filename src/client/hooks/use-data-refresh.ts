import { useEffect, useRef } from "react";
import { onDataChanged, type DataChangeReason } from "@/lib/data-change-signal";

export interface DataRefreshOptions {
  /** Only refresh for these change reasons. Omit to refresh for any change. */
  reasons?: DataChangeReason[];
  /** Also poll while mounted (ms). 0 = off. */
  intervalMs?: number;
  /** Coalesce bursts of changes into one refresh (ms). */
  debounceMs?: number;
}

/**
 * Keep a screen's data live.
 *
 * Panels used to fetch once in an effect with an empty dependency array, so
 * anything created elsewhere — a patient registered from the dashboard's
 * "New patient" dialog, an appointment booked from the agenda — never appeared
 * until a full page reload. This hook re-runs the loader when the app writes
 * data, when the tab regains focus, and (optionally) on an interval, all
 * debounced so a burst of writes costs one refetch.
 */
export function useDataRefresh(
  refresh: () => void | Promise<void>,
  options: DataRefreshOptions = {},
): void {
  const { intervalMs = 0, debounceMs = 250 } = options;
  const reasonsKey = (options.reasons ?? []).join(",");
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const allowed = reasonsKey ? new Set(reasonsKey.split(",")) : null;
    let timer: number | null = null;
    let cancelled = false;

    const run = () => {
      if (cancelled) return;
      void refreshRef.current();
    };

    const schedule = () => {
      if (cancelled) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(run, debounceMs);
    };

    const off = onDataChanged((event) => {
      if (!allowed || allowed.has(event.reason)) schedule();
    });
    const onFocus = () => schedule();
    const onVisibility = () => {
      if (document.visibilityState === "visible") schedule();
    };
    const onAuthChange = () => schedule();

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("dental-canvas:auth-required", onAuthChange);
    const interval = intervalMs > 0 ? window.setInterval(schedule, intervalMs) : null;

    return () => {
      cancelled = true;
      off();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("dental-canvas:auth-required", onAuthChange);
      if (timer !== null) window.clearTimeout(timer);
      if (interval !== null) window.clearInterval(interval);
    };
  }, [reasonsKey, intervalMs, debounceMs]);
}

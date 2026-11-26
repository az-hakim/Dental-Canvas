/**
 * Client API helper — every call goes through here so the offline/online
 * boundary stays in one place. Successful mutations additionally emit a
 * data-change signal (see ./data-change-signal) that feeds the
 * change-triggered auto-backup and the live dashboard refresh: after the app
 * writes anything meaningful, a debounced snapshot is scheduled and open
 * screens re-read their data without every caller having to remember to ask.
 *
 * A hosted deployment additionally needs the caller's session: the Supabase
 * access token is attached as a bearer token, and the server derives the
 * practice (tenant) from it.
 */
import { notifyDataChanged, type DataChangeReason } from "./lib/data-change-signal";
import { apiBaseUrl } from "./lib/api-base";
import { supabase } from "./lib/supabase";

/**
 * Map a mutating request to the kind of data it touched. GETs and
 * non-data endpoints (backups, settings, drive auth, dashboard reads, the
 * auto-backup call itself) return null and signal nothing — backing up on a
 * backup would be self-inducing.
 */
function changeReasonFor(method: string, path: string): DataChangeReason | null {
  if (method === "GET") return null;
  const p = path.split("?")[0];
  // The auto-backup endpoint writes only to the backups table, which is
  // deliberately excluded from dumps — never signal on it.
  if (p.startsWith("/api/backup")) return null;
  if (p.startsWith("/api/settings") || p.startsWith("/api/storage") || p.startsWith("/api/drive")) return null;
  if (p.includes("/appointments") || p.includes("/waiting-list") || p.includes("/appointments-to-make") || p.includes("/recalls")) {
    return "appointment";
  }
  if (p.includes("/patients") && !p.includes("/images")) return "patient";
  if (p.includes("/images")) return "image";
  if (p.includes("/invoices") || p.includes("/payment-plans") || p.includes("/installments")) return "invoice";
  if (p.includes("/prescriptions")) return "prescription";
  if (p.includes("note") || p.includes("/tooth") || p.includes("/treatment-plan") || p.includes("/consents") || p.includes("/lab")) {
    return "clinical_note";
  }
  if (p.includes("/medicines")) return "medicine";
  if (p.includes("/inventory")) return "inventory";
  return null;
}

/** Join the configured API origin (hosted deployment) with an API path. */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = apiBaseUrl();
  return base && path.startsWith("/") ? `${base}${path}` : path;
}

async function sessionHeaders(): Promise<Record<string, string>> {
  if (!supabase) return {};
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = { method, headers: { ...(await sessionHeaders()) } };
  if (body !== undefined) {
    (opts.headers as Record<string, string>)["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const reason = changeReasonFor(method, path);
  const r = await fetch(apiUrl(path), opts);
  let data: unknown = null;
  try {
    data = await r.json();
  } catch {
    /* empty body */
  }
  if (!r.ok) {
    const payload = data as { error?: string } | null;
    const msg = payload?.error || `${r.status} ${r.statusText}`;
    if (r.status === 401) {
      // Session gone (expired, revoked, or never there): the shell shows the
      // sign-in screen instead of an error banner for every panel.
      window.dispatchEvent(new CustomEvent("dental-canvas:auth-required"));
    }
    throw new Error(msg);
  }
  // Success on a data mutation → schedule (or extend) the change-triggered
  // backup window. Fire-and-forget; failures inside the signal are swallowed.
  if (reason) notifyDataChanged(reason);
  return data as T;
}

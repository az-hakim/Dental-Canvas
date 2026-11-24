/**
 * Where the API lives.
 *
 * The desktop/Tauri build normally talks to its own offline backend on the
 * same origin. Pointed at a hosted deployment (`VITE_API_BASE_URL`, or the
 * runtime override saved from Settings → Account) the exact same client code
 * calls that API instead. Whether sign-in is required is decided by the server
 * (see ./server-config), not inferred from this URL.
 */

const STORAGE_KEY = "dental-canvas:api-base";

function env(name: string): string | undefined {
  const value = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  return value?.trim() || undefined;
}

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Runtime override (desktop → hosted server), else the build-time value. */
export function apiBaseUrl(): string {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored !== null) return normalize(stored);
  } catch {
    /* private mode — fall through to the build-time value */
  }
  return normalize(env("VITE_API_BASE_URL") ?? "");
}

/** Save (or clear, with null) the server this app talks to. Needs a reload. */
export function setApiBaseUrl(url: string | null): void {
  try {
    if (url && normalize(url)) window.localStorage.setItem(STORAGE_KEY, normalize(url));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do — the build-time value still applies */
  }
}

/**
 * Signature in the app can read the current server without importing React.
 * Used by Settings to show what this install is connected to.
 */
export function currentApiBaseUrl(): string {
  return apiBaseUrl();
}

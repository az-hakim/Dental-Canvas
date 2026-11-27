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

/**
 * The override saved on this computer, or null when there is none.
 *
 * An empty string is a real choice — "use this computer's own database" — and
 * is different from having saved nothing, which falls back to the URL baked in
 * at build time. The installers ship with that URL set (see
 * .github/workflows/build-packages.yml), so clearing the key would leave an
 * existing install pointed at the hosted practice anyway.
 */

function env(name: string): string | undefined {
  const value = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  return value?.trim() || undefined;
}

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * The server URL this build was compiled with (`VITE_API_BASE_URL`), or ""
 * when it has none. The installers are built pointed at the hosted practice,
 * so on a fresh install this is the hosted address the sign-in gate offers.
 */
export function buildTimeApiBaseUrl(): string {
  return normalize(env("VITE_API_BASE_URL") ?? "");
}

/**
 * The override saved on this computer, exactly as saved: a server URL, "" for
 * this computer's own database, or null when nothing has been chosen yet (so
 * the build-time URL applies). The sign-in gate uses the null case to know a
 * desktop install has not been through the first-run choice.
 */
export function savedApiBaseUrl(): string | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === null ? null : normalize(stored);
  } catch {
    /* private mode — behave as though nothing was saved */
    return null;
  }
}

/**
 * The saved override when there is one — a server URL, or "" for this
 * computer's own database — else the URL the build was compiled with.
 */
export function apiBaseUrl(): string {
  return savedApiBaseUrl() ?? buildTimeApiBaseUrl();
}

/**
 * Save the server this app talks to — `null` forgets the override (the build's
 * URL applies again), `""` means "this computer's own database". Needs a
 * reload.
 */
export function setApiBaseUrl(url: string | null): void {
  try {
    if (url === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, normalize(url));
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

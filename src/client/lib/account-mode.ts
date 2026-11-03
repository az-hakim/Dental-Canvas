/**
 * The doctor's account preference, persisted per device.
 *
 * `unset` means first-run onboarding has not asked yet. `offline` means the
 * doctor explicitly skipped cloud sync — the app works exactly as before and
 * onboarding must never ask again. `cloud` means an account was used; the
 * doctor may still be signed out.
 */

export type AccountMode = "unset" | "offline" | "cloud";

export const ACCOUNT_MODE_KEY = "dental-canvas:account-mode";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function localStore(): KeyValueStore | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function parseAccountMode(raw: string | null): AccountMode {
  return raw === "offline" || raw === "cloud" ? raw : "unset";
}

export function readAccountMode(store: KeyValueStore | null = localStore()): AccountMode {
  try {
    return parseAccountMode(store?.getItem(ACCOUNT_MODE_KEY) ?? null);
  } catch {
    return "unset";
  }
}

export function writeAccountMode(
  mode: AccountMode,
  store: KeyValueStore | null = localStore(),
): void {
  try {
    store?.setItem(ACCOUNT_MODE_KEY, mode);
  } catch {
    /* private mode / quota — onboarding may ask again next launch */
  }
}

/**
 * Should first-run onboarding include the Account step?
 * Only when cloud sync is available and the doctor has never answered.
 */
export function shouldOfferAccountStep(
  mode: AccountMode,
  cloudAvailable: boolean,
): boolean {
  return cloudAvailable && mode === "unset";
}

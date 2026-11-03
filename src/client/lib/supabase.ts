/**
 * Supabase client — created only when both public env vars are present.
 *
 * Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are ever bundled. The
 * service role key must never appear in this file or in any VITE_* variable;
 * account deletion goes through the `delete-account` Edge Function.
 *
 * With either value missing the export is null and the whole account/sync UI
 * degrades to offline-only mode instead of crashing.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseEnv {
  url?: string;
  anonKey?: string;
}

/** Read Vite env vars without assuming import.meta.env exists (tests, SSR). */
export function readSupabaseEnv(): SupabaseEnv {
  const env = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {});
  return {
    url: env.VITE_SUPABASE_URL?.trim() || undefined,
    anonKey: env.VITE_SUPABASE_ANON_KEY?.trim() || undefined,
  };
}

export function hasSupabaseEnv(env: SupabaseEnv): boolean {
  return Boolean(env.url && env.anonKey);
}

export function createCloudClient(env: SupabaseEnv): SupabaseClient | null {
  if (!hasSupabaseEnv(env)) return null;
  try {
    return createClient(env.url!, env.anonKey!, {
      auth: {
        // Local-first: the session lives in this device's localStorage and keeps
        // the doctor signed in across desktop restarts.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: "dental-canvas-auth",
        // Implicit links keep email-confirm/reset usable even when the link
        // opens outside the app. (Tauri cannot receive deep links in this build;
        // see README "Cloud sync".)
        flowType: "implicit",
      },
    });
  } catch (err) {
    // A malformed URL in a hand-edited .env must degrade to offline-only, not
    // blank the whole app at module load.
    console.warn("[auth] Cloud sync is misconfigured; running offline only.", err);
    return null;
  }
}

const env = readSupabaseEnv();

/** Shared client, or null in offline-only builds. */
export const supabase: SupabaseClient | null = createCloudClient(env);

/** True only when a usable client was actually created. */
export const cloudConfigured = supabase !== null;

/** Non-technical auth error messages for the UI. */
export function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials")) return "That email and password don't match.";
  if (m.includes("email not confirmed")) {
    return "Check your inbox and confirm your email before signing in.";
  }
  if (m.includes("user already registered")) {
    return "An account with this email already exists. Try signing in instead.";
  }
  if (m.includes("password should be at least")) return "Use a password with at least 8 characters.";
  if (m.includes("rate limit") || m.includes("too many")) {
    return "Too many attempts. Wait a minute and try again.";
  }
  if (m.includes("network") || m.includes("fetch") || m.includes("failed to fetch")) {
    return "You appear to be offline. Cloud sync will resume when you reconnect.";
  }
  if (m.includes("invalid email")) return "Enter a valid email address.";
  if (m.includes("jwt") || m.includes("token")) return "Your session expired. Please sign in again.";
  return message;
}

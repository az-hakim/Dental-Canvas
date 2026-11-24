/**
 * Server-side authentication for the hosted deployment.
 *
 * The browser/desktop client already signs in through Supabase, so the API
 * does not implement its own password flow — it verifies the access token the
 * client sends and maps the Supabase user to a clinic. Tokens are checked
 * against the Supabase Auth server (`/auth/v1/user`) rather than decoded
 * locally, so both legacy HS256 and the newer asymmetric signing keys work
 * without shipping a JWT secret to the function.
 *
 * Unauthenticated deployments: with no SUPABASE_URL / anon key configured the
 * API runs in single-practice mode (local development, Tauri offline backend),
 * which is exactly the pre-existing behaviour.
 */

export interface VerifiedUser {
  id: string;
  email: string | null;
  clinicName: string;
}

/**
 * `process` is absent in some service-worker/mobile builds that bundle the
 * server (offline desktop mode), where every hosting variable is simply unset.
 */
function env(name: string): string {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return String(proc?.env?.[name] ?? "").trim();
}

export function supabaseServerConfig(): { url: string; anonKey: string } | null {
  const url = env("SUPABASE_URL") || env("VITE_SUPABASE_URL");
  const anonKey = env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY");
  if (!url || !anonKey) return null;
  return { url: url.replace(/\/+$/, ""), anonKey };
}

export function authConfigured(): boolean {
  return supabaseServerConfig() !== null;
}

interface CacheEntry {
  user: VerifiedUser | null;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 500;
const cache = new Map<string, CacheEntry>();

function cacheSet(key: string, value: VerifiedUser | null): void {
  if (cache.size >= CACHE_LIMIT) {
    // Drop the oldest insertion — a plain Map keeps insertion order.
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { user: value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Verify a Supabase access token. Returns null for an invalid or expired one.
 * Results are cached briefly so a dashboard's parallel requests cost one check.
 */
export async function verifyAccessToken(token: string): Promise<VerifiedUser | null> {
  if (!token) return null;
  const cached = cache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  const cfg = supabaseServerConfig();
  if (!cfg) return null;

  try {
    const res = await fetch(`${cfg.url}/auth/v1/user`, {
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      cacheSet(token, null);
      return null;
    }
    const body = (await res.json()) as {
      id?: string;
      email?: string | null;
      user_metadata?: { clinic_name?: string; doctor_name?: string };
    };
    if (!body.id) {
      cacheSet(token, null);
      return null;
    }
    const user: VerifiedUser = {
      id: body.id,
      email: body.email ?? null,
      clinicName: (body.user_metadata?.clinic_name ?? "").trim(),
    };
    cacheSet(token, user);
    return user;
  } catch {
    // Network failure is not proof the token is bad — do not cache it.
    return null;
  }
}

/** Extract a bearer token from an Authorization header. */
export function bearerToken(header: string | undefined | null): string {
  if (!header) return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : "";
}

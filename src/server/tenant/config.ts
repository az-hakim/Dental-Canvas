/**
 * Public deployment configuration (`GET /api/config`).
 *
 * The client asks the server whether sign-in is required instead of inferring
 * it from the API URL it happens to have been built with, so a hosted
 * deployment can never fall back to serving practice data unauthenticated
 * because one build-time variable was missing.
 *
 * The Supabase URL and anon key are public by design — the browser ships them
 * — so serving them here lets a deployment be configured from its server
 * environment alone, with no duplicate `VITE_*` copies to keep in sync.
 */
import { supabaseServerConfig } from "./auth";

export interface PublicConfig {
  authRequired: boolean;
  signIn: { url: string; anonKey: string } | null;
}

export function publicConfig(): PublicConfig {
  const supabase = supabaseServerConfig();
  return { authRequired: supabase !== null, signIn: supabase };
}

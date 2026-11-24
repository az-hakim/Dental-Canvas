/**
 * What this deployment says about itself.
 *
 * Whether the app requires sign-in is the server's answer (`GET /api/config`),
 * never a guess from the API URL the build happened to embed: a hosted build
 * missing one Vite variable must not quietly serve practice data without a
 * session. The boot code awaits `loadServerConfig()` before mounting the app.
 */

import { apiBaseUrl } from "./api-base";
import { configureCloud } from "./supabase";

export interface ServerConfig {
  authRequired: boolean;
  signIn: { url: string; anonKey: string } | null;
}

let config: ServerConfig | null = null;

/**
 * The config request failed. A remote API — or a page served over https, which
 * means a hosted deployment — is then assumed to require sign-in: fail closed,
 * and let the sign-in gate explain itself, rather than show the app first.
 * Desktop and local builds keep working exactly as before.
 */
function unreachable(): ServerConfig {
  const hosted =
    apiBaseUrl() !== "" ||
    (typeof window !== "undefined" && window.location.protocol === "https:");
  return { authRequired: hosted, signIn: null };
}

export function serverConfig(): ServerConfig {
  return config ?? unreachable();
}

/** True when the shell must show the sign-in gate. */
export function authRequired(): boolean {
  return serverConfig().authRequired;
}

/** Fetch the deployment config once, before the app mounts. */
export async function loadServerConfig(): Promise<ServerConfig> {
  const base = apiBaseUrl();
  const controller = new AbortController();
  // AbortSignal.timeout is not in every desktop webview yet.
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(base ? `${base}/api/config` : "/api/config", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const body = res.ok ? ((await res.json()) as Partial<ServerConfig>) : null;
    const signIn =
      body?.signIn?.url && body.signIn.anonKey
        ? { url: body.signIn.url, anonKey: body.signIn.anonKey }
        : null;
    // A malformed answer must not open the app: only an explicit false does.
    config = { authRequired: body?.authRequired !== false, signIn };
  } catch {
    config = unreachable();
  } finally {
    clearTimeout(timer);
  }
  if (config.signIn) configureCloud(config.signIn);
  return config;
}

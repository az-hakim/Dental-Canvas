/**
 * Public-token → clinic registry.
 *
 * Two endpoints are deliberately unauthenticated because a patient follows
 * them: the online-booking link (`/api/public/booking/:token`) and the
 * prescription share link (`/api/prescriptions/share/:token`). In a
 * multi-tenant deployment the server must know which clinic a bare token
 * belongs to before it can touch that clinic's tables, so every time a token
 * is minted the hosting runtime records it in the control-plane database.
 *
 * This module is the browser-safe half of that contract: `src/server/index.ts`
 * is bundled into the offline service worker, so it must not import libSQL.
 * The Node/Vercel runtime installs a registrar at boot; on Cloudflare Workers
 * and in offline mode there is only one practice, so registration is a no-op.
 */

import { currentTenantKey } from "../db";

export type PublicTokenKind = "booking" | "prescription";

type Registrar = (token: string, clinicId: string, kind: PublicTokenKind) => Promise<void>;

let registrar: Registrar | null = null;

/** Installed once by the multi-tenant runtime. */
export function setPublicTokenRegistrar(fn: Registrar | null): void {
  registrar = fn;
}

/**
 * Record a freshly minted public token. Fire-and-forget: a registry failure
 * must never fail the booking-link / share operation that created it (the
 * link is already stored in the clinic's own tables).
 */
export function registerPublicToken(token: string, kind: PublicTokenKind): void {
  if (!registrar || !token) return;
  void registrar(token, currentTenantKey(), kind).catch(() => undefined);
}

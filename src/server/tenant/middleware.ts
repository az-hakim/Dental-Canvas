/**
 * Request middleware for the hosted multi-tenant deployment.
 *
 * Runs in front of the whole Hono app (mounted in `api/index.mjs`), so the
 * tenant is known before any route handler — and therefore before any SQL —
 * executes.
 *
 *   - signed-in API calls  -> clinic resolved from the Supabase user
 *   - public booking / Rx  -> clinic resolved from the token index
 *   - health / discovery   -> no clinic needed
 *   - no auth configured   -> single-practice mode (local/offline parity)
 */

import type { Context, Next } from "hono";
import { bearerToken, authConfigured, verifyAccessToken } from "./auth";
import { clinicForPublicToken, databaseConfigError, resolveClinic, withClinic } from "./runtime";

/** Endpoints that must work without a session and without tenant data. */
function isSessionlessPath(path: string): boolean {
  return (
    path === "/api/health" ||
    path === "/api/config" ||
    path === "/api/openapi.json" ||
    path === "/llms.txt" ||
    path === "/api" ||
    path === "/"
  );
}

/**
 * Tokens are embedded in the URL for the two patient-facing flows, so the
 * clinic is looked up from the control plane before routing.
 */
function publicTokenForPath(path: string): string | null {
  const booking = /^\/api\/public\/booking\/([^/]+)/.exec(path);
  if (booking) return decodeURIComponent(booking[1]!);
  const share = /^\/api\/prescriptions\/share\/([^/]+)$/.exec(path);
  if (share) return decodeURIComponent(share[1]!);
  return null;
}

function defaultClinicId(): string {
  return (process.env.DENTAL_CANVAS_DEFAULT_CLINIC ?? "default-practice").trim();
}

function corsOrigin(requestOrigin: string | undefined): string {
  const allowed = (process.env.CORS_ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.includes("*")) return "*";
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return allowed[0] ?? "*";
}

export async function tenantMiddleware(c: Context, next: Next): Promise<Response | void> {
  const requestOrigin = c.req.header("origin");
  const allowOrigin = corsOrigin(requestOrigin);

  const applyCors = (res: Response): Response => {
    res.headers.set("Access-Control-Allow-Origin", allowOrigin);
    if (allowOrigin !== "*") res.headers.set("Vary", "Origin");
    res.headers.set("Access-Control-Allow-Credentials", "false");
    return res;
  };

  if (c.req.method === "OPTIONS") {
    const preflight = new Response(null, { status: 204 });
    preflight.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    preflight.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    preflight.headers.set("Access-Control-Max-Age", "86400");
    return applyCors(preflight);
  }

  const path = new URL(c.req.url).pathname;
  let clinicId: string | null = null;
  let dbProblem: string | null;

  const publicToken = publicTokenForPath(path);
  if (publicToken) {
    clinicId = await clinicForPublicToken(publicToken);
    if (!clinicId) return applyCors(c.json({ error: "Not found" }, 404));
  } else if (isSessionlessPath(path)) {
    // Health and discovery never read practice data — /api/config in
    // particular must keep answering so a misconfigured deployment still
    // tells the browser that sign-in is required.
    await next();
    return applyCors(c.res);
  } else if ((dbProblem = databaseConfigError())) {
    // Everything below reaches the database. Serving an unreadable crash
    // instead of saying what is missing is what made a deployment look broken
    // rather than misconfigured.
    return applyCors(c.json({ error: dbProblem, code: "database_not_configured" }, 503));
  } else if (!authConfigured()) {
    clinicId = defaultClinicId();
  } else {
    const token = bearerToken(c.req.header("authorization"));
    if (!token) {
      return applyCors(
        c.json({ error: "Sign in to continue.", code: "auth_required" }, 401),
      );
    }
    const user = await verifyAccessToken(token);
    if (!user) {
      return applyCors(
        c.json({ error: "Your session expired. Please sign in again.", code: "auth_required" }, 401),
      );
    }
    const clinic = await resolveClinic(user);
    clinicId = clinic.id;
  }

  await withClinic(clinicId, async () => {
    await next();
  });

  return applyCors(c.res);
}

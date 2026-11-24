/**
 * Vercel entry point (Node runtime).
 *
 * Every `/api/*` request reaches this handler. The tenant middleware resolves
 * the caller's clinic *before* the app's routes run, then the existing Hono
 * application handles the request exactly as it does on Cloudflare Workers and
 * in the desktop/offline backend.
 *
 * `scripts/build-api.mjs` bundles this file into `api/[...path].mjs` during the
 * Vercel build: Vercel transpiles an `api/` function in place without bundling,
 * so a plain TypeScript entry would ship extensionless ESM imports of
 * `src/server/*` that Node cannot resolve at runtime.
 */
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import app from "./index";
import { tenantMiddleware } from "./tenant/middleware";
import { installTenantRuntime } from "./tenant/runtime";
import { createD1Facade } from "./tenant/d1-facade";

installTenantRuntime();

const outer = new Hono();

outer.use("*", async (c, next) => {
  try {
    return await tenantMiddleware(c, next);
  } catch (err) {
    console.error("[api] unhandled error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

outer.route("/", app);

const env = { DB: createD1Facade() } as never;

// Vercel's Node runtime calls the default export with (req, res).
export default getRequestListener((request) => outer.fetch(request, env));

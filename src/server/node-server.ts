/**
 * Standalone Node server for local development and self-hosting.
 *
 * Serves the built Vite app from `dist/` plus the same Hono API the Vercel
 * deployment runs, on one origin — so `fetch("/api/…")` works exactly as it
 * does in production.
 *
 *   npm run build && npm run web:serve
 *   # then open http://localhost:3000
 *
 * Environment: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN (or a local file
 * database by default), SUPABASE_URL / SUPABASE_ANON_KEY to require sign-in.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import app from "./index";
import { tenantMiddleware } from "./tenant/middleware";
import { installTenantRuntime } from "./tenant/runtime";
import { createD1Facade } from "./tenant/d1-facade";

installTenantRuntime();

const outer = new Hono();
outer.use("*", tenantMiddleware);
outer.route("/", app);

const env = { DB: createD1Facade() } as never;
const apiListener = getRequestListener((request) => outer.fetch(request, env));

const DIST = path.resolve(process.cwd(), "dist");
const PORT = Number(process.env.PORT ?? 3000);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(pathname: string): Promise<{ body: Buffer; type: string } | null> {
  const relative = pathname.replace(/^\/+/, "");
  const candidate = path.resolve(DIST, relative);
  if (!candidate.startsWith(DIST)) return null;
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return null;
    return {
      body: await readFile(candidate),
      type: MIME[path.extname(candidate).toLowerCase()] ?? "application/octet-stream",
    };
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname.startsWith("/api/") || url.pathname === "/llms.txt") {
    apiListener(req, res);
    return;
  }
  void (async () => {
    const file = await serveStatic(url.pathname);
    if (file) {
      res.writeHead(200, { "Content-Type": file.type });
      res.end(file.body);
      return;
    }
    // SPA fallback: every client-side route renders index.html.
    const shell = await serveStatic("/index.html");
    if (!shell) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Run `npm run build` first.");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(shell.body);
  })();
});

server.listen(PORT, () => {
  console.log(`Dental Canvas web app listening on http://localhost:${PORT}`);
});

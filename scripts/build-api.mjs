/**
 * Bundle the Vercel API function.
 *
 * Vercel transpiles a TypeScript file in `api/` in place and does not follow
 * its relative imports out of that directory, so the emitted function carried
 * `import … from "../src/server/index"` — a bare, extensionless ESM specifier
 * that Node cannot resolve. The deployed function failed with
 * ERR_MODULE_NOT_FOUND before any request was handled.
 *
 * Bundling fixes the resolution at build time. Only packages stay external:
 * they are installed on Vercel from the lockfile, and the SQLite/WASM assets in
 * `sql.js` must stay real files.
 *
 * The output is `api/index.mjs`, a single plain function. A bracketed catch-all
 * (`api/[...path].mjs`) is not a real route on Vercel for non-Next projects: it
 * matched `/api/patients` but every deeper path — `/api/patients/1`,
 * `/api/dashboard/summary` — 404'd at the edge before reaching the function.
 * `vercel.json` sends all of `/api/*` here instead and restores the original
 * path with a `request.path` transform.
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("api", { recursive: true });

await build({
  entryPoints: ["src/server/vercel-entry.ts"],
  outfile: "api/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  legalComments: "none",
  logLevel: "info",
});

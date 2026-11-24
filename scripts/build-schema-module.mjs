/**
 * Emit `src/server/schema.generated.ts` from `src/server/schema.sql`.
 *
 * The hosted (Vercel/Node) runtime has to apply the schema to every clinic's
 * table namespace at runtime. Vite can import SQL with `?raw`, but a plain
 * Node function cannot, so the DDL is embedded as a string module instead of
 * relying on file tracing. Run this after editing schema.sql:
 *
 *   node scripts/build-schema-module.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const schemaPath = path.join(root, "src/server/schema.sql");
const outPath = path.join(root, "src/server/schema.generated.ts");

const sql = readFileSync(schemaPath, "utf8");

// Backticks appear in SQL comments; escape them (and `${`) so the DDL can live
// inside a template literal.
const escaped = sql
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

const contents = `// AUTO-GENERATED from src/server/schema.sql — do not edit by hand.
// Regenerate with: npm run schema:generate
//
// The hosted (Vercel/Node) runtime applies this DDL to each clinic's table
// namespace, where a \`?raw\` import of schema.sql is not available.
export const SCHEMA_SQL = \`${escaped}\`;
`;

writeFileSync(outPath, contents);
console.log(`wrote ${path.relative(root, outPath)} (${contents.length} bytes)`);

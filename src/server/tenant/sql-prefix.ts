/**
 * Per-tenant table namespacing.
 *
 * Dental Canvas was written as a single-practice app: every SQL statement
 * addresses a bare table name (`patients`, `invoices`, …). Rather than rewrite
 * ~6k lines of SQL to add a `clinic_id` predicate to every statement — the kind
 * of change where one forgotten `WHERE` leaks one clinic's patients into
 * another's — a hosted multi-tenant deployment gives every clinic its own
 * physical set of tables inside one SQLite database:
 *
 *     patients  ->  t_<clinicId>_patients
 *
 * Because the tables are physically different, a query cannot reach another
 * clinic's rows even if it has no tenant filter at all. `rewriteSql` performs
 * that renaming on the way to the driver, and it is careful about what is an
 * identifier and what is data:
 *
 *   - single-quoted string literals are DATA and are never rewritten, so
 *     `entity_type = 'patients'` and stored values keep their meaning;
 *   - double-quoted / backtick / bracket identifiers ARE rewritten;
 *   - comments are skipped;
 *   - indexes (`idx_*`) and sync triggers (`<table>_sync_ai`) are namespaced
 *     too, otherwise the second clinic's `CREATE ... IF NOT EXISTS` would be a
 *     silent no-op and its outbox triggers would never fire.
 */

/**
 * Every table this app creates — `src/server/schema.sql` plus the sync
 * bookkeeping tables created by `src/server/sync.ts`. Kept as a static list
 * (not parsed from schema.sql) so the offline service-worker bundle does not
 * need to carry the schema text just to rename tables.
 */
export const TENANT_TABLES: readonly string[] = [
  "appointments",
  "appointments_to_make",
  "backups",
  "booking_links",
  "booking_requests",
  "clinical_notes",
  "consent_signatures",
  "consent_templates",
  "dentist_notes",
  "insurance_plans",
  "inventory_alerts",
  "inventory_items",
  "inventory_movements",
  "invoice_items",
  "invoice_payment_plans",
  "invoice_payments",
  "invoices",
  "lab_cases",
  "medicines",
  "membership_plans",
  "operatories",
  "patient_image_blobs",
  "patient_images",
  "patient_memberships",
  "patient_recall_config",
  "patients",
  "practitioners",
  "prescription_advice_presets",
  "prescription_items",
  "prescription_layouts",
  "prescription_templates",
  "prescriptions",
  "search_index",
  "settings",
  "sync_conflicts",
  "sync_cursors",
  "sync_outbox",
  "sync_state",
  "sync_tombstones",
  "tooth_conditions",
  "treatment_plan_items",
  "treatment_types",
  "waiting_list",
] as const;

const TABLE_SET = new Set(TENANT_TABLES);

/** True for an identifier that must be namespaced for a clinic. */
export function isTenantIdentifier(token: string): boolean {
  if (TABLE_SET.has(token)) return true;
  // Index names: static ones from schema.sql and the per-table
  // `idx_<table>_sync_id` created by the sync engine.
  if (token.startsWith("idx_")) return true;
  // Sync outbox triggers, generated as `<table>_sync_ai|au|ad`.
  if (/_sync_(ai|au|ad)$/.test(token)) return true;
  return false;
}

/** Validate a clinic id and turn it into a safe table-name prefix. */
export function tenantPrefix(clinicId: string): string {
  const cleaned = clinicId.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (cleaned.length < 8) {
    throw new Error("tenant: invalid clinic id");
  }
  return `t_${cleaned}_`;
}

/**
 * Prefix for the current tenant key. Single-tenant deployments (Cloudflare
 * Workers, the desktop/offline backend) use the key "default" and their
 * tables are unprefixed, exactly as before.
 */
export function prefixForKey(key: string | null | undefined): string {
  if (!key || key === "default") return "";
  return tenantPrefix(key);
}

/** Remove a tenant prefix from a table name read back from sqlite_master. */
export function stripPrefix(name: string, prefix: string): string {
  return prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

const ID_START = /[A-Za-z_]/;
const ID_PART = /[A-Za-z0-9_$]/;

/**
 * Rewrite tenant table/index/trigger identifiers to be clinic-scoped.
 * Everything else — keywords, columns, placeholders, literals — is untouched.
 */
export function rewriteSql(sql: string, prefix: string): string {
  if (!prefix) return sql;
  let out = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i]!;

    // ── data: single-quoted string literal ('' escapes a quote) ──
    if (ch === "'") {
      out += ch;
      i++;
      while (i < n) {
        const c = sql[i]!;
        out += c;
        i++;
        if (c === "'") {
          if (sql[i] === "'") {
            out += sql[i]!;
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }

    // ── identifiers that may be quoted ──
    if (ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      let name = "";
      while (j < n && sql[j] !== close) {
        name += sql[j];
        j++;
      }
      const quoted = j < n; // closing quote present
      out += ch;
      out += isTenantIdentifier(name) ? prefix + name : name;
      if (quoted) {
        out += close;
        j++;
      }
      i = j;
      continue;
    }

    // ── comments ──
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? n : end + 1;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // ── bare identifier ──
    if (ID_START.test(ch)) {
      let j = i;
      let name = "";
      while (j < n && ID_PART.test(sql[j]!)) {
        name += sql[j];
        j++;
      }
      out += isTenantIdentifier(name) ? prefix + name : name;
      i = j;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Split a DDL script into executable statements. Trigger bodies contain `;`
 * between `BEGIN` and `END`, so a naive split corrupts them.
 */
export function splitStatements(sqlText: string): string[] {
  const noComments = sqlText
    .split("\n")
    .filter((line) => !/^[ \t]*--/.test(line))
    .join("\n");
  const stmts: string[] = [];
  let cur = "";
  let inTrigger = false;
  for (const ch of noComments) {
    cur += ch;
    if (ch !== ";") continue;
    const body = cur.slice(0, -1).trimEnd();
    if (!inTrigger) {
      if (/^\s*CREATE\s+TRIGGER/i.test(body)) {
        inTrigger = true;
        continue;
      }
      stmts.push(cur.trim());
      cur = "";
    } else if (/\bEND$/i.test(body)) {
      stmts.push(cur.trim());
      cur = "";
      inTrigger = false;
    }
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts.filter((s) => s.length > 0);
}

/** Apply a clinic's namespacing to a whole DDL script. */
export function rewriteSchema(schemaSql: string, prefix: string): string[] {
  return splitStatements(schemaSql).map((stmt) => rewriteSql(stmt, prefix));
}

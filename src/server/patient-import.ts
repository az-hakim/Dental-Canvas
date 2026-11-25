/**
 * Bulk patient import.
 *
 * A clinic changing software arrives with a spreadsheet, not with an afternoon
 * to retype it. This module turns a CSV exported from another practice
 * management system (or saved out of Excel / Google Sheets) into exactly the
 * rows `POST /api/patients` would create, and says up front which rows are new,
 * which already exist in this practice, and which cannot be read.
 *
 * Everything here is pure: the parser, the column guessing and the matching
 * rules are unit-tested without a database, and the routes in `index.ts` only
 * add the two queries (read the existing patients, insert the new ones).
 */

/** ~20k rows of name-and-phone. Bigger files belong in the JSON restore. */
export const MAX_PATIENT_IMPORT_BYTES = 2 * 1024 * 1024;

/** More than this in one go is a mistake, not an import. */
export const MAX_IMPORT_ROWS = 5000;

/** The preview table only needs enough rows to show the shape of the file. */
export const PREVIEW_ROWS = 200;

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

const DELIMITERS = [",", ";", "\t"] as const;

/**
 * Guesses the field separator from the header line. European exports use
 * semicolons (the comma is the decimal mark there) and pasted-from-a-browser
 * tables use tabs; treating either as one giant column is the classic
 * "import produced a single patient called 'First Name'" bug.
 */
function sniffDelimiter(text: string): string {
  const newline = text.search(/\r?\n/);
  const firstLine = newline === -1 ? text : text.slice(0, newline);
  let best: string = ",";
  let bestCount = -1;
  for (const delimiter of DELIMITERS) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === delimiter && !inQuotes) count++;
    }
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Splits CSV text into records. Quotes are handled the RFC 4180 way: a field
 * may contain the delimiter, line breaks and doubled quotes.
 */
function splitRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.trim() === "") {
      inQuotes = true;
      field = "";
      continue;
    }
    if (ch === delimiter) {
      record.push(field);
      field = "";
      continue;
    }
    if (ch === "\r") continue; // \r\n and a lone \r both end at the \n below
    if (ch === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/**
 * Parses CSV text into a header row plus data rows. A UTF-8 BOM (Excel writes
 * one) would otherwise become part of the first header name and hide the name
 * column, and blank lines are dropped so a trailing newline adds no patient.
 */
export function parseCsv(input: string): CsvTable {
  const text = input.replace(/^\uFEFF/, "");
  if (!text.trim()) return { headers: [], rows: [] };
  const records = splitRecords(text, sniffDelimiter(text)).filter((record) =>
    record.some((cell) => cell.trim() !== ""),
  );
  const headerRow = records.shift() ?? [];
  return {
    headers: headerRow.map((header) => header.trim()),
    rows: records,
  };
}

// ── Column guessing ───────────────────────────────────────────────

export type ImportField =
  | "first_name"
  | "last_name"
  | "full_name"
  | "phone"
  | "email"
  | "date_of_birth"
  | "address"
  | "notes"
  | "patient_gender"
  | "medical_alerts"
  | "referral_source";

export type ColumnMap = Partial<Record<ImportField, number>>;

export interface DetectedColumns {
  map: ColumnMap;
  /** Header text as written in the file, per mapped field. */
  labels: Partial<Record<ImportField, string>>;
  /** Columns we had no use for, shown to the user so nothing is a surprise. */
  unmapped: string[];
}

/** Headers seen in exports from Dentally, Open Dental, Eaglesoft, Excel… */
const ALIASES: Record<ImportField, string[]> = {
  first_name: ["first name", "firstname", "first", "given name", "given", "forename", "fname", "christian name"],
  last_name: ["last name", "lastname", "last", "surname", "family name", "family", "lname"],
  full_name: ["name", "patient", "patient name", "full name", "fullname", "client", "client name", "customer"],
  phone: [
    "phone",
    "phone number",
    "mobile",
    "mobile number",
    "cell",
    "cell phone",
    "telephone",
    "tel",
    "contact number",
    "home phone",
    "work phone",
    "whatsapp",
  ],
  email: ["email", "e mail", "email address", "mail"],
  date_of_birth: ["date of birth", "dob", "birth date", "birthdate", "birthday", "born", "d o b"],
  address: ["address", "street", "street address", "home address", "address line 1", "address 1", "postal address"],
  notes: ["notes", "note", "comments", "comment", "remarks", "reason", "reason for visit", "description"],
  patient_gender: ["gender", "sex", "patient gender"],
  medical_alerts: [
    "alerts",
    "medical alerts",
    "allergies",
    "allergy",
    "medical conditions",
    "conditions",
    "medical history",
  ],
  referral_source: ["referral", "referred by", "referral source", "source", "how did you hear about us"],
};

/**
 * Header names arrive with capitals, punctuation and units of noise
 * ("Patient's Mobile #"), so compare on lowercase words only.
 */
function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Maps header names onto the patient fields. Exact matches win first, so a file
 * with both "Email" and "Address" cannot have "Email Address" stolen by the
 * address column; the second pass then accepts word-level containment
 * ("Patient Phone Number" → phone).
 */
export function detectColumns(headers: string[]): DetectedColumns {
  const normalized = headers.map(normalizeHeader);
  const map: ColumnMap = {};
  const labels: Partial<Record<ImportField, string>> = {};
  const taken = new Set<number>();

  const assign = (field: ImportField, index: number) => {
    if (map[field] !== undefined || taken.has(index)) return false;
    map[field] = index;
    labels[field] = headers[index] ?? "";
    taken.add(index);
    return true;
  };

  for (const [index, header] of normalized.entries()) {
    if (!header) continue;
    for (const field of Object.keys(ALIASES) as ImportField[]) {
      if (ALIASES[field].includes(header)) {
        assign(field, index);
        break;
      }
    }
  }

  // Specific fields first: "email" must claim "Email Address" before "address"
  // does, and "date of birth" must beat "notes".
  const containmentOrder: ImportField[] = [
    "email",
    "date_of_birth",
    "phone",
    "first_name",
    "last_name",
    "medical_alerts",
    "patient_gender",
    "referral_source",
    "address",
    "notes",
    "full_name",
  ];
  for (const field of containmentOrder) {
    if (map[field] !== undefined) continue;
    const index = normalized.findIndex(
      (header, i) => header !== "" && !taken.has(i) && ALIASES[field].some((alias) => header.includes(alias)),
    );
    if (index !== -1) assign(field, index);
  }

  return {
    map,
    labels,
    unmapped: headers.filter((_, index) => !taken.has(index) && normalized[index] !== ""),
  };
}

// ── Value cleanup ─────────────────────────────────────────────────

/** Digits only, with a leading country code dropped so 15550100111 = 5550100111. */
export function phoneDigits(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

function cleanText(raw: string | undefined): string {
  return (raw ?? "").trim();
}

/** Excel writes a leading apostrophe on cells it decided were text. */
function cleanPhone(raw: string | undefined): string | null {
  const value = cleanText(raw).replace(/^'/, "").trim();
  return value === "" ? null : value;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Reads the date formats a spreadsheet actually produces: ISO, slashed, dotted
 * and dashed, two- or four-digit years, plus the bare serial number Excel keeps
 * when a date column is exported unformatted. `null` means "could not read".
 *
 * A date like 03/04/1990 is ambiguous; the file is read as MM/DD/YYYY (the
 * practice's own date format) unless the first number is over 12.
 */
export function normalizeImportDate(raw: string | undefined): string | null {
  const value = cleanText(raw);
  if (!value) return null;

  // Excel serial date: days since 1899-12-30.
  if (/^\d{5}$/.test(value)) {
    const days = Number(value);
    if (days > 20000 && days < 60000) {
      const date = new Date(Date.UTC(1899, 11, 30) + days * 86_400_000);
      return date.toISOString().slice(0, 10);
    }
  }

  const parts = value.match(/^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})$/);
  if (!parts) return null;
  const [, a = "", b = "", c = ""] = parts;

  let year: number;
  let month: number;
  let day: number;
  if (a.length === 4) {
    year = Number(a);
    month = Number(b);
    day = Number(c);
  } else {
    const first = Number(a);
    const second = Number(b);
    const shortYear = Number(c);
    year = shortYear < 100 ? (shortYear > new Date().getUTCFullYear() % 100 ? 1900 + shortYear : 2000 + shortYear) : shortYear;
    // Day-first only when the first number cannot be a month.
    if (first > 12) {
      day = first;
      month = second;
    } else {
      month = first;
      day = second;
    }
  }
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function normalizeGender(raw: string | undefined): string | null {
  const value = cleanText(raw).toLowerCase();
  if (!value) return null;
  if (value === "m" || value.startsWith("male") || value === "man") return "M";
  if (value === "f" || value.startsWith("female") || value === "woman") return "F";
  return "Other";
}

// ── Rows ──────────────────────────────────────────────────────────

export interface Candidate {
  /** Line in the file, header being line 1 — what the user sees in a editor. */
  line: number;
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  patient_gender: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  medical_alerts: string | null;
  notes: string | null;
  referral_source: string | null;
  /** Set when the row cannot be a patient at all. */
  error: string | null;
  /** Values dropped or adjusted on the way in ("phone looks wrong"). */
  warnings: string[];
}

function splitFullName(raw: string): { first_name: string; last_name: string } {
  const value = raw.replace(/\s+/g, " ").trim();
  if (!value) return { first_name: "", last_name: "" };
  // "Smith, John" — the comma form every export uses for a sortable name.
  const comma = value.indexOf(",");
  if (comma > 0) {
    return {
      first_name: value.slice(comma + 1).trim(),
      last_name: value.slice(0, comma).trim(),
    };
  }
  const parts = value.split(" ");
  if (parts.length === 1) return { first_name: parts[0] ?? "", last_name: "" };
  return { first_name: parts.slice(0, -1).join(" "), last_name: parts[parts.length - 1] ?? "" };
}

function cell(row: string[], index: number | undefined): string | undefined {
  if (index === undefined) return undefined;
  return row[index];
}

/**
 * Turns parsed rows into patients. Rows that cannot be a patient carry an
 * `error` and are reported, never silently dropped; recoverable problems
 * (an unreadable date, a malformed email) become `warnings` so the rest of the
 * row still imports.
 */
export function candidatesFrom(table: CsvTable, map: ColumnMap): Candidate[] {
  return table.rows.map((row, index) => {
    const warnings: string[] = [];
    let first_name = "";
    let last_name = "";

    if (map.first_name !== undefined || map.last_name !== undefined) {
      first_name = cleanText(cell(row, map.first_name));
      last_name = cleanText(cell(row, map.last_name));
    }
    if (!first_name && !last_name && map.full_name !== undefined) {
      const split = splitFullName(cleanText(cell(row, map.full_name)));
      first_name = split.first_name;
      last_name = split.last_name;
    }
    // A "Name" column plus a "First name" column: trust the explicit one.
    if (!first_name && map.full_name !== undefined && last_name) {
      const split = splitFullName(cleanText(cell(row, map.full_name)));
      first_name = split.first_name;
    }

    const dobRaw = cleanText(cell(row, map.date_of_birth));
    const date_of_birth = normalizeImportDate(dobRaw);
    if (dobRaw && !date_of_birth) warnings.push(`date of birth “${dobRaw}” could not be read`);

    const emailRaw = cleanText(cell(row, map.email));
    const email = emailRaw && EMAIL.test(emailRaw) ? emailRaw : null;
    if (emailRaw && !email) warnings.push(`email “${emailRaw}” is not an address`);

    let error: string | null = null;
    if (!first_name && !last_name) {
      error = "no name in this row";
    } else if (last_name && !first_name) {
      // "Cher" or a single surname: keep it, but say so.
      warnings.push("no first name");
    }

    return {
      line: index + 2,
      first_name,
      last_name,
      date_of_birth,
      patient_gender: normalizeGender(cell(row, map.patient_gender)),
      email,
      phone: cleanPhone(cell(row, map.phone)),
      address: cleanText(cell(row, map.address)) || null,
      medical_alerts: cleanText(cell(row, map.medical_alerts)) || null,
      notes: cleanText(cell(row, map.notes)) || null,
      referral_source: cleanText(cell(row, map.referral_source)) || null,
      error,
      warnings,
    };
  });
}

// ── Matching ──────────────────────────────────────────────────────

export interface ExistingPatient {
  id: number;
  first_name: string;
  last_name: string;
  phone: string | null;
  date_of_birth: string | null;
}

export type RowStatus = "new" | "duplicate" | "invalid";

export interface PlannedRow {
  candidate: Candidate;
  status: RowStatus;
  /** Why a row is a duplicate or invalid — shown in the preview. */
  reason: string | null;
  /** The patient already on file, when that is the reason. */
  duplicate_of: number | null;
  /** File line of the row that already contains this person, for in-file repeats. */
  duplicate_of_line: number | null;
}

function nameKey(first: string, last: string): string {
  return `${first.trim().toLowerCase()}|${last.trim().toLowerCase()}`;
}

/**
 * Marks every row new, duplicate or invalid.
 *
 * A shared phone number is the strongest signal a clinic has, so it wins on its
 * own. A name alone is only trusted when the birth dates agree, or when one
 * side has no date at all — two different "John Smith"s with dates of birth
 * are two people, but "John Smith" typed twice with no date is one.
 */
export function planImport(candidates: Candidate[], existing: ExistingPatient[]): PlannedRow[] {
  const byPhone = new Map<string, ExistingPatient>();
  const byName = new Map<string, ExistingPatient[]>();
  for (const patient of existing) {
    const digits = phoneDigits(patient.phone);
    if (digits.length >= 7 && !byPhone.has(digits)) byPhone.set(digits, patient);
    const key = nameKey(patient.first_name, patient.last_name);
    if (key !== "|") {
      const list = byName.get(key) ?? [];
      list.push(patient);
      byName.set(key, list);
    }
  }

  const seenPhone = new Map<string, number>();
  const seenName = new Map<string, number>();

  return candidates.map((candidate) => {
    if (candidate.error) {
      return { candidate, status: "invalid" as RowStatus, reason: candidate.error, duplicate_of: null, duplicate_of_line: null };
    }

    const digits = phoneDigits(candidate.phone);
    if (digits.length >= 7) {
      const samePhone = byPhone.get(digits);
      if (samePhone) {
        return {
          candidate,
          status: "duplicate" as RowStatus,
          reason: "same phone number",
          duplicate_of: samePhone.id,
          duplicate_of_line: null,
        };
      }
      const earlier = seenPhone.get(digits);
      if (earlier !== undefined) {
        return {
          candidate,
          status: "duplicate" as RowStatus,
          reason: "same phone number as an earlier row",
          duplicate_of: null,
          duplicate_of_line: earlier,
        };
      }
    }

    const key = nameKey(candidate.first_name, candidate.last_name);
    const sameName = byName.get(key) ?? [];
    const match = sameName.find(
      (patient) =>
        !patient.date_of_birth || !candidate.date_of_birth || patient.date_of_birth === candidate.date_of_birth,
    );
    if (match) {
      return {
        candidate,
        status: "duplicate" as RowStatus,
        reason: "same name on file",
        duplicate_of: match.id,
        duplicate_of_line: null,
      };
    }
    const earlierName = seenName.get(key);
    if (earlierName !== undefined) {
      return {
        candidate,
        status: "duplicate" as RowStatus,
        reason: "same name as an earlier row",
        duplicate_of: null,
        duplicate_of_line: earlierName,
      };
    }

    if (digits.length >= 7) seenPhone.set(digits, candidate.line);
    seenName.set(key, candidate.line);
    return { candidate, status: "new" as RowStatus, reason: null, duplicate_of: null, duplicate_of_line: null };
  });
}

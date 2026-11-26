import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, freshApp, jsonRequest, type TestContext } from "./helpers";
import {
  candidatesFrom,
  detectColumns,
  normalizeAlerts,
  normalizeImportDate,
  parseCsv,
  phoneDigits,
  planImport,
  type Candidate,
  type ExistingPatient,
} from "../src/server/patient-import";

// ── The parser ────────────────────────────────────────────────────

describe("CSV parsing", () => {
  it("reads a plain file into headers and rows", () => {
    const table = parseCsv("First name,Last name\nJane,Cooper\nMarcus,Hale\n");
    expect(table.headers).toEqual(["First name", "Last name"]);
    expect(table.rows).toEqual([
      ["Jane", "Cooper"],
      ["Marcus", "Hale"],
    ]);
  });

  it("keeps quoted commas, doubled quotes and line breaks inside a field", () => {
    const table = parseCsv('Name,Notes\n"Doe, John","Says ""hi""\nsecond line"\n');
    expect(table.rows[0]).toEqual(["Doe, John", 'Says "hi"\nsecond line']);
  });

  it("strips the BOM Excel writes and ignores blank lines", () => {
    const table = parseCsv("\uFEFFFirst name,Last name\r\nJane,Cooper\r\n\r\n\r\n");
    expect(table.headers).toEqual(["First name", "Last name"]);
    expect(table.rows).toHaveLength(1);
  });

  it("handles semicolon exports and tab-pasted tables", () => {
    expect(parseCsv("First name;Last name\nJane;Cooper\n").rows).toEqual([["Jane", "Cooper"]]);
    expect(parseCsv("First name\tLast name\nJane\tCooper\n").rows).toEqual([["Jane", "Cooper"]]);
  });

  it("returns nothing for an empty file", () => {
    expect(parseCsv("   \n  ")).toEqual({ headers: [], rows: [], rowLines: [] });
  });

  it("counts the physical line each row starts on, through quoted line breaks", () => {
    const table = parseCsv('Name,Notes\n"Smith, John","first\nsecond"\nJane,Cooper\n');
    expect(table.rowLines).toEqual([2, 4]);
  });

  it("counts blank lines the same way the editor does", () => {
    const table = parseCsv("First name,Last name\n\nJane,Cooper\n");
    expect(table.rowLines).toEqual([3]);
  });
});

// ── Column guessing ───────────────────────────────────────────────

describe("column detection", () => {
  it("maps the headers a real export uses", () => {
    const columns = detectColumns(["Given Name", "Surname", "Mobile Number", "E-mail", "DOB", "Notes"]);
    expect(columns.map).toEqual({
      first_name: 0,
      last_name: 1,
      phone: 2,
      email: 3,
      date_of_birth: 4,
      notes: 5,
    });
  });

  it("accepts a single name column", () => {
    const columns = detectColumns(["Patient", "Phone"]);
    expect(columns.map.full_name).toBe(0);
    expect(columns.map.phone).toBe(1);
  });

  it("does not let “Email Address” be read as the address", () => {
    const columns = detectColumns(["Name", "Email Address", "Address"]);
    expect(columns.map.email).toBe(1);
    expect(columns.map.address).toBe(2);
  });

  it("reports columns it ignored", () => {
    const columns = detectColumns(["First name", "Last name", "Policy #"]);
    expect(columns.unmapped).toEqual(["Policy #"]);
  });
});

// ── Value cleanup ─────────────────────────────────────────────────

describe("dates, phones and names", () => {
  it("reads the date formats spreadsheets produce", () => {
    expect(normalizeImportDate("1988-03-22")).toBe("1988-03-22");
    expect(normalizeImportDate("22/03/1988")).toBe("1988-03-22"); // day > 12, so day-first
    expect(normalizeImportDate("03/22/1988")).toBe("1988-03-22");
    expect(normalizeImportDate("3.4.1990")).toBe("1990-03-04"); // ambiguous → MM/DD
    expect(normalizeImportDate("25569")).toBe("1970-01-01"); // Excel serial date
    expect(normalizeImportDate("31/31/1990")).toBeNull();
    expect(normalizeImportDate("not a date")).toBeNull();
    expect(normalizeImportDate("")).toBeNull();
  });

  it("compares phone numbers by digits, ignoring the country code", () => {
    expect(phoneDigits("(555) 010-0111")).toBe("5550100111");
    expect(phoneDigits("+1 555 010 0111")).toBe("5550100111");
    expect(phoneDigits(null)).toBe("");
  });

  it("splits a single name column both ways", () => {
    // "Surname, First" — the comma form every export uses for a sortable name.
    const quoted = parseCsv('Name,Phone\n"Smith, John",555-0100\n');
    const [commaForm] = candidatesFrom(quoted, detectColumns(quoted.headers).map);
    expect(commaForm?.last_name).toBe("Smith");
    expect(commaForm?.first_name).toBe("John");

    // "First Surname" — the plain form, last word is the surname.
    const plain = parseCsv("Name,Phone\nJane Cooper,555-0101\n");
    const [plainForm] = candidatesFrom(plain, detectColumns(plain.headers).map);
    expect(plainForm?.first_name).toBe("Jane");
    expect(plainForm?.last_name).toBe("Cooper");
  });

  it("keeps a row with a bad date or email, with a warning", () => {
    const table = parseCsv(
      "First name,Last name,Email,Date of birth\nZelda,Quarrington,not-an-email,31/31/1990\n",
    );
    const [row] = candidatesFrom(table, detectColumns(table.headers).map);
    expect(row?.error).toBeNull();
    expect(row?.email).toBeNull();
    expect(row?.date_of_birth).toBeNull();
    expect(row?.warnings).toHaveLength(2);
  });

  it("rejects a row with no name at all", () => {
    const table = parseCsv("First name,Last name,Phone\n,,555-0100\n");
    const [row] = candidatesFrom(table, detectColumns(table.headers).map);
    expect(row?.error).toBe("no name in this row");
  });
});

// ── Medical alerts ────────────────────────────────────────────────

describe("medical alerts", () => {
  it("tags every entry of an allergies column", () => {
    expect(normalizeAlerts("Penicillin, latex", true)).toBe("allergy:penicillin,allergy:latex");
  });

  it("reads the ways a file writes down an allergy", () => {
    expect(normalizeAlerts("Allergic to penicillin (rash)")).toBe("allergy:penicillin-rash");
    expect(normalizeAlerts("allergy: penicillin; Sulfa drugs")).toBe("allergy:penicillin,allergy:sulfa-drugs");
    expect(normalizeAlerts("Drug allergy: Ibuprofen; reacts to latex")).toBe(
      "allergy:ibuprofen,allergy:latex",
    );
    expect(normalizeAlerts("Penicillin\nLatex", true)).toBe("allergy:penicillin,allergy:latex");
  });

  it("leaves a condition as a condition", () => {
    expect(normalizeAlerts("Asthma, heart-condition")).toBe("asthma,heart-condition");
    expect(normalizeAlerts("Aspirin, Diabetes")).toBe("allergy:aspirin,diabetes");
  });

  it("drops placeholders and repeats", () => {
    expect(normalizeAlerts("NKA")).toBeNull();
    expect(normalizeAlerts("No known allergies")).toBeNull();
    expect(normalizeAlerts("   ")).toBeNull();
    expect(normalizeAlerts("Penicillin, penicillin", true)).toBe("allergy:penicillin");
  });

  it("tags a bare drug name in an alerts column, not one elsewhere", () => {
    const alerts = parseCsv("First name,Last name,Allergies\nJane,Cooper,Penicillin\n");
    const [allergy] = candidatesFrom(alerts, detectColumns(alerts.headers).map);
    expect(allergy?.medical_alerts).toBe("allergy:penicillin");

    const conditions = parseCsv("First name,Last name,Medical conditions\nJane,Cooper,Diabetes\n");
    const [condition] = candidatesFrom(conditions, detectColumns(conditions.headers).map);
    expect(condition?.medical_alerts).toBe("diabetes");
  });
});

// ── Matching ──────────────────────────────────────────────────────

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    line: 2,
    first_name: "Jane",
    last_name: "Cooper",
    date_of_birth: null,
    patient_gender: null,
    email: null,
    phone: null,
    address: null,
    medical_alerts: null,
    notes: null,
    referral_source: null,
    error: null,
    warnings: [],
    ...over,
  };
}

function existing(over: Partial<ExistingPatient> = {}): ExistingPatient {
  return { id: 7, first_name: "Jane", last_name: "Cooper", phone: null, date_of_birth: null, ...over };
}

describe("duplicate matching", () => {
  it("treats a shared phone number as the same person", () => {
    const [row] = planImport([candidate({ phone: "(555) 010-0111" })], [existing({ phone: "5550100111" })]);
    expect(row?.status).toBe("duplicate");
    expect(row?.duplicate_of).toBe(7);
  });

  it("treats a matching name and birth date as the same person", () => {
    const [row] = planImport(
      [candidate({ date_of_birth: "1988-03-22" })],
      [existing({ date_of_birth: "1988-03-22" })],
    );
    expect(row?.status).toBe("duplicate");
  });

  it("keeps two different people who share a name but not a birth date", () => {
    const [row] = planImport(
      [candidate({ date_of_birth: "2010-01-01" })],
      [existing({ date_of_birth: "1988-03-22" })],
    );
    expect(row?.status).toBe("new");
  });

  it("treats a name typed twice with no birth date as one person", () => {
    const [row] = planImport([candidate()], [existing()]);
    expect(row?.status).toBe("duplicate");
  });

  it("catches the same person twice in one file", () => {
    const rows = planImport([candidate({ phone: "555-0100" }), candidate({ line: 3, phone: "5550100" })], []);
    expect(rows.map((r) => r.status)).toEqual(["new", "duplicate"]);
    expect(rows[1]?.duplicate_of_line).toBe(2);
  });

  it("passes unreadable rows through as invalid", () => {
    const [row] = planImport([candidate({ error: "no name in this row" })], []);
    expect(row?.status).toBe("invalid");
    expect(row?.reason).toBe("no name in this row");
  });
});

// ── The routes ────────────────────────────────────────────────────

let ctx: TestContext;
let app: Awaited<ReturnType<typeof freshApp>>;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  await ctx.resetDb();
  app = await freshApp();
});

async function post(path: string, body: Record<string, unknown>) {
  const { path: url, init } = jsonRequest("POST", path, body);
  const res = await app.request(url, init, { DB: ctx.db });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const FILE = [
  "First name,Last name,Mobile,Email,DOB",
  "Zelda,Quarrington,555-0900,zelda@example.com,1988-03-22",
  "Marcus,Hale,555-0901,,1975-11-02",
  "Marcus,Hale,555-0901,,1975-11-02",
  ",,555-0902,,",
].join("\n");

describe("POST /api/patients/import/preview", () => {
  it("classifies every row and writes nothing", async () => {
    const res = await post("/api/patients/import/preview", { csv: FILE });
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ new: 2, duplicate: 1, invalid: 1 });
    expect(res.body.total).toBe(4);
    const rows = res.body.rows as { line: number; status: string; duplicate_of_line: number | null }[];
    expect(rows[0]).toMatchObject({ line: 2, status: "new" });
    expect(rows[2]).toMatchObject({ status: "duplicate", duplicate_of_line: 3 });

    const list = await app.request("/api/patients?q=Quarrington", undefined, { DB: ctx.db });
    const { patients } = (await list.json()) as { patients: unknown[] };
    expect(patients).toHaveLength(0);
  });

  it("keeps line numbers honest when a cell wraps, and stores alerts as tags", async () => {
    const csv = [
      "First name,Last name,Allergies,Notes",
      'Nadia,Ferro,"Penicillin, latex","Moved\nfrom Leeds"',
      "Owen,Priest,Diabetes,,",
    ].join("\n");
    const preview = await post("/api/patients/import/preview", { csv });
    const rows = preview.body.rows as { line: number }[];
    expect(rows.map((row) => row.line)).toEqual([2, 4]);

    await post("/api/patients/import", { csv });
    const list = await app.request("/api/patients?q=Ferro", undefined, { DB: ctx.db });
    const { patients } = (await list.json()) as { patients: { medical_alerts: string }[] };
    expect(patients[0]?.medical_alerts).toBe("allergy:penicillin,allergy:latex");
  });

  it("refuses a file with no name column", async () => {
    const res = await post("/api/patients/import/preview", { csv: "Policy #,Amount\n1,20\n" });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("No name column");
  });

  it("refuses an empty file", async () => {
    const res = await post("/api/patients/import/preview", { csv: "   " });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/patients/import", () => {
  it("creates the new rows, skips the duplicate and the unreadable one", async () => {
    const res = await post("/api/patients/import", { csv: FILE });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, duplicates: 1, invalid: 1 });

    const list = await app.request("/api/patients?q=Quarrington", undefined, { DB: ctx.db });
    const { patients } = (await list.json()) as { patients: { date_of_birth: string; phone: string }[] };
    expect(patients).toHaveLength(1);
    expect(patients[0]?.date_of_birth).toBe("1988-03-22");
    expect(patients[0]?.phone).toBe("555-0900");
  });

  it("is safe to run twice — the second pass creates nothing", async () => {
    await post("/api/patients/import", { csv: FILE });
    const again = await post("/api/patients/import", { csv: FILE });
    // Both people are on file now, and the file still repeats Marcus.
    expect(again.body).toMatchObject({ created: 0, duplicates: 3, invalid: 1 });
  });

  it("imports the duplicates when asked to", async () => {
    const res = await post("/api/patients/import", { csv: FILE, skip_duplicates: false });
    expect(res.body).toMatchObject({ created: 3, duplicates: 0 });
  });

  it("matches a patient registered earlier by hand", async () => {
    const { path, init } = jsonRequest("POST", "/api/patients", {
      first_name: "Zelda",
      last_name: "Quarrington",
      phone: "(555) 090-0000",
    });
    await app.request(path, init, { DB: ctx.db });

    const res = await post("/api/patients/import", {
      csv: "First name,Last name,Phone\nZelda,Quarrington,5550900000\n",
    });
    expect(res.body).toMatchObject({ created: 0, duplicates: 1 });
  });
});

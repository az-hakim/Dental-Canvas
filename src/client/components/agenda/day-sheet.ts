import type { Appointment, Patient } from "@/types";

/**
 * The printed day sheet: one page the front desk can put on the counter, or
 * carry when the network is down.
 *
 * The screen is optimised for the person working the schedule — colours,
 * drag-and-drop, side panels. Paper needs the opposite: everything about one
 * day on one page, in time order, with the details someone needs when the
 * patient is standing in front of them (phone, treatment, who is seeing them,
 * and any medical alert).
 *
 * `buildDaySheetHtml` is pure so the layout and the escaping are unit-tested;
 * `printDaySheet` only adds the hidden iframe that prints it, the same
 * technique the invoice and prescription sheets use.
 */

export interface DaySheetPatientInfo {
  phone: string | null;
  alerts: string | null;
}

export interface DaySheetInput {
  /** YYYY-MM-DD of the day being printed. */
  date: string;
  appointments: Appointment[];
  clinicName?: string | null;
  clinicPhone?: string | null;
  /** Phone and medical alerts per patient id, from /api/patients. */
  patients?: Patient[];
  printedAt?: Date;
}

const STATUS_LABELS: Record<string, string> = {
  scheduled: "Scheduled",
  confirmed: "Confirmed",
  arrived: "Arrived",
  in_chair: "In chair",
  completed: "Completed",
  no_show: "No show",
  cancelled: "Cancelled",
};

/** Escapes every value that reaches the sheet — a patient surname is user data. */
function esc(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "2026-11-25T09:30:00" → "09:30", without a timezone round trip. */
export function sheetTime(iso: string | null | undefined): string {
  const match = /T(\d{2}):(\d{2})/.exec(iso ?? "");
  return match ? `${match[1]}:${match[2]}` : "";
}

function longDate(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function patientName(a: Appointment): string {
  const last = (a.patient_last_name ?? "").trim();
  const first = (a.patient_first_name ?? "").trim();
  if (!last && !first) return a.title?.trim() || "—";
  return first ? `${last}, ${first}` : last;
}

export function buildDaySheetHtml(input: DaySheetInput): string {
  const patients = new Map<number, DaySheetPatientInfo>();
  for (const p of input.patients ?? []) {
    patients.set(p.id, { phone: p.phone ?? null, alerts: p.medical_alerts ?? null });
  }

  const rows = [...input.appointments].sort((a, b) => a.start_time.localeCompare(b.start_time));
  const booked = rows.filter((a) => a.kind === "patient");
  const alerts = booked.filter((a) => {
    const info = a.patient_id != null ? patients.get(a.patient_id) : undefined;
    return Boolean(info?.alerts?.trim());
  }).length;

  const printed = (input.printedAt ?? new Date()).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  const body = rows
    .map((a) => {
      if (a.kind !== "patient") {
        return `<tr class="block"><td colspan="7">${esc(a.title?.trim() || a.kind)} · ${esc(sheetTime(a.start_time))}–${esc(sheetTime(a.end_time))}</td></tr>`;
      }
      const info = a.patient_id != null ? patients.get(a.patient_id) : undefined;
      const alert = info?.alerts?.trim();
      const notes = [a.notes?.trim(), alert ? `⚠ ${alert}` : ""].filter(Boolean).join(" · ");
      return `<tr>
        <td class="time">${esc(sheetTime(a.start_time))}</td>
        <td class="name">${esc(patientName(a))}</td>
        <td>${esc(info?.phone)}</td>
        <td>${esc(a.treatment_name)}</td>
        <td>${esc(a.practitioner_name)}</td>
        <td>${esc(a.operatory_name)}</td>
        <td class="status">${esc(STATUS_LABELS[a.status] ?? a.status)}</td>
        <td class="notes${alert ? " alert" : ""}">${esc(notes)}</td>
      </tr>`;
    })
    .join("");

  const first = booked[0] ? sheetTime(booked[0].start_time) : "";
  const last = booked.length ? sheetTime(booked[booked.length - 1]?.end_time) : "";

  return `<section class="sheet">
  <header>
    <div>
      <h1>${esc(input.clinicName?.trim() || "Day sheet")}</h1>
      <p class="sub">${esc(input.clinicName?.trim() ? "Day sheet" : "")}${input.clinicPhone ? `<span class="dot">·</span>${esc(input.clinicPhone)}` : ""}</p>
    </div>
    <div class="meta">
      <strong>${esc(longDate(input.date))}</strong>
      <span>${booked.length} appointment${booked.length === 1 ? "" : "s"}${first ? ` · ${first}–${last}` : ""}</span>
      <span>${alerts > 0 ? `${alerts} with a medical alert` : "No medical alerts"} · printed ${esc(printed)}</span>
    </div>
  </header>
  <table>
    <thead>
      <tr><th>Time</th><th>Patient</th><th>Phone</th><th>Treatment</th><th>Provider</th><th>Room</th><th>Status</th><th>Notes / alerts</th></tr>
    </thead>
    <tbody>${body || `<tr><td colspan="8" class="empty">Nothing booked for this day.</td></tr>`}</tbody>
  </table>
  <footer>Dental Canvas · ${esc(longDate(input.date))}</footer>
</section>`;
}

/** Styles + page setup for the printed sheet. */
export const DAY_SHEET_STYLE = `
  @page { size: A4 portrait; margin: 12mm; }
  html, body { margin: 0; padding: 0; background: #fff; color: #0f172a; }
  body { font: 11px/1.45 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
  .sheet header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 2px solid #0f172a; padding-bottom: 8px; }
  h1 { font-size: 16px; margin: 0; letter-spacing: -0.01em; }
  .sub { margin: 2px 0 0; color: #475569; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; }
  .sub .dot { margin: 0 6px; }
  .meta { text-align: right; font-size: 10px; color: #475569; display: flex; flex-direction: column; gap: 1px; }
  .meta strong { color: #0f172a; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: #475569; border-bottom: 1px solid #cbd5e1; padding: 4px 5px; }
  td { padding: 5px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  td.time { font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
  td.name { font-weight: 600; }
  td.status { white-space: nowrap; color: #475569; }
  td.notes { color: #475569; font-size: 10px; }
  td.notes.alert { color: #b91c1c; font-weight: 600; }
  tr.block td { background: #f1f5f9; color: #475569; font-style: italic; }
  td.empty { text-align: center; color: #64748b; padding: 24px; }
  footer { margin-top: 10px; color: #94a3b8; font-size: 9px; }
`;

/**
 * Prints the sheet through a hidden iframe, so the app's own styles and
 * scroll position are untouched (the technique the invoice sheet uses).
 */
export function printDaySheet(input: DaySheetInput): void {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) {
    frame.remove();
    return;
  }
  doc.open();
  doc.write(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Day sheet ${esc(input.date)}</title><style>${DAY_SHEET_STYLE}</style></head><body>${buildDaySheetHtml(input)}</body></html>`,
  );
  doc.close();
  frame.addEventListener("load", () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    window.setTimeout(() => frame.remove(), 1000);
  });
}

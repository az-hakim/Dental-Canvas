import { describe, expect, it } from "vitest";
import { buildDaySheetHtml, sheetTime } from "../src/client/components/agenda/day-sheet";
import type { Appointment, Patient } from "../src/client/types";

function appointment(over: Partial<Appointment> = {}): Appointment {
  return {
    id: 1,
    patient_id: 5,
    practitioner_id: 1,
    operatory_id: 1,
    treatment_type_id: null,
    start_time: "2026-11-25T09:30:00",
    end_time: "2026-11-25T10:00:00",
    status: "scheduled",
    kind: "patient",
    title: null,
    notes: null,
    created_at: "2026-11-20T10:00:00",
    patient_first_name: "Jane",
    patient_last_name: "Cooper",
    practitioner_name: "Dr Okafor",
    operatory_name: "Room 1",
    treatment_name: "Scale and polish",
    ...over,
  };
}

function patient(over: Partial<Patient> = {}): Patient {
  return {
    id: 5,
    first_name: "Jane",
    last_name: "Cooper",
    phone: "555-0100",
    medical_alerts: null,
    ...over,
  } as Patient;
}

describe("day sheet", () => {
  it("reads the clock straight off the stored time", () => {
    expect(sheetTime("2026-11-25T09:30:00")).toBe("09:30");
    expect(sheetTime("2026-11-25T13:05")).toBe("13:05");
    expect(sheetTime(null)).toBe("");
  });

  it("prints the appointment in time order with its details", () => {
    const html = buildDaySheetHtml({
      date: "2026-11-25",
      clinicName: "Bright Smile Dental",
      clinicPhone: "555-0199",
      appointments: [
        appointment({ id: 2, start_time: "2026-11-25T14:00:00", patient_first_name: "Marcus", patient_last_name: "Hale" }),
        appointment({ id: 1 }),
      ],
      patients: [patient()],
    });

    expect(html).toContain("Bright Smile Dental");
    expect(html).toContain("555-0199");
    // Marcus (14:00) sorts after Jane (09:30).
    expect(html.indexOf("Cooper, Jane")).toBeLessThan(html.indexOf("Hale, Marcus"));
    expect(html).toContain("09:30");
    expect(html).toContain("Scale and polish");
    expect(html).toContain("Dr Okafor");
    expect(html).toContain("Room 1");
    expect(html).toContain("555-0100");
    expect(html).toContain("2 appointments");
  });

  it("calls out a medical alert in the notes column", () => {
    const html = buildDaySheetHtml({
      date: "2026-11-25",
      appointments: [appointment()],
      patients: [patient({ medical_alerts: "allergy:penicillin" })],
    });
    expect(html).toContain("⚠ allergy:penicillin");
    expect(html).toContain("1 with a medical alert");
  });

  it("escapes patient-supplied text", () => {
    const html = buildDaySheetHtml({
      date: "2026-11-25",
      appointments: [appointment({ patient_last_name: '<script>alert("x")</script>', notes: "a & b" })],
      patients: [],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("a &amp; b");
  });

  it("shows breaks as a band rather than a patient row", () => {
    const html = buildDaySheetHtml({
      date: "2026-11-25",
      appointments: [appointment({ kind: "lunch", title: "Lunch", patient_id: null })],
      patients: [],
    });
    expect(html).toContain('class="block"');
    expect(html).toContain("Lunch");
    expect(html).toContain("0 appointments");
  });

  it("says so on an empty day", () => {
    const html = buildDaySheetHtml({ date: "2026-11-25", appointments: [], patients: [] });
    expect(html).toContain("Nothing booked for this day.");
  });
});

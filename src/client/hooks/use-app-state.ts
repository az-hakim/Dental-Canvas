import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "@/components/ui/toast";
import { api } from "../api";
import { notifyDataChanged } from "../lib/data-change-signal";
import { setActiveCurrency } from "../lib/utils";
import type {
  Appointment,
  AppointmentToMake,
  Medicine,
  NewAppointment,
  Operatory,
  Patient,
  Practitioner,
  TreatmentType,
  WaitingListEntry,
} from "../types";

/**
 * Holds the data needed across the app shell — operatories, practitioners, treatment
 * types, plus the day's appointments. Per-patient detail data is fetched in the
 * patient-detail page itself to keep this hook lean.
 */
export interface PracticeSettings {
  day_start_minute: number;
  day_end_minute: number;
  slot_minutes: number;
  /** Practice currency for every money display: "USD" ($) or "BDT" (৳). */
  currency: "USD" | "BDT";
  /** Appointment reminders: native + toast notification before start. */
  reminders_enabled: boolean;
  /** Minutes before the appointment to raise the reminder. */
  reminder_minutes: number;
  /**
   * In-app updates (desktop only, Settings → About): "auto" downloads as soon
   * as one is found and installs it at the first safe moment, "ask" waits for
   * a click. Never silently left undefined — see parseSettings.
   */
  update_mode: "auto" | "ask";
}

/** Auto-backup schedule (see src/client/hooks/use-auto-backup.ts). */
export interface BackupSchedule {
  auto_backup_interval_minutes: number;
  auto_backup_keep: number;
}

/** Practice profile (doctor identity) shown on the dashboard and editable in Settings → Profile. */
export interface ProfileSettings {
  doctor_name: string;
  doctor_qualifications: string;
  doctor_specialty: string;
  clinic_name: string;
  doctor_email: string;
  doctor_phone: string;
  doctor_license: string;
  clinic_address: string;
  /** Data URL of the clinic logo, printed on prescription/invoice letterheads. Empty = none. */
  clinic_logo: string;
  /** Data URL of the payment QR image (bKash/Nagad/bank…). Empty = none. */
  payment_qr: string;
  /** Caption printed under the payment QR (e.g. "bKash — Personal"). */
  payment_qr_label: string;
  /** Fixed practice instructions printed in the Chamber template's footer. Newline = new line on the sheet. Empty = none. */
  chamber_footer_instructions: string;
  /** Google review link included in post-visit review-request messages. Empty = no link. */
  google_review_url: string;
}

const DEFAULT_SETTINGS: PracticeSettings = {
  day_start_minute: 7 * 60,
  day_end_minute: 19 * 60,
  slot_minutes: 15,
  currency: "USD",
  reminders_enabled: true,
  reminder_minutes: 15,
  update_mode: "auto",
};

export const DEFAULT_PROFILE: ProfileSettings = {
  doctor_name: "",
  doctor_specialty: "Dentist",
  clinic_name: "",
  doctor_email: "",
  doctor_phone: "",
  doctor_license: "",
  clinic_address: "",
  clinic_logo: "",
  payment_qr: "",
  payment_qr_label: "",
  chamber_footer_instructions: "",
  google_review_url: "",
  doctor_qualifications: "",
};

const PROFILE_KEYS = Object.keys(DEFAULT_PROFILE) as (keyof ProfileSettings)[];

function parseBackupSchedule(raw: Record<string, string>): BackupSchedule {
  const interval = parseInt(raw.auto_backup_interval_minutes, 10);
  const keep = parseInt(raw.auto_backup_keep, 10);
  return {
    auto_backup_interval_minutes: Number.isFinite(interval) && interval >= 0 ? interval : 0,
    auto_backup_keep: Number.isFinite(keep) && keep >= 1 ? Math.min(keep, 100) : 10,
  };
}

function parseSettings(raw: Record<string, string>): PracticeSettings {
  const num = (key: "day_start_minute" | "day_end_minute" | "slot_minutes" | "reminder_minutes") => {
    const v = parseInt(raw[key], 10);
    return Number.isFinite(v) ? v : DEFAULT_SETTINGS[key];
  };
  return {
    day_start_minute: num("day_start_minute"),
    day_end_minute: num("day_end_minute"),
    slot_minutes: num("slot_minutes"),
    currency: raw.currency === "BDT" ? "BDT" : "USD",
    reminders_enabled: raw.reminders_enabled !== "0",
    reminder_minutes: Math.min(Math.max(num("reminder_minutes"), 1), 240),
    // Anything but a stored "ask" means unattended updates: that is what a
    // fresh install gets, and what an install predating this key gets too.
    update_mode: raw.update_mode === "ask" ? "ask" : "auto",
  };
}

function parseProfile(raw: Record<string, string>): ProfileSettings {
  const out = { ...DEFAULT_PROFILE };
  for (const k of PROFILE_KEYS) {
    if (typeof raw[k] === "string") out[k] = raw[k];
  }
  return out;
}

/**
 * `enabled` is false while a hosted deployment is still showing the sign-in
 * gate. Practice data is tenant-scoped on the server, so nothing here may be
 * requested before a session exists: every one of those calls would be answered
 * 401 and fill the sign-in screen's console with errors. Once the user signs in
 * the flag flips and the shell loads normally.
 */
export function useAppState(enabled = true) {
  const [operatories, setOperatories] = useState<Operatory[]>([]);
  const [practitioners, setPractitioners] = useState<Practitioner[]>([]);
  const [treatmentTypes, setTreatmentTypes] = useState<TreatmentType[]>([]);
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [waitingList, setWaitingList] = useState<WaitingListEntry[]>([]);
  const [appointmentsToMake, setAppointmentsToMake] = useState<AppointmentToMake[]>([]);
  const [settings, setSettings] = useState<PracticeSettings>(DEFAULT_SETTINGS);
  const [profile, setProfile] = useState<ProfileSettings>(DEFAULT_PROFILE);
  const [backupSchedule, setBackupSchedule] = useState<BackupSchedule>({
    auto_backup_interval_minutes: 0,
    auto_backup_keep: 10,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshLookups = useCallback(async () => {
    const [ops, prs, tts, meds, st] = await Promise.all([
      api<{ operatories: Operatory[] }>("GET", "/api/operatories"),
      api<{ practitioners: Practitioner[] }>("GET", "/api/practitioners"),
      api<{ treatment_types: TreatmentType[] }>("GET", "/api/treatment-types"),
      api<{ medicines: Medicine[] }>("GET", "/api/medicines").catch(() => ({ medicines: [] as Medicine[] })),
      api<{ settings: Record<string, string> }>("GET", "/api/settings").catch(() => ({ settings: {} as Record<string, string> })),
    ]);
    setOperatories(ops.operatories);
    setPractitioners(prs.practitioners);
    setTreatmentTypes(tts.treatment_types);
    setMedicines(meds.medicines);
    setSettings(parseSettings(st.settings));
    setActiveCurrency(parseSettings(st.settings).currency);
    setProfile(parseProfile(st.settings));
    setBackupSchedule(parseBackupSchedule(st.settings));
  }, []);

  const refreshMedicines = useCallback(async () => {
    const data = await api<{ medicines: Medicine[] }>("GET", "/api/medicines");
    setMedicines(data.medicines);
  }, []);

  const updateBackupSchedule = useCallback(async (patch: Partial<BackupSchedule>) => {
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) body[k] = String(v);
    }
    const res = await api<{ settings: Record<string, string> }>("PUT", "/api/settings", body);
    setBackupSchedule(parseBackupSchedule(res.settings));
  }, []);

  const updateProfile = useCallback(async (patch: Partial<ProfileSettings>) => {
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) body[k] = String(v);
    }
    const res = await api<{ settings: Record<string, string> }>("PUT", "/api/settings", body);
    setProfile(parseProfile(res.settings));
  }, []);

  const updateSettings = useCallback(async (patch: Partial<PracticeSettings>) => {
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) body[k] = String(v);
    }
    const res = await api<{ settings: Record<string, string> }>("PUT", "/api/settings", body);
    setSettings(parseSettings(res.settings));
    setActiveCurrency(parseSettings(res.settings).currency);
  }, []);

  const refreshDay = useCallback(async (date: string) => {
    const data = await api<{ appointments: Appointment[] }>("GET", `/api/appointments?date=${date}`);
    setAppointments(data.appointments);
  }, []);

  const refreshSidePanels = useCallback(async () => {
    const [w, m] = await Promise.all([
      api<{ waiting: WaitingListEntry[] }>("GET", "/api/waiting-list"),
      api<{ to_make: AppointmentToMake[] }>("GET", "/api/appointments-to-make"),
    ]);
    setWaitingList(w.waiting);
    setAppointmentsToMake(m.to_make);
  }, []);

  // Initial load — and the reload once a session appears.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        await refreshLookups();
        await refreshSidePanels();
        if (cancelled) return;
        setError(null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshLookups, refreshSidePanels]);

  const createAppointment = useCallback(async (data: NewAppointment) => {
    const res = await api<{ appointment: Appointment }>("POST", "/api/appointments", data);
    setAppointments((prev) => [...prev, res.appointment].sort((a, b) => a.start_time.localeCompare(b.start_time)));
    notifyDataChanged("appointment");
    toast.success(`Appointment booked for ${new Date(res.appointment.start_time).toLocaleDateString()}`);
    return res.appointment;
  }, []);

  const updateAppointment = useCallback(async (id: number, patch: Partial<NewAppointment>) => {
    const res = await api<{ appointment: Appointment }>("PUT", `/api/appointments/${id}`, patch);
    setAppointments((prev) => prev.map((a) => (a.id === id ? res.appointment : a)));
    notifyDataChanged("appointment");
    if (patch.status === "cancelled") toast.info("Appointment cancelled");
    else if (patch.status === "no_show") toast.info("Marked as no-show");
    else if (patch.status === "completed") toast.success("Visit completed");
    else if (patch.status === "confirmed") toast.success("Appointment confirmed");
    else toast.success("Appointment updated");
    return res.appointment;
  }, []);

  const deleteAppointment = useCallback(async (id: number) => {
    await api("DELETE", `/api/appointments/${id}`);
    setAppointments((prev) => prev.filter((a) => a.id !== id));
    notifyDataChanged("appointment");
    toast.success("Appointment deleted");
  }, []);

  const searchPatients = useCallback(async (q: string): Promise<Patient[]> => {
    const data = await api<{ patients: Patient[] }>(
      "GET",
      q ? `/api/patients?q=${encodeURIComponent(q)}` : "/api/patients",
    );
    return data.patients;
  }, []);

  const createPatient = useCallback(async (input: Partial<Patient> & { first_name: string; last_name: string }) => {
    const res = await api<{ patient: Patient }>("POST", "/api/patients", input);
    notifyDataChanged("patient");
    return res.patient;
  }, []);

  // Memoized so the context value keeps a stable identity between renders —
  // consumers put `app` in effect deps, and a fresh literal every render made
  // them refetch (and remount, resetting local UI state) on every tick.
  return useMemo(
    () => ({
      // data
      operatories, practitioners, treatmentTypes, appointments,
      waitingList, appointmentsToMake,
      medicines,

      settings, profile, backupSchedule,
      loading, error,
      setError,
      // refresh
      refreshLookups, refreshDay, refreshSidePanels, refreshMedicines,
      // mutations
      createAppointment, updateAppointment, deleteAppointment,
      searchPatients, createPatient,
      updateSettings, updateProfile, updateBackupSchedule,
    }),
    [
      operatories, practitioners, treatmentTypes, appointments,
      waitingList, appointmentsToMake,
      medicines,
      settings, profile, backupSchedule,
      loading, error,
      refreshLookups, refreshDay, refreshSidePanels, refreshMedicines,
      createAppointment, updateAppointment, deleteAppointment,
      searchPatients, createPatient,
      updateSettings, updateProfile, updateBackupSchedule,
    ],
  );
}

export type AppStateValue = ReturnType<typeof useAppState>;

import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeftRight,
  Eye,
  FilePlus2,
  MoreHorizontal,
  Plus,
  Trash2,
  UserPlus,
} from "lucide-react";
import { api } from "@/api";
import { useApp } from "@/context";
import { cn } from "@/lib/utils";
import { openQuickRegister } from "@/lib/quick-register";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PrescriptionDialog } from "@/components/prescriptions/prescriptions-tab";
import { useDataRefresh } from "@/hooks/use-data-refresh";
import type { RecentPatient } from "./dashboard-page";
import type { Patient } from "@/types";

// ── Dentist note type + add dialog (used by the notes panel) ───────

export interface DentistNote {
  id: number;
  body: string;
  pinned: number;
  created_at: string;
}

function AddNoteDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (note: DentistNote) => void;
}) {
  const app = useApp();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!body.trim()) return;
    setBusy(true);
    try {
      const res = await api<{ note: DentistNote }>("POST", "/api/dentist-notes", { body: body.trim() });
      onSaved(res.note);
      setBody("");
      onOpenChange(false);
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add dentist note</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="dentist-note-body">Note</Label>
          <Textarea
            id="dentist-note-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="e.g. Restock sterilization pouches"
            rows={4}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || !body.trim()}>
            {busy ? "Saving…" : "Save note"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Patient List (Today) ───────────────────────────────────────────

type ListFilter = "today" | "week";

interface ListAppointment {
  id: number;
  patient_id: number | null;
  start_time: string;
  status: string;
  patient_first_name: string | null;
  patient_last_name: string | null;
  /** Treatment booked for the visit — the row's subtitle when present. */
  treatment_name?: string | null;
}

// Each status carries a tint that also works on the dark card: the 700 steps
// are unreadable there (sky-700 on oklch(0.2) is under 3:1), so every entry
// pairs a light and a dark shade.
const STATUS_LABELS: Record<string, { label: string; classes: string }> = {
  scheduled: { label: "Scheduled",  classes: "text-sky-700 dark:text-sky-300" },
  confirmed: { label: "Confirmed",  classes: "text-teal-700 dark:text-teal-300" },
  arrived:   { label: "Arrived",    classes: "text-emerald-700 dark:text-emerald-300" },
  in_chair:  { label: "In Chair",   classes: "text-violet-700 dark:text-violet-300" },
  completed: { label: "Completed",  classes: "text-emerald-700 dark:text-emerald-300" },
  no_show:   { label: "No-show",    classes: "text-rose-700 dark:text-rose-300" },
  cancelled: { label: "Cancelled",  classes: "text-muted-foreground" },
};

const AVATAR_TONES = [
  "bg-amber-200 text-amber-900 dark:bg-amber-400/20 dark:text-amber-200",
  "bg-emerald-200 text-emerald-900 dark:bg-emerald-400/20 dark:text-emerald-200",
  "bg-violet-200 text-violet-900 dark:bg-violet-400/20 dark:text-violet-200",
  "bg-rose-200 text-rose-900 dark:bg-rose-400/20 dark:text-rose-200",
  "bg-sky-200 text-sky-900 dark:bg-sky-400/20 dark:text-sky-200",
];

function Avatar({ name, index }: { name: string; index: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <span
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold",
        AVATAR_TONES[index % AVATAR_TONES.length],
      )}
    >
      {initials || "?"}
    </span>
  );
}

export function PatientListPanel({
  navigate,
  recentPatients = [],
}: {
  navigate: (to: string) => void;
  recentPatients?: RecentPatient[];
}) {
  const [filter, setFilter] = useState<ListFilter>("today");
  const [items, setItems] = useState<ListAppointment[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const today = new Date();
      const end = new Date(today);
      if (filter === "week") end.setDate(end.getDate() + 6);
      const from = toIsoDateParam(today);
      const to = toIsoDateParam(end);
      const data = await api<{ appointments: ListAppointment[] }>(
        "GET",
        `/api/appointments?from=${from}&to=${to}`,
      );
      setItems(data.appointments);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Booking, check-in and registration all land here without a reload.
  useDataRefresh(load, { reasons: ["appointment", "patient"], debounceMs: 400 });

  return (
    <section className="dc-card card-lift animate-rise min-w-0 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight">Patient List</h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1 rounded-lg">
              {filter === "today" ? "Today" : "This Week"}
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 opacity-60" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setFilter("today")}>Today</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setFilter("week")}>This Week</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-3 space-y-1.5">
        {loading ? (
          <div className="space-y-1.5" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 px-2 py-2">
                <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-muted" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
                  <div className="h-2.5 w-1/3 animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2.5 px-2 py-6 text-center">
            <p className="text-sm text-muted-foreground">
              No visits {filter === "today" ? "today" : "this week"}.
            </p>
            <Button variant="outline" size="sm" onClick={openQuickRegister}>
              <UserPlus className="h-4 w-4" />
              Book a patient
            </Button>
          </div>
        ) : (
          items.slice(0, 6).map((a, i) => {
            const name = [a.patient_first_name, a.patient_last_name].filter(Boolean).join(" ") || "Walk-in";
            const time = new Date(a.start_time).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              hour12: true,
            });
            const status = STATUS_LABELS[a.status] ?? STATUS_LABELS.scheduled;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => (a.patient_id ? navigate(`/patients/${a.patient_id}`) : navigate("/agenda"))}
                className="group flex w-full items-center gap-3 rounded-2xl border border-transparent px-2 py-2 text-left transition-colors hover:border-primary/15 hover:bg-primary/[0.04]"
              >
                <Avatar name={name} index={i} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{name}</span>
                  <span className={cn("block truncate text-xs font-medium", a.treatment_name ? "text-primary/80" : status.classes)}>
                    {a.treatment_name ?? status.label}
                  </span>
                </span>
                {/* text-background, not text-white: the chip is an inverted
                    surface, and in dark mode the foreground is near-white, so
                    white text on it was invisible. */}
                <span className="shrink-0 rounded-xl bg-foreground px-2.5 py-1.5 text-[11px] font-semibold tabular-nums text-background shadow-sm">
                  {time}
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* Registrations that exist but have no visit booked yet. Without this
          someone added at the front desk was invisible until they were
          scheduled — the dashboard looked like it had lost the patient. */}
      {filter === "today" && recentPatients.length > 0 && (
        <div className="mt-3 border-t border-border/60 pt-2">
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Recently registered
          </p>
          {recentPatients.slice(0, 4).map((p) => (
            <button
              key={`new-${p.id}`}
              type="button"
              onClick={() => navigate(`/patients/${p.id}`)}
              className="group flex w-full items-center gap-3 rounded-2xl border border-transparent px-2 py-1.5 text-left transition-colors hover:border-primary/15 hover:bg-primary/[0.04]"
            >
              <Avatar name={`${p.first_name} ${p.last_name}`} index={p.id} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">
                  {p.first_name} {p.last_name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {p.phone || "New patient · no visit booked"}
                </span>
              </span>
              <span className="shrink-0 rounded-xl bg-primary/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
                New
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function toIsoDateParam(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── Consultation ───────────────────────────────────────────────────

interface ConsultationData {
  patient: {
    id: number;
    first_name: string;
    last_name: string;
    date_of_birth: string | null;
    medical_alerts: string | null;
  };
  last_checked: string | null;
  observation: string | null;
  prescription: string | null;
  /** Date of the most recent issued prescription (yyyy-mm-dd), if any. */
  last_prescribed: string | null;
  conditions: { condition: string; n: number }[];
}

function ageFromDob(dob: string | null): string | null {
  if (!dob) return null;
  const d = new Date(`${dob}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 ? `${age}` : null;
}

export function ConsultationPanel({ navigate }: { navigate: (to: string) => void }) {
  const [patient, setPatient] = useState<Patient | null>(null);
  const [data, setData] = useState<ConsultationData | null>(null);
  const [loading, setLoading] = useState(true);
  /** True when the request itself failed — different from "no patient yet",
   *  which used to be shown for both and hid real server errors. */
  const [failed, setFailed] = useState(false);
  /** Bumped by the Retry button to re-run patient discovery. */
  const [retry, setRetry] = useState(0);
  /** Whether the prescription editor is open for the selected patient. */
  const [rxOpen, setRxOpen] = useState(false);

  const loadFor = useCallback(async (pid: number | null) => {
    setLoading(true);
    setFailed(false);
    try {
      if (pid) {
        // The endpoint returns the consultation object flat ({patient, ...}),
        // matching tests/dashboard.test.ts.
        const res = await api<ConsultationData>("GET", `/api/dashboard/consultation?patient_id=${pid}`);
        setPatient(res.patient as unknown as Patient);
        setData(res);
      } else {
        setPatient(null);
        setData(null);
      }
    } catch {
      setData(null);
      setPatient(null);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Latest appointment (today or most recent past) drives the default patient.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const today = toIsoDateParam(new Date());
        // Nearest visits: the week starting today, newest first.
        const weekEnd = new Date();
        weekEnd.setDate(weekEnd.getDate() + 7);
        const res = await api<{ appointments: ListAppointment[] }>(
          "GET",
          `/api/appointments?from=${today}&to=${toIsoDateParam(weekEnd)}`,
        );
        if (cancelled) return;
        const first = res.appointments[0];
        if (first?.patient_id) {
          await loadFor(first.patient_id);
        } else {
          // Fall back to the most recently added patient so the panel is never empty.
          const ps = await api<{ patients: Patient[] }>("GET", "/api/patients");
          if (cancelled) return;
          if (ps.patients[0]) {
            await loadFor(ps.patients[0].id);
          } else {
            setLoading(false);
          }
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadFor, retry]);

  const age = ageFromDob(patient?.date_of_birth ?? null);

  return (
    <section className="dc-card card-lift animate-rise min-w-0 p-5">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight">Consultation</h2>
        {patient && (
          <div className="flex items-center gap-1.5">
            <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" aria-label={`More actions for ${patient.first_name} ${patient.last_name}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => navigate(`/patients/${patient.id}`)}>
                <Eye className="h-4 w-4" /> Open patient record
              </DropdownMenuItem>
              <DropdownMenuItem onClick={openQuickRegister}>
                <UserPlus className="h-4 w-4" /> Register new patient
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          </div>
        )}
      </div>

      {loading ? (
        <div className="space-y-3 py-4">
          <div className="h-14 animate-pulse rounded-xl bg-muted" />
          <div className="h-20 animate-pulse rounded-xl bg-muted" />
          <div className="h-24 animate-pulse rounded-xl bg-muted" />
        </div>
      ) : failed ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center" role="alert">
          <p className="text-sm font-medium">Couldn't load this patient's details.</p>
          <p className="text-xs text-muted-foreground">
            The record is still there — this panel just couldn't read it.
          </p>
          <Button variant="outline" size="sm" onClick={() => setRetry((n) => n + 1)}>
            Try again
          </Button>
        </div>
      ) : !patient || !data ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-muted-foreground">No patient data yet.</p>
          <Button variant="outline" size="sm" onClick={openQuickRegister}>
            <UserPlus className="h-4 w-4" />
            Register a patient
          </Button>
        </div>
      ) : (
        <>
          {/* Identity row: who is in the panel, then the two actions that
              apply to them (issue a prescription, switch patient). */}
          <div className="flex items-center gap-2.5">
            <Avatar name={`${patient.first_name} ${patient.last_name}`} index={patient.id} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-base font-semibold">
                {patient.first_name} {patient.last_name}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {age !== null ? `${age} years old` : "Age unknown"}
              </div>
            </div>
            <Button
              size="sm"
              className="h-8 shrink-0 rounded-xl px-2.5"
              title="New prescription"
              onClick={() => setRxOpen(true)}
            >
              <FilePlus2 className="h-4 w-4" /> Rx
            </Button>
            <PatientSwitcher onPick={(p) => loadFor(p.id)} currentId={patient.id} />
          </div>

          {/* Quick condition chips */}
          <div className="mt-4 grid grid-cols-3 gap-2">
            {[
              { key: "caries", label: "Cavity", icon: "🦷" },
              { key: "restoration", label: "Filling", icon: "🛠️" },
              { key: "crown", label: "Crown", icon: "👑" },
            ].map((chip) => {
              const hit = data.conditions.find((c) => c.condition === chip.key);
              return (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => navigate(`/patients/${patient.id}`)}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-2xl border py-3 text-xs font-semibold transition-all hover:-translate-y-0.5 hover:shadow-sm",
                    hit
                      ? "border-primary/25 bg-primary/[0.06] text-primary"
                      : "border-border/60 bg-card/60 text-muted-foreground hover:bg-accent/50",
                  )}
                >
                  <span className="text-lg" aria-hidden>{chip.icon}</span>
                  {chip.label}
                  {hit && <span className="text-[10px] font-medium opacity-75">{hit.n} noted</span>}
                </button>
              );
            })}
          </div>

          {/* Details */}
          <div className="mt-4 space-y-3 text-sm">
            <Row label="Last Checked">
              {data.last_checked
                ? new Date(`${data.last_checked}T00:00:00`).toLocaleDateString(undefined, {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })
                : "—"}
            </Row>
            <Row label="Observation">
              {data.observation ? (
                <span className="line-clamp-2">{data.observation}</span>
              ) : (
                "No clinical notes recorded."
              )}
            </Row>
            <Row label="Prescription">
              {data.prescription ? data.prescription.split(",").join(", ") : "None recorded."}
            </Row>
            <Row label="Last ℞">
              {data.last_prescribed
                ? new Date(`${data.last_prescribed}T00:00:00`).toLocaleDateString(undefined, {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })
                : "—"}
            </Row>
          </div>

          {/* Issue a prescription without leaving the dashboard. Saving closes
              the dialog and refreshes the card; Save & Print opens the print view. */}
          {patient && (
            <PrescriptionDialog
              open={rxOpen}
              onOpenChange={setRxOpen}
              patientId={patient.id}
              patientName={`${patient.first_name} ${patient.last_name}`}
              prescription={null}
              duplicateOf={null}
              onSaved={() => {
                setRxOpen(false);
                void loadFor(patient.id);
              }}
              onOpenPrint={(id) => {
                setRxOpen(false);
                navigate(`/patients/${patient.id}/prescriptions/${id}`);
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-b pb-3 last:border-0 last:pb-0">
      <span className="w-24 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-muted-foreground">{children}</span>
    </div>
  );
}

function PatientSwitcher({ onPick, currentId }: { onPick: (p: Patient) => void; currentId: number }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Patient[]>([]);
  const [all, setAll] = useState<Patient[]>([]);

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const res = await api<{ patients: Patient[] }>("GET", "/api/patients");
        setAll(res.patients);
        setResults(res.patients);
      } catch {
        setAll([]);
        setResults([]);
      }
    })();
  }, [open]);

  useEffect(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) {
      setResults(all);
      return;
    }
    setResults(
      all.filter((p) =>
        `${p.first_name} ${p.last_name}`.toLowerCase().includes(needle) || (p.phone ?? "").includes(needle),
      ),
    );
  }, [q, all]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 rounded-full" title="Switch patient">
          <ArrowLeftRight className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 p-0">
        <div className="border-b p-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search patient…"
            className="h-8"
            autoFocus
          />
        </div>
        <div className="max-h-56 overflow-y-auto p-1">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No matches.</p>
          ) : (
            results.slice(0, 30).map((p) => (
              <DropdownMenuItem
                key={p.id}
                onClick={() => onPick(p)}
                className={cn(p.id === currentId && "bg-accent")}
              >
                <span className="truncate">
                  {p.first_name} {p.last_name}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Dentist Notes ──────────────────────────────────────────────────

export function DentistNotesPanel() {
  const app = useApp();
  const [notes, setNotes] = useState<DentistNote[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await api<{ notes: DentistNote[] }>("GET", "/api/dentist-notes");
      setNotes(res.notes);
    } catch (err) {
      app.setError((err as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function remove(id: number) {
    try {
      await api("DELETE", `/api/dentist-notes/${id}`);
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } catch (err) {
      app.setError((err as Error).message);
    }
  }

  return (
    <section className="dc-card card-lift animate-rise min-w-0 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Dentist Notes</h2>
        <Button
          size="sm"
          className="h-8 rounded-lg"
          onClick={() => setDialogOpen(true)}
        >
          <Plus className="h-4 w-4" /> Add new note
        </Button>
      </div>

      <div className="mt-3 space-y-2">
        {notes.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            No notes yet — jot down reminders, supply orders, or follow-ups.
          </p>
        ) : (
          notes.slice(0, 5).map((n) => (
            <div
              key={n.id}
              className="group flex items-start gap-2 rounded-2xl bg-primary/[0.05] px-3 py-2.5 text-sm text-foreground/90 dark:bg-primary/10"
            >
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{n.body}</span>
              <button
                type="button"
                onClick={() => remove(n.id)}
                className="shrink-0 rounded-lg p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-rose-500/10 hover:text-rose-600 focus:opacity-100 group-hover:opacity-100"
                aria-label="Delete note"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </div>

      <AddNoteDialog open={dialogOpen} onOpenChange={setDialogOpen} onSaved={(n) => setNotes((prev) => [n, ...prev])} />
    </section>
  );
}

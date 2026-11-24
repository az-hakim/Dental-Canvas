import { useEffect, useState } from "react";
import { UserPlus } from "lucide-react";
import { useApp } from "@/context";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/page-shell";
import { toIsoDate } from "@/lib/utils";
import type { Appointment, Patient } from "@/types";
import { DayToolbar } from "./day-toolbar";
import { DayGrid } from "./day-grid";
import { AppointmentDialog } from "./appointment-dialog";
import { AgendaSidePanel } from "./side-panel";
import { RegisterAndBookDialog } from "./register-and-book-dialog";

export function AgendaPage() {
  const app = useApp();
  // Accepts an optional ?date=YYYY-MM-DD (e.g. from the dashboard calendar).
  const [date, setDate] = useState<string>(() => {
    const q = new URLSearchParams(window.location.search).get("date");
    return q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : toIsoDate(new Date());
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Appointment | null>(null);
  const [defaults, setDefaults] = useState<{ operatoryId: number; minutesFromMidnight: number } | undefined>();
  /** Register & book dialog state. */
  const [rbOpen, setRbOpen] = useState(false);
  /** The patient just registered — lets us offer "open their record". */
  const [justBooked, setJustBooked] = useState<Patient | null>(null);

  // Reload appointments whenever the day or operatory list changes.
  useEffect(() => {
    if (!app.operatories.length) return;
    app.refreshDay(date).catch((err) => app.setError((err as Error).message));
  }, [date, app.operatories.length]);

  function openCreate(operatoryId?: number, minutesFromMidnight?: number) {
    setEditing(null);
    setDefaults(
      operatoryId !== undefined && minutesFromMidnight !== undefined
        ? { operatoryId, minutesFromMidnight }
        : undefined,
    );
    setDialogOpen(true);
  }

  function openEdit(appt: Appointment) {
    setEditing(appt);
    setDefaults(undefined);
    setDialogOpen(true);
  }

  function handleBooked(patient: Patient, _appointment: Appointment) {
    void _appointment;
    setJustBooked(patient);
    // Clear the notice after a moment so the toolbar stays tidy.
    window.setTimeout(() => setJustBooked(null), 8000);
  }

  return (
    <PageShell contentClassName="flex-col lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <DayToolbar date={date} onChange={setDate} onCreate={() => openCreate()}>
          <Button
            variant="outline"
            size="sm"
            className="h-10 flex-1 justify-center rounded-full border-border/60 bg-card/85 shadow-sm backdrop-blur sm:flex-none"
            onClick={() => setRbOpen(true)}
          >
            <UserPlus className="h-4 w-4" /> Register &amp; book
          </Button>
          {justBooked && (
            <button
              type="button"
              onClick={() => {
                setJustBooked(null);
                window.history.pushState(null, "", `/patients/${justBooked.id}`);
                window.dispatchEvent(new PopStateEvent("popstate"));
              }}
              className="rounded-full border border-emerald-200/70 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 shadow-sm transition-colors hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200 dark:hover:bg-emerald-900"
              title="Open the new patient's record"
            >
              {justBooked.first_name} {justBooked.last_name} registered &amp; booked — open record
            </button>
          )}
        </DayToolbar>
        <DayGrid
          date={date}
          operatories={app.operatories}
          appointments={app.appointments}
          onSlotClick={(opId, min) => openCreate(opId, min)}
          onAppointmentClick={openEdit}
        />
      </div>
      <AgendaSidePanel />
      <AppointmentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        appointment={editing}
        date={date}
        defaults={defaults}
      />
      <RegisterAndBookDialog
        open={rbOpen}
        onOpenChange={setRbOpen}
        date={date}
        onBooked={handleBooked}
      />
    </PageShell>
  );
}

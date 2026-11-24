import { useEffect, useState } from "react";
import { Check, ChevronRight, Circle, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  STERILIZATION_ITEMS,
  emptyChecklist,
  formatCountdown,
  localDateKey,
  nextVisit,
  parseChecklist,
  toggleChecklistItem,
  type ChecklistState,
  type ScheduledVisitLike,
} from "./clinic-tools-logic";

/**
 * Compact clinic tools beside the chairside timer:
 *
 *  - next patient countdown, driven by the dashboard summary's upcoming list
 *  - a four-step sterilization checklist that resets at local midnight
 *
 * The checklist is deliberately local: it is a quick "did we finish the
 * cycle?" reminder for whoever is at the front desk, not a clinical record.
 * It says so under the list so nobody mistakes it for the autoclave log.
 */

const CHECKLIST_KEY = "dental-canvas:sterilisation-checklist";
const TICK_MS = 15_000;

function readStoredChecklist(today: string): ChecklistState {
  try {
    return parseChecklist(localStorage.getItem(CHECKLIST_KEY), today);
  } catch {
    return emptyChecklist(today);
  }
}

export function ClinicToolsCard({
  events,
  loading,
  navigate,
  className,
}: {
  events: readonly ScheduledVisitLike[];
  loading: boolean;
  navigate: (to: string) => void;
  className?: string;
}) {
  // A 15-second clock is enough for minute-level countdowns and keeps the
  // tick cheap; the appointment itself is computed from its real start time.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const today = localDateKey(new Date(clock));
  const [checklist, setChecklist] = useState<ChecklistState>(() => readStoredChecklist(today));

  // Roll the list over at local midnight if the dashboard stays open.
  useEffect(() => {
    setChecklist(readStoredChecklist(today));
  }, [today]);

  useEffect(() => {
    try {
      localStorage.setItem(CHECKLIST_KEY, JSON.stringify(checklist));
    } catch {
      /* storage unavailable — the ticks still hold for this session */
    }
  }, [checklist]);

  const next = nextVisit(events, clock);
  const doneCount = checklist.done.length;
  const total = STERILIZATION_ITEMS.length;
  const donePercent = total > 0 ? (doneCount / total) * 100 : 0;
  const nextTime = next
    ? new Date(next.startsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <section
      aria-labelledby="clinic-tools-heading"
      className={cn("dc-card card-lift animate-rise min-w-0 p-5", className)}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="clinic-tools-heading" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-300">
            <ShieldCheck className="h-4 w-4" />
          </span>
          Clinic tools
        </h2>
        <button
          type="button"
          onClick={() => navigate("/agenda")}
          className="text-[11px] font-semibold text-primary underline-offset-2 hover:underline"
        >
          Agenda
        </button>
      </div>

      {/* Next patient */}
      <button
        type="button"
        onClick={() => navigate("/agenda")}
        className="group mt-3 flex w-full items-center gap-2 rounded-2xl border border-primary/15 bg-primary/[0.04] px-3 py-2.5 text-left transition-colors hover:bg-primary/[0.07]"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Next patient
          </span>
          {loading ? (
            <span className="mt-0.5 block text-sm font-semibold text-muted-foreground">Loading today's list…</span>
          ) : next ? (
            <>
              <span className="mt-0.5 block truncate text-sm font-semibold">{next.title}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {[next.detail, nextTime].filter(Boolean).join(" · ")}
              </span>
            </>
          ) : (
            <>
              <span className="mt-0.5 block text-sm font-semibold">No upcoming visits</span>
              <span className="block text-[11px] text-muted-foreground">Open the agenda to book one.</span>
            </>
          )}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-1 text-[11px] font-bold tabular-nums",
            next?.isNow
              ? "animate-pulse-ring bg-teal-500 text-white"
              : next
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground",
          )}
        >
          {loading ? "—" : next ? (next.isNow ? "Now" : formatCountdown(next.startsInMs)) : "Free"}
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </button>

      {/* Sterilization cycle */}
      <div className="mt-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Sterilization cycle
          </p>
          <span className="text-[11px] font-semibold tabular-nums text-muted-foreground">
            {doneCount}/{total}
            {doneCount === total ? <span className="sr-only"> — complete</span> : null}
          </span>
        </div>
        <div
          className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={doneCount}
          aria-label="Sterilization checklist progress"
        >
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              doneCount === total ? "bg-emerald-500" : "bg-teal-500",
            )}
            style={{ width: `${donePercent}%` }}
          />
        </div>

        <ul className="mt-2 space-y-0.5">
          {STERILIZATION_ITEMS.map((item) => {
            const checked = checklist.done.includes(item.id);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => setChecklist((state) => toggleChecklistItem(state, item.id))}
                  className={cn(
                    "flex min-h-9 w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[11px] font-medium transition-colors sm:min-h-0 sm:py-1",
                    checked ? "text-muted-foreground line-through" : "text-foreground/90 hover:bg-accent/60",
                  )}
                >
                  {checked ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </button>
              </li>
            );
          })}
        </ul>

        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
          Resets each day · saved on this device, not the clinical log.
        </p>
      </div>
    </section>
  );
}

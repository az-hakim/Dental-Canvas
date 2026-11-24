import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bell,
  Calendar as CalendarIcon,
  Cake,
  ChevronLeft,
  ChevronRight,
  Repeat,
  Search,
  TrendingDown,
  TrendingUp,
  UserPlus,
} from "lucide-react";
import { api } from "@/api";
import { useApp } from "@/context";
import { cn, toIsoDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DentalBackdrop, ToothIllustration } from "@/components/dental-art";
import { PatientListPanel, ConsultationPanel, DentistNotesPanel } from "./dashboard-panels";
import { ChairsideTimer } from "./chairside-timer";
import { ClinicToolsCard } from "./clinic-tools-card";
import { DentalTipCard } from "./dental-tip-card";
import { InventoryAlertsPanel } from "./inventory-alerts-panel";
import { visitMetrics } from "./visits-metrics";
import { openQuickRegister } from "@/lib/quick-register";
import { useDataRefresh } from "@/hooks/use-data-refresh";

// ── Dashboard API types ────────────────────────────────────────────

export interface UpcomingEvent {
  id: number;
  kind: string;
  title: string | null;
  patient_id: number | null;
  start_time: string;
  status: string;
  first_name: string | null;
  last_name: string | null;
  treatment_name: string | null;
  treatment_color: string | null;
}

export interface DashboardSummary {
  total_visits: number;
  visits_delta_pct: number | null;
  new_patients: number;
  new_patients_delta_pct: number | null;
  returning_patients: number;
  returning_patients_delta_pct: number | null;
  new_patients_today?: number;
  returning_patients_today?: number;
  /** Patients registered in the last 24h, newest first. */
  recent_patients?: RecentPatient[];
  upcoming: UpcomingEvent[];
}

export interface RecentPatient {
  id: number;
  first_name: string;
  last_name: string;
  phone: string | null;
  created_at: string;
}

export interface Birthday {
  id: number;
  name: string;
  date_of_birth: string | null;
  phone: string | null;
  turning: number;
  days_away: number;
  is_today: boolean;
}

const WEEKDAY_LABELS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

// ── Page ───────────────────────────────────────────────────────────

export function DashboardPage({
  navigate,
  openSearch,
}: {
  navigate: (to: string) => void;
  openSearch?: () => void;
}) {
  const app = useApp();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSummary = useCallback(async () => {
    try {
      // The server's clock is UTC; send the clinic's own calendar day so a
      // 9am appointment in UTC+6 is not counted against yesterday.
      const res = await api<DashboardSummary>("GET", `/api/dashboard/summary?today=${toIsoDate(new Date())}`);
      setSummary(res);
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [app]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  // A patient registered from the "New patient" dialog (or anywhere else in
  // the app) shows up here immediately: the panel re-reads on every data
  // change, when the window regains focus, and once a minute as a backstop.
  useDataRefresh(loadSummary, { intervalMs: 60_000, debounceMs: 400 });

  const today = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
      }),
    [],
  );

  return (
    <div className="dc-page relative flex-1 overflow-auto">
      {/* The wrapper grows with the scrolling content, so the drifting teeth
          cover the whole page rather than only the first screen. */}
      <div className="relative min-h-full">
        <DentalBackdrop />

        <div className="relative z-10">
          {/* Top bar: search + notifications — redundant on phones (the mobile
              top bar already carries search/register). */}
          <div className="hidden items-center gap-3 px-4 pt-5 md:flex md:px-6">
            <button
              type="button"
              onClick={() => (openSearch ? openSearch() : navigate("/patients"))}
              className="group flex h-12 flex-1 items-center gap-3 rounded-full border border-border/60 bg-card/85 px-5 text-left text-sm text-muted-foreground shadow-sm backdrop-blur transition-colors hover:border-primary/30 hover:bg-card"
            >
              <Search className="h-4 w-4 shrink-0 transition-colors group-hover:text-primary" />
              <span className="flex-1">Find patients, appointments or invoices…</span>
              <kbd className="hidden rounded-full border bg-muted/70 px-2 py-0.5 text-[10px] font-semibold sm:block">⌘K</kbd>
            </button>
            <Button
              variant="outline"
              size="icon"
              className="h-12 w-12 shrink-0 rounded-full border-border/60 bg-card/85 shadow-sm backdrop-blur"
              onClick={() => navigate("/agenda")}
              aria-label="Open the agenda"
              title="Open the agenda"
            >
              <Bell className="h-4 w-4" />
            </Button>
            <Button className="h-12 shrink-0 rounded-full px-5 shadow-lg shadow-primary/20" onClick={openQuickRegister}>
              <UserPlus className="h-4 w-4" />
              <span className="hidden sm:inline">New patient</span>
            </Button>
            <AvatarBadge navigate={navigate} />
          </div>

          {/* Greeting */}
          <div className="px-4 pb-5 pt-6 md:px-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary/80">{today}</p>
            <h1 className="mt-1 text-[26px] font-bold tracking-tight md:text-[32px]">
              {greeting()},{" "}
              <span className="text-primary">{doctorDisplayName(app.profile.doctor_name)}</span>{" "}
              <span className="inline-block animate-float" aria-hidden>
                👋
              </span>
            </h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              {app.profile.clinic_name.trim()
                ? `Here's what's happening at ${app.profile.clinic_name.trim()} today.`
                : "Here's what's happening at the clinic today."}
            </p>
          </div>

          {/* Main grid — cards rise in with a stagger (pure CSS, reduced-motion aware). */}
          <div className="grid gap-4 px-4 pb-8 md:px-6 xl:grid-cols-[minmax(0,1fr)_356px]">
            <div className="stagger flex min-w-0 flex-col gap-4">
              <VisitsCard summary={summary} loading={loading} />

              <div className="stagger grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)]">
                <PatientListPanel navigate={navigate} recentPatients={summary?.recent_patients ?? []} />
                <ConsultationPanel navigate={navigate} />
              </div>

              {/* Tools: the chairside countdown beside the next-patient and
                  sterilization helpers. */}
              <div className="stagger grid min-w-0 gap-4 md:grid-cols-2">
                <ChairsideTimer />
                <ClinicToolsCard
                  events={summary?.upcoming ?? []}
                  loading={loading}
                  navigate={navigate}
                />
              </div>

              <div className="stagger grid min-w-0 gap-4 md:grid-cols-2">
                <InventoryAlertsPanel navigate={navigate} />
                <DentistNotesPanel />
              </div>
            </div>

            <div className="stagger flex min-w-0 flex-col gap-4">
              <ScheduleCard navigate={navigate} />
              <UpcomingCard summary={summary} loading={loading} navigate={navigate} />
              <DentalTipCard />
              <BirthdaysCard navigate={navigate} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good Morning";
  if (h < 18) return "Good Afternoon";
  return "Good Evening";
}

function doctorDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "Doctor";
  return /^dr\.?\s/i.test(trimmed) ? trimmed : `Dr. ${trimmed}`;
}

function AvatarBadge({ navigate }: { navigate: (to: string) => void }) {
  const app = useApp();
  const initial = (app.profile.doctor_name.trim()[0] ?? "D").toUpperCase();
  return (
    <button
      type="button"
      onClick={() => navigate("/settings")}
      title="Open settings"
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-blue-600 text-sm font-semibold text-white shadow-lg shadow-sky-500/25 ring-2 ring-card/80 transition-transform hover:scale-105"
    >
      {initial}
    </button>
  );
}

// ── Today's Patient Visits ─────────────────────────────────────────

/** Delta chip for a light surface. */
function DeltaBadge({ pct, onDark = false }: { pct: number | null; onDark?: boolean }) {
  if (pct === null) {
    return (
      <span
        className={cn(
          "rounded-full px-2 py-0.5 text-[11px] font-semibold",
          onDark ? "bg-white/20 text-white/80" : "bg-muted text-muted-foreground",
        )}
      >
        —
      </span>
    );
  }
  const up = pct >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums",
        onDark
          ? up
            ? "bg-white/25 text-white"
            : "bg-white/25 text-white"
          : up
            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
            : "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
      )}
      title={`${up ? "Up" : "Down"} ${Math.abs(pct)}% versus the same day last month`}
    >
      {Math.abs(pct)}% <Icon className="h-3 w-3" />
    </span>
  );
}

function VisitsCard({ summary, loading }: { summary: DashboardSummary | null; loading: boolean }) {
  const m = visitMetrics(summary);
  const goalCopy = loading
    ? "Today's new-patient goal"
    : m.newGoalRemaining === 0
      ? "Daily goal met — nice work"
      : `${m.newGoalRemaining} more to reach today's goal`;
  const returningCopy = loading
    ? "Share of today's list"
    : m.visits === 0
      ? "No returning patients booked yet"
      : `${Math.round(m.returningShare)}% of today's ${m.visits === 1 ? "visit" : "visits"}`;

  return (
    <section className="dc-card card-lift animate-rise relative overflow-hidden p-5 sm:p-6">
      <div className="dc-hero-glow pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full" aria-hidden />
      <div className="relative flex flex-col gap-5 xl:flex-row xl:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary/80">Today</p>
              <h2 className="text-lg font-semibold tracking-tight">Today's Patient Visits</h2>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">vs last month</span>
              <DeltaBadge pct={m.visitsDelta} />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span
              key={m.visits}
              className="animate-count text-[52px] font-bold leading-none tracking-tight tabular-nums sm:text-[60px]"
            >
              {loading ? "…" : m.visits}
            </span>
            <span className="text-sm font-medium text-muted-foreground">
              {m.visits === 1 ? "patient visit" : "patient visits"} today
            </span>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {loading
              ? "Loading today's schedule…"
              : m.visits === 0
                ? "No patient visits booked yet today — the chairs are ready when they are."
                : `${m.newToday} new ${m.newToday === 1 ? "patient" : "patients"} and ${m.returningToday} returning, all counted from today's list.`}
          </p>

          {/* New / returning pair — the coloured tiles from the reference design. */}
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="dc-tile-new relative overflow-hidden rounded-2xl p-4 shadow-lg shadow-sky-500/20">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/85">
                  <UserPlus className="h-3.5 w-3.5" /> New patients
                </span>
                <DeltaBadge pct={m.newDelta} onDark />
              </div>
              <div className="mt-2 flex items-baseline gap-1.5">
                <span className="text-3xl font-bold leading-none tabular-nums">
                  {loading ? "…" : m.newToday}
                </span>
                <span className="text-xs text-white/75">of {m.newGoal} goal</span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/25">
                <div
                  className="dc-tile-bar h-full rounded-full"
                  style={{ width: `${loading ? 0 : m.newGoalPercent}%` }}
                />
              </div>
              <p className="mt-1.5 text-[11px] text-white/80">{goalCopy}</p>
            </div>

            <div className="dc-tile-returning relative overflow-hidden rounded-2xl p-4 shadow-lg shadow-rose-500/20">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/85">
                  <Repeat className="h-3.5 w-3.5" /> Returning patients
                </span>
                <DeltaBadge pct={m.returningDelta} onDark />
              </div>
              <div className="mt-2 flex items-baseline gap-1.5">
                <span className="text-3xl font-bold leading-none tabular-nums">
                  {loading ? "…" : m.returningToday}
                </span>
                <span className="text-xs text-white/75">in the chair</span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/25">
                <div
                  className="dc-tile-bar h-full rounded-full"
                  style={{ width: `${loading ? 0 : m.returningShare}%` }}
                />
              </div>
              <p className="mt-1.5 text-[11px] text-white/80">{returningCopy}</p>
            </div>
          </div>
        </div>

        {/* Dental hero art — decorative, hidden when the card is narrow. */}
        <div className="hidden w-56 shrink-0 self-center xl:block" aria-hidden>
          <ToothIllustration className="h-auto w-full opacity-95 drop-shadow-sm dark:opacity-75" />
        </div>
      </div>
    </section>
  );
}

// ── Your Schedule (calendar) ───────────────────────────────────────

function ScheduleCard({ navigate }: { navigate: (to: string) => void }) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const todayIso = toIsoDate(new Date());

  // Days with patient appointments, fetched per visible month.
  const [busyDays, setBusyDays] = useState<Set<string>>(new Set());
  const yearMonth = `${cursor.year}-${String(cursor.month + 1).padStart(2, "0")}`;

  const loadBusyDays = useCallback(async () => {
    try {
      // Pull the month's appointments via two boundary queries (first/last day).
      const first = `${yearMonth}-01`;
      const lastDay = new Date(cursor.year, cursor.month + 1, 0).getDate();
      const last = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;
      const data = await api<{ appointments: { start_time: string }[] }>(
        "GET",
        `/api/appointments?from=${first}&to=${last}`,
      );
      setBusyDays(new Set(data.appointments.map((a) => a.start_time.slice(0, 10))));
    } catch {
      /* non-critical decoration */
    }
  }, [yearMonth, cursor.year, cursor.month]);

  useEffect(() => {
    void loadBusyDays();
  }, [loadBusyDays]);

  // Booking or cancelling an appointment repaints the month's dots at once.
  useDataRefresh(loadBusyDays, { reasons: ["appointment"], debounceMs: 400 });

  const cells = useMemo(() => {
    const firstDow = new Date(cursor.year, cursor.month, 1).getDay();
    const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
    const out: (number | null)[] = Array.from({ length: firstDow }, () => null);
    for (let d = 1; d <= daysInMonth; d++) out.push(d);
    return out;
  }, [cursor]);

  const monthLabel = new Date(cursor.year, cursor.month, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  function shift(delta: number) {
    setCursor((c) => {
      const d = new Date(c.year, c.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  return (
    <section className="dc-card card-lift animate-rise p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Your Schedule</h2>
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={() => navigate("/agenda")} title="Open agenda">
          <CalendarIcon className="h-4 w-4" />
        </Button>
      </div>

      <div className="mt-1 flex items-center justify-between">
        <div className="text-sm text-muted-foreground">{monthLabel}</div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" onClick={() => shift(-1)} aria-label="Previous month">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" onClick={() => shift(1)} aria-label="Next month">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-7 gap-y-1 text-center">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d} className="pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground">
            {d}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={`pad-${i}`} />;
          const iso = `${yearMonth}-${String(day).padStart(2, "0")}`;
          const isToday = iso === todayIso;
          const hasVisits = busyDays.has(iso);
          return (
            <button
              key={iso}
              type="button"
              onClick={() => navigate(`/agenda?date=${iso}`)}
              style={{ "--stagger-i": Math.min(i, 30) } as React.CSSProperties}
              aria-label={`${new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
              })}${isToday ? ", today" : ""}${hasVisits ? ", appointments booked" : ""}`}
              className={cn(
                "animate-day relative mx-auto flex h-8 w-8 items-center justify-center rounded-xl text-sm transition-colors",
                isToday
                  ? "bg-primary font-semibold text-primary-foreground shadow-md shadow-primary/25"
                  : hasVisits
                    ? "bg-primary/10 font-medium text-primary hover:bg-primary/20"
                    : "hover:bg-accent",
              )}
            >
              {day}
              {hasVisits && !isToday ? (
                <span className="absolute bottom-1 h-1 w-1 rounded-full bg-primary/70" aria-hidden />
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ── Birthdays ──────────────────────────────────────────────────────

function BirthdaysCard({ navigate }: { navigate: (to: string) => void }) {
  const [birthdays, setBirthdays] = useState<Birthday[] | null>(null);

  const loadBirthdays = useCallback(async () => {
    try {
      const res = await api<{ birthdays: Birthday[] }>(
        "GET",
        `/api/dashboard/birthdays?days=30&today=${toIsoDate(new Date())}`,
      );
      setBirthdays(res.birthdays);
    } catch {
      setBirthdays([]); // non-critical panel — fail quiet
    }
  }, []);

  useEffect(() => {
    void loadBirthdays();
  }, [loadBirthdays]);

  useDataRefresh(loadBirthdays, { reasons: ["patient"], debounceMs: 400 });

  const today = birthdays?.filter((b) => b.is_today) ?? [];
  const upcoming = birthdays?.filter((b) => !b.is_today) ?? [];

  return (
    <section className="dc-card card-lift animate-rise p-5">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-pink-500/10 text-pink-500">
          <Cake className="h-4 w-4" />
        </span>
        <h2 className="text-lg font-semibold tracking-tight">Birthdays</h2>
        <span className="ml-auto text-xs text-muted-foreground">next 30 days</span>
      </div>
      <div className="stagger mt-3 space-y-2">
        {birthdays === null ? (
          <p className="py-2 text-sm text-muted-foreground">Loading…</p>
        ) : birthdays.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">No patient birthdays in the next 30 days.</p>
        ) : (
          <>
            {today.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => navigate(`/patients/${b.id}`)}
                className="flex w-full items-center gap-3 rounded-2xl border border-pink-200/70 bg-pink-50 px-3 py-2.5 text-left transition-colors hover:bg-pink-100 dark:border-pink-900 dark:bg-pink-950/40 dark:hover:bg-pink-950/70"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-pink-500 text-white">
                  <Cake className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{b.name}</span>
                  <span className="block text-xs text-pink-700 dark:text-pink-300">🎂 Turns {b.turning} today!</span>
                </span>
              </button>
            ))}
            {upcoming.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => navigate(`/patients/${b.id}`)}
                className="flex w-full items-center gap-3 rounded-2xl border bg-card/60 px-3 py-2.5 text-left transition-colors hover:bg-accent/60"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-pink-500/10 text-pink-600 dark:text-pink-300">
                  <Cake className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{b.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    Turns {b.turning} · {b.days_away === 1 ? "tomorrow" : `in ${b.days_away} days`}
                  </span>
                </span>
              </button>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

// ── Upcoming ───────────────────────────────────────────────────────

/** "29 Oct, 9:00 AM" — the year only appears when it is not the current one,
 *  so rows stay one line in a 360px column. */
export function formatEventWhen(iso: string): string {
  const dateOnly = iso.length <= 10;
  const d = new Date(dateOnly ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const day = d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  if (dateOnly) return day;
  return `${day}, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/** Placeholder rows while the summary loads — same rhythm as the real rows so
 *  the panel does not jump when the data lands. */
function UpcomingSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3 rounded-2xl border px-3 py-2.5">
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-xl bg-muted" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

function UpcomingCard({
  summary,
  loading,
  navigate,
}: {
  summary: DashboardSummary | null;
  loading: boolean;
  navigate: (to: string) => void;
}) {
  const events = summary?.upcoming ?? [];
  return (
    <section className="dc-card card-lift animate-rise p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Upcoming</h2>
        <button
          type="button"
          onClick={() => navigate("/agenda")}
          className="text-xs font-semibold text-primary underline-offset-2 hover:underline"
        >
          View All
        </button>
      </div>
      <div className="stagger mt-3 space-y-2">
        {loading ? (
          <UpcomingSkeleton />
        ) : events.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">Nothing scheduled — enjoy the calm.</p>
        ) : (
          events.map((ev) => {
            const patientName = [ev.first_name, ev.last_name].filter(Boolean).join(" ");
            const isRecall = ev.kind === "recall";
            // The headline is the patient (or the free-text title for a block
            // like "Lunch"); everything else moves to the second line.
            const title = ev.title ?? (isRecall ? "Recall" : patientName || "Appointment");
            const detail = [
              ev.title ? patientName : "",
              ev.treatment_name ?? "",
              `${isRecall ? "Recall due" : ""} ${formatEventWhen(ev.start_time)}`.trim(),
            ].filter(Boolean);
            return (
              <button
                key={`${ev.kind}-${ev.id}`}
                type="button"
                onClick={() => navigate(ev.kind === "recall" ? "/patients" : "/agenda")}
                className="flex w-full items-center gap-3 rounded-2xl border border-sky-200/60 bg-sky-50/70 px-3 py-2.5 text-left transition-colors hover:bg-sky-100/70 dark:border-sky-900/60 dark:bg-sky-950/30 dark:hover:bg-sky-950/60"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-500/15 text-sky-700 dark:text-sky-300">
                  <CalendarIcon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{detail.join(" · ")}</span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}

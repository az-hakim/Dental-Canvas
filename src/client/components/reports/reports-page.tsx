import { useCallback, useEffect, useState } from "react";
import {
  CalendarDays, CalendarRange, TrendingUp, Wallet, AlertTriangle, FlaskConical, Users, ListChecks,
  Armchair, Timer,
} from "lucide-react";
import { api } from "@/api";
import { useApp } from "@/context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatMoney } from "@/lib/utils";
import { useDataRefresh } from "@/hooks/use-data-refresh";
import type { ReportsSummary } from "@/types";

export function ReportsPage() {
  const app = useApp();
  const [data, setData] = useState<ReportsSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api<ReportsSummary>("GET", "/api/reports/summary");
      setData(res);
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [app]);

  useEffect(() => {
    void load();
  }, [load]);

  // Appointments, invoices and visits made elsewhere are reflected here
  // without leaving and re-entering the page.
  useDataRefresh(load, { debounceMs: 800, intervalMs: 120_000 });

  if (loading || !data) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        {loading ? "Loading…" : "No data"}
      </div>
    );
  }

  const completedRate = data.month_appointments
    ? Math.round((data.month_completed / data.month_appointments) * 100)
    : 0;
  const noShowRate = data.month_appointments
    ? Math.round((data.month_no_shows / data.month_appointments) * 100)
    : 0;
  const collectionRate = data.month_production
    ? Math.round((data.month_collections / data.month_production) * 100)
    : 0;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b bg-card px-4 py-3">
        <h1 className="text-lg font-semibold tracking-tight">Reports</h1>
        <p className="text-xs text-muted-foreground">Practice KPIs · month-to-date</p>
      </div>

      <div className="flex-1 space-y-4 overflow-auto p-4">
        {/* KPI cards */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard icon={CalendarDays}  label="Today's appointments" value={data.today_appointments.toString()} tone="sky" />
          <KpiCard icon={CalendarRange} label="This week"             value={data.week_appointments.toString()}  tone="emerald" />
          <KpiCard icon={TrendingUp}    label="MTD production"        value={formatMoney(data.month_production)} sub={`${data.month_appointments} appts`} tone="violet" />
          <KpiCard icon={Wallet}        label="MTD collections"       value={formatMoney(data.month_collections)} sub={`${collectionRate}% of production`} tone="amber" />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Completion vs no-show */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Appointment outcomes (MTD)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Bar label="Completed" count={data.month_completed} total={data.month_appointments || 1} pct={completedRate} tone="emerald" />
              <Bar label="No-shows"  count={data.month_no_shows}  total={data.month_appointments || 1} pct={noShowRate}    tone="rose" />
              <Bar label="Cancelled" count={data.month_cancelled} total={data.month_appointments || 1} pct={Math.round((data.month_cancelled / (data.month_appointments || 1)) * 100)} tone="slate" />
            </CardContent>
          </Card>

          {/* Case acceptance — the ADA-benchmarked treatment funnel */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Case acceptance (MTD)</CardTitle>
              <p className="text-xs text-muted-foreground">Treatment plan items presented this month — the industry benchmark is 75–80%</p>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.case_acceptance.presented === 0 ? (
                <p className="text-sm text-muted-foreground">No treatment plan items presented yet this month.</p>
              ) : (
                <>
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold tracking-tight">{data.case_acceptance.rate}%</span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium",
                        (data.case_acceptance.rate ?? 0) >= 75
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                          : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
                    )}
                    >
                      {(data.case_acceptance.rate ?? 0) >= 75 ? "at benchmark" : "below benchmark"}
                    </span>
                  </div>
                  <Bar label="Accepted" count={data.case_acceptance.accepted} total={data.case_acceptance.presented} pct={Math.round((data.case_acceptance.accepted / data.case_acceptance.presented) * 100)} tone="emerald" />
                  <Bar label="Completed (delivered)" count={data.case_acceptance.completed} total={data.case_acceptance.presented} pct={Math.round((data.case_acceptance.completed / data.case_acceptance.presented) * 100)} tone="sky" />
                  <Bar label="Declined" count={data.case_acceptance.declined} total={data.case_acceptance.presented} pct={Math.round((data.case_acceptance.declined / data.case_acceptance.presented) * 100)} tone="rose" />
                </>
              )}
            </CardContent>
          </Card>

          {/* Operational alerts */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Needs attention</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Alert icon={ListChecks} label="Patients on waiting list" value={data.waiting_list_count} tone={data.waiting_list_count > 0 ? "sky" : "slate"} />
              <Alert icon={FlaskConical} label="Overdue lab cases" value={data.overdue_lab_cases} tone={data.overdue_lab_cases > 0 ? "rose" : "slate"} />
              <Alert icon={AlertTriangle} label="No-shows this month" value={data.month_no_shows} tone={data.month_no_shows > 0 ? "amber" : "slate"} />
            </CardContent>
          </Card>
        </div>

        {/* Production by provider */}
        {data.by_provider.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Production by provider (MTD)</CardTitle>
              <p className="text-xs text-muted-foreground">Invoices attributed to the appointment that generated them</p>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.by_provider.map((p, i) => {
                const max = data.by_provider[0].production || 1;
                return (
                  <Bar
                    key={p.name}
                    label={`${p.name} · ${formatMoney(p.production)} prod / ${formatMoney(p.collections)} collected`}
                    count={p.visits}
                    total={max}
                    pct={Math.round((p.production / max) * 100)}
                    tone={i === 0 ? "violet" : "sky"}
                  />
                );
              })}
            </CardContent>
          </Card>
        )}

        {/* Chair utilization & wait time (from kiosk/front-desk check-in data) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Armchair className="h-4 w-4 text-violet-600 dark:text-violet-400" /> Clinic efficiency (MTD)
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Measured from patient check-ins (kiosk or front desk). {data.clinic_efficiency.visits_with_checkin} visit{data.clinic_efficiency.visits_with_checkin === 1 ? "" : "s"} tracked this month.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <EffStat
                label="Avg wait"
                value={data.clinic_efficiency.avg_wait_minutes != null ? `${data.clinic_efficiency.avg_wait_minutes} min` : "—"}
                sub="check-in → chair"
                tone={data.clinic_efficiency.avg_wait_minutes == null ? "slate" : data.clinic_efficiency.avg_wait_minutes > 15 ? "rose" : data.clinic_efficiency.avg_wait_minutes > 5 ? "amber" : "emerald"}
              />
              <EffStat
                label="Longest wait"
                value={data.clinic_efficiency.longest_wait_minutes != null ? `${data.clinic_efficiency.longest_wait_minutes} min` : "—"}
                sub="this month"
                tone={data.clinic_efficiency.longest_wait_minutes != null && data.clinic_efficiency.longest_wait_minutes > 30 ? "rose" : "slate"}
              />
              <EffStat
                label="Chairs used"
                value={String(data.clinic_efficiency.chairs_used)}
                sub={`over ${data.clinic_efficiency.clinic_days} clinic day${data.clinic_efficiency.clinic_days === 1 ? "" : "s"}`}
                tone="sky"
              />
              <EffStat
                label="Chair utilization"
                value={`${data.clinic_efficiency.chair_utilization_pct}%`}
                sub="of 8h × chairs"
                tone={data.clinic_efficiency.chair_utilization_pct >= 70 ? "emerald" : data.clinic_efficiency.chair_utilization_pct >= 50 ? "amber" : "rose"}
              />
            </div>
            <div>
              <div className="mb-1 flex items-baseline justify-between text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1"><Timer className="h-3 w-3" /> Utilization — busy chair-minutes vs. available capacity</span>
                <span className="tabular-nums">70%+ is healthy</span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    data.clinic_efficiency.chair_utilization_pct >= 70 ? "bg-emerald-500" : data.clinic_efficiency.chair_utilization_pct >= 50 ? "bg-amber-500" : "bg-rose-500",
                  )}
                  style={{ width: `${Math.min(100, data.clinic_efficiency.chair_utilization_pct)}%` }}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Aged receivables */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Aged receivables</CardTitle>
            <p className="text-xs text-muted-foreground">Outstanding balances by days since invoice issue</p>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <ARBucket label="0–30 days"  amount={data.aged_receivables["0-30"]}  tone="emerald" />
            <ARBucket label="31–60 days" amount={data.aged_receivables["31-60"]} tone="amber" />
            <ARBucket label="61–90 days" amount={data.aged_receivables["61-90"]} tone="orange" />
            <ARBucket label="90+ days"   amount={data.aged_receivables["90+"]}   tone="rose" />
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* By treatment */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Top treatments (MTD)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.by_treatment.length === 0 ? (
                <p className="text-sm text-muted-foreground">No appointments this month yet.</p>
              ) : (
                data.by_treatment.slice(0, 8).map((row, i) => {
                  const max = data.by_treatment[0].n || 1;
                  return (
                    <Bar
                      key={`${row.name}-${i}`}
                      label={row.name}
                      count={row.n}
                      total={max}
                      pct={Math.round((row.n / max) * 100)}
                      tone="sky"
                    />
                  );
                })
              )}
            </CardContent>
          </Card>

          {/* By marketing source */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="h-4 w-4" /> Patients by acquisition source
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.by_source.length === 0 ? (
                <p className="text-sm text-muted-foreground">No patients yet.</p>
              ) : (
                data.by_source.slice(0, 8).map((row, i) => {
                  const max = data.by_source[0].n || 1;
                  return (
                    <Bar
                      key={`${row.source}-${i}`}
                      label={row.source}
                      count={row.n}
                      total={max}
                      pct={Math.round((row.n / max) * 100)}
                      tone="violet"
                    />
                  );
                })
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

const TONE: Record<string, { bg: string; border: string; text: string; bar: string; dot: string }> = {
  sky:     { bg: "bg-sky-50 dark:bg-sky-950/50",         border: "border-sky-200 dark:border-sky-800",         text: "text-sky-900 dark:text-sky-100",         bar: "bg-sky-500",     dot: "bg-sky-500" },
  emerald: { bg: "bg-emerald-50 dark:bg-emerald-950/50", border: "border-emerald-200 dark:border-emerald-800", text: "text-emerald-900 dark:text-emerald-100", bar: "bg-emerald-500", dot: "bg-emerald-500" },
  amber:   { bg: "bg-amber-50 dark:bg-amber-950/50",     border: "border-amber-200 dark:border-amber-800",     text: "text-amber-900 dark:text-amber-100",     bar: "bg-amber-500",   dot: "bg-amber-500" },
  rose:    { bg: "bg-rose-50 dark:bg-rose-950/50",       border: "border-rose-200 dark:border-rose-800",       text: "text-rose-900 dark:text-rose-100",       bar: "bg-rose-500",    dot: "bg-rose-500" },
  violet:  { bg: "bg-violet-50 dark:bg-violet-950/50",   border: "border-violet-200 dark:border-violet-800",   text: "text-violet-900 dark:text-violet-100",   bar: "bg-violet-500",  dot: "bg-violet-500" },
  orange:  { bg: "bg-orange-50 dark:bg-orange-950/50",   border: "border-orange-200 dark:border-orange-800",   text: "text-orange-900 dark:text-orange-100",   bar: "bg-orange-500",  dot: "bg-orange-500" },
  slate:   { bg: "bg-slate-50 dark:bg-slate-900/60",     border: "border-slate-200 dark:border-slate-700",     text: "text-slate-700 dark:text-slate-200",     bar: "bg-slate-400",   dot: "bg-slate-400" },
};

function KpiCard({ icon: Icon, label, value, sub, tone }: {
  icon: typeof CalendarDays; label: string; value: string; sub?: string; tone: keyof typeof TONE;
}) {
  const t = TONE[tone];
  return (
    <div className={cn("rounded-lg border p-4", t.bg, t.border)}>
      <div className={cn("flex items-center gap-2 text-xs font-semibold uppercase tracking-wider opacity-80", t.text)}>
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className={cn("mt-1 text-2xl font-bold tabular-nums", t.text)}>{value}</div>
      {sub && <div className={cn("text-xs opacity-70", t.text)}>{sub}</div>}
    </div>
  );
}

function Bar({ label, count, total, pct, tone }: { label: string; count: number; total: number; pct: number; tone: keyof typeof TONE }) {
  const t = TONE[tone];
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">{count} · {pct}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", t.bar)} style={{ width: `${Math.min(100, (count / Math.max(total, 1)) * 100)}%` }} />
      </div>
    </div>
  );
}

function Alert({ icon: Icon, label, value, tone }: { icon: typeof ListChecks; label: string; value: number; tone: keyof typeof TONE }) {
  const t = TONE[tone];
  return (
    <div className={cn("flex items-center justify-between rounded-md border px-3 py-2", t.bg, t.border)}>
      <span className={cn("flex items-center gap-2 text-sm font-medium", t.text)}>
        <Icon className="h-4 w-4" />
        {label}
      </span>
      <span className={cn("tabular-nums text-lg font-bold", t.text)}>{value}</span>
    </div>
  );
}

function ARBucket({ label, amount, tone }: { label: string; amount: number; tone: keyof typeof TONE }) {
  const t = TONE[tone];
  return (
    <div className={cn("rounded-lg border p-3", t.bg, t.border)}>
      <div className={cn("text-xs font-semibold uppercase tracking-wider opacity-80", t.text)}>{label}</div>
      <div className={cn("mt-1 text-xl font-bold tabular-nums", t.text)}>{formatMoney(amount)}</div>
    </div>
  );
}

function EffStat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: keyof typeof TONE }) {
  const t = TONE[tone];
  return (
    <div className={cn("rounded-lg border p-3", t.bg, t.border)}>
      <div className={cn("text-xs font-semibold uppercase tracking-wider opacity-80", t.text)}>{label}</div>
      <div className={cn("mt-1 text-xl font-bold tabular-nums", t.text)}>{value}</div>
      <div className={cn("text-[11px] opacity-70", t.text)}>{sub}</div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BriefcaseMedical,
  CalendarClock,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Printer,
  Search,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { api } from "@/api";
import { useApp } from "@/context";
import type { Route } from "@/hooks/use-router";
import { cn, formatDate, formatMoney as money, formatTime } from "@/lib/utils";
import { useDataRefresh } from "@/hooks/use-data-refresh";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { openQuickRegister } from "@/lib/quick-register";
import { rememberFinanceTab } from "@/lib/finance-tab";
import { UserPlus } from "lucide-react";

/**
 * FINANCE section — three pages sharing one endpoint (`/api/finance/overview`):
 * Billing Record (every invoice with its balance), Revenue Breakdown (paid
 * revenue with the full datatable controls), and Appointment Overview
 * (appointment counts per day + status).
 */

// ── Data types ─────────────────────────────────────────────────────

interface FinanceStats {
  total_appointments: number;
  total_revenue: number;
  remaining_balance: number;
}

interface FinanceRow {
  id: number;
  patient_id: number | null;
  issued_at: string;
  total: number;
  amount_paid: number;
  balance: number;
  status: "open" | "paid" | "void";
  patient_name: string | null;
  service: string | null;
  doctor_name: string | null;
  appointment_id: number | null;
}

interface FinanceOverview {
  stats: FinanceStats;
  clinic_name: string;
  profile_doctor: string;
  rows: FinanceRow[];
}

interface FinanceAppointment {
  id: number;
  patient_id: number | null;
  start_time: string;
  end_time: string;
  status: string;
  patient_first_name: string | null;
  patient_last_name: string | null;
  practitioner_name: string | null;
  treatment_name: string | null;
  operatory_name: string | null;
}


const STATUS_BADGE: Record<FinanceRow["status"], string> = {
  open: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800",
  paid: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-800",
  void: "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700",
};

// ── Page shell ─────────────────────────────────────────────────────

export function FinancePage({ route, navigate }: { route: Route; navigate: (to: string) => void }) {
  const tab =
    route.name === "finance-billing" ? "billing" : route.name === "finance-revenue" ? "revenue" : "appointments";

  // Keep the rail's single Finance entry pointed at whatever view was open last.
  useEffect(() => {
    rememberFinanceTab(tab);
  }, [tab]);

  return <FinanceContent tab={tab} navigate={navigate} />;
}

// ── Content ────────────────────────────────────────────────────────

type SortKey =
  | "no"
  | "patient_name"
  | "issued_at"
  | "service"
  | "doctor_name"
  | "total"
  | "amount_paid"
  | "balance";

function FinanceContent({ tab, navigate }: { tab: "billing" | "revenue" | "appointments"; navigate: (to: string) => void }) {
  const app = useApp();
  const [data, setData] = useState<FinanceOverview | null>(null);
  const [appts, setAppts] = useState<FinanceAppointment[]>([]);
  const [loading, setLoading] = useState(true);

  // Table controls
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [perPage, setPerPage] = useState(10);
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState<SortKey>("issued_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const loadFinance = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      const res = await api<FinanceOverview>("GET", `/api/finance/overview${qs ? `?${qs}` : ""}`);
      setData(res);
      if (tab === "appointments") {
        const ap = await api<{ appointments: FinanceAppointment[] }>(
          "GET",
          `/api/appointments${qs ? `?${qs}` : ""}`,
        );
        setAppts(ap.appointments);
      }
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [tab, from, to, app]);

  useEffect(() => {
    void loadFinance();
  }, [loadFinance]);

  // Payments taken elsewhere (billing tab, agenda) update the ledger live.
  useDataRefresh(loadFinance, { reasons: ["invoice", "appointment"], debounceMs: 600 });

  // Reset to the first page whenever the data or a control changes.
  useEffect(() => setPage(1), [search, perPage, sortKey, sortDir, from, to, tab]);

  const filtered = useMemo(() => {
    const rows = data?.rows ?? [];
    if (!search.trim()) return rows;
    const q = search.trim().toLowerCase();
    return rows.filter((r) =>
      [r.patient_name, r.service, r.doctor_name, data?.clinic_name, String(r.id)]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [data, search]);

  const sorted = useMemo(() => {
    const rows = [...filtered];
    const dir = sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      let av: string | number;
      let bv: string | number;
      switch (sortKey) {
        case "no":
          av = a.id; bv = b.id; break;
        case "patient_name":
          av = (a.patient_name ?? "").toLowerCase(); bv = (b.patient_name ?? "").toLowerCase(); break;
        case "service":
          av = (a.service ?? "").toLowerCase(); bv = (b.service ?? "").toLowerCase(); break;
        case "doctor_name":
          av = (a.doctor_name ?? "").toLowerCase(); bv = (b.doctor_name ?? "").toLowerCase(); break;
        case "issued_at":
          av = a.issued_at; bv = b.issued_at; break;
        case "total":
          av = a.total; bv = b.total; break;
        case "amount_paid":
          av = a.amount_paid; bv = b.amount_paid; break;
        case "balance":
          av = a.balance; bv = b.balance; break;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return rows;
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage));
  const pageRows = sorted.slice((page - 1) * perPage, page * perPage);
  const showBalance = tab === "billing";

  const title = tab === "billing" ? "Billing Record" : tab === "revenue" ? "Revenue Breakdown" : "Appointment Overview";
  const subtitle =
    tab === "billing"
      ? "Every invoice with its outstanding balance"
      : tab === "revenue"
        ? "Invoice revenue with payments and balances"
        : "Appointments and their financial linkage";

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header + sub-tabs */}
      <div className="border-b bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight">Finance</h1>
          <span className="text-muted-foreground">/</span>
          <span className="text-sm font-medium text-muted-foreground">{title}</span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={openQuickRegister}>
              <UserPlus className="h-4 w-4" /> Register patient
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
        <div className="mt-2 flex gap-1 overflow-x-auto">
          <SubTab label="Billing Record" active={tab === "billing"} onClick={() => navigate("/finance/billing-record")} />
          <SubTab label="Revenue Breakdown" active={tab === "revenue"} onClick={() => navigate("/finance/revenue-breakdown")} />
          <SubTab label="Appointment Overview" active={tab === "appointments"} onClick={() => navigate("/finance/appointment-overview")} />
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-auto p-4 md:p-6">
        {/* Stats cards */}
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard
            icon={CalendarDays}
            label="Total Appointments"
            value={(data?.stats.total_appointments ?? 0).toString()}
            tone="sky"
            hint={from || to ? `${from || "…"} → ${to || "…"}` : "All time"}
          />
          <StatCard
            icon={BriefcaseMedical}
            label="Total Clinic Revenue"
            value={money(data?.stats.total_revenue ?? 0)}
            tone="emerald"
            hint="Billed across all invoices"
          />
          <StatCard
            icon={Wallet}
            label="Remaining Balance"
            value={money(data?.stats.remaining_balance ?? 0)}
            tone={(data?.stats.remaining_balance ?? 0) > 0 ? "rose" : "slate"}
            hint="Outstanding across all invoices"
          />
        </div>

        {tab === "appointments" ? (
          <AppointmentsPanel appts={appts} loading={loading} navigate={navigate} />
        ) : (
          <>
            {/* Filters */}
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground">From</label>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-auto" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground">To</label>
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-auto" />
              </div>
              {(from || to) && (
                <Button variant="ghost" size="sm" onClick={() => { setFrom(""); setTo(""); }}>
                  Clear dates
                </Button>
              )}
              <div className="relative ml-auto">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search patient, service, doctor…"
                  className="h-9 w-64 pl-8"
                />
              </div>
            </div>

            {/* Datatable */}
            <div className="rounded-lg border bg-card">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <Th label="No." active={sortKey === "no"} dir={sortDir} onClick={() => toggleSort("no")} />
                      <Th label="Patient Name" active={sortKey === "patient_name"} dir={sortDir} onClick={() => toggleSort("patient_name")} />
                      <Th label="Date Time" active={sortKey === "issued_at"} dir={sortDir} onClick={() => toggleSort("issued_at")} />
                      <Th label="Service" active={sortKey === "service"} dir={sortDir} onClick={() => toggleSort("service")} />
                      <Th label="Dr. Name" active={sortKey === "doctor_name"} dir={sortDir} onClick={() => toggleSort("doctor_name")} />
                      <Th label="Clinic Name" />
                      {showBalance ? (
                        <>
                          <Th label="Paid" align="right" active={sortKey === "amount_paid"} dir={sortDir} onClick={() => toggleSort("amount_paid")} />
                          <Th label="Balance" align="right" active={sortKey === "balance"} dir={sortDir} onClick={() => toggleSort("balance")} />
                        </>
                      ) : (
                        <Th label="Price" align="right" active={sortKey === "total"} dir={sortDir} onClick={() => toggleSort("total")} />
                      )}
                      <Th label="" />
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td colSpan={showBalance ? 9 : 8} className="px-3 py-10 text-center text-muted-foreground">Loading…</td>
                      </tr>
                    ) : pageRows.length === 0 ? (
                      <tr>
                        <td colSpan={showBalance ? 9 : 8} className="px-3 py-10 text-center text-muted-foreground">
                          No data available in table
                        </td>
                      </tr>
                    ) : (
                      pageRows.map((r, i) => (
                        <tr key={r.id} className="border-b transition-colors last:border-0 hover:bg-muted/40">
                          <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{(page - 1) * perPage + i + 1}</td>
                          <td className="px-3 py-2">
                            {r.patient_id ? (
                              <button
                                type="button"
                                className="font-medium text-primary hover:underline"
                                onClick={() => navigate(`/patients/${r.patient_id}`)}
                              >
                                {r.patient_name || `Patient #${r.patient_id}`}
                              </button>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                            {formatDate(r.issued_at)} · {formatTime(r.issued_at)}
                          </td>
                          <td className="max-w-[220px] truncate px-3 py-2">{r.service ?? "—"}</td>
                          <td className="whitespace-nowrap px-3 py-2">{r.doctor_name ?? "—"}</td>
                          <td className="whitespace-nowrap px-3 py-2">{data?.clinic_name || "—"}</td>
                          {showBalance ? (
                            <>
                              <td className="px-3 py-2 text-right tabular-nums text-emerald-700 dark:text-emerald-300">{money(r.amount_paid)}</td>
                              <td className={cn("px-3 py-2 text-right font-semibold tabular-nums", r.balance > 0 && r.status !== "void" ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground")}>
                                {r.status === "void" ? "—" : money(r.balance)}
                              </td>
                            </>
                          ) : (
                            <td className="px-3 py-2 text-right font-semibold tabular-nums">{money(r.total)}</td>
                          )}
                          <td className="px-3 py-2">
                            <div className="flex items-center justify-end gap-2">
                              <Badge variant="outline" className={STATUS_BADGE[r.status]}>{r.status}</Badge>
                              <Button
                                size="icon"
                                variant="ghost"
                                title="Open invoice"
                                onClick={() => r.patient_id && navigate(`/patients/${r.patient_id}/invoices/${r.id}`)}
                                disabled={!r.patient_id}
                              >
                                <Printer className="h-4 w-4" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Footer: entries-per-page + pagination */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span>Rows per page</span>
                  <Select value={String(perPage)} onValueChange={(v) => setPerPage(Number(v))}>
                    <SelectTrigger className="h-8 w-[70px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[10, 25, 50, 100].map((n) => (
                        <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="ml-2 hidden sm:inline">
                    {sorted.length === 0 ? "0" : `${(page - 1) * perPage + 1}–${Math.min(page * perPage, sorted.length)}`} of {sorted.length}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="icon" variant="outline" className="h-8 w-8" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page">
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="min-w-[64px] text-center text-muted-foreground">Page {page} / {totalPages}</span>
                  <Button size="icon" variant="outline" className="h-8 w-8" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} aria-label="Next page">
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "issued_at" || key === "total" ? "desc" : "asc");
    }
  }
}

// ── Appointment overview ───────────────────────────────────────────

function AppointmentsPanel({
  appts,
  loading,
  navigate,
}: {
  appts: FinanceAppointment[];
  loading: boolean;
  navigate: (to: string) => void;
}) {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(10);

  useEffect(() => setPage(1), [perPage, appts]);

  const sorted = useMemo(
    () => [...appts].sort((a, b) => (a.start_time < b.start_time ? 1 : -1)),
    [appts],
  );
  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage));
  const pageRows = sorted.slice((page - 1) * perPage, page * perPage);

  const statusTone: Record<string, string> = {
    scheduled: "bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:border-sky-800",
    confirmed: "bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-950 dark:text-teal-200 dark:border-teal-800",
    arrived: "bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-950 dark:text-violet-200 dark:border-violet-800",
    in_chair: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800",
    completed: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-800",
    no_show: "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950 dark:text-rose-200 dark:border-rose-800",
    cancelled: "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700",
  };

  return (
    <div className="rounded-lg border bg-card">
      <div className="border-b px-3 py-2 text-sm font-semibold">
        <span className="inline-flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-muted-foreground" /> Appointments
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 font-semibold">No.</th>
              <th className="px-3 py-2 font-semibold">Patient</th>
              <th className="px-3 py-2 font-semibold">Date Time</th>
              <th className="px-3 py-2 font-semibold">Service</th>
              <th className="px-3 py-2 font-semibold">Doctor</th>
              <th className="px-3 py-2 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">Loading…</td></tr>
            ) : pageRows.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">No data available in table</td></tr>
            ) : (
              pageRows.map((a, i) => (
                <tr key={a.id} className="border-b transition-colors last:border-0 hover:bg-muted/40">
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{(page - 1) * perPage + i + 1}</td>
                  <td className="px-3 py-2">
                    {a.patient_id ? (
                      <button type="button" className="font-medium text-primary hover:underline" onClick={() => navigate(`/patients/${a.patient_id}`)}>
                        {[a.patient_first_name, a.patient_last_name].filter(Boolean).join(" ") || `Patient #${a.patient_id}`}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {formatDate(a.start_time)} · {formatTime(a.start_time)}
                  </td>
                  <td className="max-w-[220px] truncate px-3 py-2">{a.treatment_name ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2">{a.practitioner_name ?? "—"}</td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className={statusTone[a.status] ?? ""}>{a.status.replace("_", " ")}</Badge>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-sm">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span>Rows per page</span>
          <Select value={String(perPage)} onValueChange={(v) => setPerPage(Number(v))}>
            <SelectTrigger className="h-8 w-[70px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[10, 25, 50, 100].map((n) => (
                <SelectItem key={n} value={String(n)}>{n}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="ml-2 hidden sm:inline">
            {sorted.length === 0 ? "0" : `${(page - 1) * perPage + 1}–${Math.min(page * perPage, sorted.length)}`} of {sorted.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="outline" className="h-8 w-8" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[64px] text-center text-muted-foreground">Page {page} / {totalPages}</span>
          <Button size="icon" variant="outline" className="h-8 w-8" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} aria-label="Next page">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Small pieces ───────────────────────────────────────────────────

const TONES = {
  sky: "text-sky-700 dark:text-sky-300 bg-sky-100 dark:bg-sky-950",
  emerald: "text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-950",
  rose: "text-rose-700 dark:text-rose-300 bg-rose-100 dark:bg-rose-950",
  slate: "text-muted-foreground bg-muted",
} as const;

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
  hint,
}: {
  icon: typeof CalendarDays;
  label: string;
  value: string;
  tone: keyof typeof TONES;
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-4">
      <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", TONES[tone])}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="truncate text-xl font-bold tabular-nums">{value}</div>
        {hint && <div className="truncate text-xs text-muted-foreground">{hint}</div>}
      </div>
    </div>
  );
}

function SubTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function Th({
  label,
  align = "left",
  active,
  dir,
  onClick,
}: {
  label: string;
  align?: "left" | "right";
  active?: boolean;
  dir?: "asc" | "desc";
  onClick?: () => void;
}) {
  if (!onClick) {
    return <th className={cn("px-3 py-2 font-semibold", align === "right" && "text-right")}>{label}</th>;
  }
  return (
    <th className={cn("px-3 py-2 font-semibold", align === "right" && "text-right")}>
      <button type="button" onClick={onClick} className={cn("inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground")}>
        {label}
        <span className={cn("text-[10px]", active ? "opacity-100" : "opacity-0")}>{dir === "asc" ? "▲" : "▼"}</span>
      </button>
    </th>
  );
}

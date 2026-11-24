import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Search, UserPlus, Users } from "lucide-react";
import { useApp } from "@/context";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader, PageShell } from "@/components/page-shell";
import { ToothGlyph } from "@/components/dental-art";
import { formatDate, formatMoney } from "@/lib/utils";
import { useDataRefresh } from "@/hooks/use-data-refresh";
import type { Patient } from "@/types";
import { PatientDialog } from "./patient-dialog";

/** Two initials on the row avatar — the same visual rhythm as the dashboard. */
function initials(p: Patient): string {
  const a = p.first_name.trim()[0] ?? "";
  const b = p.last_name.trim()[0] ?? "";
  return `${a}${b}`.toUpperCase() || "?";
}

export function PatientsList({ navigate }: { navigate: (to: string) => void }) {
  const app = useApp();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [balances, setBalances] = useState<Record<string, number>>({});
  /** Patient being quick-edited from its row; null = registering a new one. */
  const [editing, setEditing] = useState<Patient | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [pRes, bRes] = await Promise.all([
        api<{ patients: Patient[] }>(
          "GET",
          q.trim() ? `/api/patients?q=${encodeURIComponent(q.trim())}` : "/api/patients",
        ),
        // Balances come from the reports endpoint (open-invoice sums per patient).
        api<{ balances: Record<string, number> }>("GET", "/api/reports/balances").catch(() => ({ balances: {} })),
      ]);
      setPatients(pRes.patients);
      setBalances(bRes.balances ?? {});
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, app]);

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);

  // A patient registered or edited anywhere (dashboard dialog, agenda side
  // panel, patient page) is reflected here without a reload.
  useDataRefresh(load, { reasons: ["patient", "invoice"], debounceMs: 500 });

  const visible = useMemo(() => patients, [patients]);

  const count = visible.length;
  const countLabel = loading
    ? "Patient records"
    : `${count} ${count === 1 ? "patient" : "patients"}${q.trim() ? " matched" : " on file"}`;

  return (
    <PageShell>
      <PageHeader
        icon={<Users className="h-5 w-5" />}
        eyebrow={countLabel}
        title="Patients"
        description="Search the list, register someone new, or open a chart."
        actions={
          <>
            <div className="relative min-w-0 flex-1 sm:w-80 sm:flex-none">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search patients…"
                aria-label="Search patients"
                className="h-11 rounded-full border-border/60 bg-card/85 pl-11 pr-4 shadow-sm backdrop-blur focus-visible:ring-primary/40"
              />
            </div>
            <Button
              className="h-11 rounded-full px-5 shadow-lg shadow-primary/20"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4" />
              New patient
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto px-4 pb-8 md:px-6">
        <Card className="animate-rise overflow-hidden">
          <Table>
            <TableHeader>
              {/* Email is the one column that can be dropped on a phone
                  without losing what the list is for: with it visible the
                  table scrolled sideways and every row wrapped to three
                  lines. It stays available on the patient's record. */}
              <TableRow className="border-b border-border/50 bg-muted/40 hover:bg-muted/40">
                {/* Name claims the leftover width so "Villanueva, Marta"
                    stays on one line on a phone. */}
                <TableHead className="h-10 w-full px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground sm:px-4">
                  Name
                </TableHead>
                <TableHead className="hidden h-10 whitespace-nowrap px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground sm:table-cell sm:px-4">
                  Date of birth
                </TableHead>
                <TableHead className="hidden h-10 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground sm:table-cell">
                  Email
                </TableHead>
                <TableHead className="h-10 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground sm:px-4">
                  Phone
                </TableHead>
                <TableHead className="h-10 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground sm:px-4">
                  Alerts
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && visible.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} aria-hidden className="py-6">
                    {/* Skeleton rows, matching the list's real rhythm. */}
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="flex items-center gap-4 py-2.5">
                        <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-muted" />
                        <div className="h-3 w-40 animate-pulse rounded bg-muted" />
                        <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                        <div className="h-3 flex-1 animate-pulse rounded bg-muted" />
                      </div>
                    ))}
                  </TableCell>
                </TableRow>
              ) : visible.length === 0 && !q ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="py-14 text-center">
                    <div className="mx-auto flex max-w-sm flex-col items-center gap-3">
                      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/15 to-teal-500/10 text-primary">
                        <ToothGlyph className="h-7 w-7" />
                      </span>
                      <p className="text-sm text-muted-foreground">
                        No patients yet. Register your first patient — a name is all it takes.
                      </p>
                      <Button
                        size="sm"
                        className="rounded-full"
                        onClick={() => {
                          setEditing(null);
                          setDialogOpen(true);
                        }}
                      >
                        <Plus className="h-4 w-4" />
                        Register patient
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : visible.length === 0 && q ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="py-14 text-center">
                    <div className="mx-auto flex max-w-sm flex-col items-center gap-2">
                      <Search className="h-7 w-7 text-muted-foreground/50" />
                      <p className="text-sm text-muted-foreground">
                        No patients match “{q.trim()}”. Try a surname, phone number or email.
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                visible.map((p) => (
                  <TableRow
                    key={p.id}
                    onClick={() => navigate(`/patients/${p.id}`)}
                    className="group cursor-pointer border-b border-border/40 transition-colors last:border-0 hover:bg-primary/[0.05]"
                  >
                    <TableCell className="px-3 py-3 sm:px-4">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">
                          {initials(p)}
                        </span>
                        <span className="min-w-0 truncate font-medium">
                          {p.last_name}, {p.first_name}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap px-3 text-muted-foreground sm:table-cell sm:px-4">
                      {p.date_of_birth ? formatDate(p.date_of_birth) : "—"}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {p.email ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap px-3 text-muted-foreground tabular-nums sm:px-4">
                      {p.phone ?? "—"}
                    </TableCell>
                    <TableCell className="px-3 sm:px-4">
                      {/* Stacked on a phone, inline on a desktop: side by
                          side they pushed the table into a horizontal
                          scroll. The pencil is a hover affordance and is
                          dropped on touch, where the whole row opens the
                          record anyway. */}
                      <div className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2">
                        {(balances[p.id] ?? 0) > 0 && (
                          <span
                            className="inline-flex items-center whitespace-nowrap rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-800 dark:bg-rose-950 dark:text-rose-200"
                            title="Outstanding balance"
                          >
                            owes {formatMoney(balances[p.id])}
                          </span>
                        )}
                        {p.medical_alerts ? (
                          <span className="inline-flex items-center whitespace-nowrap rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-800 dark:bg-rose-950 dark:text-rose-200">
                            {p.medical_alerts.split(",").length} alert{p.medical_alerts.split(",").length === 1 ? "" : "s"}
                          </span>
                        ) : (
                          (balances[p.id] ?? 0) <= 0 && <span className="text-muted-foreground">—</span>
                        )}
                        <button
                          type="button"
                          title="Quick edit"
                          aria-label={`Quick edit ${p.first_name} ${p.last_name}`}
                          className="hidden rounded-full p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 sm:inline-flex"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditing(p);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>

        {visible.length > 0 && (
          <p className="mt-3 flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
            <UserPlus className="h-3.5 w-3.5" />
            Showing {visible.length} {visible.length === 1 ? "record" : "records"} — click a row to open the chart.
          </p>
        )}
      </div>

      {/* Quick register / row quick-edit. Creating keeps you on the list; the
          success screen offers “Open record” for when you do want to continue. */}
      <PatientDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        patient={editing}
        onSaved={(p) => {
          setPatients((prev) => {
            const rest = prev.filter((x) => x.id !== p.id);
            // Keep the list's alphabetical order (server sorts by last, first).
            const next = [...rest, p];
            next.sort(
              (a, b) =>
                a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name),
            );
            return next;
          });
        }}
        onOpenPatient={(p) => navigate(`/patients/${p.id}`)}
        openPatientLabel="Open record"
      />
    </PageShell>
  );
}

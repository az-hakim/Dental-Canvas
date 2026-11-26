import { useEffect, useState } from "react";
import { AlertTriangle, Combine, Loader2, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/api";
import { toast } from "@/components/ui/toast";
import type { Patient } from "@/types";

/**
 * Merge the record on screen into another record for the same person.
 *
 * The case is always the same: bulk import (or a hurried quick registration)
 * left two rows for one patient, and one of them holds the appointments, the
 * invoices and the notes. Deleting the spare would take its history with it, so
 * this moves everything onto the record that is kept and then removes the
 * other. The counts shown come from the server's own preview endpoint, so what
 * the dialog promises is what the merge does.
 */

interface MergeCounts {
  [table: string]: number;
}

interface MergePreview {
  keep: { id: number; first_name: string; last_name: string };
  other: { id: number; first_name: string; last_name: string };
  counts: MergeCounts;
  kept: MergeCounts;
}

/** Table → what to call it in a sentence. */
const LABELS: Record<string, string> = {
  appointments: "appointment",
  clinical_notes: "clinical note",
  invoices: "invoice",
  prescriptions: "prescription",
  treatment_plan_items: "treatment plan item",
  tooth_conditions: "tooth chart entry",
  patient_images: "image",
  lab_cases: "lab case",
  waiting_list: "waiting list entry",
  patient_memberships: "membership",
  consent_signatures: "signed consent",
  insurance_plans: "insurance plan",
  appointments_to_make: "recall item",
};

function summarise(counts: MergeCounts): { moved: string[]; total: number } {
  const moved: string[] = [];
  let total = 0;
  for (const [table, value] of Object.entries(counts)) {
    if (!value) continue;
    total += value;
    const label = LABELS[table] ?? table;
    moved.push(`${value} ${label}${value === 1 ? "" : "s"}`);
  }
  return { moved, total };
}

function fullName(p: { first_name: string; last_name: string }): string {
  return `${p.first_name} ${p.last_name}`.trim();
}

export function MergePatientDialog({
  open,
  onOpenChange,
  patient,
  onMerged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  patient: Patient;
  onMerged: (survivor: Patient, removedId: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Patient[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Patient | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [keepSide, setKeepSide] = useState<"current" | "other">("current");
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults([]);
    setSelected(null);
    setPreview(null);
    setKeepSide("current");
    setMerging(false);
  }, [open]);

  // Search-as-you-type against the same patient search the list uses, so a
  // surname, a phone number or an email all find the duplicate.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const q = query.trim();
        const data = await api<{ patients: Patient[] }>(
          "GET",
          q ? `/api/patients?q=${encodeURIComponent(q)}` : "/api/patients",
        );
        if (!cancelled) {
          setResults(data.patients.filter((p) => p.id !== patient.id).slice(0, 8));
        }
      } catch (err) {
        if (!cancelled) toast.error((err as Error).message);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, query.trim() ? 200 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, patient.id]);

  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await api<MergePreview>(
          "GET",
          `/api/patients/${patient.id}/merge-preview?other_id=${selected.id}`,
        );
        if (!cancelled) setPreview(data);
      } catch (err) {
        if (!cancelled) toast.error((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, patient.id]);

  async function runMerge() {
    if (!selected) return;
    const keep_id = keepSide === "current" ? patient.id : selected.id;
    const merge_id = keepSide === "current" ? selected.id : patient.id;
    setMerging(true);
    try {
      const result = await api<{ patient: Patient; removed_id: number; moved: MergeCounts }>(
        "POST",
        "/api/patients/merge",
        { keep_id, merge_id },
      );
      const { total } = summarise(result.moved);
      toast.success(
        `Merged into ${fullName(result.patient)}` +
          (total > 0 ? ` — ${total} ${total === 1 ? "record" : "records"} moved` : ""),
      );
      onMerged(result.patient, result.removed_id);
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setMerging(false);
    }
  }

  const otherSummary = preview ? summarise(preview.counts) : null;
  const keepSummary = preview ? summarise(preview.kept) : null;
  const otherName = selected ? fullName(selected) : "";
  const currentName = fullName(patient);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Combine className="h-4 w-4 text-primary" />
            Merge {currentName} into another record
          </DialogTitle>
          <DialogDescription>
            For the same person entered twice — after a bulk import, for example. Appointments,
            invoices and clinical notes move to the record you keep, then the other record is
            removed. Nothing is deleted except the duplicate itself.
          </DialogDescription>
        </DialogHeader>

        {!selected && (
          <div className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find the other record — name, phone or email"
                className="pl-9"
              />
            </div>
            <div className="max-h-64 overflow-auto rounded-lg border">
              {searching && results.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                  Searching…
                </p>
              ) : results.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No other record matches{query.trim() ? ` “${query.trim()}”` : ""}.
                </p>
              ) : (
                results.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelected(p)}
                    className="flex w-full items-center justify-between gap-3 border-b border-border/50 px-3 py-2.5 text-left text-sm transition-colors last:border-0 hover:bg-primary/[0.05]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {p.last_name}, {p.first_name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[p.date_of_birth, p.phone, p.email].filter(Boolean).join(" · ") || "No details"}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">#{p.id}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {selected && (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  { side: "current" as const, label: "This record", name: currentName, counts: keepSummary },
                  { side: "other" as const, label: "Other record", name: otherName, counts: otherSummary },
                ]
              ).map((option) => (
                <button
                  key={option.side}
                  type="button"
                  onClick={() => setKeepSide(option.side)}
                  className={`rounded-xl border p-3 text-left transition-colors ${
                    keepSide === option.side
                      ? "border-primary/60 bg-primary/[0.06]"
                      : "border-border/70 hover:border-primary/40"
                  }`}
                >
                  <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
                    <span
                      className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border ${
                        keepSide === option.side ? "border-primary" : "border-muted-foreground/50"
                      }`}
                    >
                      {keepSide === option.side && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
                    </span>
                    Keep {option.label.toLowerCase()}
                  </span>
                  <span className="mt-1 block truncate font-medium">{option.name}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {option.counts
                      ? option.counts.total > 0
                        ? `${option.counts.total} record${option.counts.total === 1 ? "" : "s"}`
                        : "No history yet"
                      : "Reading…"}
                  </span>
                </button>
              ))}
            </div>

            <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100">
              <p className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {otherSummary && otherSummary.total > 0 ? (
                    <>
                      Moving <strong>{otherSummary.moved.join(", ")}</strong> to{" "}
                      {keepSide === "current" ? currentName : otherName}. The record not kept is
                      removed; its alerts and any blank details are copied over first.
                    </>
                  ) : (
                    <>
                      {otherName} has no appointments, invoices or notes — merging it only removes
                      the duplicate.
                    </>
                  )}
                </span>
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={merging}>
            Cancel
          </Button>
          {selected && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setSelected(null);
                setPreview(null);
              }}
              disabled={merging}
            >
              Choose another
            </Button>
          )}
          {selected && (
            <Button type="button" onClick={() => void runMerge()} disabled={merging || !preview}>
              {merging ? <Loader2 className="h-4 w-4 animate-spin" /> : <Combine className="h-4 w-4" />}
              Merge records
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

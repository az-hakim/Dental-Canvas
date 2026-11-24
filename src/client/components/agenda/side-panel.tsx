import { useEffect, useState } from "react";
import { Plus, Trash2, ChevronRight, ChevronLeft, ListChecks, CalendarPlus, BellRing, MessageCircle, Phone, Copy, CheckCheck, PhoneCall, Star, CalendarClock, BadgeCheck, Banknote } from "lucide-react";
import { useApp } from "@/context";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, colorClasses, formatDate, formatMoney } from "@/lib/utils";
import { openExternalUrl } from "@/lib/open-external";
import type { AppointmentToMake, FollowUpsResponse, Invoice, Patient, PaymentReminderRow, ReminderRow, ReviewRequestRow, ToMakeSource, WaitingListEntry } from "@/types";
import { PaymentDialog } from "@/components/patients/billing";

const TO_MAKE_SOURCES: ToMakeSource[] = ["reception", "patient", "system"];

export function AgendaSidePanel() {
  // Phones start with the desk panel folded: open, its fixed 46% height left
  // the day grid about two hours tall, which is the wrong trade on a phone.
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches,
  );

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="flex h-11 w-full shrink-0 items-center justify-center gap-2 border-t border-border/50 bg-card/80 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground backdrop-blur transition-colors hover:bg-accent lg:h-full lg:w-8 lg:flex-col lg:border-l lg:border-t-0"
        aria-label="Expand side panel"
      >
        <ChevronLeft className="h-4 w-4 rotate-90 lg:rotate-0" />
        <span className="lg:hidden">Waiting list &amp; reminders</span>
      </button>
    );
  }

  return (
    /* Below lg the desk panels sit under the grid instead of squeezing it to
       a 70px sliver; from lg up they are the familiar right-hand rail. */
    <aside className="flex h-[46%] min-h-0 w-full shrink-0 flex-col border-t border-border/50 bg-card/80 backdrop-blur-md lg:h-full lg:w-80 lg:border-l lg:border-t-0">
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Side panel
        </span>
        <Button variant="ghost" size="icon" onClick={() => setCollapsed(true)} aria-label="Collapse side panel">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <Tabs defaultValue="waiting" className="flex flex-1 flex-col">
        {/* Six tabs cannot fit one 320px row: in a single row the last two
            were clipped ("Rev…") and the labels were cut off at the top.
            Two rows of three fit at every panel width. */}
        <TabsList className="dc-tabbar mx-3 mt-3 grid h-auto grid-cols-3 gap-1 rounded-2xl border border-border/60 bg-card/70 p-1 shadow-sm backdrop-blur">
          <TabsTrigger value="waiting" className="gap-1.5 px-1.5 py-1.5 text-[11px]">
            <ListChecks className="h-3.5 w-3.5 shrink-0" /> Waiting
          </TabsTrigger>
          <TabsTrigger value="to-make" className="gap-1.5 px-1.5 py-1.5 text-[11px]">
            <CalendarPlus className="h-3.5 w-3.5 shrink-0" /> To make
          </TabsTrigger>
          <TabsTrigger value="reminders" className="gap-1.5 px-1.5 py-1.5 text-[11px]">
            <BellRing className="h-3.5 w-3.5 shrink-0" /> Remind
          </TabsTrigger>
          <TabsTrigger value="followups" className="gap-1.5 px-1.5 py-1.5 text-[11px]">
            <PhoneCall className="h-3.5 w-3.5 shrink-0" /> Follow up
          </TabsTrigger>
          <TabsTrigger value="reviews" className="gap-1.5 px-1.5 py-1.5 text-[11px]">
            <Star className="h-3.5 w-3.5 shrink-0" /> Reviews
          </TabsTrigger>
          <TabsTrigger value="recall" className="gap-1.5 px-1.5 py-1.5 text-[11px]">
            <CalendarClock className="h-3.5 w-3.5 shrink-0" /> Recall
          </TabsTrigger>
        </TabsList>
        <TabsContent value="waiting" className="flex-1 overflow-auto px-3 pb-3">
          <WaitingListPanel />
        </TabsContent>
        <TabsContent value="to-make" className="flex-1 overflow-auto px-3 pb-3">
          <ToMakePanel />
        </TabsContent>
        <TabsContent value="reminders" className="flex-1 overflow-auto px-3 pb-3">
          <RemindersPanel />
        </TabsContent>
        <TabsContent value="followups" className="flex-1 overflow-auto px-3 pb-3">
          <FollowUpsPanel />
        </TabsContent>
        <TabsContent value="reviews" className="flex-1 overflow-auto px-3 pb-3">
          <ReviewRequestsPanel />
        </TabsContent>
        <TabsContent value="recall" className="flex-1 overflow-auto px-3 pb-3">
          <RecallPanel />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

// ── Waiting list ──────────────────────────────────────────────────

function WaitingListPanel() {
  const app = useApp();
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        Patients ready to be slotted into a sooner opening.
      </div>
      <Button size="sm" variant="outline" onClick={() => setAdding(true)} className="w-full rounded-full">
        <Plus className="h-4 w-4" /> Add to waiting list
      </Button>
      {adding && <AddWaitingListForm onClose={() => setAdding(false)} />}

      {app.waitingList.length === 0 && !adding ? (
        <div className="rounded-md border border-dashed py-6 text-center text-xs text-muted-foreground">
          Waiting list is empty.
        </div>
      ) : (
        <div className="space-y-2">
          {app.waitingList.map((w) => (
            <WaitingListRow key={w.id} entry={w} />
          ))}
        </div>
      )}
    </div>
  );
}

function WaitingListRow({ entry }: { entry: WaitingListEntry }) {
  const app = useApp();
  const palette = colorClasses(entry.treatment_color || "sky");
  const [offering, setOffering] = useState(false);
  const [offerUrl, setOfferUrl] = useState<string | null>(null);
  async function remove() {
    if (!confirm("Remove from waiting list?")) return;
    try {
      await api("DELETE", `/api/waiting-list/${entry.id}`);
      await app.refreshSidePanels();
    } catch (err) {
      app.setError((err as Error).message);
    }
  }

  /**
   * "A slot opened" — offer the waiting patient the next free gap in the
   * current agenda day. Builds a ready-to-send WhatsApp message via the
   * server (which also stamps the offer on the entry's notes).
   */
  async function offerSlot() {
    // Next working-hour gap: 1h from now on the hour, within 7 days.
    const slot = new Date();
    slot.setMinutes(0, 0, 0);
    slot.setHours(slot.getHours() + 1);
    if (slot.getHours() < 9 || slot.getHours() >= 17) {
      slot.setDate(slot.getDate() + 1);
      slot.setHours(9, 0, 0, 0);
    }
    setOffering(true);
    try {
      const res = await api<{ wa_url: string }>(
        "POST",
        `/api/waiting-list/${entry.id}/offer?slot=${slot.toISOString().slice(0, 19)}`,
      );
      setOfferUrl(res.wa_url);
      void openExternalUrl(res.wa_url);
      await app.refreshSidePanels();
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setOffering(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-1 p-3 text-sm">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-medium">{entry.first_name} {entry.last_name}</div>
            {entry.date_of_birth && (
              <div className="text-xs text-muted-foreground">{formatDate(entry.date_of_birth)}</div>
            )}
          </div>
          <Button size="icon" variant="ghost" onClick={remove} aria-label="Remove">
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {entry.treatment_name && (
            <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5", palette.bg, palette.text)}>
              <span className={cn("inline-block h-1.5 w-1.5 rounded-full", palette.dot)} />
              {entry.treatment_name}
            </span>
          )}
          <span className="text-muted-foreground">{entry.duration_minutes} min</span>
          {entry.practitioner_name && (
            <span className="text-muted-foreground">· {entry.practitioner_name}</span>
          )}
        </div>
        {entry.notes && <p className="text-xs text-muted-foreground">{entry.notes}</p>}
        <div className="flex gap-1.5 pt-1">
          <Button size="sm" variant="outline" className="h-7 flex-1 text-xs" onClick={offerSlot} disabled={offering}>
            <MessageCircle className="h-3 w-3" />
            {offering ? "Preparing…" : "Offer a slot"}
          </Button>
          {offerUrl && (
            <a
              href={offerUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 items-center rounded-md border px-2 text-xs hover:bg-accent"
              title="Re-open the WhatsApp message"
            >
              Re-open
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function AddWaitingListForm({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [patientLabel, setPatientLabel] = useState("");
  const [patientId, setPatientId] = useState<number | null>(null);
  const [results, setResults] = useState<Patient[]>([]);
  const [treatmentTypeId, setTreatmentTypeId] = useState<string>("none");
  const [practitionerId, setPractitionerId] = useState<string>("none");
  const [duration, setDuration] = useState("30");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = patientLabel.trim();
    if (!q || patientId) { setResults([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await api<{ patients: Patient[] }>("GET", `/api/patients?q=${encodeURIComponent(q)}`);
        if (!cancelled) setResults(r.patients.slice(0, 5));
      } catch { /* ignore */ }
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [patientLabel, patientId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!patientId && !patientLabel.trim()) {
      app.setError("Type a patient name");
      return;
    }
    setBusy(true);
    try {
      let pid = patientId;
      if (!pid) {
        const [first, ...rest] = patientLabel.trim().split(/\s+/);
        const created = await app.createPatient({
          first_name: first,
          last_name: rest.join(" ") || "(unknown)",
        });
        pid = created.id;
      }
      await api("POST", "/api/waiting-list", {
        patient_id: pid,
        treatment_type_id: treatmentTypeId === "none" ? null : parseInt(treatmentTypeId, 10),
        preferred_practitioner_id: practitionerId === "none" ? null : parseInt(practitionerId, 10),
        duration_minutes: parseInt(duration, 10) || 30,
        notes: notes.trim() || null,
      });
      await app.refreshSidePanels();
      onClose();
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-md border bg-muted/30 p-3">
      <FieldSm label="Patient">
        <div className="relative">
          <Input
            value={patientLabel}
            onChange={(e) => { setPatientLabel(e.target.value); setPatientId(null); }}
            placeholder="Type a name…"
            className="h-8"
          />
          {results.length > 0 && !patientId && (
            <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-md">
              {results.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { setPatientId(p.id); setPatientLabel(`${p.first_name} ${p.last_name}`); setResults([]); }}
                  className="block w-full px-3 py-1.5 text-left text-xs hover:bg-accent"
                >
                  <div className="font-medium">{p.first_name} {p.last_name}</div>
                  <div className="text-muted-foreground">{p.date_of_birth ?? p.email ?? p.phone ?? "—"}</div>
                </button>
              ))}
            </div>
          )}
          {patientLabel && !patientId && results.length === 0 && (
            <p className="mt-1 text-[10px] text-muted-foreground">A new patient will be created on save.</p>
          )}
        </div>
      </FieldSm>
      <FieldSm label="Treatment">
        <Select value={treatmentTypeId} onValueChange={setTreatmentTypeId}>
          <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">— None —</SelectItem>
            {app.treatmentTypes.map((t) => <SelectItem key={t.id} value={t.id.toString()}>{t.code} · {t.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </FieldSm>
      <FieldSm label="Practitioner">
        <Select value={practitionerId} onValueChange={setPractitionerId}>
          <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">— Any —</SelectItem>
            {app.practitioners.map((p) => <SelectItem key={p.id} value={p.id.toString()}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </FieldSm>
      <FieldSm label="Duration (min)">
        <Input type="number" min="5" value={duration} onChange={(e) => setDuration(e.target.value)} className="h-8" />
      </FieldSm>
      <FieldSm label="Notes">
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} className="h-8" />
      </FieldSm>
      <div className="flex gap-2 pt-1">
        <Button size="sm" type="submit" disabled={busy} className="flex-1">Add</Button>
        <Button size="sm" type="button" variant="outline" onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

// ── Appointments to make ──────────────────────────────────────────

function ToMakePanel() {
  const app = useApp();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<ToMakeSource | "all">("all");

  const visible = filter === "all"
    ? app.appointmentsToMake
    : app.appointmentsToMake.filter((a) => a.source === filter);

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        Recall and follow-up bookings to schedule.
      </div>
      <div className="flex gap-1">
        <Pill active={filter === "all"} onClick={() => setFilter("all")}>All ({app.appointmentsToMake.length})</Pill>
        {TO_MAKE_SOURCES.map((s) => (
          <Pill key={s} active={filter === s} onClick={() => setFilter(s)}>
            {capitalize(s)} ({app.appointmentsToMake.filter((a) => a.source === s).length})
          </Pill>
        ))}
      </div>
      <Button size="sm" variant="outline" onClick={() => setAdding(true)} className="w-full">
        <Plus className="h-4 w-4" /> New entry
      </Button>
      {adding && <AddToMakeForm onClose={() => setAdding(false)} />}

      {visible.length === 0 && !adding ? (
        <div className="rounded-md border border-dashed py-6 text-center text-xs text-muted-foreground">
          Nothing to schedule.
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((a) => <ToMakeRow key={a.id} entry={a} />)}
        </div>
      )}
    </div>
  );
}

function ToMakeRow({ entry }: { entry: AppointmentToMake }) {
  const app = useApp();
  const palette = colorClasses(entry.treatment_color || "sky");
  async function remove() {
    if (!confirm("Remove this entry?")) return;
    try {
      await api("DELETE", `/api/appointments-to-make/${entry.id}`);
      await app.refreshSidePanels();
    } catch (err) {
      app.setError((err as Error).message);
    }
  }
  return (
    <Card>
      <CardContent className="space-y-1 p-3 text-sm">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-medium">{entry.first_name} {entry.last_name}</div>
            {entry.date_of_birth && (
              <div className="text-xs text-muted-foreground">{formatDate(entry.date_of_birth)}</div>
            )}
          </div>
          <Button size="icon" variant="ghost" onClick={remove} aria-label="Remove">
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {entry.treatment_name && (
            <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5", palette.bg, palette.text)}>
              <span className={cn("inline-block h-1.5 w-1.5 rounded-full", palette.dot)} />
              {entry.treatment_name}
            </span>
          )}
          <span className="text-muted-foreground">via {entry.source}</span>
          {entry.due_after && (
            <span className="text-muted-foreground">· due after {formatDate(entry.due_after)}</span>
          )}
        </div>
        {entry.notes && <p className="text-xs text-muted-foreground">{entry.notes}</p>}
      </CardContent>
    </Card>
  );
}

function AddToMakeForm({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [patientLabel, setPatientLabel] = useState("");
  const [patientId, setPatientId] = useState<number | null>(null);
  const [results, setResults] = useState<Patient[]>([]);
  const [treatmentTypeId, setTreatmentTypeId] = useState("none");
  const [source, setSource] = useState<ToMakeSource>("reception");
  const [dueAfter, setDueAfter] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = patientLabel.trim();
    if (!q || patientId) { setResults([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await api<{ patients: Patient[] }>("GET", `/api/patients?q=${encodeURIComponent(q)}`);
        if (!cancelled) setResults(r.patients.slice(0, 5));
      } catch { /* ignore */ }
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [patientLabel, patientId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!patientId && !patientLabel.trim()) {
      app.setError("Type a patient name");
      return;
    }
    setBusy(true);
    try {
      let pid = patientId;
      if (!pid) {
        const [first, ...rest] = patientLabel.trim().split(/\s+/);
        const created = await app.createPatient({
          first_name: first,
          last_name: rest.join(" ") || "(unknown)",
        });
        pid = created.id;
      }
      await api("POST", "/api/appointments-to-make", {
        patient_id: pid,
        treatment_type_id: treatmentTypeId === "none" ? null : parseInt(treatmentTypeId, 10),
        source,
        due_after: dueAfter || null,
        notes: notes.trim() || null,
      });
      await app.refreshSidePanels();
      onClose();
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-md border bg-muted/30 p-3">
      <FieldSm label="Patient">
        <div className="relative">
          <Input value={patientLabel} onChange={(e) => { setPatientLabel(e.target.value); setPatientId(null); }} placeholder="Type a name…" className="h-8" />
          {results.length > 0 && !patientId && (
            <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-md">
              {results.map((p) => (
                <button key={p.id} type="button" onClick={() => { setPatientId(p.id); setPatientLabel(`${p.first_name} ${p.last_name}`); setResults([]); }} className="block w-full px-3 py-1.5 text-left text-xs hover:bg-accent">
                  <div className="font-medium">{p.first_name} {p.last_name}</div>
                  <div className="text-muted-foreground">{p.date_of_birth ?? p.email ?? p.phone ?? "—"}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </FieldSm>
      <FieldSm label="Treatment">
        <Select value={treatmentTypeId} onValueChange={setTreatmentTypeId}>
          <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">— None —</SelectItem>
            {app.treatmentTypes.map((t) => <SelectItem key={t.id} value={t.id.toString()}>{t.code} · {t.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </FieldSm>
      <FieldSm label="Source">
        <Select value={source} onValueChange={(v) => setSource(v as ToMakeSource)}>
          <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            {TO_MAKE_SOURCES.map((s) => <SelectItem key={s} value={s}>{capitalize(s)}</SelectItem>)}
          </SelectContent>
        </Select>
      </FieldSm>
      <FieldSm label="Due after">
        <Input type="date" value={dueAfter} onChange={(e) => setDueAfter(e.target.value)} className="h-8" />
      </FieldSm>
      <FieldSm label="Notes">
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} className="h-8" />
      </FieldSm>
      <div className="flex gap-2 pt-1">
        <Button size="sm" type="submit" disabled={busy} className="flex-1">Add</Button>
        <Button size="sm" type="button" variant="outline" onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

function FieldSm({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors",
        active ? "border-foreground/30 bg-foreground/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Follow-ups (unscheduled treatment + dormant patients) ─────────

/**
 * The weekly call lists: patients with accepted treatment they never booked
 * (highest intent — call first), and dormant patients who haven't visited in
 * months. One-click WhatsApp/call per row, mirroring the reminders tab.
 */
function FollowUpsPanel() {
  const ctx = useApp();
  const [data, setData] = useState<FollowUpsResponse | null>(null);
  const [list, setList] = useState<"unscheduled" | "dormant" | "payments">("unscheduled");
  const [contacted, setContacted] = useState<Set<string>>(new Set());
  const [payReminders, setPayReminders] = useState<PaymentReminderRow[] | null>(null);
  // Installment row the user wants to record a payment against (dialog open).
  const [recording, setRecording] = useState<PaymentReminderRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<FollowUpsResponse>("GET", "/api/followups")
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setData({ unscheduled_treatment: [], dormant_patients: [], dormant_months: 12 });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Installment reminders load lazily — only when the Payments pill is opened.
  useEffect(() => {
    if (list !== "payments" || payReminders) return;
    let cancelled = false;
    api<{ reminders: PaymentReminderRow[] }>("GET", "/api/payment-reminders?days=3")
      .then((res) => {
        if (!cancelled) setPayReminders(res.reminders);
      })
      .catch(() => {
        if (!cancelled) setPayReminders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [list, payReminders]);

  /** After a payment is recorded, reload so paid installments drop out. */
  function refreshPayments() {
    api<{ reminders: PaymentReminderRow[] }>("GET", "/api/payment-reminders?days=3")
      .then((res) => setPayReminders(res.reminders))
      .catch(() => setPayReminders([]));
  }

  function markContacted(key: string) {
    setContacted((s) => new Set(s).add(key));
  }

  const unscheduled = data?.unscheduled_treatment ?? [];
  const dormant = data?.dormant_patients ?? [];
  const payments = payReminders ?? [];

  async function markPlanReminded(planId: number, key: string) {
    setContacted((s) => new Set(s).add(key));
    try {
      await api("POST", `/api/payment-plans/${planId}/reminded`);
    } catch {
      /* re-syncs on reload */
    }
  }

  return (
    <div className="space-y-2 pt-1">
      <div className="flex gap-1">
        <Pill active={list === "unscheduled"} onClick={() => setList("unscheduled")}>
          Treatment ({unscheduled.length})
        </Pill>
        <Pill active={list === "dormant"} onClick={() => setList("dormant")}>
          Dormant ({dormant.length})
        </Pill>
        <Pill active={list === "payments"} onClick={() => setList("payments")}>
          Payments ({payReminders === null ? "…" : payments.length})
        </Pill>
      </div>

      {!data ? (
        <p className="py-2 text-xs text-muted-foreground">Loading…</p>
      ) : list === "payments" ? (
        payReminders === null ? (
          <p className="py-2 text-xs text-muted-foreground">Loading…</p>
        ) : payments.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">No installments are due in the next 3 days — collections are up to date.</p>
        ) : (
          payments.map((r) => {
            const key = `p-${r.plan_id}-${r.installment_n}`;
            const digits = (r.phone ?? "").replace(/[^\d]/g, "");
            const dueLabel = r.overdue
              ? `${Math.abs(r.days_until_due)}d overdue`
              : r.days_until_due === 0
                ? "due today"
                : `due in ${r.days_until_due}d`;
            const msg = `Hello ${r.patient_name.split(" ")[0]}! A friendly reminder that installment ${r.installment_n} of your payment plan (${formatMoney(r.amount)}) was due ${formatDate(r.due_date)}. You can pay at the clinic or reply here to arrange it. Thank you!`;
            return (
              <div key={key} className={cn(
                "rounded-md border p-2 text-xs",
                contacted.has(key) ? "border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40"
                  : r.overdue ? "border-rose-300/60 bg-rose-50/60 dark:border-rose-900 dark:bg-rose-950/30"
                  : "bg-muted/30",
              )}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-semibold">{r.patient_name}</span>
                  <span className={cn("shrink-0 tabular-nums", r.overdue && "font-medium text-rose-600 dark:text-rose-400")}>
                    {dueLabel}
                  </span>
                </div>
                <div className="mt-0.5 text-muted-foreground">
                  Installment {r.installment_n} · {formatMoney(r.amount)} · invoice #{r.invoice_id} balance {formatMoney(r.balance)}
                </div>
                <div className="mt-1.5 flex gap-1">
                  {digits && (
                    <a
                      href={`https://wa.me/${digits}?text=${encodeURIComponent(msg)}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => void markPlanReminded(r.plan_id, key)}
                      className="inline-flex h-6 flex-1 items-center justify-center gap-1 rounded border bg-background text-[10px] font-medium hover:bg-accent"
                    >
                      <MessageCircle className="h-3 w-3" /> WhatsApp
                    </a>
                  )}
                  {r.phone && (
                    <a href={`tel:${r.phone}`} className="inline-flex h-6 w-8 items-center justify-center rounded border bg-background hover:bg-accent" title={`Call ${r.phone}`}>
                      <Phone className="h-3 w-3" />
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => setRecording(r)}
                    className="inline-flex h-6 w-8 items-center justify-center rounded border bg-background hover:bg-accent"
                    title="Record this installment as a payment"
                  >
                    <Banknote className={cn("h-3 w-3", contacted.has(key) ? "text-emerald-600" : "")} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void markPlanReminded(r.plan_id, key)}
                    className="inline-flex h-6 w-8 items-center justify-center rounded border bg-background hover:bg-accent"
                    title="Mark as reminded"
                  >
                    <CheckCheck className={cn("h-3 w-3", contacted.has(key) && "text-emerald-600")} />
                  </button>
                </div>
              </div>
            );
          })
        )
      ) : list === "unscheduled" ? (
        unscheduled.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">
            No accepted treatment waiting to be booked — everyone's scheduled.
          </p>
        ) : (
          unscheduled.map((r) => {
            const key = `u-${r.item_id}`;
            const name = [r.first_name, r.last_name].filter(Boolean).join(" ") || "Patient";
            const digits = (r.phone ?? "").replace(/[^\d]/g, "");
            const msg = `Hello ${r.first_name ?? ""}! You have ${r.treatment_name ?? "treatment"} on your treatment plan${r.tooth ? ` (tooth ${r.tooth})` : ""} that hasn't been booked yet. When would you like to come in? Reply here and we'll find a time that suits you.`;
            return (
              <div key={key} className={cn("rounded-md border p-2 text-xs", contacted.has(key) ? "border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40" : "bg-muted/30")}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-semibold">{name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {r.treatment_name ?? "Treatment"}{r.tooth ? ` · #${r.tooth}` : ""}
                  </span>
                </div>
                <div className="mt-0.5 text-muted-foreground">
                  Planned {formatDate(r.created_at)} · est. {formatMoney(r.fee)}
                </div>
                <div className="mt-1.5 flex gap-1">
                  {digits && (
                    <a
                      href={`https://wa.me/${digits}?text=${encodeURIComponent(msg)}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => markContacted(key)}
                      className="inline-flex h-6 flex-1 items-center justify-center gap-1 rounded border bg-background text-[10px] font-medium hover:bg-accent"
                    >
                      <MessageCircle className="h-3 w-3" /> WhatsApp
                    </a>
                  )}
                  {r.phone && (
                    <a href={`tel:${r.phone}`} className="inline-flex h-6 w-8 items-center justify-center rounded border bg-background hover:bg-accent" title={`Call ${r.phone}`}>
                      <Phone className="h-3 w-3" />
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => markContacted(key)}
                    className="inline-flex h-6 w-8 items-center justify-center rounded border bg-background hover:bg-accent"
                    title="Mark as contacted"
                  >
                    <CheckCheck className={cn("h-3 w-3", contacted.has(key) && "text-emerald-600")} />
                  </button>
                </div>
              </div>
            );
          })
        )
      ) : dormant.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">No dormant patients — the whole roster is active.</p>
      ) : (
        dormant.map((p) => {
          const key = `d-${p.id}`;
          const name = [p.first_name, p.last_name].filter(Boolean).join(" ") || "Patient";
          const digits = (p.phone ?? "").replace(/[^\d]/g, "");
          const monthsAgo = p.last_visit
            ? Math.max(1, Math.round((Date.now() - new Date(p.last_visit).getTime()) / (30 * 86_400_000)))
            : null;
          const msg = `Hello ${p.first_name ?? ""}! It's been a while since your last visit to ${ctx.profile.clinic_name || "our clinic"}${monthsAgo ? ` (${monthsAgo} month${monthsAgo === 1 ? "" : "s"} ago)` : ""}. Regular check-ups keep small issues small — would you like to book one? Reply here and we'll set it up.`;
          return (
            <div key={key} className={cn("rounded-md border p-2 text-xs", contacted.has(key) ? "border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40" : "bg-muted/30")}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-semibold">{name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {p.last_visit ? `last visit ${formatDate(p.last_visit)}` : "never visited"}
                </span>
              </div>
              <div className="mt-1.5 flex gap-1">
                {digits && (
                  <a
                    href={`https://wa.me/${digits}?text=${encodeURIComponent(msg)}`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => markContacted(key)}
                    className="inline-flex h-6 flex-1 items-center justify-center gap-1 rounded border bg-background text-[10px] font-medium hover:bg-accent"
                  >
                    <MessageCircle className="h-3 w-3" /> WhatsApp
                  </a>
                )}
                {p.phone && (
                  <a href={`tel:${p.phone}`} className="inline-flex h-6 w-8 items-center justify-center rounded border bg-background hover:bg-accent" title={`Call ${p.phone}`}>
                    <Phone className="h-3 w-3" />
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => markContacted(key)}
                  className="inline-flex h-6 w-8 items-center justify-center rounded border bg-background hover:bg-accent"
                  title="Mark as contacted"
                >
                  <CheckCheck className={cn("h-3 w-3", contacted.has(key) && "text-emerald-600")} />
                </button>
              </div>
            </div>
          );
        })
      )}

      {/* Record-payment dialog for an installment row. The invoice is fetched
          on open so the shared PaymentDialog gets real totals; the amount is
          pre-seeded with the installment amount. */}
      {recording && <InstallmentPayDialog reminder={recording} onClose={() => setRecording(null)} onPaid={refreshPayments} />}
    </div>
  );
}

/**
 * Fetches the reminder's invoice and opens the shared payment dialog with the
 * installment amount pre-filled. Saving reloads the worklist so paid
 * installments drop out immediately.
 */
function InstallmentPayDialog({
  reminder,
  onClose,
  onPaid,
}: {
  reminder: PaymentReminderRow;
  onClose: () => void;
  onPaid: () => void;
}) {
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ invoice: Invoice }>("GET", `/api/invoices/${reminder.invoice_id}`)
      .then((res) => {
        if (!cancelled) setInvoice(res.invoice);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load this invoice.");
      });
    return () => {
      cancelled = true;
    };
  }, [reminder.invoice_id]);

  if (error) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Payment — invoice #{reminder.invoice_id}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{error}</p>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  if (!invoice) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-sm">
          <div className="py-8 text-center text-sm text-muted-foreground">Loading invoice…</div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <PaymentDialog
      invoice={invoice}
      prefillAmount={Math.min(reminder.amount, reminder.balance)}
      onClose={onClose}
      onSaved={() => {
        onPaid();
        onClose();
      }}
    />
  );
}

// ── Reminders (upcoming appointments outreach) ───────────────────

/**
 * Work list of scheduled appointments in the next 2 days with one-click
 * WhatsApp reminder, phone call, or message copy. Mirrors how reminder
 * tools (NexHealth, DoctorConnect) work: the practice reaches out, the
 * patient confirms — no patient-facing portal needed.
 */
function RemindersPanel() {
  const ctx = useApp();
  const [rows, setRows] = useState<ReminderRow[] | null>(null);
  const [days, setDays] = useState(2);
  const [copied, setCopied] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ reminders: ReminderRow[] }>("GET", `/api/appointments/reminders?days=${days}`)
      .then((res) => {
        if (!cancelled) setRows(res.reminders);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  function reminderMessage(r: ReminderRow): string {
    const d = new Date(r.start_time);
    const clinic = ctx.profile.clinic_name || "our clinic";
    return `Hello ${r.first_name ?? ""}! This is a reminder of your appointment at ${clinic} on ${d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })} at ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${r.treatment_name ? ` for ${r.treatment_name}` : ""}. Reply to confirm or call us to reschedule. See you soon!`;
  }

  async function confirmAppointment(id: number) {
    try {
      await ctx.updateAppointment(id, { status: "confirmed" });
    } catch {
      /* status re-syncs on reload */
    }
  }

  async function copyMessage(r: ReminderRow) {
    try {
      await navigator.clipboard.writeText(reminderMessage(r));
      setCopied(r.id);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked — the WhatsApp button still works */
    }
  }

  return (
    <div className="space-y-2 pt-1">
      <div className="flex items-center justify-between">
        <Select value={days.toString()} onValueChange={(v) => setDays(parseInt(v, 10))}>
          <SelectTrigger className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Next 1 day</SelectItem>
            <SelectItem value="2">Next 2 days</SelectItem>
            <SelectItem value="3">Next 3 days</SelectItem>
            <SelectItem value="7">Next 7 days</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-[10px] text-muted-foreground">
          {rows === null ? "" : `${rows.length} upcoming`}
        </span>
      </div>

      {rows === null ? (
        <p className="py-2 text-xs text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">No scheduled appointments in this window — everyone's reminded.</p>
      ) : (
        rows.map((r) => {
          const d = new Date(r.start_time);
          const name = [r.first_name, r.last_name].filter(Boolean).join(" ") || "Unnamed";
          const isSent = r.status === "confirmed";
          const digits = (r.phone ?? "").replace(/[^\d]/g, "");
          return (
            <div
              key={r.id}
              className={cn(
                "rounded-md border p-2 text-xs transition-colors",
                isSent ? "border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40" : "bg-muted/30",
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-semibold">{name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              {r.treatment_name && <div className="truncate text-muted-foreground">{r.treatment_name}</div>}
              <div className="mt-1.5 flex gap-1">
                {digits ? (
                  <a
                    href={`https://wa.me/${digits}?text=${encodeURIComponent(reminderMessage(r))}`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => void confirmAppointment(r.id)}
                    className="inline-flex h-6 flex-1 items-center justify-center gap-1 rounded border bg-background text-[10px] font-medium hover:bg-accent"
                    title="Send a WhatsApp reminder"
                  >
                    <MessageCircle className="h-3 w-3" /> WhatsApp
                  </a>
                ) : (
                  <span className="inline-flex h-6 flex-1 items-center justify-center rounded border bg-muted text-[10px] text-muted-foreground" title="No phone on file">
                    no phone
                  </span>
                )}
                {r.phone && (
                  <a
                    href={`tel:${r.phone}`}
                    className="inline-flex h-6 w-8 items-center justify-center rounded border bg-background hover:bg-accent"
                    title={`Call ${r.phone}`}
                  >
                    <Phone className="h-3 w-3" />
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => copyMessage(r)}
                  className="inline-flex h-6 w-8 items-center justify-center rounded border bg-background hover:bg-accent"
                  title="Copy reminder message"
                >
                  {copied === r.id ? <CheckCheck className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                </button>
                <button
                  type="button"
                  onClick={() => void confirmAppointment(r.id)}
                  className="inline-flex h-6 flex-1 items-center justify-center gap-1 rounded border bg-background text-[10px] font-medium hover:bg-accent"
                  title="Mark as confirmed by the patient"
                >
                  {isSent ? (
                    <>
                      <CheckCheck className="h-3 w-3 text-emerald-600" /> Confirmed
                    </>
                  ) : (
                    "Confirm"
                  )}
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Review requests: ask recent patients for a Google review ──────

interface ReviewSettings {
  review_url?: string;
}

function ReviewRequestsPanel() {
  const ctx = useApp();
  const [rows, setRows] = useState<ReviewRequestRow[] | null>(null);
  const [days, setDays] = useState(7);
  const [asked, setAsked] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState<number | null>(null);
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<{ requests: ReviewRequestRow[] }>("GET", `/api/review-requests?days=${days}`),
      api<{ settings: ReviewSettings }>("GET", "/api/settings").catch((): { settings: ReviewSettings } => ({ settings: {} })),
    ])
      .then(([rq, st]) => {
        if (cancelled) return;
        setRows(rq.requests);
        const url = st.settings.review_url;
        setReviewUrl(typeof url === "string" && url.trim() ? url.trim() : null);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  function askMessage(r: ReviewRequestRow): string {
    const clinic = ctx.profile.clinic_name || "our clinic";
    const visit = new Date(r.end_time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const base = `Hello ${r.first_name ?? ""}! Thank you for visiting ${clinic} on ${visit}${r.treatment_name ? ` for your ${r.treatment_name}` : ""}. We'd love to hear about your experience — a quick review helps other patients find us.`;
    return reviewUrl ? `${base}\n${reviewUrl}` : base;
  }

  async function markAsked(id: number) {
    setAsked((s) => new Set(s).add(id));
    try {
      await api("POST", `/api/appointments/${id}/review-requested`);
    } catch {
      /* the optimistic stamp stays; it re-syncs on reload */
    }
  }

  async function copyMessage(r: ReviewRequestRow) {
    try {
      await navigator.clipboard.writeText(askMessage(r));
      setCopied(r.id);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked — WhatsApp button still works */
    }
  }

  return (
    <div className="space-y-2 pt-1">
      <div className="flex items-center justify-between">
        <Select value={days.toString()} onValueChange={(v) => setDays(parseInt(v, 10))}>
          <SelectTrigger className="h-7 w-36 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Last 1 day</SelectItem>
            <SelectItem value="3">Last 3 days</SelectItem>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="14">Last 14 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-[10px] text-muted-foreground">
          {rows === null ? "" : `${rows.length} visit${rows.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {!reviewUrl && (
        <p className="rounded border border-amber-300/50 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Tip: set your Google review link in Settings → Profile ("Google review URL") to include a direct link in every message.
        </p>
      )}

      {rows === null ? (
        <p className="py-2 text-xs text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">No recently completed visits awaiting a review request.</p>
      ) : (
        rows.map((r) => {
          const name = [r.first_name, r.last_name].filter(Boolean).join(" ") || "Unnamed";
          const isAsked = asked.has(r.id);
          const digits = (r.phone ?? "").replace(/[^\d]/g, "");
          return (
            <div
              key={r.id}
              className={cn(
                "rounded-md border p-2 text-xs transition-colors",
                isAsked ? "border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40" : "bg-muted/30",
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-semibold">{name}</span>
                <span className="shrink-0 text-muted-foreground">
                  visited {new Date(r.end_time).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              </div>
              {r.treatment_name && <div className="truncate text-muted-foreground">{r.treatment_name}</div>}
              <div className="mt-1.5 flex gap-1">
                {digits ? (
                  <a
                    href={`https://wa.me/${digits}?text=${encodeURIComponent(askMessage(r))}`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => void markAsked(r.id)}
                    className="inline-flex h-6 flex-1 items-center justify-center gap-1 rounded border bg-background text-[10px] font-medium hover:bg-accent"
                    title="Send a WhatsApp review request"
                  >
                    <MessageCircle className="h-3 w-3" /> WhatsApp
                  </a>
                ) : (
                  <span className="inline-flex h-6 flex-1 items-center justify-center rounded border bg-background text-[10px] text-muted-foreground">
                    No phone
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void copyMessage(r)}
                  className="inline-flex h-6 w-7 items-center justify-center rounded border bg-background hover:bg-accent"
                  title="Copy the message"
                >
                  {copied === r.id ? <CheckCheck className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                </button>
                {digits ? (
                  <a
                    href={`tel:${r.phone}`}
                    className="inline-flex h-6 w-7 items-center justify-center rounded border bg-background hover:bg-accent"
                    title="Call"
                  >
                    <Phone className="h-3 w-3" />
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={() => void markAsked(r.id)}
                    className="inline-flex h-6 w-7 items-center justify-center rounded border bg-background hover:bg-accent"
                    title="Mark as asked"
                  >
                    <CheckCheck className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Hygiene recall: patients due for their continuing-care visit ──

interface RecallDueRow {
  id: number;
  patient_id: number;
  name: string;
  phone: string | null;
  email: string | null;
  recall_type: string | null;
  interval_months: number;
  due_date: string;
  days_overdue: number;
}

function RecallPanel() {
  const { profile } = useApp();
  const [rows, setRows] = useState<RecallDueRow[] | null>(null);
  const [confirmed, setConfirmed] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    api<{ recalls: RecallDueRow[] }>("GET", "/api/recalls/due")
      .then((res) => {
        if (!cancelled) setRows(res.recalls);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function recallMessage(r: RecallDueRow): string {
    const clinic = profile.clinic_name || "our clinic";
    return `Hello ${r.name.split(" ")[0]}! You're due for your ${r.recall_type ?? "check-up and clean"} at ${clinic} (due ${new Date(`${r.due_date}T00:00:00`).toLocaleDateString(undefined, { month: "long" })}). Reply to book a time that suits you.`;
  }

  async function confirmRecall(id: number) {
    setConfirmed((s) => new Set(s).add(id));
    try {
      await api("POST", `/api/recalls/${id}/confirm`);
    } catch {
      /* re-syncs on reload */
    }
  }

  if (rows === null) return <p className="py-2 text-xs text-muted-foreground">Loading…</p>;
  if (!rows.length) {
    return (
      <p className="py-2 text-xs text-muted-foreground">
        No patients are due for recall in the next 30 days. Completing a recall visit automatically schedules the next cycle.
      </p>
    );
  }

  return (
    <div className="space-y-2 pt-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Due within 30 days</span>
        <span className="text-[10px] text-muted-foreground">{rows.length} patient{rows.length === 1 ? "" : "s"}</span>
      </div>
      {rows.map((r) => {
        const isConfirmed = confirmed.has(r.id);
        const digits = (r.phone ?? "").replace(/[^\d]/g, "");
        const overdue = r.days_overdue > 30;
        return (
          <div
            key={r.id}
            className={cn(
              "rounded-md border p-2 text-xs transition-colors",
              isConfirmed
                ? "border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40"
                : overdue
                  ? "border-rose-300/60 bg-rose-50/60 dark:border-rose-900 dark:bg-rose-950/30"
                  : "bg-muted/30",
            )}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-semibold">{r.name}</span>
              <span className={cn("shrink-0 tabular-nums", overdue && "font-medium text-rose-600 dark:text-rose-400")}>
                {overdue ? `${r.days_overdue}d overdue` : `due ${new Date(`${r.due_date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
              </span>
            </div>
            <div className="text-muted-foreground">
              {r.recall_type ?? "Check-up"} · {r.interval_months}-month cycle
            </div>
            <div className="mt-1.5 flex gap-1">
              {digits ? (
                <a
                  href={`https://wa.me/${digits}?text=${encodeURIComponent(recallMessage(r))}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-6 flex-1 items-center justify-center gap-1 rounded border bg-background text-[10px] font-medium hover:bg-accent"
                  title="Send a WhatsApp recall message"
                >
                  <MessageCircle className="h-3 w-3" /> WhatsApp
                </a>
              ) : (
                <span className="inline-flex h-6 flex-1 items-center justify-center rounded border bg-muted text-[10px] text-muted-foreground" title="No phone on file">
                  no phone
                </span>
              )}
              {r.phone && (
                <a
                  href={`tel:${r.phone}`}
                  className="inline-flex h-6 w-8 items-center justify-center rounded border bg-background hover:bg-accent"
                  title={`Call ${r.phone}`}
                >
                  <Phone className="h-3 w-3" />
                </a>
              )}
              <button
                type="button"
                onClick={() => void confirmRecall(r.id)}
                className="inline-flex h-6 flex-1 items-center justify-center gap-1 rounded border bg-background text-[10px] font-medium hover:bg-accent"
                title="Patient agreed to rebook — book them through the agenda"
              >
                {isConfirmed ? (
                  <>
                    <BadgeCheck className="h-3 w-3 text-emerald-600" /> Confirmed
                  </>
                ) : (
                  "Confirm"
                )}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

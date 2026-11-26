import { useCallback, useEffect, useState } from "react";
import { Copy, Eye, FileText, Link, Plus, Printer, Trash2 } from "lucide-react";
import { api } from "@/api";
import { useApp } from "@/context";
import { toast } from "@/components/ui/toast";
import type {
  Patient,
  PatientImage,
  Prescription,
  PrescriptionItem,
  PrescriptionTemplateId,
  TreatmentPlanItem,
} from "@/types";
import type {
  ComplaintChip,
  Investigation,
  RxComplaints,
  RxInvestigations,
  RxVitals,
  DoseSchedule,
  MealRelation,
} from "@/types";
import {
  DOSE_SCHEDULE_LABELS,
  MEAL_RELATION_LABELS,
} from "@/types";
import { formatDate } from "@/lib/utils";
import { PrescriptionPreviewModal } from "./prescription-preview-modal";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TemplatePickerGrid } from "./template-picker";
import type { PrescriptionSheetData } from "./prescription-sheet";
import { DrugAutocomplete } from "./drug-autocomplete";
import { RxTemplateMenu } from "./rx-template-menu";
import { SaveRxTemplateButton } from "./save-rx-template-dialog";
import type { DrugPreset } from "@/lib/dental-drugs";
import { useTemplateChoices } from "@/lib/prescription-layouts";
import type { RxClinicalTemplate, RxTemplateSource } from "@/types";

/**
 * Prescriptions tab on the patient record: lists issued prescriptions and
 * provides the create/edit dialog. Printing, sharing and template switching
 * live in PrescriptionPrintView, opened from a row's Print action.
 */
export function PrescriptionsTab({
  patientId,
  navigate,
}: {
  patientId: number;
  navigate: (to: string) => void;
}) {
  const app = useApp();
  const [list, setList] = useState<Prescription[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Prescription | null>(null);
  const [creating, setCreating] = useState(false);
  const [duplicating, setDuplicating] = useState<Prescription | null>(null);
  // Patient display name for the preview sheet's patient block.
  const [patientName, setPatientName] = useState("");

  useEffect(() => {
    let cancelled = false;
    api<{ patient: Patient }>("GET", `/api/patients/${patientId}`)
      .then((res) => {
        if (!cancelled) {
          setPatientName(`${res.patient.first_name ?? ""} ${res.patient.last_name ?? ""}`.trim());
        }
      })
      .catch(() => {
        /* preview falls back to "Patient" — not worth an error banner */
      });
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  const reload = useCallback(async () => {
    try {
      const res = await api<{ prescriptions: Prescription[] }>("GET", `/api/patients/${patientId}/prescriptions`);
      setList(res.prescriptions);
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function remove(id: number) {
    if (!confirm("Delete this prescription? This cannot be undone.")) return;
    try {
      await api("DELETE", `/api/prescriptions/${id}`);
      setList((prev) => prev.filter((p) => p.id !== id));
      toast.success("Prescription deleted");
    } catch (err) {
      toast.error((err as Error).message);
      app.setError((err as Error).message);
    }
  }

  /** Fetch the full prescription (with items) and open the editor pre-filled as a new one. */
  async function duplicate(rx: Prescription) {
    try {
      const res = await api<{ prescription: Prescription }>("GET", `/api/prescriptions/${rx.id}`);
      setDuplicating(res.prescription);
    } catch (err) {
      app.setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Prescriptions issued to this patient. Print on A4 or share a secure link.
        </p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New prescription
        </Button>
      </div>

      {loading ? (
        <div className="rounded-md border p-8 text-center text-sm text-muted-foreground">Loading…</div>
      ) : list.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center">
          <FileText className="mx-auto h-8 w-8 text-muted-foreground/60" />
          <p className="mt-3 text-sm text-muted-foreground">No prescriptions yet.</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> Write the first one
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2 font-semibold">Date</th>
                <th className="px-3 py-2 font-semibold">Medications</th>
                <th className="px-3 py-2 font-semibold">Prescriber</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {list.map((rx) => (
                <tr key={rx.id} className="border-b last:border-0">
                  <td className="px-3 py-2 font-medium">{formatDate(rx.issued_date)}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {rx.item_count ?? 0} medication{(rx.item_count ?? 0) === 1 ? "" : "s"}
                    {rx.diagnosis ? <span className="block text-xs">dx: {rx.diagnosis}</span> : null}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{rx.practitioner_name ?? "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => navigate(`/patients/${patientId}/prescriptions/${rx.id}`)}
                      >
                        <Printer className="h-4 w-4" /> Print
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          try {
                            const res = await api<{ share_token: string; share_url: string }>(
                              "POST",
                              `/api/prescriptions/${rx.id}/share`,
                            );
                            navigate(res.share_url);
                          } catch (err) {
                            app.setError((err as Error).message);
                          }
                        }}
                        title="Share a public read-only link"
                      >
                        <Link className="h-4 w-4" /> Share
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => duplicate(rx)}
                        className="text-muted-foreground"
                        title="Duplicate"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => setEditing(rx)} title="Edit">
                        <FileText className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => remove(rx.id)}
                        className="text-muted-foreground hover:text-destructive"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PrescriptionDialog
        open={creating || editing !== null || duplicating !== null}
        onOpenChange={(o) => {
          if (!o) {
            setCreating(false);
            setEditing(null);
            setDuplicating(null);
          }
        }}
        patientId={patientId}
        patientName={patientName}
        prescription={editing}
        duplicateOf={duplicating}
        onSaved={() => {
          setCreating(false);
          setEditing(null);
          setDuplicating(null);
          reload();
        }}
        onOpenPrint={(id) => {
          setCreating(false);
          setEditing(null);
          setDuplicating(null);
          navigate(`/patients/${patientId}/prescriptions/${id}`);
        }}
      />
    </div>
  );
}

interface DraftItem {
  drug_name: string;
  dosage: string;
  frequency: string;
  duration: string;
  instructions: string;
}

const EMPTY_ITEM: DraftItem = { drug_name: "", dosage: "", frequency: "", duration: "", instructions: "" };

/**
 * The prescription editor dialog. Exported so the dashboard's consultation
 * card can mount the same editor for issuing a prescription mid-visit.
 */
/** Clinical preset chip sets used by the prescription editor. These are
 *  convenience shortcuts — the clinician confirms every value. */

const COMPLAINT_CHIPS = [
  "Fever",
  "Pain",
  "Weakness",
  "Cough",
  "Headache",
  "Toothache",
  "Loose tooth",
  "Swelling",
  "Bleeding",
  "Sensitivity",
] as const;

export type ComplaintChipLabel = (typeof COMPLAINT_CHIPS)[number];

const COMPLAINSION_DURATION_CHIPS = [
  "1 day",
  "2 days",
  "3 days",
  "7 days",
  "1 month",
] as const;

const COMPLAINT_SITES = [
  "Head",
  "Throat",
  "Chest",
  "Abdomen",
  "Back",
  "Limb",
  "Jaw",
  "Tooth #",
  "Other",
] as const;

const VITALS_BP_CHIPS = ["120/80", "140/90", "130/85", "110/70", "Normal"] as const;
const VITALS_TEMP_CHIPS = ["98.6°F", "100°F", "102°F", "Normal"] as const;
const VITALS_PULSE_CHIPS = ["60 bpm", "72 bpm", "80 bpm", "90 bpm", "100 bpm"] as const;
const VITALS_SPO2_CHIPS = ["98%", "96%", "94%", "Normal"] as const;

const INVESTIGATION_CHIPS = [
  "CBC",
  "Blood glucose (fasting)",
  "Blood glucose (random)",
  "Serum calcium",
  "25-OH Vitamin D",
  "Chest X-ray",
] as const;

export type InvestigationChipLabel = (typeof INVESTIGATION_CHIPS)[number];

const ADVICE_CHIPS = [
  "Drink plenty of water",
  "Avoid oily food",
  "Rest",
  "Warm salt-water rinse",
  "Maintain oral hygiene",
  "Return if symptoms worsen",
  "Avoid strenuous activity",
  "Take medication with food",
] as const;

export type AdviceChipLabel = (typeof ADVICE_CHIPS)[number];

const FOLLOW_UP_UNITS = [
  { label: "1 day", value: 1, unit: "days" },
  { label: "7 days", value: 7, unit: "days" },
  { label: "15 days", value: 15, unit: "days" },
  { label: "30 days", value: 30, unit: "days" },
  { label: "90 days", value: 90, unit: "days" },
  { label: "180 days", value: 180, unit: "days" },
  { label: "1 month", value: 1, unit: "months" },
  { label: "3 months", value: 3, unit: "months" },
  { label: "6 months", value: 6, unit: "months" },
  { label: "1 year", value: 1, unit: "years" },
] as const;

function addPeriodISO(baseISO: string, value: number, unit: "days" | "months" | "years"): string {
  const d = new Date(`${baseISO}T00:00:00`);
  if (isNaN(d.getTime())) return baseISO;
  if (unit === "days") d.setUTCDate(d.getUTCDate() + value);
  else if (unit === "months") d.setUTCMonth(d.getUTCMonth() + value);
  else d.setUTCFullYear(d.getUTCFullYear() + value);
  return d.toISOString().slice(0, 10);
}

export function PrescriptionDialog({
  open,
  onOpenChange,
  patientId,
  patientName,
  prescription,
  duplicateOf,
  onSaved,
  onOpenPrint,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  patientId: number;
  /** Display name for the preview sheet's patient block. */
  patientName: string;
  prescription: Prescription | null;
  /** Source prescription when duplicating — prefills everything but stays a new record. */
  duplicateOf: Prescription | null;
  onSaved: () => void;
  onOpenPrint: (id: number) => void;
}) {
  const app = useApp();
  const isEdit = prescription !== null;
  const [issuedDate, setIssuedDate] = useState("");
  const [template, setTemplate] = useState<PrescriptionTemplateId>("chamber");
  // Built-in gallery + the practice's own templates (Settings → Rx templates).
  const templateChoices = useTemplateChoices();
  const [largePrint, setLargePrint] = useState(false);
  const [tooth, setTooth] = useState("");
  const [planItemId, setPlanItemId] = useState<string>("none");
  /** The patient's treatment-plan items, loaded once for the plan picker. */
  const [planItems, setPlanItems] = useState<TreatmentPlanItem[]>([]);
  const [practitionerId, setPractitionerId] = useState<string>("none");
  const [diagnosis, setDiagnosis] = useState("");
  const [onExamination, setOnExamination] = useState("");
  const [history, setHistory] = useState("");
  const [advice, setAdvice] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [items, setItems] = useState<DraftItem[]>([{ ...EMPTY_ITEM }]);
  const [saving, setSaving] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // Images attachable to the sheet (X-ray/intraoral/panoramic on file) and the
  // ids currently selected to print on it.
  const [attachOptions, setAttachOptions] = useState<PatientImage[]>([]);
  const [imageIds, setImageIds] = useState<number[]>([]);

  // Load the plan items for the picker (only while the dialog is open).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api<{ items: TreatmentPlanItem[] }>("GET", `/api/patients/${patientId}/treatment-plan`)
      .then((res) => {
        if (!cancelled) setPlanItems(res.items);
      })
      .catch(() => {
        /* picker just stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, [open, patientId]);

  useEffect(() => {
    if (!open) return;
    const source = prescription ?? duplicateOf;
    setIssuedDate(prescription?.issued_date ?? new Date().toISOString().slice(0, 10));
    setTemplate(source?.template ?? "chamber");
    setLargePrint(Boolean(source?.large_print));
    setTooth(source?.tooth ?? "");
    setPlanItemId(source?.plan_item_id ? String(source.plan_item_id) : "none");
    setPractitionerId(source?.practitioner_id ? String(source.practitioner_id) : "none");
    setDiagnosis(source?.diagnosis ?? "");
    setOnExamination(source?.on_examination ?? "");
    setHistory(source?.history ?? "");
    setAdvice(source?.advice ?? "");
    setFollowUp(source?.follow_up ?? "");
    const existing = source?.items ?? [];
    setItems(
      existing.length > 0
        ? existing.map((i: PrescriptionItem) => ({
            drug_name: i.drug_name,
            dosage: i.dosage ?? "",
            frequency: i.frequency ?? "",
            duration: i.duration ?? "",
            instructions: i.instructions ?? "",
          }))
        : [{ ...EMPTY_ITEM }],
    );
    // Attached images. The list row only carries image_ids (as JSON text), so
    // in edit mode fetch the full record for the renderable thumbnails.
    if (prescription && !(source?.images?.length)) {
      let cancelled = false;
      api<{ prescription: Prescription }>("GET", `/api/prescriptions/${prescription.id}`)
        .then((res) => {
          if (cancelled) return;
          setAttachOptions(res.prescription.images ?? []);
          setImageIds(res.prescription.image_ids ?? []);
        })
        .catch((err) => app.setError((err as Error).message));
      return () => {
        cancelled = true;
      };
    }
    setAttachOptions(source?.images ?? []);
    setImageIds(source?.image_ids ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prescription, duplicateOf, patientId]);

  /** Auto-fill tooth + X-ray from the record when creating a fresh prescription. */
  useEffect(() => {
    if (!open || prescription || duplicateOf) return;
    let cancelled = false;
    api<{ tooth: string | null; images: PatientImage[]; storage: { enabled: boolean } }>(
      "GET",
      `/api/patients/${patientId}/prescription-context`,
    )
      .then((ctx) => {
        if (cancelled) return;
        if (ctx.tooth) setTooth((t) => t || ctx.tooth!);
        const opts = ctx.images ?? [];
        setAttachOptions(opts);
        // Auto-attach the most recent X-ray so the sheet reflects today's film.
        const latest = opts.find((i) => i.url);
        if (latest) setImageIds([latest.id]);
      })
      .catch(() => {
        /* context is best-effort — the sheet works without it */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, patientId, prescription, duplicateOf]);

  function setItem(index: number, patch: Partial<DraftItem>) {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  }

  /**
   * Choosing a plan procedure autofills the tooth and, when the diagnosis is
   * empty, suggests the procedure name — one pick instead of four typed fields.
   * Editing fields afterwards is always allowed.
   */
  function pickPlanItem(value: string) {
    setPlanItemId(value);
    if (value === "none") return;
    const item = planItems.find((p) => String(p.id) === value);
    if (!item) return;
    if (item.tooth) setTooth(item.tooth);
    setDiagnosis((d) => d.trim() || item.treatment_name || d);
  }

  function addRow() {
    setItems((prev) => [...prev, { ...EMPTY_ITEM }]);
  }

  /** Committing a preset fills dosage/frequency/duration/instructions for that row. */
  function applyPreset(index: number, preset: DrugPreset) {
    setItem(index, {
      dosage: preset.dosage,
      frequency: preset.frequency,
      duration: preset.duration,
      instructions: preset.instructions,
    });
  }

  function removeRow(index: number) {
    setItems((prev) => (prev.length === 1 ? [{ ...EMPTY_ITEM }] : prev.filter((_, i) => i !== index)));
  }

  /** The clinical content of the draft, for saving it as a reusable template. */
  function templateSource(): RxTemplateSource {
    return {
      diagnosis,
      on_examination: onExamination,
      history,
      advice,
      items: items.filter((i) => i.drug_name.trim()),
    };
  }

  /**
   * One click from a saved template to a filled draft. Existing medications are
   * replaced only after an explicit confirmation, so a template can never
   * silently wipe a prescription that was already half written.
   */
  function applyRxTemplate(t: RxClinicalTemplate) {
    const current = items.filter((i) => i.drug_name.trim()).length;
    if (
      current > 0 &&
      !window.confirm(
        `Replace the ${current} medication${current === 1 ? "" : "s"} in this prescription with “${t.name}”? Advice and clinical notes are filled in too.`,
      )
    ) {
      return;
    }
    const next = t.items.filter((i) => i.drug_name.trim());
    setItems(
      next.length > 0
        ? next.map((i) => ({
            drug_name: i.drug_name,
            dosage: i.dosage ?? "",
            frequency: i.frequency ?? "",
            duration: i.duration ?? "",
            instructions: i.instructions ?? "",
          }))
        : [{ ...EMPTY_ITEM }],
    );
    if (t.advice) setAdvice(t.advice);
    if (t.diagnosis) setDiagnosis(t.diagnosis);
    if (t.on_examination) setOnExamination(t.on_examination);
    if (t.history) setHistory(t.history);
    toast.success(`Applied “${t.name}”`);
  }

  /** The sheet as it would print right now, from the unsaved draft. */
  function draftSheetData(): PrescriptionSheetData | null {
    const valid = items.filter((i) => i.drug_name.trim());
    if (valid.length === 0) {
      app.setError("Add at least one medication to preview.");
      return null;
    }
    const prescriber = app.practitioners.find((p) => String(p.id) === practitionerId);
    return {
      clinic_name: app.profile.clinic_name || null,
      clinic_address: app.profile.clinic_address || null,
      clinic_phone: app.profile.doctor_phone || null,
      clinic_logo: app.profile.clinic_logo || null,
      chamber_footer_instructions: app.profile.chamber_footer_instructions?.trim() || null,
      doctor_name: app.profile.doctor_name || "Doctor",
      doctor_specialty: app.profile.doctor_specialty || null,
      doctor_license: app.profile.doctor_license || null,
      patient_name: patientName || "Patient",
      practitioner_name: prescriber?.name ?? null,
      issued_date: issuedDate,
      template,
      // Custom ids render from their saved skin; built-ins carry none.
      template_config: templateChoices.find((c) => c.id === template)?.config ?? null,
      large_print: largePrint,
      tooth: tooth.trim() || null,
      plan_treatment_name: planItems.find((p) => String(p.id) === planItemId)?.treatment_name ?? null,
      images: attachOptions
        .filter((o) => imageIds.includes(o.id))
        .map((o) => ({ id: o.id, label: o.label, src: o.url })),
      diagnosis: diagnosis.trim() || null,
      on_examination: onExamination.trim() || null,
      history: history.trim() || null,
      advice: advice.trim() || null,
      follow_up: followUp.trim() || null,
      items: valid.map((i) => ({
        drug_name: i.drug_name.trim(),
        dosage: i.dosage.trim() || null,
        frequency: i.frequency.trim() || null,
        duration: i.duration.trim() || null,
        instructions: i.instructions.trim() || null,
      })),
    };
  }

  function openPreview() {
    if (draftSheetData()) setPreviewOpen(true);
  }

  async function save(e: React.FormEvent, thenPrint: boolean) {
    e.preventDefault();
    const valid = items.filter((i) => i.drug_name.trim());
    if (valid.length === 0) {
      app.setError("Add at least one medication with a drug name.");
      return;
    }
    setSaving(true);
    try {
      const body = {
        patient_id: patientId,
        practitioner_id: practitionerId === "none" ? null : Number(practitionerId),
        issued_date: issuedDate || null,
        template,
        large_print: largePrint,
        tooth: tooth.trim() || null,
        plan_item_id: planItemId === "none" ? null : Number(planItemId),
        diagnosis: diagnosis.trim() || null,
        on_examination: onExamination.trim() || null,
        history: history.trim() || null,
        advice: advice.trim() || null,
        follow_up: followUp.trim() || null,
        image_ids: imageIds,
        items: valid.map((i) => ({
          drug_name: i.drug_name.trim(),
          dosage: i.dosage.trim() || null,
          frequency: i.frequency.trim() || null,
          duration: i.duration.trim() || null,
          instructions: i.instructions.trim() || null,
        })),
      };
      // Duplicate mode passes prescription=null, so this naturally creates a new record.
      const res =
        isEdit && !duplicateOf
          ? await api<{ prescription: Prescription }>("PUT", `/api/prescriptions/${prescription!.id}`, body)
          : await api<{ prescription: Prescription }>("POST", "/api/prescriptions", body);
      toast.success(
        isEdit && !duplicateOf
          ? "Prescription updated"
          : `Prescription issued with ${valid.length} medication${valid.length === 1 ? "" : "s"}`,
      );
      onSaved();
      if (thenPrint) onOpenPrint(res.prescription.id);
    } catch (err) {
      toast.error((err as Error).message);
      app.setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit prescription" : "New prescription"}</DialogTitle>
          {duplicateOf !== null ? (
            <DialogDescription>
              Duplicating the prescription from{" "}
              {duplicateOf.issued_date ? formatDate(duplicateOf.issued_date) : "an earlier visit"} — medications,
              diagnosis and advice are copied; the issue date is today.
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <form onSubmit={(e) => save(e, false)} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Date</Label>
              <Input type="date" value={issuedDate} onChange={(e) => setIssuedDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Prescriber</Label>
              <Select value={practitionerId} onValueChange={setPractitionerId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— Practice default —</SelectItem>
                  {app.practitioners.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-3">
              <Label className="text-xs">Template</Label>
              <TemplatePickerGrid value={template} onChange={setTemplate} />
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-2.5 rounded-md border bg-muted/30 px-3 py-2.5">
            <input
              type="checkbox"
              checked={largePrint}
              onChange={(e) => setLargePrint(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            <span className="text-sm">
              Large print
              <span className="block text-xs text-muted-foreground">
                Enlarged medication and advice text for visually impaired patients.
              </span>
            </span>
          </label>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Linked procedure</Label>
              <Select value={planItemId} onValueChange={pickPlanItem}>
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None —</SelectItem>
                  {planItems.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.treatment_name ?? "Treatment"}
                      {p.tooth ? ` · tooth ${p.tooth}` : ""}
                      {p.treatment_code ? ` (${p.treatment_code})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Tooth</Label>
              <Input
                value={tooth}
                onChange={(e) => setTooth(e.target.value)}
                placeholder="e.g. 36"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Diagnosis (C/C)</Label>
              <Input
                value={diagnosis}
                onChange={(e) => setDiagnosis(e.target.value)}
                placeholder="e.g. Acute periapical abscess, tooth 36"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">On examination (O/E)</Label>
              <Textarea
                value={onExamination}
                onChange={(e) => setOnExamination(e.target.value)}
                rows={2}
                placeholder="e.g. Tenderness on percussion, deep caries with 36"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">History (H/O)</Label>
              <Textarea
                value={history}
                onChange={(e) => setHistory(e.target.value)}
                rows={2}
                placeholder="e.g. Pain for 3 days, worse at night; swelling since yesterday"
              />
            </div>
          </div>

          {/* Attach X-ray / intraoral images */}
          {attachOptions.length > 0 && (
            <div className="rounded-md border bg-muted/20 p-3">
              <Label className="text-xs">
                Attach images <span className="font-normal text-muted-foreground">— they print on the sheet</span>
              </Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {attachOptions.map((img) => {
                  const on = imageIds.includes(img.id);
                  return (
                    <button
                      key={img.id}
                      type="button"
                      onClick={() => {
                        setImageIds((prev) => (on ? prev.filter((i) => i !== img.id) : [...prev, img.id]));
                      }}
                      title={img.label || img.file_name || `Image #${img.id}`}
                      className={
                        on
                          ? "relative overflow-hidden rounded-md border-2 border-primary"
                          : "relative overflow-hidden rounded-md border-2 border-transparent opacity-60 hover:opacity-100"
                      }
                    >
                      {img.url ? (
                        <img src={img.url} alt={img.label || img.file_name || "X-ray"} className="h-16 w-20 object-cover" />
                      ) : (
                        <div className="flex h-16 w-20 items-center justify-center bg-muted text-[10px] text-muted-foreground">
                          {img.kind === "xray" ? "X-ray" : img.kind}
                        </div>
                      )}
                      {on && (
                        <span className="absolute inset-0 flex items-center justify-center bg-primary/20 text-xs font-bold text-white">
                          ✓
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Medication rows — bounded scroll so the list never overflows the dialog on long prescriptions. */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-xs">Medications *</Label>
              <div className="flex flex-wrap items-center gap-1.5">
                <RxTemplateMenu onApply={applyRxTemplate} className="h-8 rounded-md px-2.5 text-xs" />
                <SaveRxTemplateButton source={templateSource()} className="h-8 rounded-md px-2.5 text-xs" />
              </div>
            </div>
            {/* On phones the dialog is one column wide, so this list is long
                rather than boxed: the dialog itself scrolls and the medication
                rows stack in full width. */}
            <div className="force-scrollbar max-h-none space-y-2 overflow-y-auto rounded-xl border border-border/40 bg-muted/20 p-2 sm:max-h-[44vh]">
              {items.map((item, i) => (
                <div key={i} className="space-y-2 rounded-lg border border-border/60 bg-background p-2.5">
                  {/* Narrow screens stack the six fields, so the row needs a
                      header (which one is this?) and the remove action has to
                      live here instead of at the end of a long column. */}
                  <div className="flex items-center justify-between gap-2 sm:hidden">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      Medication {i + 1}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeRow(i)}
                      className="h-7 gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`Remove medication ${i + 1}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Remove
                    </Button>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_1.5fr_auto]">
                    {/* Each field keeps its own cell at every width; the label is
                        only rendered when stacked, because a typed value hides
                        the placeholder that used to identify the field. */}
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={`drug-${i}`} className="text-[11px] font-medium text-muted-foreground sm:hidden">
                        Drug
                      </Label>
                      <DrugAutocomplete
                        inputId={`drug-${i}`}
                        value={item.drug_name}
                        onChange={(v) => setItem(i, { drug_name: v })}
                        onPick={(preset) => applyPreset(i, preset)}
                        required
                      />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={`dosage-${i}`} className="text-[11px] font-medium text-muted-foreground sm:hidden">
                        Dose
                      </Label>
                      <Input id={`dosage-${i}`} value={item.dosage} onChange={(e) => setItem(i, { dosage: e.target.value })} placeholder="500 mg" className="h-9" />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={`frequency-${i}`} className="text-[11px] font-medium text-muted-foreground sm:hidden">
                        Frequency
                      </Label>
                      <Input id={`frequency-${i}`} value={item.frequency} onChange={(e) => setItem(i, { frequency: e.target.value })} placeholder="3x daily" className="h-9" />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={`duration-${i}`} className="text-[11px] font-medium text-muted-foreground sm:hidden">
                        Duration
                      </Label>
                      <Input id={`duration-${i}`} value={item.duration} onChange={(e) => setItem(i, { duration: e.target.value })} placeholder="5 days" className="h-9" />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={`instructions-${i}`} className="text-[11px] font-medium text-muted-foreground sm:hidden">
                        Instructions
                      </Label>
                      <Input id={`instructions-${i}`} value={item.instructions} onChange={(e) => setItem(i, { instructions: e.target.value })} placeholder="after meals" className="h-9" />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeRow(i)}
                      className="hidden h-9 w-9 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:inline-flex"
                      title="Remove"
                      aria-label={`Remove medication ${i + 1}`}
                    >
                      ✕
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <Button type="button" variant="outline" size="sm" className="rounded-full" onClick={addRow}>
              <Plus className="h-3.5 w-3.5" /> Add medication
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Advice</Label>
            <Textarea
              value={advice}
              onChange={(e) => setAdvice(e.target.value)}
              rows={2}
              placeholder="e.g. Rinse with warm salt water; return if swelling worsens."
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Follow-up</Label>
            <Input value={followUp} onChange={(e) => setFollowUp(e.target.value)} placeholder="e.g. Recheck in 2 weeks" />
          </div>

          {/* Sticky on phones: the form is several screens tall there, and
              saving should never need a scroll hunt. Sits flush in the desktop
              dialog, where the whole form is visible anyway. */}
          <DialogFooter className="sticky -bottom-6 z-10 -mx-6 -mb-6 gap-2 border-t bg-background px-6 py-3 sm:static sm:bottom-auto sm:mx-0 sm:mb-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" variant="outline" disabled={saving} onClick={openPreview}>
              <Eye className="h-4 w-4" /> Preview
            </Button>
            <Button type="submit" variant="secondary" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button type="button" disabled={saving} onClick={(e) => save(e as unknown as React.FormEvent, true)}>
              Save &amp; print
            </Button>
          </DialogFooter>
        </form>

        {previewOpen && draftSheetData() && (
          <PrescriptionPreviewModal
            open={previewOpen}
            onOpenChange={setPreviewOpen}
            data={draftSheetData()!}
            title={`Preview — ${patientName || "Patient"}`}
            onTemplateChange={setTemplate}
            onLargePrintChange={setLargePrint}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

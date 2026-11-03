import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  Cloud,
  FolderSync,
  Loader2,
  ShieldCheck,
  Sparkles,
  Stethoscope,
} from "lucide-react";
import { useApp } from "@/context";
import { useAuth } from "@/auth";
import { AccountStep } from "@/components/account/account-step";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { ProfileSettings } from "@/hooks/use-app-state";
import {
  chooseDesktopBackupFolder,
  isDesktopBackupSupported,
} from "@/offline/desktop-backup";

/**
 * First-run setup wizard (desktop only).
 *
 * A fresh offline install starts with an empty profile — no doctor name, no
 * clinic name — which the rest of the app (dashboard greeting, prescription
 * letterheads, invoices) depends on. This wizard collects the essentials in
 * three friendly steps before the app is usable, writing through the same
 * settings API that Settings → Profile uses, so everything it fills in is
 * immediately editable there later.
 *
 * It renders as a full-screen takeover with no app chrome; the shell mounts
 * the real app underneath so the first dashboard load is already warm.
 */

interface Draft {
  doctor_name: string;
  doctor_specialty: string;
  doctor_phone: string;
  doctor_email: string;
  doctor_license: string;
  clinic_name: string;
  clinic_address: string;
}

const STEPS = [
  { id: 1, title: "The doctor", icon: Stethoscope },
  { id: 2, title: "The clinic", icon: Building2 },
  // Only rendered when folder backup is supported (desktop WebView2); the
  // progress row filters it out otherwise.
  { id: 3, title: "Safety net", icon: FolderSync },
  // Optional cloud account. Hidden entirely when this build has no Supabase
  // env vars, so the app never shows a dead account screen.
  { id: 4, title: "Account", icon: Cloud },
] as const;

type StepId = 1 | 2 | 3 | 4;

export function SetupWizard({ onDone }: { onDone: () => void }) {
  const { updateProfile } = useApp();
  const auth = useAuth();
  const backupSupported = isDesktopBackupSupported();
  const withoutBackup = backupSupported ? STEPS : STEPS.filter((s) => s.id !== 3);
  const steps = auth.cloudAvailable
    ? withoutBackup
    : withoutBackup.filter((s) => s.id !== 4);
  const [step, setStep] = useState<StepId>(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Step 3 state: picking the folder writes the first backup immediately, so
  // the button doubles as the action; the result feeds a small status line.
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [backupOk, setBackupOk] = useState(false);
  const [draft, setDraft] = useState<Draft>({
    doctor_name: "",
    doctor_specialty: "Dentist",
    doctor_phone: "",
    doctor_email: "",
    doctor_license: "",
    clinic_name: "",
    clinic_address: "",
  });

  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));

  const doctorOk = draft.doctor_name.trim().length > 0;
  const clinicOk = draft.clinic_name.trim().length > 0;

  async function pickBackupFolder() {
    setBackupBusy(true);
    setError(null);
    try {
      const res = await chooseDesktopBackupFolder();
      if (res.ok) {
        setBackupOk(true);
        setBackupMsg(`Backups on — "${res.folderName}" (first backup written).`);
      } else if (res.error !== "cancelled") {
        setBackupMsg(res.error);
      }
    } finally {
      setBackupBusy(false);
    }
  }

  async function saveDraft(): Promise<void> {
    // Only send non-empty fields — skipping optional ones keeps any existing
    // defaults (e.g. specialty) intact.
    const patch: Partial<ProfileSettings> = {};
    for (const [k, v] of Object.entries(draft)) {
      if (v.trim() !== "") patch[k as keyof ProfileSettings] = v.trim();
    }
    await updateProfile(patch);
  }

  async function finish() {
    setSaving(true);
    setError(null);
    try {
      await saveDraft();
      onDone();
    } catch (err) {
      setError((err as Error).message || "Saving failed — try again.");
      setSaving(false);
    }
  }

  const stepIndex = steps.findIndex((s) => s.id === step);
  const nextStep = (steps[stepIndex + 1]?.id ?? null) as StepId | null;
  const prevStep = (steps[stepIndex - 1]?.id ?? null) as StepId | null;

  /** Save the profile before the account step so sign-up metadata has a name. */
  async function goNext() {
    setError(null);
    if (step === 2) {
      setSaving(true);
      try {
        await saveDraft();
      } catch (err) {
        setError((err as Error).message || "Saving failed — try again.");
        setSaving(false);
        return;
      }
      setSaving(false);
    }
    if (nextStep) setStep(nextStep);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm">
      {/* Bounded flex column: without max-h the card grows with its content
          and overflow-hidden clipped the footer buttons off-screen on short
          windows (same bug family as the medicine list clipping). */}
      {/* role="dialog": it is announced as a modal, and it is what tells the
          unattended updater not to restart the app — an unfinished setup is the
          worst thing to throw away. */}
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl"
      >
        {/* Header */}
        <div className="border-b bg-gradient-to-br from-primary/10 to-transparent px-8 pb-6 pt-8">
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <Sparkles className="h-4 w-4" />
            Welcome to Dental Canvas
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Let&apos;s set up your practice
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A few quick steps — everything can be changed later in Settings.
          </p>
          {/* Progress dots */}
          <div className="mt-5 flex items-center gap-2">
            {steps.map((s, i) => (
              <div key={s.id} className="flex items-center gap-2">
                <div
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-full border text-xs font-medium transition-colors",
                    step > s.id
                      ? "border-primary bg-primary text-primary-foreground"
                      : step === s.id
                        ? "border-primary text-primary"
                        : "border-border text-muted-foreground",
                  )}
                >
                  {step > s.id ? <Check className="h-3.5 w-3.5" /> : s.id}
                </div>
                <span
                  className={cn(
                    "text-xs",
                    step === s.id ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {s.title}
                </span>
                {i < steps.length - 1 && (
                  <div className="h-px w-10 bg-border" role="separator" />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Body — scrolls inside the bounded card so the footer stays visible */}
        <div className="force-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-8 py-6">
          {step === 1 && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="wiz-doctor-name">
                    Doctor&apos;s name <span className="text-rose-500">*</span>
                  </Label>
                  <Input
                    id="wiz-doctor-name"
                    placeholder="Dr. Sarah Ahmed"
                    value={draft.doctor_name}
                    onChange={set("doctor_name")}
                    autoFocus
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wiz-specialty">Specialty</Label>
                  <Input
                    id="wiz-specialty"
                    placeholder="Dentist"
                    value={draft.doctor_specialty}
                    onChange={set("doctor_specialty")}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wiz-license">License / Reg. no.</Label>
                  <Input
                    id="wiz-license"
                    placeholder="Optional"
                    value={draft.doctor_license}
                    onChange={set("doctor_license")}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wiz-doctor-phone">Phone</Label>
                  <Input
                    id="wiz-doctor-phone"
                    type="tel"
                    placeholder="Optional"
                    value={draft.doctor_phone}
                    onChange={set("doctor_phone")}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wiz-doctor-email">Email</Label>
                  <Input
                    id="wiz-doctor-email"
                    type="email"
                    placeholder="Optional"
                    value={draft.doctor_email}
                    onChange={set("doctor_email")}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                The doctor&apos;s name appears on the dashboard greeting,
                prescriptions, and invoices.
              </p>
            </>
          )}

          {step === 2 && (
            <>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="wiz-clinic-name">
                    Clinic name <span className="text-rose-500">*</span>
                  </Label>
                  <Input
                    id="wiz-clinic-name"
                    placeholder="Bright Smile Dental Care"
                    value={draft.clinic_name}
                    onChange={set("clinic_name")}
                    autoFocus
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wiz-clinic-address">Clinic address</Label>
                  <Input
                    id="wiz-clinic-address"
                    placeholder="Optional"
                    value={draft.clinic_address}
                    onChange={set("clinic_address")}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                The clinic name is printed on prescription and invoice
                letterheads. You can upload a logo from Settings → Profile
                after setup.
              </p>
            </>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-4">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                <div className="min-w-0 text-sm">
                  <p className="font-medium">Keep a safety copy of your data</p>
                  <p className="mt-1 text-muted-foreground">
                    Your data lives on this computer. Pick a folder (a USB
                    drive or a synced folder like Google Drive works great) and
                    Dental Canvas writes a full backup file there
                    <span className="font-medium"> right now</span>, then
                    automatically once a week — the last 12 are kept.
                  </p>
                </div>
              </div>
              {backupOk ? (
                <p className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">
                  <Check className="h-4 w-4 shrink-0" />
                  {backupMsg}
                </p>
              ) : (
                <Button onClick={pickBackupFolder} disabled={backupBusy} className="w-full">
                  {backupBusy ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Waiting for folder…
                    </>
                  ) : (
                    <>
                      <FolderSync className="h-4 w-4" /> Choose backup folder…
                    </>
                  )}
                </Button>
              )}
              {!backupOk && backupMsg && (
                <p className="text-xs text-rose-600">{backupMsg}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Optional — you can set this up (daily or Drive sync too) anytime
                in Settings → Backup.
              </p>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-4">
                <Cloud className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div className="min-w-0 text-sm">
                  <p className="font-medium">Back up and sync across devices (optional)</p>
                  <p className="mt-1 text-muted-foreground">
                    Your practice keeps working offline either way. An account backs up
                    patients, appointments and billing to your own Supabase project, so a
                    new computer can pick up where you left off.
                  </p>
                </div>
              </div>
              <AccountStep onDone={onDone} compact />
            </div>
          )}

          {error && (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t px-8 py-4">
          <Button
            variant="ghost"
            onClick={() => (prevStep ? setStep(prevStep) : onDone())}
            disabled={saving}
          >
            {prevStep ? (
              <>
                <ArrowLeft className="h-4 w-4" /> Back
              </>
            ) : (
              "Skip for now"
            )}
          </Button>
          {step === 4 ? null : nextStep ? (
            <Button
              onClick={() => void goNext()}
              disabled={!doctorOk || (step === 2 && !clinicOk) || saving}
            >
              Next <ArrowRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={() => void finish()} disabled={!clinicOk || saving}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" /> Finish setup
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

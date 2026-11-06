import { Fragment, useEffect, useRef, useState } from "react";
import { Plus, Trash2, Pencil, Check, X, Clock, UserRound, DatabaseBackup, Palette, Monitor, Sun, Moon, ImageUp, Mail, ReceiptText, MailCheck, QrCode, Printer, Link2, CircleDollarSign, Info, Download, Loader2, RefreshCw, Search, BellRing, Sparkles, FileText, Cloud } from "lucide-react";
import { useApp } from "@/context";
import { api } from "@/api";
import { toast } from "@/components/ui/toast";
import { BackupTab } from "./backup-tab";
import { SyncTab } from "./sync-tab";
import { UpdateCard } from "./app-update-card";
import { BookingTab } from "./booking-tab";
import { RxTemplatesTab } from "./rx-templates-tab";
import { StorageTab } from "./storage-tab";
import { AccountPanel } from "@/components/account/account-panel";
import { StartupCard } from "./startup-card";
import { PageHeader, PageShell } from "@/components/page-shell";
import { ToothGlyph } from "@/components/dental-art";
import { useTheme, type ThemePreference } from "@/hooks/use-theme";
import { useRouter } from "@/hooks/use-router";
import { useAccessibility, type A11yPreference } from "@/hooks/use-accessibility";
import { useBrandAccent } from "@/hooks/use-brand-accent";
import { brandAccentFromHex } from "@/lib/color";
import { Contrast } from "lucide-react";
import { cn, colorClasses, formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ConsentTemplate } from "@/types";
import type { Operatory, Practitioner, PractitionerRole, TreatmentType } from "@/types";
import { fileToLogoDataUrl } from "@/lib/logo";
import { notify } from "@/lib/desktop-notify";
import { printQrPoster } from "@/lib/print";
import { INVOICE_STYLES, InvoiceSheet, type InvoiceStyle } from "@/components/patients/invoice-sheet";

const COLOR_TOKENS = ["sky", "emerald", "amber", "rose", "violet", "fuchsia", "teal", "orange", "slate"] as const;
const ROLES: PractitionerRole[] = ["dentist", "hygienist", "assistant"];

// ── Basic / Advanced settings ──────────────────────────────────
// Sixteen tabs made every setting feel equally urgent. Basic is the daily
// clinic setup a front desk touches; Advanced adds the technical and one-off
// screens. Advanced reveals every tab (the basics stay put, so switching does
// not hide the page you were on).

type SettingsScope = "basic" | "advanced";

type SettingsTab = {
  value: string;
  label: string;
  icon?: typeof Monitor;
  scope: SettingsScope;
};

const SETTINGS_TABS: SettingsTab[] = [
  { value: "profile", label: "Profile", scope: "basic" },
  { value: "appearance", label: "Appearance", scope: "basic" },
  { value: "hours", label: "Hours", scope: "basic" },
  { value: "notifications", label: "Notifications", icon: BellRing, scope: "basic" },
  { value: "billing", label: "Billing", icon: ReceiptText, scope: "basic" },
  { value: "account", label: "Account", icon: Cloud, scope: "advanced" },
  { value: "sync", label: "Cloud sync", icon: RefreshCw, scope: "advanced" },
  { value: "operatories", label: "Operatories", scope: "advanced" },
  { value: "practitioners", label: "Practitioners", scope: "advanced" },
  { value: "treatments", label: "Treatment types", scope: "advanced" },
  { value: "consents", label: "Consent forms", scope: "advanced" },
  { value: "booking", label: "Online booking", icon: Link2, scope: "advanced" },
  { value: "email", label: "Email", icon: Mail, scope: "advanced" },
  { value: "rx-templates", label: "Rx templates", icon: FileText, scope: "advanced" },
  { value: "storage", label: "Storage", icon: ImageUp, scope: "advanced" },
  { value: "backup", label: "Backup", icon: DatabaseBackup, scope: "advanced" },
  { value: "about", label: "About", icon: Info, scope: "advanced" },
];

const BASIC_TABS = new Set(SETTINGS_TABS.filter((t) => t.scope === "basic").map((t) => t.value));
const SCOPE_KEY = "dental-canvas:settings-scope";

function readScope(): SettingsScope {
  try {
    return localStorage.getItem(SCOPE_KEY) === "advanced" ? "advanced" : "basic";
  } catch {
    return "basic";
  }
}

export function SettingsPage() {
  const [scope, setScopeState] = useState<SettingsScope>(readScope);
  const [tab, setTab] = useState("profile");

  function setScope(next: SettingsScope) {
    setScopeState(next);
    try {
      localStorage.setItem(SCOPE_KEY, next);
    } catch {
      /* storage unavailable — the choice still holds for this session */
    }
  }

  // Basic mode does not draw an advanced trigger, so a tab left over from
  // Advanced would have no trigger to return to (and no content to show).
  useEffect(() => {
    if (scope === "basic" && !BASIC_TABS.has(tab)) setTab("profile");
  }, [scope, tab]);

  const visibleTabs = SETTINGS_TABS.filter((t) => scope === "advanced" || t.scope === "basic");

  return (
    <PageShell>
      <PageHeader
        icon={<ToothGlyph className="h-5 w-5" />}
        eyebrow="Clinic setup"
        title="Settings"
        description="The profile, schedule and money rules behind every chart, letterhead and invoice."
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-8 md:px-6">
        <Tabs value={tab} onValueChange={setTab}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div
              role="group"
              aria-label="Settings level"
              className="flex items-center gap-1 rounded-full border border-border/60 bg-card/70 p-1 shadow-sm backdrop-blur"
            >
              {(["basic", "advanced"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  aria-pressed={scope === s}
                  className={cn(
                    "rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
                    scope === s
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {s === "basic" ? "Basic" : "Advanced"}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {scope === "basic"
                ? "Everyday clinic setup. Switch to Advanced for booking, email, storage and backups."
                : "Every setting, including the technical and one-off screens."}
            </p>
          </div>
          {/* Scrollable tab bar: the whole set overflows on narrow windows, so
              the list wraps instead of clipping (and scrolls horizontally as a
              last resort on very small screens). The pill styling lives in
              styles.css (.dc-tabbar) so every trigger — including the ones
              added later — picks it up from the list alone. */}
          <TabsList className="dc-tabbar flex h-auto w-full flex-wrap justify-start gap-1 rounded-2xl border border-border/60 bg-card/70 p-1.5 shadow-sm backdrop-blur">
            {visibleTabs.map((t, i) => (
              <Fragment key={t.value}>
                {i > 0 && t.scope === "advanced" && visibleTabs[i - 1].scope === "basic" && (
                  <span className="mx-1 h-6 w-px self-center bg-border/70" aria-hidden />
                )}
                <TabsTrigger value={t.value} className={t.icon ? "gap-1.5" : undefined}>
                  {t.icon ? <t.icon className="h-3.5 w-3.5" /> : null}
                  {t.label}
                </TabsTrigger>
              </Fragment>
            ))}
          </TabsList>
          <TabsContent value="profile" className="mt-4">
            <ProfileTab />
          </TabsContent>
          <TabsContent value="account" className="mt-4">
            <AccountPanel />
          </TabsContent>
          <TabsContent value="sync" className="mt-4">
            <SyncTab />
          </TabsContent>
          <TabsContent value="appearance" className="mt-4 space-y-4">
            <AppearanceTab />
            <CurrencyCard />
            <AccentColorCard />
            <AccessibilityCard />
            <StartupCard />
          </TabsContent>
          <TabsContent value="operatories" className="mt-4">
            <OperatoriesTab />
          </TabsContent>
          <TabsContent value="practitioners" className="mt-4">
            <PractitionersTab />
          </TabsContent>
          <TabsContent value="treatments" className="mt-4">
            <TreatmentTypesTab />
          </TabsContent>
          <TabsContent value="consents" className="mt-4">
            <ConsentTemplatesTab />
          </TabsContent>
          <TabsContent value="hours" className="mt-4">
            <HoursTab />
          </TabsContent>
          <TabsContent value="notifications" className="mt-4">
            <NotificationsTab />
          </TabsContent>
          <TabsContent value="booking" className="mt-4">
            <BookingTab />
          </TabsContent>
          <TabsContent value="email" className="mt-4 space-y-4">
            <EmailTab />
            <DigestTab />
          </TabsContent>
          <TabsContent value="billing" className="mt-4">
            <InvoiceStyleTab />
          </TabsContent>
          <TabsContent value="rx-templates" className="mt-4">
            <RxTemplatesTab />
          </TabsContent>
          <TabsContent value="storage" className="mt-4">
            <StorageTab />
          </TabsContent>
          <TabsContent value="backup" className="mt-4">
            <BackupTab />
          </TabsContent>
          <TabsContent value="about" className="mt-4">
            <AboutTab />
          </TabsContent>
        </Tabs>
      </div>
    </PageShell>
  );
}

// ── Profile (doctor identity) ──────────────────────────────────────

function ProfileTab() {
  const app = useApp();
  const [form, setForm] = useState(app.profile);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const qrInputRef = useRef<HTMLInputElement>(null);

  function printQr() {
    const saved = app.profile;
    const qr = form.payment_qr || saved.payment_qr;
    if (!qr) {
      toast.error("Save the QR image first, then print the poster.");
      return;
    }
    printQrPoster({
      clinicName: form.clinic_name.trim() || saved.clinic_name || "Our Clinic",
      qrDataUrl: qr,
      label: form.payment_qr_label.trim() || saved.payment_qr_label,
    });
  }

  useEffect(() => {
    setForm(app.profile);
  }, [app.profile]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.doctor_name.trim()) {
      app.setError("Doctor name is required so the dashboard greeting can address you.");
      return;
    }
    setBusy(true);
    try {
      await app.updateProfile({
        doctor_name: form.doctor_name.trim(),
        doctor_specialty: form.doctor_specialty.trim(),
        clinic_name: form.clinic_name.trim(),
        doctor_email: form.doctor_email.trim(),
        doctor_phone: form.doctor_phone.trim(),
        doctor_license: form.doctor_license.trim(),
        clinic_address: form.clinic_address.trim(),
        clinic_logo: form.clinic_logo,
        payment_qr: form.payment_qr,
        payment_qr_label: form.payment_qr_label.trim(),
        chamber_footer_instructions: form.chamber_footer_instructions,
        google_review_url: form.google_review_url.trim(),
      });
      toast.success("Profile saved");
      setSavedAt(Date.now());
    } catch (err) {
      toast.error((err as Error).message);
      app.setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserRound className="h-4 w-4" />
          Doctor profile
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Shown on the dashboard greeting and avatar. The name appears as “Dr. &lt;name&gt;” automatically.
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Clinic logo (prescriptions &amp; invoices)</Label>
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  "flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/40",
                  !form.clinic_logo && "text-muted-foreground/50",
                )}
                aria-hidden
              >
                {form.clinic_logo ? (
                  <img src={form.clinic_logo} alt="Clinic logo" className="max-h-full max-w-full object-contain" />
                ) : (
                  <ImageUp className="h-5 w-5" />
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => logoInputRef.current?.click()}>
                    {form.clinic_logo ? "Replace" : "Upload logo"}
                  </Button>
                  {form.clinic_logo && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setForm({ ...form, clinic_logo: "" })}
                    >
                      Remove
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">PNG or SVG with transparency works best.</p>
              </div>
              <input
                ref={logoInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = ""; // allow re-choosing the same file
                  if (!file) return;
                  try {
                    const dataUrl = await fileToLogoDataUrl(file);
                    setForm((f) => ({ ...f, clinic_logo: dataUrl }));
                  } catch (err) {
                    app.setError((err as Error).message);
                  }
                }}
              />
            </div>
          </div>
          <FieldGroup label="Doctor name *">
            <Input
              value={form.doctor_name}
              onChange={(e) => setForm({ ...form, doctor_name: e.target.value })}
              placeholder="e.g. Sarah"
              required
            />
          </FieldGroup>
          <FieldGroup label="Specialty">
            <Input
              value={form.doctor_specialty}
              onChange={(e) => setForm({ ...form, doctor_specialty: e.target.value })}
              placeholder="e.g. Orthodontist"
            />
          </FieldGroup>
          <FieldGroup label="Clinic name">
            <Input
              value={form.clinic_name}
              onChange={(e) => setForm({ ...form, clinic_name: e.target.value })}
              placeholder="e.g. Bright Smile Dental"
            />
          </FieldGroup>
          <FieldGroup label="Email">
            <Input
              type="email"
              value={form.doctor_email}
              onChange={(e) => setForm({ ...form, doctor_email: e.target.value })}
              placeholder="dr.sarah@clinic.com"
            />
          </FieldGroup>
          <FieldGroup label="Phone">
            <Input
              type="tel"
              value={form.doctor_phone}
              onChange={(e) => setForm({ ...form, doctor_phone: e.target.value })}
              placeholder="+1 555 010 2030"
            />
          </FieldGroup>
          <div className="space-y-1.5">
            <Label className="text-xs">Payment QR (printable poster)</Label>
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  "flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/40",
                  !form.payment_qr && "text-muted-foreground/50",
                )}
                aria-hidden
              >
                {form.payment_qr ? (
                  <img src={form.payment_qr} alt="Payment QR" className="max-h-full max-w-full object-contain" />
                ) : (
                  <QrCode className="h-5 w-5" />
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => qrInputRef.current?.click()}>
                    {form.payment_qr ? "Replace" : "Upload QR"}
                  </Button>
                  {form.payment_qr && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setForm({ ...form, payment_qr: "" })}
                    >
                      Remove
                    </Button>
                  )}
                  {form.payment_qr && (
                    <Button type="button" variant="outline" size="sm" onClick={printQr}>
                      <Printer className="mr-1 h-3.5 w-3.5" /> Print poster
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Your bKash/Nagad/bank QR image — patients scan it to pay. Print the poster for the waiting room.
                </p>
              </div>
              <input
                ref={qrInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = ""; // allow re-choosing the same file
                  if (!file) return;
                  try {
                    const dataUrl = await fileToLogoDataUrl(file);
                    setForm((f) => ({ ...f, payment_qr: dataUrl }));
                  } catch (err) {
                    toast.error((err as Error).message);
                  }
                }}
              />
            </div>
            {form.payment_qr && (
              <Input
                value={form.payment_qr_label}
                onChange={(e) => setForm({ ...form, payment_qr_label: e.target.value })}
                placeholder="Caption, e.g. bKash — Personal · 01712-345678"
                className="max-w-sm"
              />
            )}
          </div>
          <FieldGroup label="License no. (prescriptions)">
            <Input
              value={form.doctor_license}
              onChange={(e) => setForm({ ...form, doctor_license: e.target.value })}
              placeholder="e.g. DDS-102938"
            />
          </FieldGroup>
          <FieldGroup label="Clinic address (prescriptions)">
            <Input
              value={form.clinic_address}
              onChange={(e) => setForm({ ...form, clinic_address: e.target.value })}
              placeholder="123 Main St, Springfield"
            />
          </FieldGroup>
          <FieldGroup
            label="Chamber footer instructions (prescriptions)"
            hint="Fixed instructions printed at the foot of every Chamber prescription — e.g. emergency contact or after-care notes. One line each."
            className="sm:col-span-2 lg:col-span-3"
          >
            <Textarea
              rows={3}
              value={form.chamber_footer_instructions}
              onChange={(e) => setForm({ ...form, chamber_footer_instructions: e.target.value })}
              placeholder={"e.g. In case of bleeding or fever, call +1 555 010 2030\nAvoid hot drinks for 2 hours after extraction"}
            />
          </FieldGroup>
          <FieldGroup
            label="Google review URL"
            hint="Included as a clickable link in post-visit review requests (Agenda → Reviews tab)."
          >
            <Input
              value={form.google_review_url}
              onChange={(e) => setForm({ ...form, google_review_url: e.target.value })}
              placeholder="https://g.page/r/your-clinic/review"
            />
          </FieldGroup>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save profile"}
            </Button>
            {savedAt && <span className="text-xs text-emerald-700">Saved ✓</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ── Appearance (theme) ─────────────────────────────────────────────

function AppearanceTab() {
  const { pref, setTheme } = useTheme();
  const options: { value: ThemePreference; label: string; description: string; icon: typeof Monitor }[] = [
    { value: "system", label: "System", description: "Follow the OS setting automatically", icon: Monitor },
    { value: "light", label: "Light", description: "Always use the light theme", icon: Sun },
    { value: "dark", label: "Dark", description: "Always use the dark theme", icon: Moon },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Palette className="h-4 w-4" />
          Theme
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          “System” follows your device's dark mode and switches instantly when it changes. Your choice is remembered per browser.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-3">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setTheme(o.value)}
              aria-pressed={pref === o.value}
              className={cn(
                "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                pref === o.value
                  ? "border-primary bg-accent/50 ring-1 ring-primary"
                  : "hover:bg-accent/30",
              )}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <o.icon className="h-4 w-4" />
                {o.label}
              </span>
              <span className="text-xs text-muted-foreground">{o.description}</span>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Notifications (reminders & native alerts) ─────────────────

const REMINDER_OPTIONS = [5, 10, 15, 20, 30, 45, 60];

function NotificationsTab() {
  const app = useApp();
  const { reminders_enabled, reminder_minutes } = app.settings;
  const [busy, setBusy] = useState(false);

  async function save(patch: { reminders_enabled?: boolean; reminder_minutes?: number }) {
    setBusy(true);
    try {
      await app.updateSettings(patch);
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BellRing className="h-4 w-4" />
            Appointment reminders
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Get a notification before each of today's appointments — an in-app toast
            always, and a native OS notification (Windows Action Center / macOS
            Notification Center) in the desktop app, even when the window is
            minimized or in the background.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <span>
              <span className="block text-sm font-medium">Enable appointment reminders</span>
              <span className="block text-xs text-muted-foreground">
                Reminders re-arm automatically as appointments are added or changed.
              </span>
            </span>
            <input
              type="checkbox"
              className="h-5 w-5 accent-[var(--primary)]"
              checked={reminders_enabled}
              disabled={busy}
              onChange={(e) => save({ reminders_enabled: e.target.checked })}
            />
          </label>

          <div className="space-y-1.5">
            <Label htmlFor="reminder-minutes">Remind me before</Label>
            <Select
              value={String(reminder_minutes)}
              onValueChange={(v) => save({ reminder_minutes: parseInt(v, 10) })}
            >
              <SelectTrigger id="reminder-minutes" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REMINDER_OPTIONS.map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    {m} minutes
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Applies to reminders armed from now on; already-scheduled ones keep their timing.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Test notification</CardTitle>
          <p className="text-sm text-muted-foreground">
            Checks that notifications can reach you. The first native notification asks
            the operating system for permission — choose Allow.
          </p>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              toast.info("This is what an in-app reminder looks like", 6000);
              await notify("Dental Canvas", { body: "Test notification — reminders are working. 🦷" });
              toast.success("Test notification sent");
            }}
          >
            <BellRing className="h-4 w-4" />
            Send a test notification
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Currency (appearance) ──────────────────────────────────────

function CurrencyCard() {
  const app = useApp();
  const { currency } = app.settings;
  const options: { value: "USD" | "BDT"; label: string; example: string }[] = [
    { value: "USD", label: "US Dollar ($)", example: "$1,500.00" },
    { value: "BDT", label: "Bangladeshi Taka (৳)", example: "৳1,500" },
  ];

  async function pick(next: "USD" | "BDT") {
    if (next === currency) return;
    try {
      await app.updateSettings({ currency: next });
      toast.success(`Currency set to ${next === "BDT" ? "taka (৳)" : "US dollar ($)"}`);
    } catch (err) {
      app.setError((err as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CircleDollarSign className="h-4 w-4" />
          Currency
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Applies everywhere money is shown — billing, invoices, treatment plans, reports and printed sheets.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => pick(o.value)}
              aria-pressed={currency === o.value}
              className={cn(
                "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                currency === o.value
                  ? "border-primary bg-accent/50 ring-1 ring-primary"
                  : "hover:bg-accent/30",
              )}
            >
              <span className="text-sm font-medium">{o.label}</span>
              <span className="text-xs text-muted-foreground">Example: {o.example}</span>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ── About (version + in-app updates) ───────────────────────────

function AboutTab() {
  const { navigate } = useRouter();
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Info className="h-4 w-4" />
            About Dental Canvas
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Dental Canvas</span> — chamber management system for
            dental practices. Version <span className="font-medium text-foreground">{__APP_VERSION__}</span>.
          </p>
          <p>
            The app runs fully offline: the interface and the local database both live on this computer, so the
            clinic keeps working without internet. When online, it checks for updates automatically once an hour.
          </p>
          <div>
            <Button size="sm" variant="outline" onClick={() => navigate("/whats-new")}>
              <Sparkles className="h-4 w-4" />
              What&apos;s new — recent versions &amp; changes
            </Button>
          </div>
        </CardContent>
      </Card>
      <UpdateCard />
    </div>
  );
}

// ── Accent color ───────────────────────────────────────────────

/** Curated presets: hue family + display swatch. Default teal first. */
const ACCENT_PRESETS: { hex: string; name: string }[] = [
  { hex: "#0e7490", name: "Teal (default)" },
  { hex: "#059669", name: "Emerald" },
  { hex: "#2563eb", name: "Blue" },
  { hex: "#7c3aed", name: "Violet" },
  { hex: "#db2777", name: "Pink" },
  { hex: "#dc2626", name: "Red" },
  { hex: "#ea580c", name: "Orange" },
  { hex: "#ca8a04", name: "Gold" },
  { hex: "#4d7c0f", name: "Olive" },
  { hex: "#0f766e", name: "Viridian" },
];

function AccentColorCard() {
  const { accent, setAccent } = useBrandAccent();
  const isDefault = accent === null;
  // The live swatch for a custom pick needs its own preview; derive it from
  // the same conversion the CSS uses.
  const customPreview = accent && !ACCENT_PRESETS.some((p) => p.hex.toLowerCase() === accent.toLowerCase())
    ? accent
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Palette className="h-4 w-4" />
          Accent color
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Recolors buttons, highlights and focus rings across the app — an easy way to match your practice's branding. Works with every theme and with high contrast.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {ACCENT_PRESETS.map((p) => (
            <button
              key={p.hex}
              type="button"
              title={p.name}
              aria-label={`Accent: ${p.name}`}
              aria-pressed={accent?.toLowerCase() === p.hex.toLowerCase()}
              onClick={() => setAccent(p.hex === "#0e7490" ? null : p.hex)}
              className={cn(
                "h-9 w-9 rounded-full border-2 transition-transform hover:scale-110",
                accent?.toLowerCase() === p.hex.toLowerCase()
                  ? "border-foreground ring-2 ring-ring ring-offset-2 ring-offset-background"
                  : "border-transparent",
              )}
              style={{ backgroundColor: p.hex }}
            />
          ))}
          {customPreview && (
            <span
              className="h-9 w-9 rounded-full border-2 border-foreground ring-2 ring-ring ring-offset-2 ring-offset-background"
              style={{ backgroundColor: customPreview }}
              title={accent ?? undefined}
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="color"
              value={accent ?? "#0e7490"}
              onChange={(e) => setAccent(e.target.value)}
              className="h-9 w-12 cursor-pointer rounded border bg-background p-1"
              aria-label="Custom accent color"
            />
            Custom color
          </label>
          <Input
            value={accent ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setAccent(brandAccentFromHex(v) ? (v.startsWith("#") ? v : `#${v}`) : null);
            }}
            placeholder="#0e7490"
            className="w-36"
            aria-label="Accent color hex"
          />
          <Button variant="ghost" size="sm" disabled={isDefault} onClick={() => setAccent(null)}>
            Reset to default
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Accessibility ───────────────────────────────────────────────

function AccessibilityCard() {
  const { contrast, setContrast, reduceMotion, setReduceMotion } = useAccessibility();

  const settings: {
    key: "contrast" | "motion";
    title: string;
    description: string;
    value: A11yPreference;
    onChange: (p: A11yPreference) => void;
  }[] = [
    {
      key: "contrast",
      title: "High contrast",
      description:
        "Stronger text and border contrast, plus clearly visible focus outlines. Follows your OS high-contrast setting by default.",
      value: contrast,
      onChange: setContrast,
    },
    {
      key: "motion",
      title: "Reduce motion",
      description:
        "Minimizes animations and smooth scrolling, which can cause discomfort or dizziness. Follows your OS reduced-motion setting by default.",
      value: reduceMotion,
      onChange: setReduceMotion,
    },
  ];

  const options: { value: A11yPreference; label: string }[] = [
    { value: "system", label: "System" },
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Contrast className="h-4 w-4" />
          Accessibility
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Defaults follow your device's own accessibility settings and switch instantly when they change. Your choice is remembered per browser.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {settings.map((s) => (
          <div
            key={s.key}
            className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">{s.title}</p>
              <p className="text-xs text-muted-foreground">{s.description}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1 rounded-lg border bg-background p-0.5">
              {options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => s.onChange(o.value)}
                  aria-pressed={s.value === o.value}
                  className={cn(
                    "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                    s.value === o.value
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ── Hours ──────────────────────────────────────────────────────────

function HoursTab() {
  const app = useApp();
  const [start, setStart] = useState(toHHMM(app.settings.day_start_minute));
  const [end, setEnd] = useState(toHHMM(app.settings.day_end_minute));
  const [slot, setSlot] = useState(app.settings.slot_minutes);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setStart(toHHMM(app.settings.day_start_minute));
    setEnd(toHHMM(app.settings.day_end_minute));
    setSlot(app.settings.slot_minutes);
  }, [app.settings]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const startMin = parseHHMM(start);
    const endMin = parseHHMM(end);
    if (Number.isNaN(startMin) || Number.isNaN(endMin)) {
      app.setError("Enter valid HH:MM times");
      return;
    }
    if (endMin <= startMin) {
      app.setError("End must be after start");
      return;
    }
    setBusy(true);
    try {
      await app.updateSettings({
        day_start_minute: startMin,
        day_end_minute: endMin,
        slot_minutes: slot,
      });
      setSavedAt(Date.now());
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-4 w-4" />
          Working hours
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Controls the time range shown on the agenda day-view and the granularity of bookable slots.
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
          <FieldGroup label="Day starts">
            <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
          </FieldGroup>
          <FieldGroup label="Day ends">
            <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
          </FieldGroup>
          <FieldGroup label="Slot length">
            <Select value={slot.toString()} onValueChange={(v) => setSlot(parseInt(v, 10))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {[5, 10, 15, 20, 30, 60].map((m) => (
                  <SelectItem key={m} value={m.toString()}>{m} min</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldGroup>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </form>
        {savedAt && (
          <p className="mt-3 text-xs text-emerald-700">Saved. The agenda will reflect the new hours immediately.</p>
        )}
      </CardContent>
    </Card>
  );
}

function toHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseHHMM(s: string): number {
  const [h, m] = s.split(":").map((n) => parseInt(n, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
}

// ── Operatories ────────────────────────────────────────────────────

function OperatoriesTab() {
  const app = useApp();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>("sky");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("sky");

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await api<{ operatory: Operatory }>("POST", "/api/operatories", {
        name: name.trim(),
        color,
      });
      app.refreshLookups();
      void res;
      setName("");
      setColor("sky");
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save(id: number) {
    try {
      await api("PUT", `/api/operatories/${id}`, { name: editName.trim(), color: editColor });
      app.refreshLookups();
      setEditingId(null);
    } catch (err) {
      app.setError((err as Error).message);
    }
  }

  async function remove(id: number) {
    if (!confirm("Delete this operatory? Existing appointments in it will be deleted too.")) return;
    try {
      await api("DELETE", `/api/operatories/${id}`);
      app.refreshLookups();
    } catch (err) {
      app.setError((err as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Operatories</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={add} className="grid items-end gap-2 rounded-md border bg-muted/30 p-3 sm:grid-cols-[2fr_1fr_auto]">
          <FieldGroup label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Op 4" required />
          </FieldGroup>
          <FieldGroup label="Color">
            <ColorSelect value={color} onChange={setColor} />
          </FieldGroup>
          <Button type="submit" disabled={busy}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </form>

        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2 font-semibold">Name</th>
                <th className="px-3 py-2 font-semibold">Color</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {app.operatories.length === 0 ? (
                <tr><td colSpan={3} className="px-3 py-8 text-center text-muted-foreground">No operatories yet.</td></tr>
              ) : app.operatories.map((o) => {
                const palette = colorClasses(o.color);
                const editing = editingId === o.id;
                return (
                  <tr key={o.id} className="border-b last:border-0">
                    <td className="px-3 py-2">
                      {editing ? (
                        <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="h-8" />
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className={cn("inline-block h-2 w-2 rounded-full", palette.dot)} />
                          {o.name}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editing ? (
                        <ColorSelect value={editColor} onChange={setEditColor} />
                      ) : (
                        <span className="capitalize text-muted-foreground">{o.color}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {editing ? (
                        <div className="flex justify-end gap-1">
                          <Button size="icon" variant="ghost" aria-label="Save operatory" onClick={() => save(o.id)}><Check className="h-4 w-4 text-emerald-600" /></Button>
                          <Button size="icon" variant="ghost" aria-label="Cancel editing" onClick={() => setEditingId(null)}><X className="h-4 w-4" /></Button>
                        </div>
                      ) : (
                        <div className="flex justify-end gap-1">
                          <Button size="icon" variant="ghost" aria-label={`Edit ${o.name}`} onClick={() => { setEditingId(o.id); setEditName(o.name); setEditColor(o.color); }}><Pencil className="h-4 w-4" /></Button>
                          <Button size="icon" variant="ghost" aria-label={`Delete ${o.name}`} onClick={() => remove(o.id)}><Trash2 className="h-4 w-4 text-muted-foreground" /></Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Practitioners ──────────────────────────────────────────────────

function PractitionersTab() {
  const app = useApp();
  const [name, setName] = useState("");
  const [role, setRole] = useState<PractitionerRole>("dentist");
  const [color, setColor] = useState("teal");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [edit, setEdit] = useState<{ name: string; role: PractitionerRole; color: string }>({ name: "", role: "dentist", color: "teal" });

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api<{ practitioner: Practitioner }>("POST", "/api/practitioners", {
        name: name.trim(), role, color,
      });
      app.refreshLookups();
      setName("");
      setRole("dentist");
      setColor("teal");
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save(id: number) {
    try {
      await api("PUT", `/api/practitioners/${id}`, edit);
      app.refreshLookups();
      setEditingId(null);
    } catch (err) {
      app.setError((err as Error).message);
    }
  }

  async function remove(id: number) {
    if (!confirm("Delete this practitioner?")) return;
    try {
      await api("DELETE", `/api/practitioners/${id}`);
      app.refreshLookups();
    } catch (err) {
      app.setError((err as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Practitioners</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={add} className="grid items-end gap-2 rounded-md border bg-muted/30 p-3 sm:grid-cols-[2fr_1fr_1fr_auto]">
          <FieldGroup label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </FieldGroup>
          <FieldGroup label="Role">
            <Select value={role} onValueChange={(v) => setRole(v as PractitionerRole)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => <SelectItem key={r} value={r}>{capitalize(r)}</SelectItem>)}
              </SelectContent>
            </Select>
          </FieldGroup>
          <FieldGroup label="Color">
            <ColorSelect value={color} onChange={setColor} />
          </FieldGroup>
          <Button type="submit" disabled={busy}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </form>

        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2 font-semibold">Name</th>
                <th className="px-3 py-2 font-semibold">Role</th>
                <th className="px-3 py-2 font-semibold">Color</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {app.practitioners.length === 0 ? (
                <tr><td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">No practitioners yet.</td></tr>
              ) : app.practitioners.map((p) => {
                const palette = colorClasses(p.color);
                const editing = editingId === p.id;
                return (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="px-3 py-2">
                      {editing ? (
                        <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} className="h-8" />
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className={cn("inline-block h-2 w-2 rounded-full", palette.dot)} />
                          {p.name}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 capitalize">
                      {editing ? (
                        <Select value={edit.role} onValueChange={(v) => setEdit({ ...edit, role: v as PractitionerRole })}>
                          <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                          <SelectContent>{ROLES.map((r) => <SelectItem key={r} value={r}>{capitalize(r)}</SelectItem>)}</SelectContent>
                        </Select>
                      ) : p.role}
                    </td>
                    <td className="px-3 py-2">
                      {editing ? <ColorSelect value={edit.color} onChange={(c) => setEdit({ ...edit, color: c })} /> : <span className="capitalize text-muted-foreground">{p.color}</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {editing ? (
                        <div className="flex justify-end gap-1">
                          <Button size="icon" variant="ghost" aria-label="Save practitioner" onClick={() => save(p.id)}><Check className="h-4 w-4 text-emerald-600" /></Button>
                          <Button size="icon" variant="ghost" aria-label="Cancel editing" onClick={() => setEditingId(null)}><X className="h-4 w-4" /></Button>
                        </div>
                      ) : (
                        <div className="flex justify-end gap-1">
                          <Button size="icon" variant="ghost" aria-label={`Edit ${p.name}`} onClick={() => { setEditingId(p.id); setEdit({ name: p.name, role: p.role, color: p.color }); }}><Pencil className="h-4 w-4" /></Button>
                          <Button size="icon" variant="ghost" aria-label={`Delete ${p.name}`} onClick={() => remove(p.id)}><Trash2 className="h-4 w-4 text-muted-foreground" /></Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Treatment types ────────────────────────────────────────────────

function TreatmentTypesTab() {
  const app = useApp();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [duration, setDuration] = useState("30");
  const [fee, setFee] = useState("0");
  const [color, setColor] = useState("sky");
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim() || !name.trim()) return;
    setBusy(true);
    try {
      await api<{ treatment_type: TreatmentType }>("POST", "/api/treatment-types", {
        code: code.trim(),
        name: name.trim(),
        duration_minutes: parseInt(duration, 10) || 30,
        default_fee: parseFloat(fee) || 0,
        color,
      });
      app.refreshLookups();
      setCode("");
      setName("");
      setDuration("30");
      setFee("0");
      setColor("sky");
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("Delete this treatment type?")) return;
    try {
      await api("DELETE", `/api/treatment-types/${id}`);
      app.refreshLookups();
    } catch (err) {
      app.setError((err as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Treatment types</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={add} className="grid items-end gap-2 rounded-md border bg-muted/30 p-3 sm:grid-cols-[1fr_2fr_1fr_1fr_1fr_auto]">
          <FieldGroup label="Code"><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="EXAM" required /></FieldGroup>
          <FieldGroup label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Exam & Cleaning" required /></FieldGroup>
          <FieldGroup label="Duration (min)"><Input type="number" min="5" value={duration} onChange={(e) => setDuration(e.target.value)} /></FieldGroup>
          <FieldGroup label="Default fee"><Input type="number" step="0.01" min="0" value={fee} onChange={(e) => setFee(e.target.value)} /></FieldGroup>
          <FieldGroup label="Color"><ColorSelect value={color} onChange={setColor} /></FieldGroup>
          <Button type="submit" disabled={busy}><Plus className="h-4 w-4" /> Add</Button>
        </form>

        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2 font-semibold">Code</th>
                <th className="px-3 py-2 font-semibold">Name</th>
                <th className="px-3 py-2 text-right font-semibold">Duration</th>
                <th className="px-3 py-2 text-right font-semibold">Default fee</th>
                <th className="px-3 py-2 font-semibold">Color</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {app.treatmentTypes.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No treatment types yet.</td></tr>
              ) : app.treatmentTypes.map((t) => {
                const palette = colorClasses(t.color);
                return (
                  <tr key={t.id} className="border-b last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">{t.code}</td>
                    <td className="px-3 py-2 font-medium">{t.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{t.duration_minutes} min</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(t.default_fee)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className={cn("inline-block h-2 w-2 rounded-full", palette.dot)} />
                        <span className="capitalize text-muted-foreground">{t.color}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button size="icon" variant="ghost" aria-label={`Delete ${t.name}`} onClick={() => remove(t.id)}><Trash2 className="h-4 w-4 text-muted-foreground" /></Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Email (prescription delivery via Resend) ──────────────────────

function EmailTab() {
  const app = useApp();
  const [apiKey, setApiKey] = useState("");
  const [from, setFrom] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const data = await api<{ settings: Record<string, string> }>("GET", "/api/settings");
        setFrom(data.settings.email_from ?? "");
        setHasKey(Boolean((data.settings.email_api_key ?? "").trim()));
      } catch (err) {
        app.setError((err as Error).message);
      } finally {
        setLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const patch: Record<string, string> = { email_from: from.trim() };
      // Only send the key when the user typed one — the server never returns
      // it, so echoing back an empty value would silently clear it.
      if (apiKey.trim()) patch.email_api_key = apiKey.trim();
      await api("PUT", "/api/settings", patch);
      setHasKey(Boolean(apiKey.trim()) || hasKey);
      setApiKey("");
      setSavedAt(Date.now());
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-4 w-4" />
          Prescription email delivery
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Lets the prescription print view email the PDF straight to a patient.
          Uses the Resend email API — create a free API key at resend.com and
          verify the sending address or domain there first.
        </p>
      </CardHeader>
      <CardContent>
        {loaded ? (
          <form onSubmit={save} className="grid max-w-xl gap-3">
            <FieldGroup
              label="From address"
              hint="The verified sender, e.g. “Dental Canvas <prescriptions@yourclinic.com>”."
            >
              <Input
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder="Dental Canvas <prescriptions@yourclinic.com>"
              />
            </FieldGroup>
            <FieldGroup
              label={hasKey ? "API key — configured ✓ (enter a new key to replace)" : "Resend API key"}
              hint="Stored server-side only; never sent to the browser again."
            >
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={hasKey ? "•••••••• (configured)" : "re_…"}
                autoComplete="off"
              />
            </FieldGroup>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save email settings"}
              </Button>
              {savedAt && <span className="text-xs text-emerald-700">Saved ✓</span>}
            </div>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Daily worklist digest (Settings → Email) ────────────────────

function DigestTab() {
  const app = useApp();
  const [enabled, setEnabled] = useState(false);
  const [time, setTime] = useState("07:30");
  const [recipient, setRecipient] = useState("");
  const [sections, setSections] = useState<Record<string, boolean>>({ reminders: true, recalls: true, installments: true });
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [emailReady, setEmailReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const data = await api<{ settings: Record<string, string> }>("GET", "/api/settings");
        setEnabled((data.settings.digest_enabled ?? "") === "1");
        setTime(data.settings.digest_time || "07:30");
        setRecipient(data.settings.digest_recipient ?? "");
        // Empty/absent = all sections (the default before this existed).
        const saved = (data.settings.digest_sections ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        setSections({
          reminders: saved.length === 0 || saved.includes("reminders"),
          recalls: saved.length === 0 || saved.includes("recalls"),
          installments: saved.length === 0 || saved.includes("installments"),
        });
        setLastSent(data.settings.digest_last_sent || null);
        setEmailReady(Boolean((data.settings.email_api_key ?? "").trim()) && Boolean((data.settings.email_from ?? "").trim()));
      } catch (err) {
        app.setError((err as Error).message);
      } finally {
        setLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // Store only the enabled sections; all-on stores "" (the default).
      const wanted = (Object.entries(sections) as [string, boolean][]).filter(([, on]) => on).map(([id]) => id);
      await api("PUT", "/api/settings", {
        digest_enabled: enabled ? "1" : "",
        digest_time: time,
        digest_recipient: recipient.trim(),
        digest_sections: wanted.length === 3 ? "" : wanted.join(","),
      });
      toast.success("Digest schedule saved");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendNow() {
    setSending(true);
    setSendResult(null);
    try {
      const res = await api<{ counts: { reminders: number; recalls: number; installments: number } }>(
        "POST", "/api/email/worklist-digest", {},
      );
      const c = res.counts;
      const parts: string[] = [];
      if (sections.reminders) parts.push(`${c.reminders} reminder${c.reminders === 1 ? "" : "s"}`);
      if (sections.recalls) parts.push(`${c.recalls} recall${c.recalls === 1 ? "" : "s"}`);
      if (sections.installments) parts.push(`${c.installments} installment${c.installments === 1 ? "" : "s"}`);
      setSendResult({ ok: true, message: `Sent ✓ — ${parts.join(", ")}` });
      setLastSent(new Date().toISOString().slice(0, 19).replace("T", " "));
    } catch (err) {
      setSendResult({ ok: false, message: (err as Error).message });
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MailCheck className="h-4 w-4" />
          Daily worklist digest
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Every morning, email the clinic inbox one summary of the three outreach
          lists: tomorrow's appointment reminders, hygiene recalls due (30 days),
          and installments due (3 days). Requires the Resend settings above.
        </p>
      </CardHeader>
      <CardContent>
        {!loaded ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !emailReady ? (
          <p className="text-sm text-muted-foreground">
            Configure the Resend API key and from address above first — then the digest can send.
          </p>
        ) : (
          <form onSubmit={save} className="grid max-w-xl gap-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-input"
              />
              Send the daily digest email
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <FieldGroup label="Send at" hint="Local clinic time — the first device open after this sends it.">
                <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </FieldGroup>
              <FieldGroup label="Clinic inbox" hint="Where the digest is delivered.">
                <Input
                  type="email"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="reception@yourclinic.com"
                />
              </FieldGroup>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Sections in the email</Label>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {(
                  [
                    { id: "reminders", label: "Appointment reminders" },
                    { id: "recalls", label: "Hygiene recalls" },
                    { id: "installments", label: "Installments due" },
                  ] as const
                ).map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm font-normal">
                    <input
                      type="checkbox"
                      checked={sections[s.id]}
                      onChange={(e) => setSections((prev) => ({ ...prev, [s.id]: e.target.checked }))}
                      className="h-4 w-4 rounded border-input"
                    />
                    {s.label}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Untick a section to leave it out of the daily email entirely — the subject line and counts update to match.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save schedule"}</Button>
              <Button type="button" variant="outline" onClick={() => void sendNow()} disabled={sending || !recipient.trim()}>
                {sending ? "Sending…" : "Send now"}
              </Button>
              {lastSent && (
                <span className="text-xs text-muted-foreground">
                  Last sent {lastSent.slice(0, 16).replace("T", " ")}
                </span>
              )}
            </div>
            {sendResult && (
              <p className={cn("text-sm", sendResult.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>
                {sendResult.message}
              </p>
            )}
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function FieldGroup({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    // flex+gap, not space-y: Radix renders a hidden native <select> next to the
    // trigger, which space-y counts as a sibling and so leaves a 6px bottom
    // margin on the trigger. Inside an `items-end` row that made the column 6px
    // taller and lifted its label out of line with the neighbouring inputs.
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ColorSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {COLOR_TOKENS.map((c) => (
          <SelectItem key={c} value={c}>
            <div className="flex items-center gap-2">
              <span className={cn("inline-block h-2 w-2 rounded-full", colorClasses(c).dot)} />
              <span className="capitalize">{c}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Billing (invoice look & feel) ──────────────────────────────

const INVOICE_ACCENT_SWATCHES = [
  "#0e7490", // teal (default)
  "#0f766e", // pine
  "#1d4ed8", // royal blue
  "#6d28d9", // violet
  "#b91c1c", // crimson
  "#b45309", // amber
  "#be185d", // rose
  "#374151", // graphite
];

function InvoiceStyleTab() {
  const app = useApp();
  const [style, setStyle] = useState<InvoiceStyle>("classic");
  const [accent, setAccent] = useState("#0e7490");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [footerNote, setFooterNote] = useState("");
  const [showPayments, setShowPayments] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const data = await api<{ settings: Record<string, string> }>("GET", "/api/settings");
        const s = data.settings ?? {};
        if (INVOICE_STYLES.some((t) => t.id === s.invoice_style)) setStyle(s.invoice_style as InvoiceStyle);
        if (/^#[0-9a-fA-F]{6}$/.test(s.invoice_accent ?? "")) setAccent(s.invoice_accent);
        setPaymentTerms(s.invoice_payment_terms ?? "");
        setFooterNote(s.invoice_footer_note ?? "");
        setShowPayments((s.invoice_show_payments ?? "1") !== "0");
      } catch (err) {
        app.setError((err as Error).message);
      } finally {
        setLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSavedAt(null);
    try {
      await api("PUT", "/api/settings", {
        invoice_style: style,
        invoice_accent: accent,
        invoice_payment_terms: paymentTerms,
        invoice_footer_note: footerNote,
        invoice_show_payments: showPayments ? "1" : "0",
      });
      setSavedAt(Date.now());
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const sample = {
    invoice_id: 42,
    issued_at: new Date().toISOString(),
    status: "open",
    patient_name: "Alex Rivera",
    items: [
      { description: "Consultation & examination", quantity: 1, unit_price: 50 },
      { description: "Composite filling, tooth 26", quantity: 1, unit_price: 120 },
      { description: "Scaling & polishing", quantity: 1, unit_price: 70 },
    ],
    total: 240,
    amount_paid: 100,
    balance: 140,
    payments: [{ id: 1, paid_at: new Date().toISOString(), method: "Cash", note: "Deposit", amount: 100 }],
    clinic_name: app.profile.clinic_name,
    clinic_address: app.profile.clinic_address,
    clinic_phone: app.profile.doctor_phone,
    clinic_logo: app.profile.clinic_logo,
    doctor_name: app.profile.doctor_name || "Dr. Sarah",
    doctor_specialty: app.profile.doctor_specialty,
    doctor_license: app.profile.doctor_license,
    style,
    accent,
    payment_terms: paymentTerms,
    footer_note: footerNote,
    show_payments: showPayments,
  };

  return (
    <div className="space-y-4">
      <form onSubmit={save} className="space-y-4">
        {/* Style gallery — real scaled-down sheets, WYSIWYG. */}
        <div>
          <Label className="text-xs">Invoice style</Label>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {INVOICE_STYLES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setStyle(t.id)}
                className={cn(
                  "group relative overflow-hidden rounded-lg border-2 bg-white text-left transition-all",
                  style === t.id ? "border-primary shadow-md ring-2 ring-primary/20" : "border-transparent shadow-sm hover:shadow-md",
                )}
              >
                <div className="pointer-events-none h-[150px] w-full origin-top-left" style={{ width: "210mm", transform: "scale(0.24)", transformOrigin: "top left" }}>
                  <div aria-hidden style={{ filter: "saturate(0.85)", pointerEvents: "none" }}>
                    <InvoiceSheet data={{ ...sample, style: t.id }} />
                  </div>
                </div>
                <div className="border-t bg-card p-2">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-sm font-medium">{t.label}</span>
                    {style === t.id && <Check className="h-4 w-4 text-primary" />}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t.blurb}</p>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Accent color */}
        <div className="rounded-lg border p-3">
          <Label className="text-xs">Accent color</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">Colors the header, rules and totals on every invoice.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {INVOICE_ACCENT_SWATCHES.map((hex) => (
              <button
                key={hex}
                type="button"
                onClick={() => setAccent(hex)}
                title={hex}
                className={cn(
                  "h-8 w-8 rounded-full border-2 transition-transform",
                  accent.toLowerCase() === hex ? "scale-110 border-foreground shadow-md" : "border-transparent hover:scale-105",
                )}
                style={{ background: hex }}
              />
            ))}
            <label className="ml-1 inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              Custom
              <input
                type="color"
                value={accent}
                onChange={(e) => setAccent(e.target.value)}
                className="h-8 w-10 cursor-pointer rounded border bg-background"
              />
            </label>
            <span className="ml-auto font-mono text-xs text-muted-foreground">{accent}</span>
          </div>
        </div>

        {/* Terms + footer note */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Payment terms line</Label>
            <Textarea
              rows={2}
              value={paymentTerms}
              onChange={(e) => setPaymentTerms(e.target.value)}
              placeholder="e.g. Payment due within 14 days · Bank transfer details on request"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Footer note</Label>
            <Textarea
              rows={2}
              value={footerNote}
              onChange={(e) => setFooterNote(e.target.value)}
              placeholder="e.g. Thank you for choosing Bright Smile Dental"
            />
            <p className="text-xs text-muted-foreground">Empty = the standard thank-you line with clinic contact.</p>
          </div>
        </div>

        {/* Payment history visibility */}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showPayments}
            onChange={(e) => setShowPayments(e.target.checked)}
            className="h-4 w-4 rounded border-input accent-primary"
          />
          Show payment history on the invoice
        </label>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy}>
            Save invoice style
          </Button>
          {savedAt && <span className="text-xs text-emerald-700">Saved ✓</span>}
        </div>
      </form>

      {/* Full-size live preview of the CURRENT form values (not just saved). */}
      {loaded && (
        <div className="rounded-lg border p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Live preview</p>
          <div className="max-h-[600px] overflow-auto rounded bg-muted/40 p-4">
            <div className="mx-auto w-fit origin-top shadow-lg" style={{ transform: "scale(0.72)" }}>
              <InvoiceSheet data={sample} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Consent form templates (Settings) ─────────────────────────────

function ConsentTemplatesTab() {
  const app = useApp();
  const [templates, setTemplates] = useState<ConsentTemplate[]>([]);
  const [editing, setEditing] = useState<ConsentTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: "", body: "", requires_guardian: false });

  const load = async () => {
    try {
      const data = await api<{ templates: ConsentTemplate[] }>("GET", "/api/consent-templates");
      setTemplates(data.templates);
    } catch (err) {
      app.setError((err as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openNew = () => {
    setForm({ title: "", body: "", requires_guardian: false });
    setCreating(true);
    setEditing(null);
  };

  const openEdit = (t: ConsentTemplate) => {
    setForm({ title: t.title, body: t.body, requires_guardian: !!t.requires_guardian });
    setEditing(t);
    setCreating(false);
  };

  const save = async () => {
    const body = { title: form.title.trim(), body: form.body, requires_guardian: form.requires_guardian };
    if (!body.title || !body.body.trim()) return;
    try {
      if (editing) {
        await api("PUT", `/api/consent-templates/${editing.id}`, body);
        toast.success("Template updated");
      } else {
        await api("POST", "/api/consent-templates", body);
        toast.success("Template created");
      }
      setEditing(null);
      setCreating(false);
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const remove = async (t: ConsentTemplate) => {
    if (!confirm(`Delete template "${t.title}"? Signed forms already on record are kept.`)) return;
    try {
      await api("DELETE", `/api/consent-templates/${t.id}`);
      toast.info("Template deleted");
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Consent form templates</CardTitle>
        <Button size="sm" onClick={openNew}><Plus className="mr-1 h-3.5 w-3.5" /> New template</Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {!templates.length ? (
          <p className="text-sm text-muted-foreground">
            No templates yet. Create reusable forms (anesthesia consent, extraction consent, HIPAA acknowledgment…) that get signed on a tablet at check-in.
          </p>
        ) : (
          templates.map((t) => (
            <div key={t.id} className="flex items-start justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0">
                <div className="font-medium">
                  {t.title}
                  {t.requires_guardian ? <span className="ml-2 text-xs text-muted-foreground">(guardian required)</span> : null}
                  {!t.active && <span className="ml-2 text-xs text-muted-foreground">(inactive)</span>}
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{t.body}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Edit ${t.title}`} onClick={() => openEdit(t)}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" aria-label={`Delete ${t.title}`} onClick={() => remove(t)}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
          ))
        )}

        {(creating || editing) && (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Local anesthesia consent" />
            </div>
            <div className="space-y-1.5">
              <Label>Form text</Label>
              <Textarea rows={8} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="I understand that… risks include…" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.requires_guardian}
                onChange={(e) => setForm({ ...form, requires_guardian: e.target.checked })}
                className="h-4 w-4 rounded border-input"
              />
              Requires a parent/guardian signature
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { setCreating(false); setEditing(null); }}>Cancel</Button>
              <Button size="sm" onClick={save} disabled={!form.title.trim() || !form.body.trim()}>{editing ? "Save changes" : "Create template"}</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

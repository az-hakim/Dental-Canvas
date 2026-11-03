import { useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Cloud,
  CloudOff,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import { useAuth } from "@/auth";
import { useApp } from "@/context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Mode = "choose" | "signup" | "signin" | "reset" | "confirm";

/**
 * Sign up / sign in / skip, shared by first-run onboarding and Settings.
 *
 * Skipping writes `accountMode = offline` so onboarding never asks again. The
 * app keeps reading and writing the local store exactly as before.
 */
export function AccountStep({
  onDone,
  showSkip = true,
  initialMode = "choose",
  compact = false,
}: {
  onDone: () => void;
  showSkip?: boolean;
  initialMode?: Mode;
  compact?: boolean;
}) {
  const auth = useAuth();
  const app = useApp();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function reset() {
    setError(null);
    setNotice(null);
    setPassword("");
    setConfirm("");
  }

  function skip() {
    auth.setAccountMode("offline");
    onDone();
  }

  async function submitSignUp(e: React.FormEvent) {
    e.preventDefault();
    reset();
    if (!email.trim()) return setError("Enter your email address.");
    if (password.length < 8) return setError("Use a password with at least 8 characters.");
    if (password !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    try {
      const result = await auth.signUp(email, password, {
        doctor_name: app.profile.doctor_name,
        clinic_name: app.profile.clinic_name,
      });
      if (result.needsConfirmation) {
        setMode("confirm");
        setNotice(`We sent a confirmation link to ${email.trim()}. Open it, then sign in here.`);
      } else {
        onDone();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitSignIn(e: React.FormEvent) {
    e.preventDefault();
    reset();
    if (!email.trim() || !password) return setError("Enter your email and password.");
    setBusy(true);
    try {
      await auth.signIn(email, password);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault();
    reset();
    if (!email.trim()) return setError("Enter your email address.");
    setBusy(true);
    try {
      await auth.resetPassword(email);
      setNotice("If that email has an account, a password reset link is on its way.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!auth.cloudAvailable) {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-4">
          <CloudOff className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="text-sm">
            <p className="font-medium">Cloud sync isn't configured in this build</p>
            <p className="mt-1 text-muted-foreground">
              Dental Canvas works fully offline — nothing changes. A clinic administrator
              can enable accounts by setting the Supabase environment variables.
            </p>
          </div>
        </div>
        <Button type="button" onClick={onDone} className="w-full">
          Continue offline
        </Button>
      </div>
    );
  }

  if (mode === "confirm") {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-100">
          <Mail className="mt-0.5 h-5 w-5 shrink-0" />
          <p className="text-sm">{notice}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button className="flex-1" onClick={() => { setMode("signin"); reset(); }}>
            I've confirmed — sign in
          </Button>
          <Button variant="outline" className="flex-1" onClick={onDone}>
            Skip for now
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Didn't get the email? Check spam, or use “Forgot password” on the sign-in form to
          try again.
        </p>
      </div>
    );
  }

  if (mode === "reset") {
    return (
      <form onSubmit={submitReset} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="account-reset-email">Email</Label>
          <Input
            id="account-reset-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@clinic.com"
            autoFocus
          />
        </div>
        {notice && (
          <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">
            {notice}
          </p>
        )}
        {error && <ErrorLine message={error} />}
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => { setMode("signin"); reset(); }}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          <Button type="submit" className="flex-1" disabled={busy}>
            {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</> : "Send reset link"}
          </Button>
        </div>
      </form>
    );
  }

  if (mode === "signin" || mode === "signup") {
    const signingUp = mode === "signup";
    return (
      <form onSubmit={signingUp ? submitSignUp : submitSignIn} className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Cloud className="h-4 w-4 text-primary" />
          {signingUp ? "Create your account" : "Sign in to your account"}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="account-email">Email</Label>
          <Input
            id="account-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@clinic.com"
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="account-password">Password</Label>
          <Input
            id="account-password"
            type="password"
            autoComplete={signingUp ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={signingUp ? "At least 8 characters" : "Your password"}
          />
        </div>
        {signingUp && (
          <div className="space-y-1.5">
            <Label htmlFor="account-confirm">Confirm password</Label>
            <Input
              id="account-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
        )}
        {error && <ErrorLine message={error} />}
        {notice && (
          <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">
            {notice}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> {signingUp ? "Creating…" : "Signing in…"}</>
          ) : signingUp ? (
            "Create account"
          ) : (
            "Sign in"
          )}
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <button
            type="button"
            className="text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => { setMode(signingUp ? "signin" : "signup"); reset(); }}
          >
            {signingUp ? "I already have an account" : "Create an account instead"}
          </button>
          {!signingUp && (
            <button
              type="button"
              className="text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => { setMode("reset"); reset(); }}
            >
              Forgot password?
            </button>
          )}
        </div>
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Your practice data is stored in your Supabase project with row-level security:
          only your account can read or change it.
        </p>
      </form>
    );
  }

  return (
    <div className={cn("space-y-4", compact && "space-y-3")}>
      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="button" onClick={() => { setMode("signup"); reset(); }} className="w-full">
          <UserPlus className="h-4 w-4" /> Sign up
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => { setMode("signin"); reset(); }}
          className="w-full"
        >
          Sign in
        </Button>
      </div>
      <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
        <span>
          Signing in backs up your patients, appointments and billing to the cloud and keeps
          your other devices in sync. You can also do this later in Settings → Account.
        </span>
      </div>
      {showSkip && (
        <button
          type="button"
          onClick={skip}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent/40 hover:text-foreground"
        >
          <CloudOff className="h-4 w-4" />
          Skip, keep data offline only
        </button>
      )}
      <p className="text-center text-xs text-muted-foreground">
        Skipping keeps everything on this device. The app is fully usable without an account.
      </p>
    </div>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200"
    >
      {message}
    </p>
  );
}

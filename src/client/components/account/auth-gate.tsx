import { Loader2, ShieldCheck, Stethoscope } from "lucide-react";
import { useAuth } from "@/auth";
import { AccountStep } from "./account-step";

/**
 * Sign-in gate for a hosted, multi-tenant deployment.
 *
 * Each clinic's data lives in its own tenant namespace on the server, so the
 * practice can only be shown once the server knows which clinic the caller
 * belongs to. Offline and self-hosted builds never render this.
 */
export function AuthGate() {
  const auth = useAuth();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-gradient-to-br from-primary/10 via-background to-background p-4">
      <div className="w-full max-w-md">
        <div className="mb-4 flex items-center gap-2.5 px-1">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/25">
            <Stethoscope className="h-5 w-5" />
          </span>
          <div>
            <p className="text-lg font-semibold tracking-tight">Dental Canvas</p>
            <p className="text-xs text-muted-foreground">Practice management in the browser</p>
          </div>
        </div>

        <div className="rounded-2xl border bg-card p-6 shadow-2xl">
          {auth.status === "loading" ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking your session…
            </div>
          ) : auth.cloudAvailable ? (
            <>
              <h1 className="text-xl font-semibold tracking-tight">Sign in to your practice</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Your clinic's patients and appointments are private to your account.
              </p>
              <div className="mt-5">
                <AccountStep onDone={() => undefined} showSkip={false} initialMode="signin" />
              </div>
            </>
          ) : (
            <div className="space-y-2 text-sm">
              <h1 className="text-lg font-semibold tracking-tight">Sign-in is not configured</h1>
              <p className="text-muted-foreground">
                This deployment requires an account, but no authentication provider is configured.
                An administrator needs to set <code className="rounded bg-muted px-1">SUPABASE_URL</code>{" "}
                and <code className="rounded bg-muted px-1">SUPABASE_ANON_KEY</code> in the server
                environment. The app reads them from there.
              </p>
            </div>
          )}
        </div>

        <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5" />
          Each practice's data is isolated on the server.
        </p>
      </div>
    </div>
  );
}

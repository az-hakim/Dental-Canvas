import { useEffect, useState } from "react";
import { HardDrive, Loader2, ShieldCheck, Stethoscope } from "lucide-react";
import { useAuth } from "@/auth";
import { Button } from "@/components/ui/button";
import { isTauriDesktop } from "@/offline/activate";
import { hasLocalPracticeDatabase, useThisComputer } from "@/lib/local-practice";
import { AccountStep } from "./account-step";

/**
 * Sign-in gate for a hosted, multi-tenant deployment.
 *
 * Each clinic's data lives in its own tenant namespace on the server, so the
 * practice can only be shown once the server knows which clinic the caller
 * belongs to. Offline and self-hosted builds never render this.
 *
 * One exception, and it is the reason this screen checks the disk: a desktop
 * install that ran its own backend before the installer started shipping
 * pointed at the hosted practice still holds that practice's database. Updating
 * into a sign-in gate with no door back to it would lock a clinic out of its
 * own records, so when such a database is found the gate offers to open it.
 */
export function AuthGate() {
  const auth = useAuth();
  const [localPractice, setLocalPractice] = useState(false);

  useEffect(() => {
    // Only a desktop shell can run the bundled backend; in a browser this
    // probe would find nothing (or, worse, a dropdown from a URL that has
    // since become the hosted practice).
    if (!isTauriDesktop()) return;
    let alive = true;
    void hasLocalPracticeDatabase().then((found) => {
      if (alive) setLocalPractice(found);
    });
    return () => {
      alive = false;
    };
  }, []);

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

        {localPractice && (
          <div className="mt-3 rounded-2xl border border-dashed border-primary/40 bg-card/80 p-4 shadow-sm backdrop-blur">
            <p className="flex items-center gap-2 text-sm font-medium">
              <HardDrive className="h-4 w-4 shrink-0 text-primary" />
              This computer already has its own practice records
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              An earlier version of Dental Canvas kept the practice database on this computer. It is
              still here: you can keep working in it without an account, and nothing is uploaded or
              deleted.
            </p>
            <Button
              variant="outline"
              className="mt-3 w-full gap-2 rounded-full"
              onClick={() => {
                useThisComputer();
                window.location.reload();
              }}
            >
              <HardDrive className="h-4 w-4" />
              Open this computer's records
            </Button>
          </div>
        )}

        <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5" />
          Each practice's data is isolated on the server.
        </p>
      </div>
    </div>
  );
}

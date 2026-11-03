import { useState } from "react";
import { Loader2, LockKeyhole, Trash2, UserRoundX } from "lucide-react";
import { useAuth } from "@/auth";
import { httpLocalSyncApi } from "@/lib/sync/local-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Opaque takeover shown when a different account signs in on a device that
 * already holds another account's local practice data.
 *
 * The local data is not deleted implicitly (sign-out never is), but it must not
 * be visible to the new account either — that would expose another practice's
 * patients. The doctor either signs out or explicitly clears the device.
 */
export function AccountConflictScreen() {
  const auth = useAuth();
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!auth.accountConflict || !auth.user) return null;

  async function removeLocalAndContinue() {
    if (confirm.trim().toUpperCase() !== "DELETE") return;
    setBusy(true);
    setError(null);
    try {
      // Clear the other account's local rows, then let the engine claim this
      // device for the signed-in account and pull that account's data.
      await httpLocalSyncApi.wipe();
      const status = await auth.syncNow();
      if (status?.phase === "error") {
        setError(status.error ?? "Sync failed. Try again, or sign out.");
      } else {
        setConfirm("");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError(null);
    try {
      await auth.signOut();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-conflict-title"
      className="fixed inset-0 z-[70] flex items-center justify-center overflow-hidden bg-background p-4"
    >
      <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl">
        <div className="border-b bg-gradient-to-br from-rose-500/10 to-transparent px-6 pb-5 pt-6">
          <div className="flex items-center gap-2 text-sm font-medium text-rose-700 dark:text-rose-300">
            <LockKeyhole className="h-4 w-4" /> Patient privacy
          </div>
          <h1 id="account-conflict-title" className="mt-2 text-xl font-semibold tracking-tight">
            This device belongs to another account
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            You're signed in as <span className="font-medium text-foreground">{auth.user.email}</span>,
            but the local data on this device is linked to a different cloud account. It is
            hidden to protect that practice's patients.
          </p>
        </div>

        <div className="force-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="rounded-lg border bg-muted/30 p-4 text-sm">
            <p className="font-medium">Use this account on this device</p>
            <p className="mt-1 text-muted-foreground">
              This permanently removes the other account's local rows from this device. Its
              cloud backup is not touched. Type <span className="font-mono">DELETE</span> to
              confirm.
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="account-conflict-confirm">Type DELETE</Label>
                <Input
                  id="account-conflict-confirm"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={busy}
                />
              </div>
              <Button
                variant="destructive"
                disabled={busy || confirm.trim().toUpperCase() !== "DELETE"}
                onClick={() => void removeLocalAndContinue()}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Remove local data &amp; continue
              </Button>
            </div>
          </div>

          <div className="rounded-lg border p-4 text-sm">
            <p className="font-medium">Use the other account instead</p>
            <p className="mt-1 text-muted-foreground">
              Sign out here and sign back in with the account this device belongs to. All
              local data is kept.
            </p>
            <Button variant="outline" className="mt-3" disabled={busy} onClick={() => void signOut()}>
              <UserRoundX className="h-4 w-4" /> Sign out
            </Button>
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200"
            >
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

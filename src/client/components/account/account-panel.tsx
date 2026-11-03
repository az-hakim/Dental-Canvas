import { useState } from "react";
import {
  AlertTriangle,
  Cloud,
  CloudOff,
  HardDrive,
  Loader2,
  LogOut,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useAuth } from "@/auth";
import { useSyncStatus } from "@/hooks/use-sync-status";
import { httpLocalSyncApi } from "@/lib/sync/local-api";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AccountStep } from "./account-step";
import { SyncStatusBadge } from "./sync-status";

/**
 * Settings → Account. Optional by design: offline-only installs see an
 * explanation, never a blocker.
 */
export function AccountPanel() {
  const auth = useAuth();
  const status = useSyncStatus();
  const [form, setForm] = useState<"signup" | "signin" | null>(null);
  const [signOutRemoveOpen, setSignOutRemoveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [removeLocalOnDelete, setRemoveLocalOnDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!auth.cloudAvailable) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CloudOff className="h-4 w-4" /> Cloud account
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            This build has no Supabase configuration, so accounts and cloud sync are
            unavailable. Dental Canvas keeps running fully offline on this device.
          </p>
        </CardHeader>
        <CardContent>
          <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            A clinic administrator can set <code>VITE_SUPABASE_URL</code> and{" "}
            <code>VITE_SUPABASE_ANON_KEY</code> before building to enable optional
            accounts. See the README.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (auth.status === "loading") {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking your account…
        </CardContent>
      </Card>
    );
  }

  // ── Signed out ───────────────────────────────────────────────────
  if (!auth.user) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CloudOff className="h-4 w-4" /> Offline mode
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Your data lives only on this device right now. Create an account or sign in
              to back it up and sync it to your other devices. Everything keeps working
              while you're offline.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <SyncStatusBadge status={status} />
              {auth.accountMode === "offline" && (
                <span className="text-xs text-muted-foreground">
                  You chose offline-only during setup.
                </span>
              )}
            </div>

            {form ? (
              <div className="rounded-lg border bg-card p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-medium">
                    {form === "signup" ? "Create an account" : "Sign in"}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setForm(null)}
                  >
                    Cancel
                  </Button>
                </div>
                <AccountStep
                  showSkip={false}
                  initialMode={form}
                  onDone={() => setForm(null)}
                />
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setForm("signup")}>
                  <Cloud className="h-4 w-4" /> Sign up
                </Button>
                <Button variant="outline" onClick={() => setForm("signin")}>
                  Sign in
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="h-4 w-4" /> This device
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Local data is kept until you explicitly remove it. Signing out or staying
              offline never deletes patients or appointments.
            </p>
          </CardHeader>
        </Card>
      </div>
    );
  }

  // ── Signed in ────────────────────────────────────────────────────
  async function syncNow() {
    const next = await auth.syncNow();
    if (!next) return;
    if (next.phase === "error") toast.error(next.error ?? "Sync failed — it will retry.");
    else toast.success("Sync finished");
  }

  async function signOut() {
    setBusy(true);
    setError(null);
    try {
      await auth.signOut();
      setForm(null);
      toast.success("Signed out. Your data stays on this device.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function signOutAndRemoveLocal() {
    if (confirmText.trim().toUpperCase() !== "DELETE") return;
    setBusy(true);
    setError(null);
    try {
      // Stop sync first, then clear the store — otherwise an in-flight pull
      // could re-insert rows after the wipe.
      await auth.signOut();
      await httpLocalSyncApi.wipe();
      setSignOutRemoveOpen(false);
      toast.success("Local data removed from this device.");
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    if (confirmText.trim().toUpperCase() !== "DELETE") return;
    setBusy(true);
    setError(null);
    try {
      await auth.deleteAccount(removeLocalOnDelete);
      setDeleteOpen(false);
      toast.success("Your cloud account and data were deleted.");
      if (!removeLocalOnDelete) setConfirmText("");
      else window.location.reload();
    } catch (err) {
      setError(auth.accountError ?? (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cloud className="h-4 w-4" /> Cloud account
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Your data is backed up to Supabase and synced across the devices you sign in
            on. This device stays fully usable offline.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Email</p>
              <p className="truncate font-medium">{auth.user.email ?? "—"}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Last sync
              </p>
              <p className="font-medium">
                {status.lastSyncAt
                  ? new Date(status.lastSyncAt).toLocaleString()
                  : "Not yet synced on this device"}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <SyncStatusBadge status={status} />
            {status.pending > 0 && (
              <span className="text-xs text-muted-foreground">
                {status.pending} {status.pending === 1 ? "change" : "changes"} waiting to
                upload
              </span>
            )}
          </div>

          {status.phase === "error" && status.error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {status.error}
            </p>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200"
            >
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void syncNow()}
              disabled={busy || status.phase === "syncing"}
            >
              <RefreshCw
                className={`h-4 w-4 ${status.phase === "syncing" ? "animate-spin" : ""}`}
              />
              Sync now
            </Button>
            <Button variant="outline" onClick={() => void signOut()} disabled={busy}>
              <LogOut className="h-4 w-4" /> Sign out
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Signing out keeps every local patient and appointment on this device.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-4 w-4" /> This device
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Removing local data deletes this device's copy only. Your cloud backup stays
            available if you sign in again.
          </p>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            className="border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/40"
            onClick={() => {
              setConfirmText("");
              setSignOutRemoveOpen(true);
            }}
            disabled={busy}
          >
            <Trash2 className="h-4 w-4" /> Sign out and remove local data…
          </Button>
        </CardContent>
      </Card>

      <Card className="border-rose-200 dark:border-rose-900">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-rose-700 dark:text-rose-300">
            <ShieldAlert className="h-4 w-4" /> Delete cloud account
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Permanently deletes your Supabase account and every synced row (patients,
            appointments, billing, prescriptions). This cannot be undone.
          </p>
        </CardHeader>
        <CardContent>
          <Button
            variant="destructive"
            onClick={() => {
              setConfirmText("");
              setRemoveLocalOnDelete(false);
              setDeleteOpen(true);
            }}
            disabled={busy}
          >
            <Trash2 className="h-4 w-4" /> Delete my cloud account and data…
          </Button>
        </CardContent>
      </Card>

      {/* Sign out + remove local data */}
      <Dialog open={signOutRemoveOpen} onOpenChange={setSignOutRemoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign out and remove local data?</DialogTitle>
            <DialogDescription>
              This deletes this device's patients, appointments, billing and clinical
              records. Your cloud backup is kept. Type DELETE to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-remove-local">Type DELETE</Label>
            <Input
              id="confirm-remove-local"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSignOutRemoveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || confirmText.trim().toUpperCase() !== "DELETE"}
              onClick={() => void signOutAndRemoveLocal()}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Remove local data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete cloud account */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete your cloud account and data?</DialogTitle>
            <DialogDescription>
              Your Supabase account and all synced practice data are permanently deleted.
              This cannot be undone. Type DELETE to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="confirm-delete-account">Type DELETE</Label>
            <Input
              id="confirm-delete-account"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoFocus
            />
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
                checked={removeLocalOnDelete}
                onChange={(e) => setRemoveLocalOnDelete(e.target.checked)}
              />
              <span>
                Also remove data from this device
                <span className="block text-xs text-muted-foreground">
                  Leave unchecked to keep your local records.
                </span>
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || confirmText.trim().toUpperCase() !== "DELETE"}
              onClick={() => void deleteAccount()}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete cloud account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

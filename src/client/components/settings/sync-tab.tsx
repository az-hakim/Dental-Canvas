import { useState } from "react";
import {
  AlertTriangle,
  Cloud,
  CloudOff,
  Clock,
  HardDrive,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "@/auth";
import { useSyncOptions } from "@/hooks/use-sync-options";
import { useSyncStatus } from "@/hooks/use-sync-status";
import {
  SYNC_INTERVAL_CHOICES,
  writeSyncOptions,
} from "@/lib/sync/options";
import { SYNC_TABLES } from "../../../shared/sync-schema";
import { SYNC_CATEGORIES } from "../../../shared/sync-categories";
import { SyncStatusBadge } from "@/components/account/sync-status";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Settings → Cloud sync. Owns the doctor-facing sync controls: what is
 * synced, when it syncs automatically, and a manual "Sync now". The status
 * badge, sign-in and account deletion stay in Settings → Account.
 */
export function SyncTab() {
  const auth = useAuth();
  const status = useSyncStatus();
  const options = useSyncOptions();
  const [busy, setBusy] = useState(false);

  if (!auth.cloudAvailable) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CloudOff className="h-4 w-4" /> Cloud sync isn't configured
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            This build has no Supabase configuration, so nothing leaves this device.
            Dental Canvas keeps working fully offline.
          </p>
        </CardHeader>
        <CardContent>
          <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            A clinic administrator can set <code>VITE_SUPABASE_URL</code> and{" "}
            <code>VITE_SUPABASE_ANON_KEY</code> before building to enable optional
            cloud sync. See the README.
          </p>
        </CardContent>
      </Card>
    );
  }

  async function syncNow() {
    setBusy(true);
    try {
      const next = await auth.syncNow();
      if (!next) return;
      if (next.phase === "error") toast.error(next.error ?? "Sync failed — it will retry.");
      else toast.success("Sync finished");
    } finally {
      setBusy(false);
    }
  }

  const syncing = status.phase === "syncing";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4" /> Sync status
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Your practice data is copied to your own Supabase project and pulled onto
            every device you sign in on. This device is always the source of truth while
            you work, so the clinic never waits on the network.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <SyncStatusBadge status={status} />
            <span className="truncate text-xs text-muted-foreground">
              {auth.user?.email ?? "Not signed in on this device"}
            </span>
          </div>

          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Last sync
              </dt>
              <dd className="font-medium">
                {status.lastSyncAt
                  ? new Date(status.lastSyncAt).toLocaleString()
                  : "Not yet synced on this device"}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Waiting to upload
              </dt>
              <dd className="font-medium">
                {status.pending === 1 ? "1 change" : `${status.pending} changes`}
              </dd>
            </div>
          </dl>

          {status.phase === "error" && status.error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {status.error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void syncNow()} disabled={!auth.user || busy || syncing}>
              <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
              Sync now
            </Button>
            {!auth.user && (
              <span className="text-xs text-muted-foreground">
                Sign in from <span className="font-medium">Settings → Account</span> to
                start syncing.
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4" /> Automatic sync
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Applies to this device. Edits are still written locally first and queued for
            upload, so nothing is lost while automatic sync is paused.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <span>
              <span className="block text-sm font-medium">Sync automatically</span>
              <span className="block text-xs text-muted-foreground">
                Upload edits, listen for changes from other devices and check for updates
                in the background.
              </span>
            </span>
            <input
              type="checkbox"
              className="h-5 w-5 accent-[var(--primary)]"
              checked={options.autoSync}
              onChange={(e) => writeSyncOptions({ autoSync: e.target.checked })}
            />
          </label>

          <div className="space-y-1.5">
            <Label htmlFor="sync-interval">Check for other devices&apos; changes every</Label>
            <Select
              value={String(options.intervalMinutes)}
              onValueChange={(v) => writeSyncOptions({ intervalMinutes: Number(v) })}
              disabled={!options.autoSync}
            >
              <SelectTrigger id="sync-interval" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SYNC_INTERVAL_CHOICES.map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    {m === 60 ? "60 minutes" : m === 1 ? "1 minute" : `${m} minutes`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Live changes normally arrive instantly; this poll is the fallback for
              networks where realtime updates are blocked. A slower interval saves
              battery and data on mobile.
            </p>
          </div>

          {!options.autoSync && (
            <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Automatic sync is off. Use <span className="font-medium">Sync now</span>{" "}
              above to upload queued changes and pull the latest from your other devices.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> What syncs
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            All {SYNC_TABLES.length} record types of practice data sync to your Supabase
            project, readable only by your signed-in account (row-level security).
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {SYNC_CATEGORIES.map((cat) => (
            <div key={cat.label} className="rounded-lg border p-3">
              <p className="text-sm font-medium">
                {cat.label}{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  {cat.tables.length} record {cat.tables.length === 1 ? "type" : "types"}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">{cat.description}</p>
            </div>
          ))}

          <div className="flex items-start gap-2 rounded-lg border border-dashed p-3">
            <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Stays on this device:</span>{" "}
              clinic settings (email and storage credentials), local backup files and the
              image files themselves. Everything else in the list above syncs.
            </p>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-dashed p-3">
            <Cloud className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              Sign out, delete your cloud account and remove this device&apos;s copy from{" "}
              <span className="font-medium text-foreground">Settings → Account</span>.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

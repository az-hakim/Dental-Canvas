import { AlertTriangle, CheckCircle2, CloudOff, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SyncStatus } from "@/lib/sync/types";

/** Human-readable, non-technical sync state shared by the shell + Settings. */
export function syncStatusText(status: SyncStatus): string {
  switch (status.phase) {
    case "syncing":
      return "Syncing…";
    case "offline":
      return "Offline — saved on this device";
    case "error":
      return "Sync problem";
    case "unavailable":
      return "Cloud sync not configured";
    case "signed-out":
      return "Signed out";
    case "idle":
      return status.lastSyncAt ? "Synced" : "Ready to sync";
    default:
      return "Cloud sync";
  }
}

function toneClasses(phase: SyncStatus["phase"], synced: boolean): string {
  switch (phase) {
    case "syncing":
      return "border-sky-300/60 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-200";
    case "error":
      return "border-rose-300/60 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200";
    case "offline":
      return "border-amber-300/60 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200";
    case "idle":
      return synced
        ? "border-emerald-300/60 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200"
        : "border-border bg-muted text-muted-foreground";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

/** Compact pill for Settings → Account. */
export function SyncStatusBadge({
  status,
  className,
}: {
  status: SyncStatus;
  className?: string;
}) {
  const Icon =
    status.phase === "syncing"
      ? Loader2
      : status.phase === "error"
        ? AlertTriangle
        : status.phase === "offline" || status.phase === "unavailable"
          ? CloudOff
          : status.phase === "idle" && status.lastSyncAt
            ? CheckCircle2
            : RefreshCw;
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        toneClasses(status.phase, Boolean(status.lastSyncAt)),
        className,
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", status.phase === "syncing" && "animate-spin")} />
      {syncStatusText(status)}
      {status.pending > 0 && status.phase !== "syncing" && (
        <span className="tabular-nums opacity-80">· {status.pending} waiting</span>
      )}
    </span>
  );
}

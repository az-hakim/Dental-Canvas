import { AlertTriangle, CheckCircle2, CloudOff, Loader2, RefreshCw } from "lucide-react";
import { useAuth } from "@/auth";
import { useSyncStatus } from "@/hooks/use-sync-status";
import { cn } from "@/lib/utils";
import { syncStatusText } from "./sync-status";

/**
 * Small, non-blocking cloud state in the app shell. Signed-out/offline-only
 * installs see nothing, exactly as before accounts existed.
 *
 * Navigation is passed in rather than using `useRouter` here: each call to
 * that hook has its own route state, so pushing a URL from a second instance
 * would move the address bar without re-rendering the app shell.
 */
export function SyncIndicator({ compact = false, onOpenSettings }: { compact?: boolean; onOpenSettings: () => void }) {
  const auth = useAuth();
  const status = useSyncStatus();

  if (!auth.cloudAvailable || !auth.user) return null;

  const phase = status.phase;
  const Icon =
    phase === "syncing"
      ? Loader2
      : phase === "error"
        ? AlertTriangle
        : phase === "offline"
          ? CloudOff
          : phase === "idle" && status.lastSyncAt
            ? CheckCircle2
            : RefreshCw;
  const label = syncStatusText(status);
  const tone =
    phase === "syncing"
      ? "text-sky-600 dark:text-sky-400"
      : phase === "error"
        ? "text-rose-600 dark:text-rose-400"
        : phase === "offline"
          ? "text-amber-600 dark:text-amber-400"
          : phase === "idle" && status.lastSyncAt
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-muted-foreground";

  return (
    <button
      type="button"
      onClick={onOpenSettings}
      title={`${label}${status.error ? ` — ${status.error}` : ""} · open Settings → Account`}
      aria-label={`Cloud sync: ${label}. Open account settings.`}
      className={cn(
        "flex items-center justify-center rounded-2xl transition-colors hover:bg-primary/[0.07]",
        compact ? "h-10 w-10" : "h-9 w-9",
      )}
    >
      <Icon className={cn("h-[18px] w-[18px]", tone, phase === "syncing" && "animate-spin")} />
    </button>
  );
}

import { useAuth } from "../auth";
import type { SyncStatus } from "../lib/sync/types";

/** Non-blocking sync state for the shell indicator and Settings → Account. */
export function useSyncStatus(): SyncStatus {
  return useAuth().syncStatus;
}

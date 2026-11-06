import { useSyncExternalStore } from "react";
import { getSyncOptions, subscribeSyncOptions, type SyncOptions } from "../lib/sync/options";

/** Live sync preferences for Settings → Cloud sync and the sync lifecycle. */
export function useSyncOptions(): SyncOptions {
  return useSyncExternalStore(subscribeSyncOptions, getSyncOptions, getSyncOptions);
}

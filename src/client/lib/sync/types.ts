/** Shared contracts for the local-first cloud sync engine. */

export interface SyncCursor {
  updated_at: string;
  sync_id: string | null;
}

export interface LocalSyncMeta {
  owner_user_id: string | null;
  last_pull_at: string | null;
  last_push_at: string | null;
  pending_changes: number;
  conflicts: number;
  cursors: Record<string, SyncCursor>;
}

export interface PendingChange {
  entity: string;
  op: "upsert" | "delete";
  sync_id: string | null;
  outbox_ids: number[];
  base_updated_at: string | null;
  payload?: Record<string, unknown>;
}

export interface SnapshotChunk {
  entity: string;
  rows: Record<string, unknown>[];
  next_after: number | null;
}

export interface RemoteChange {
  entity: string;
  op: "upsert" | "delete";
  row?: Record<string, unknown>;
}

export interface ApplyResult {
  applied: number;
  skipped: number;
  deferred: number;
  conflicts: number;
}

export interface LocalDataSummary {
  has_user_data: boolean;
  counts: Record<string, number>;
}

export interface LocalConflict {
  entity: string;
  sync_id: string | null;
  resolution: string;
  local?: unknown;
  remote?: unknown;
}

export type ClaimResult =
  | { ok: true; owner_user_id: string }
  | { ok: false; reason: string; owner_user_id: string };

/** All local-side operations the engine needs (HTTP in production, fake in tests). */
export interface LocalSyncApi {
  meta(): Promise<LocalSyncMeta>;
  claim(userId: string): Promise<ClaimResult>;
  /** Sign-out: stop syncing but keep rows, queued edits and the account claim. */
  release(): Promise<void>;
  /** Account deleted: unclaim the device without deleting rows. */
  forgetAccount(): Promise<void>;
  pending(limit?: number): Promise<{ changes: PendingChange[]; hasMore: boolean }>;
  ack(ids: number[], pushed?: boolean): Promise<void>;
  snapshot(entity: string, after: number, limit?: number): Promise<SnapshotChunk>;
  apply(
    changes: RemoteChange[],
    opts?: { push?: boolean; cursors?: Record<string, SyncCursor> },
  ): Promise<ApplyResult>;
  summary(): Promise<LocalDataSummary>;
  preparePull(): Promise<{ ok: boolean; reason?: string }>;
  wipe(): Promise<void>;
  conflict(input: LocalConflict): Promise<void>;
}

export type CloudRow = Record<string, unknown> & {
  sync_id: string;
  updated_at: string;
  deleted_at?: string | null;
};

/** Supabase-facing operations. Only the anon key is used. */
export interface CloudSyncAdapter {
  userId: string;
  isAccountInitialized(): Promise<boolean>;
  markAccountInitialized(): Promise<void>;
  pushUpserts(entity: string, rows: Record<string, unknown>[]): Promise<CloudRow[]>;
  softDelete(entity: string, syncIds: string[]): Promise<CloudRow[]>;
  pull(entity: string, cursor: SyncCursor | null, limit?: number): Promise<CloudRow[]>;
  remoteTimestamps(
    entity: string,
    syncIds: string[],
  ): Promise<{ sync_id: string; updated_at: string; deleted_at: string | null }[]>;
  /** Realtime nudge; returns an unsubscribe function. */
  subscribe(onChange: () => void): () => void;
}

export type SyncPhase =
  | "unavailable"
  | "signed-out"
  | "idle"
  | "syncing"
  | "offline"
  | "error";

export interface SyncStatus {
  phase: SyncPhase;
  lastSyncAt: number | null;
  pending: number;
  error: string | null;
}

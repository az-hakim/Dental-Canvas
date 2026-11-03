/**
 * HTTP implementation of LocalSyncApi — talks to this device's own Hono
 * server, which works in the browser (wrangler), the desktop service worker,
 * and the mobile in-page server alike.
 */
import type {
  ApplyResult,
  ClaimResult,
  LocalConflict,
  LocalDataSummary,
  LocalSyncApi,
  LocalSyncMeta,
  PendingChange,
  RemoteChange,
  SnapshotChunk,
  SyncCursor,
} from "./types";

export class LocalSyncHttpError extends Error {
  status: number;
  code?: string;
  payload?: unknown;
  constructor(message: string, status: number, code?: string, payload?: unknown) {
    super(message);
    this.name = "LocalSyncHttpError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const payload = data as { error?: string; code?: string } | null;
    throw new LocalSyncHttpError(
      payload?.error || `${res.status} ${res.statusText}`,
      res.status,
      payload?.code,
      payload,
    );
  }
  return data as T;
}

export const httpLocalSyncApi: LocalSyncApi = {
  meta: () => request<LocalSyncMeta>("GET", "/api/sync/meta"),

  claim: (userId) =>
    request<ClaimResult>("POST", "/api/sync/claim", { user_id: userId }).catch(
      (err: unknown) => {
        if (err instanceof LocalSyncHttpError && err.status === 409) {
          const payload = err.payload as { owner_user_id?: string } | undefined;
          return {
            ok: false,
            reason: err.code ?? "different_account",
            owner_user_id: payload?.owner_user_id ?? "",
          } as ClaimResult;
        }
        throw err;
      },
    ),

  release: async () => {
    await request("POST", "/api/sync/release");
  },

  forgetAccount: async () => {
    await request("POST", "/api/sync/forget");
  },

  pending: (limit = 250) =>
    request<{ changes: PendingChange[]; hasMore: boolean }>(
      "GET",
      `/api/sync/pending?limit=${limit}`,
    ),

  ack: async (ids, pushed = true) => {
    if (ids.length === 0) return;
    await request("POST", "/api/sync/ack", { ids, pushed });
  },

  snapshot: (entity, after, limit = 250) =>
    request<SnapshotChunk>(
      "GET",
      `/api/sync/snapshot?entity=${encodeURIComponent(entity)}&after=${after}&limit=${limit}`,
    ),

  apply: (changes: RemoteChange[], opts: { push?: boolean; cursors?: Record<string, SyncCursor> } = {}) =>
    request<ApplyResult>("POST", "/api/sync/apply", {
      changes,
      push: opts.push === true,
      cursors: opts.cursors,
    }),

  summary: () => request<LocalDataSummary>("GET", "/api/sync/summary"),

  preparePull: () => request<{ ok: boolean; reason?: string }>("POST", "/api/sync/prepare-pull"),

  wipe: async () => {
    await request("POST", "/api/sync/wipe", { confirm: "DELETE" });
  },

  conflict: async (input: LocalConflict) => {
    await request("POST", "/api/sync/conflict", input);
  },
};

/**
 * Supabase implementation of the cloud half of sync.
 *
 * The anon key + RLS are the only credentials involved. Every query is scoped
 * to the signed-in user, and the cloud server stamps `updated_at` on every
 * write (see supabase/migrations/*_dental_canvas_sync.sql).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { SYNC_TABLES } from "../../../shared/sync-schema";
import type { CloudRow, CloudSyncAdapter, SyncCursor } from "./types";

const PULL_PAGE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createSupabaseSyncAdapter(
  client: SupabaseClient,
  userId: string,
): CloudSyncAdapter {
  return {
    userId,

    async isAccountInitialized() {
      const { data, error } = await client
        .from("account_sync_state")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return Boolean(data);
    },

    async markAccountInitialized() {
      const { error } = await client.from("account_sync_state").upsert(
        { user_id: userId, schema_version: 1, last_device_sync_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
      if (error) throw new Error(error.message);
    },

    async pushUpserts(entity, rows) {
      if (rows.length === 0) return [];
      const withOwner = rows.map((r) => ({ ...r, user_id: userId }));
      const { data, error } = await client
        .from(entity)
        .upsert(withOwner, { onConflict: "sync_id" })
        .select("*");
      if (error) throw new Error(`${entity}: ${error.message}`);
      return (data ?? []) as CloudRow[];
    },

    async softDelete(entity, syncIds) {
      if (syncIds.length === 0) return [];
      const echo: CloudRow[] = [];
      for (const ids of chunk(syncIds, 200)) {
        const { data, error } = await client
          .from(entity)
          .update({ deleted_at: new Date().toISOString() })
          .eq("user_id", userId)
          .in("sync_id", ids)
          .select("*");
        if (error) throw new Error(`${entity}: ${error.message}`);
        echo.push(...((data ?? []) as CloudRow[]));
      }
      return echo;
    },

    async pull(entity, cursor, limit = PULL_PAGE) {
      let query = client
        .from(entity)
        .select("*")
        .eq("user_id", userId)
        .order("updated_at", { ascending: true })
        .order("sync_id", { ascending: true })
        .limit(limit);
      if (cursor) {
        // Keyset pagination on (updated_at, sync_id): batches inserted in one
        // transaction share the same updated_at, so the sync_id breaks ties
        // without skipping rows at a page boundary.
        query = cursor.sync_id
          ? query.or(
              `updated_at.gt.${cursor.updated_at},and(updated_at.eq.${cursor.updated_at},sync_id.gt.${cursor.sync_id})`,
            )
          : query.gte("updated_at", cursor.updated_at);
      }
      const { data, error } = await query;
      if (error) throw new Error(`${entity}: ${error.message}`);
      return (data ?? []) as CloudRow[];
    },

    async remoteTimestamps(entity, syncIds) {
      const out: { sync_id: string; updated_at: string; deleted_at: string | null }[] = [];
      for (const ids of chunk(syncIds, 200)) {
        const { data, error } = await client
          .from(entity)
          .select("sync_id,updated_at,deleted_at")
          .eq("user_id", userId)
          .in("sync_id", ids);
        if (error) throw new Error(`${entity}: ${error.message}`);
        out.push(...((data ?? []) as typeof out));
      }
      return out;
    },

    subscribe(onChange) {
      const channel = client.channel(`dc-sync-${userId}`);
      for (const table of SYNC_TABLES) {
        channel.on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: table.name,
            filter: `user_id=eq.${userId}`,
          },
          () => onChange(),
        );
      }
      channel.subscribe();
      return () => {
        void client.removeChannel(channel);
      };
    },
  };
}

/** Parse a cursor out of the last row of a pull page. */
export function cursorFromRow(row: CloudRow): SyncCursor {
  return { updated_at: row.updated_at, sync_id: row.sync_id ?? null };
}

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseSyncAdapter } from "../src/client/lib/sync/cloud";
import { SYNC_TABLES } from "../src/shared/sync-schema";

/**
 * Real-Supabase sync test.
 *
 * Runs only when a local stack is up (`supabase start`) and the three env vars
 * below are exported, e.g.:
 *
 *   eval "$(supabase status -o env)"   # gives API_URL / ANON_KEY / SERVICE_ROLE_KEY
 *   SUPABASE_LOCAL_URL=$API_URL \
 *   SUPABASE_LOCAL_ANON_KEY=$ANON_KEY \
 *   SUPABASE_LOCAL_SERVICE_KEY=$SERVICE_ROLE_KEY \
 *   npx vitest run tests/supabase-local-sync.test.ts
 *
 * It proves the parts unit tests can't: the migration applies, every syncable
 * table is reachable through PostgREST, and row-level security keeps one
 * doctor's rows invisible to another account.
 */

const url = process.env.SUPABASE_LOCAL_URL;
const anonKey = process.env.SUPABASE_LOCAL_ANON_KEY;
const serviceKey = process.env.SUPABASE_LOCAL_SERVICE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const PASSWORD = "Passw0rd!sync";
const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

interface Account {
  id: string;
  email: string;
  client: SupabaseClient;
}

async function createAccount(admin: SupabaseClient, label: string): Promise<Account> {
  const email = `sync-${label}-${stamp}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser(${label}): ${error?.message ?? "no user"}`);

  const client = createClient(url as string, anonKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signIn = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) {
    throw new Error(`signIn(${label}): ${signIn.error?.message ?? "no session"}`);
  }
  return { id: data.user.id, email, client };
}

describe.skipIf(!configured)("sync against a real local Supabase", () => {
  let admin: SupabaseClient;
  let alice: Account;
  let bob: Account;

  beforeAll(async () => {
    admin = createClient(url as string, serviceKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    [alice, bob] = await Promise.all([createAccount(admin, "alice"), createAccount(admin, "bob")]);
  }, 60_000);

  afterAll(async () => {
    for (const account of [alice, bob]) {
      if (account) await admin?.auth.admin.deleteUser(account.id).catch(() => undefined);
    }
  });

  it("exposes every syncable table to a signed-in account", async () => {
    const failures: string[] = [];
    for (const table of SYNC_TABLES) {
      const { error } = await alice.client.from(table.name).select("sync_id").limit(1);
      if (error) failures.push(`${table.name}: ${error.message}`);
    }
    expect(failures).toEqual([]);
  });

  it("pushes a row and reads it back for the same account", async () => {
    const adapter = createSupabaseSyncAdapter(alice.client, alice.id);
    const syncId = randomUUID();

    const echo = await adapter.pushUpserts("patients", [
      { sync_id: syncId, first_name: "Ada", last_name: "Lovelace", phone: "555-0100" },
    ]);
    expect(echo).toHaveLength(1);
    expect(echo[0].sync_id).toBe(syncId);
    expect(echo[0].user_id).toBe(alice.id);
    expect(echo[0].updated_at).toBeTruthy();

    const pulled = await adapter.pull("patients", null);
    expect(pulled.map((r) => r.sync_id)).toContain(syncId);
  }, 30_000);

  it("keeps one doctor's rows invisible to another account", async () => {
    const adapterA = createSupabaseSyncAdapter(alice.client, alice.id);
    const adapterB = createSupabaseSyncAdapter(bob.client, bob.id);
    const syncId = randomUUID();

    await adapterA.pushUpserts("patients", [
      { sync_id: syncId, first_name: "Grace", last_name: "Hopper" },
    ]);

    const bobsRows = await adapterB.pull("patients", null);
    expect(bobsRows.some((r) => r.sync_id === syncId)).toBe(false);

    // Bob cannot overwrite Alice's row either: the insert/update policy rejects
    // a user_id that is not his own.
    await expect(
      adapterB.pushUpserts("patients", [
        { sync_id: syncId, first_name: "Mallory", last_name: "Hijack" },
      ]),
    ).rejects.toBeTruthy();
  }, 30_000);

  it("propagates deletes as tombstones instead of removing the row", async () => {
    const adapter = createSupabaseSyncAdapter(alice.client, alice.id);
    const syncId = randomUUID();

    await adapter.pushUpserts("patients", [
      { sync_id: syncId, first_name: "Delete", last_name: "Me" },
    ]);
    const echo = await adapter.softDelete("patients", [syncId]);
    expect(echo).toHaveLength(1);
    expect(echo[0].deleted_at).toBeTruthy();

    const pulled = await adapter.pull("patients", null);
    const row = pulled.find((r) => r.sync_id === syncId);
    expect(row?.deleted_at).toBeTruthy();
  }, 30_000);

  it("tracks first-device initialization per account", async () => {
    const adapter = createSupabaseSyncAdapter(bob.client, bob.id);
    expect(await adapter.isAccountInitialized()).toBe(false);
    await adapter.markAccountInitialized();
    expect(await adapter.isAccountInitialized()).toBe(true);
  }, 30_000);

  it("bootstraps the doctor profile and blocks sign-in until the email is confirmed", async () => {
    // Hosted projects reject synthetic domains on the public sign-up endpoint
    // (`email_address_invalid`), so the unconfirmed account is created through
    // the admin API — the confirmation gate itself is what this test proves.
    const email = `sync-confirm-${stamp}@example.com`;
    const created = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: false,
    });
    expect(created.error).toBeNull();
    const userId = created.data.user?.id as string;
    expect(userId).toBeTruthy();

    // auth.users insert → public.profiles row (the migration's trigger).
    const profile = await admin
      .from("profiles")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    expect(profile.error).toBeNull();
    expect(profile.data?.user_id).toBe(userId);

    const client = createClient(url as string, anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const blocked = await client.auth.signInWithPassword({ email, password: PASSWORD });
    expect(blocked.error?.message ?? "").toMatch(/confirm/i);

    const confirmed = await admin.auth.admin.updateUserById(userId, { email_confirm: true });
    expect(confirmed.error).toBeNull();

    const signedIn = await client.auth.signInWithPassword({ email, password: PASSWORD });
    expect(signedIn.error).toBeNull();
    expect(signedIn.data.session?.user.id).toBe(userId);

    await admin.auth.admin.deleteUser(userId).catch(() => undefined);
  }, 60_000);

  it("deletes the account and every synced row through the delete-account function", async () => {
    const victim = await createAccount(admin, `victim`);
    const adapter = createSupabaseSyncAdapter(victim.client, victim.id);
    await adapter.pushUpserts("patients", [
      { sync_id: randomUUID(), first_name: "Gone", last_name: "Tomorrow" },
    ]);

    const { data, error } = await victim.client.functions.invoke("delete-account", {
      method: "POST",
    });
    expect(error).toBeNull();
    expect(data?.deleted ?? true).toBeTruthy();

    // Auth user and cascaded practice rows are gone; the token no longer works.
    const gone = await admin.auth.admin.getUserById(victim.id);
    expect(gone.data.user).toBeNull();

    const after = await admin
      .from("patients")
      .select("sync_id")
      .eq("user_id", victim.id);
    expect(after.error).toBeNull();
    expect(after.data ?? []).toEqual([]);
  }, 60_000);
});

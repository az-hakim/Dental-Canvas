/**
 * Optional Supabase account + sync lifecycle.
 *
 * This provider is mounted above the app shell. With no cloud env vars it is a
 * no-op (`cloudAvailable: false`) and the app behaves exactly as before.
 *
 * The engine is created per signed-in user and torn down on sign-out. Signing
 * out detaches local data from the account but NEVER deletes it; removing local
 * data is a separate, explicitly confirmed action.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { User } from "@supabase/supabase-js";
import {
  cloudConfigured,
  friendlyAuthError,
  supabase,
} from "./lib/supabase";
import {
  readAccountMode,
  writeAccountMode,
  type AccountMode,
} from "./lib/account-mode";
import { onDataChanged } from "./lib/data-change-signal";
import { httpLocalSyncApi } from "./lib/sync/local-api";
import { createSupabaseSyncAdapter } from "./lib/sync/cloud";
import {
  createSyncEngine,
  type SyncEngine,
} from "./lib/sync/engine";
import type { SyncStatus } from "./lib/sync/types";

export type AuthStatus = "loading" | "signed-out" | "signed-in";

export interface SignUpExtras {
  doctor_name?: string;
  clinic_name?: string;
}

export interface SignUpResult {
  /** True when Supabase requires email confirmation before the first sign-in. */
  needsConfirmation: boolean;
}

export interface AuthContextValue {
  cloudAvailable: boolean;
  status: AuthStatus;
  user: User | null;
  accountMode: AccountMode;
  recoveryMode: boolean;
  accountError: string | null;
  /** Signed in, but this device's local data belongs to another account. */
  accountConflict: boolean;
  syncStatus: SyncStatus;
  setAccountMode(mode: AccountMode): void;
  clearAccountError(): void;
  signUp(email: string, password: string, extras?: SignUpExtras): Promise<SignUpResult>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  resetPassword(email: string): Promise<void>;
  updatePassword(password: string): Promise<void>;
  deleteAccount(removeLocalData: boolean): Promise<void>;
  syncNow(): Promise<SyncStatus | null>;
  dismissRecovery(): void;
}

const INITIAL_SYNC_STATUS: SyncStatus = {
  phase: cloudConfigured ? "idle" : "unavailable",
  lastSyncAt: null,
  pending: 0,
  error: null,
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = supabase;
  const [status, setStatus] = useState<AuthStatus>(client ? "loading" : "signed-out");
  const [user, setUser] = useState<User | null>(null);
  const [accountMode, setAccountModeState] = useState<AccountMode>(() => readAccountMode());
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(INITIAL_SYNC_STATUS);

  const engineRef = useRef<SyncEngine | null>(null);
  const engineUserIdRef = useRef<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const setAccountMode = useCallback((mode: AccountMode) => {
    writeAccountMode(mode);
    setAccountModeState(mode);
  }, []);

  const stopEngine = useCallback(async (release: boolean) => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    const engine = engineRef.current;
    engineRef.current = null;
    engineUserIdRef.current = null;
    if (engine) {
      if (release) {
        await engine.release().catch(() => undefined);
      } else {
        engine.stop();
      }
    }
    setSyncStatus(INITIAL_SYNC_STATUS);
  }, []);

  const startEngine = useCallback((nextUser: User) => {
    if (!client) return;
    if (engineRef.current && engineUserIdRef.current === nextUser.id) return;
    if (engineRef.current) {
      // Another account signed in without the explicit sign-out flow. Stop the
      // old engine, but never clear local rows or the device's account claim.
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      engineRef.current.stop();
      engineRef.current = null;
      engineUserIdRef.current = null;
    }
    const engine = createSyncEngine({
      userId: nextUser.id,
      local: httpLocalSyncApi,
      cloud: createSupabaseSyncAdapter(client, nextUser.id),
    });
    engineRef.current = engine;
    engineUserIdRef.current = nextUser.id;
    setSyncStatus(engine.getStatus());
    unsubscribeRef.current = engine.subscribe(() => setSyncStatus(engine.getStatus()));
    engine.start();
  }, [client]);

  // Initial session + auth event wiring.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;

    void client.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      const sessionUser = data.session?.user ?? null;
      setUser(sessionUser);
      setStatus(sessionUser ? "signed-in" : "signed-out");
      if (sessionUser) {
        setAccountMode("cloud");
        startEngine(sessionUser);
      }
    });

    const { data: sub } = client.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;
      const sessionUser = session?.user ?? null;
      if (event === "PASSWORD_RECOVERY") {
        setRecoveryMode(true);
        if (sessionUser) {
          setUser(sessionUser);
          setStatus("signed-in");
        }
        return;
      }
      setUser(sessionUser);
      setStatus(sessionUser ? "signed-in" : "signed-out");
      if (sessionUser) {
        setAccountMode("cloud");
        startEngine(sessionUser);
      } else {
        // A revoked/expired session is not an intentional sign-out: stop the
        // engine but keep every local row and queued edit for a later sign-in.
        void stopEngine(false);
      }
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
      unsubscribeRef.current?.();
      engineRef.current?.stop();
      engineRef.current = null;
    };
    // startEngine/stopEngine/setAccountMode are stable (useCallback).
  }, [client, setAccountMode, startEngine, stopEngine]);

  // Local writes → debounced push; connectivity return → immediate retry; a
  // slow poll covers environments where Realtime is blocked (some clinics).
  useEffect(() => {
    const engine = () => engineRef.current;
    const offData = onDataChanged(() => engine()?.requestSync(1_200));
    const onOnline = () => engine()?.requestSync(0);
    window.addEventListener("online", onOnline);
    const interval = window.setInterval(() => {
      if (engine() && navigator.onLine !== false) engine()?.requestSync(0);
    }, 60_000);
    return () => {
      offData();
      window.removeEventListener("online", onOnline);
      window.clearInterval(interval);
    };
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, extras?: SignUpExtras): Promise<SignUpResult> => {
      setAccountError(null);
      if (!client) throw new Error("Cloud sync is not configured in this build.");
      const { data, error } = await client.auth.signUp({
        email: email.trim(),
        password,
        options: {
          emailRedirectTo: window.location.origin,
          data: {
            doctor_name: extras?.doctor_name ?? "",
            clinic_name: extras?.clinic_name ?? "",
          },
        },
      });
      if (error) throw new Error(friendlyAuthError(error.message));
      setAccountMode("cloud");
      return { needsConfirmation: !data.session };
    },
    [client, setAccountMode],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      setAccountError(null);
      if (!client) throw new Error("Cloud sync is not configured in this build.");
      const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw new Error(friendlyAuthError(error.message));
      setAccountMode("cloud");
    },
    [client, setAccountMode],
  );

  const signOut = useCallback(async () => {
    setAccountError(null);
    // Release the device owner BEFORE signing out so a later different account
    // cannot upload this practice's data. Local rows are untouched.
    await stopEngine(true);
    if (client) await client.auth.signOut().catch(() => undefined);
  }, [client, stopEngine]);

  const resetPassword = useCallback(
    async (email: string) => {
      if (!client) throw new Error("Cloud sync is not configured in this build.");
      const { error } = await client.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: window.location.origin,
      });
      if (error) throw new Error(friendlyAuthError(error.message));
    },
    [client],
  );

  const updatePassword = useCallback(
    async (password: string) => {
      if (!client) throw new Error("Cloud sync is not configured in this build.");
      const { error } = await client.auth.updateUser({ password });
      if (error) throw new Error(friendlyAuthError(error.message));
      setRecoveryMode(false);
    },
    [client],
  );

  const deleteAccount = useCallback(
    async (removeLocalData: boolean) => {
      setAccountError(null);
      if (!client) throw new Error("Cloud sync is not configured in this build.");
      const { error } = await client.functions.invoke("delete-account", { method: "POST" });
      if (error) {
        setAccountError(
          /401|unauthorized|not signed in/i.test(error.message)
            ? "Please sign in again before deleting your account."
            : "Could not delete the cloud account. Please try again or contact support.",
        );
        throw new Error("Cloud account deletion failed.");
      }
      await stopEngine(true);
      if (removeLocalData) {
        await httpLocalSyncApi.wipe();
      } else {
        // The account no longer exists, so the device must not stay claimed to
        // it; its local rows are kept and can belong to a future account.
        await httpLocalSyncApi.forgetAccount();
      }
      await client.auth.signOut().catch(() => undefined);
      setAccountMode("offline");
    },
    [client, setAccountMode, stopEngine],
  );

  const syncNow = useCallback(async (): Promise<SyncStatus | null> => {
    const engine = engineRef.current;
    if (!engine) return null;
    await engine.syncNow("manual");
    const final = engine.getStatus();
    setSyncStatus(final);
    return final;
  }, []);

  const accountConflict = Boolean(
    user && syncStatus.error && /different account/i.test(syncStatus.error),
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      cloudAvailable: cloudConfigured,
      status,
      user,
      accountMode,
      recoveryMode,
      accountError,
      accountConflict,
      syncStatus,
      setAccountMode,
      clearAccountError: () => setAccountError(null),
      signUp,
      signIn,
      signOut,
      resetPassword,
      updatePassword,
      deleteAccount,
      syncNow,
      dismissRecovery: () => setRecoveryMode(false),
    }),
    [
      status,
      user,
      accountMode,
      recoveryMode,
      accountError,
      accountConflict,
      syncStatus,
      setAccountMode,
      signUp,
      signIn,
      signOut,
      resetPassword,
      updatePassword,
      deleteAccount,
      syncNow,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

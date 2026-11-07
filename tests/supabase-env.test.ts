import { describe, expect, it } from "vitest";
import {
  authRedirectUrl,
  createCloudClient,
  friendlyAuthError,
  hasSupabaseEnv,
} from "../src/client/lib/supabase";

describe("Supabase env fallback", () => {
  it("reports no cloud configuration when either value is missing", () => {
    expect(hasSupabaseEnv({})).toBe(false);
    expect(hasSupabaseEnv({ url: "https://project.supabase.co" })).toBe(false);
    expect(hasSupabaseEnv({ anonKey: "anon" })).toBe(false);
    expect(createCloudClient({})).toBeNull();
    expect(createCloudClient({ url: "https://project.supabase.co" })).toBeNull();
  });

  it("creates a client when both public values exist", () => {
    const client = createCloudClient({
      url: "https://project.supabase.co",
      anonKey: "public-anon-key",
    });
    expect(client).not.toBeNull();
    expect(typeof client?.from).toBe("function");
    expect(typeof client?.auth.signInWithPassword).toBe("function");
  });

  it("falls back to offline-only instead of throwing on a malformed URL", () => {
    expect(
      createCloudClient({ url: "not a url", anonKey: "public-anon-key" }),
    ).toBeNull();
    expect(
      createCloudClient({ url: "ftp://project.supabase.co", anonKey: "public-anon-key" }),
    ).toBeNull();
  });

  it("turns auth failures into plain-language messages", () => {
    expect(friendlyAuthError("Invalid login credentials")).toBe(
      "That email and password don't match.",
    );
    expect(friendlyAuthError("Email not confirmed")).toContain("confirm your email");
    expect(friendlyAuthError("User already registered")).toContain("already exists");
    expect(friendlyAuthError("Failed to fetch")).toContain("cloud server");
    // WebKit (the desktop app) words the same failure differently.
    expect(friendlyAuthError("Load failed")).toContain("cloud server");
    expect(friendlyAuthError("NetworkError when attempting to fetch resource.")).toContain(
      "cloud server",
    );
    // Supabase's built-in mailer throttles confirmation emails per hour.
    expect(friendlyAuthError("email rate limit exceeded")).toContain(
      "Too many confirmation emails",
    );
  });
});

describe("auth redirect target", () => {
  it("keeps http(s) origins so links can return to the browser build", () => {
    expect(authRedirectUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(authRedirectUrl("https://clinic.example.com")).toBe(
      "https://clinic.example.com",
    );
  });

  it("omits webview origins Supabase would reject", () => {
    // Desktop: tauri://localhost on Linux/macOS, http://tauri.localhost on Windows.
    expect(authRedirectUrl("tauri://localhost")).toBeUndefined();
    expect(authRedirectUrl("http://tauri.localhost")).toBeUndefined();
    expect(authRedirectUrl("https://tauri.localhost")).toBeUndefined();
    expect(authRedirectUrl("")).toBeUndefined();
  });
});

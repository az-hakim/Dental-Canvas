import { describe, expect, it } from "vitest";
import {
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
    expect(friendlyAuthError("Failed to fetch")).toContain("offline");
  });
});

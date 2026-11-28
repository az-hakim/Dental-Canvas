import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Image uploads and thumbnails on a hosted deployment.
 *
 * Built-in database storage serves images from this app's own API, which
 * derives the practice from the caller's session — a bare `fetch()` sent the
 * bytes without it and every x-ray upload came back 401. These pin the two
 * halves of the rule: our own routes get the bearer token, a presigned bucket
 * URL never does.
 */
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: "session-token" } } }),
    },
  }),
}));

describe("image bytes over a signed-in deployment", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-anon-key");
    fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("sends the session to the built-in image store's upload route", async () => {
    const { apiFetch, apiUrl } = await import("@/api");
    await apiFetch("/api/image-file?key=patients/1/2026/11/x.png", {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    });

    // CI exports VITE_API_BASE_URL, so compare against whatever origin this
    // build is pointed at rather than assuming a relative path.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(apiUrl("/api/image-file?key=patients/1/2026/11/x.png"));
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer session-token");
    expect(headers.get("content-type")).toBe("image/png");
  });

  it("sends the session when reading an image back for a thumbnail", async () => {
    const { apiFetch } = await import("@/api");
    await apiFetch("/api/image-file?key=patients/1/2026/11/x.png");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer session-token");
  });

  it("never hands the session to a presigned bucket URL", async () => {
    const { apiFetch } = await import("@/api");
    const signed = "https://acct.r2.cloudflarestorage.com/bucket/patients/1/x.png?X-Amz-Signature=abc";
    await apiFetch(signed, { method: "PUT", body: new Uint8Array([1]) });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(signed);
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("recognises this app's own routes and nothing else", async () => {
    const { isAppApiUrl, apiUrl } = await import("@/api");
    expect(isAppApiUrl("/api/image-file?key=patients/1/x.png")).toBe(true);
    expect(isAppApiUrl(apiUrl("/api/image-file?key=patients/1/x.png"))).toBe(true);
    expect(isAppApiUrl("https://bucket.example.com/patients/1/x.png")).toBe(false);
  });
});

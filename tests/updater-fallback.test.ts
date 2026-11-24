import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The "stuck on an old version" reports came from a check that failed silently:
 * `check()` threw or returned null and the app then claimed it was up to date.
 * These tests pin down the three outcomes the card depends on:
 *
 *   plugin finds an update                  → mode "installer"
 *   plugin fails but the feed is newer      → mode "manual"  (+ the reason)
 *   plugin says "none" and the feed is newer → mode "repair"  (stale UI)
 */

const checkMock = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: (...args: unknown[]) => checkMock(...args) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@/offline/activate", () => ({
  isTauriDesktop: () => true,
  flushDatabase: vi.fn(),
  flushDatabaseAndWait: () => Promise.resolve(),
}));
vi.mock("@/components/update-applied-banner", () => ({ saveUpdateNotesForNextBoot: vi.fn() }));

const openExternalUrlMock = vi.fn();
vi.mock("@/lib/open-external", () => ({ openExternalUrl: (...args: unknown[]) => openExternalUrlMock(...args) }));

const RELEASES = {
  tag_name: "v1.4.23",
  body: "Fixes the medicines list",
  html_url: "https://github.com/az-hakim/Dental-Canvas/releases/tag/v1.4.23",
  assets: [
    {
      name: "Dental.Canvas_1.4.23_x64-setup.exe",
      browser_download_url: "https://example.test/Dental.Canvas_1.4.23_x64-setup.exe",
    },
    {
      name: "Dental.Canvas_1.4.23_amd64.AppImage",
      browser_download_url: "https://example.test/Dental.Canvas_1.4.23_amd64.AppImage",
    },
  ],
};

async function loadUpdater() {
  const mod = await import("@/lib/updater");
  mod.__resetUpdateStateForTests();
  return mod;
}

beforeEach(() => {
  vi.stubGlobal("__APP_VERSION__", "1.4.22");
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
  checkMock.mockReset();
  openExternalUrlMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("checkForUpdates", () => {
  it("uses the signed in-app updater when it finds a release", async () => {
    checkMock.mockResolvedValue({
      version: "1.4.23",
      body: "notes",
      downloadAndInstall: vi.fn(),
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { checkForUpdates, getUpdateState, getUpdateDiagnostics } = await loadUpdater();
    const version = await checkForUpdates();

    expect(version).toBe("1.4.23");
    expect(getUpdateState()).toMatchObject({ version: "1.4.23", mode: "installer", phase: "available" });
    expect(getUpdateDiagnostics()).toMatchObject({ selfInstall: true, lastError: null });
    // No need to hit the network when the plugin already answered.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("offers the installer when the plugin fails but the feed is newer", async () => {
    checkMock.mockRejectedValue(new Error("signature verification failed"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(RELEASES), { status: 200 })),
    );

    const { checkForUpdates, getUpdateState, getUpdateDiagnostics } = await loadUpdater();
    const version = await checkForUpdates();

    expect(version).toBe("1.4.23");
    const state = getUpdateState();
    expect(state).toMatchObject({ version: "1.4.23", mode: "manual", phase: "available" });
    // The Windows installer is picked from the release assets, not the page.
    expect(state?.downloadUrl).toBe("https://example.test/Dental.Canvas_1.4.23_x64-setup.exe");
    expect(getUpdateDiagnostics()).toMatchObject({
      selfInstall: false,
      feedVersion: "1.4.23",
      lastError: "signature verification failed",
    });
  });

  it("asks for a cache repair when the binary is current but the UI is stale", async () => {
    // The plugin compares the BINARY with the feed; "no update" here means the
    // installed app is already 1.4.23 while this page still runs 1.4.22.
    checkMock.mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(RELEASES), { status: 200 })),
    );

    const { checkForUpdates, getUpdateState } = await loadUpdater();
    await checkForUpdates();

    expect(getUpdateState()).toMatchObject({ version: "1.4.23", mode: "repair" });
  });

  it("reports the failure instead of claiming the app is up to date", async () => {
    checkMock.mockRejectedValue(new Error("network unreachable"));
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));

    const { checkForUpdates, getUpdateState, getUpdateDiagnostics } = await loadUpdater();
    const version = await checkForUpdates();

    expect(version).toBeNull();
    expect(getUpdateState()).toBeNull();
    expect(getUpdateDiagnostics()).toMatchObject({
      selfInstall: false,
      feedVersion: null,
      lastError: "network unreachable",
    });
  });

  it("does not offer an older feed version as an update", async () => {
    checkMock.mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ...RELEASES, tag_name: "v1.4.21" }), { status: 200 }),
      ),
    );

    const { checkForUpdates, getUpdateState, getUpdateDiagnostics } = await loadUpdater();
    const version = await checkForUpdates();

    expect(version).toBeNull();
    expect(getUpdateState()).toBeNull();
    expect(getUpdateDiagnostics().feedVersion).toBe("1.4.21");
  });
});

describe("openManualUpdate", () => {
  it("opens the installer URL from the feed", async () => {
    checkMock.mockRejectedValue(new Error("no registry entry for this install"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(RELEASES), { status: 200 })),
    );

    const { checkForUpdates, openManualUpdate } = await loadUpdater();
    await checkForUpdates();
    await openManualUpdate();

    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://example.test/Dental.Canvas_1.4.23_x64-setup.exe",
    );
  });
});

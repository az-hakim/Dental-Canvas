/**
 * The desktop app's Content-Security-Policy is the only thing standing between
 * the webview and the cloud API: an origin missing from `connect-src` makes
 * every auth, REST and Realtime call fail as a bare "Load failed" (WebKit) with
 * no visible reason. v1.4.30 shipped exactly that bug, so guard the rule here
 * instead of discovering it in an installer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function desktopCsp(): string {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), "src-tauri", "tauri.conf.json"), "utf8"),
  ) as { app?: { security?: { csp?: string } } };
  const csp = config.app?.security?.csp;
  if (!csp) throw new Error("tauri.conf.json has no app.security.csp");
  return csp;
}

function directive(csp: string, name: string): string[] {
  const match = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  return match ? match.split(/\s+/).slice(1) : [];
}

describe("desktop CSP", () => {
  it("lets the app talk to Supabase over HTTPS and Realtime websockets", () => {
    const connect = directive(desktopCsp(), "connect-src");
    expect(connect).toContain("https://*.supabase.co");
    expect(connect).toContain("wss://*.supabase.co");
  });

  it("keeps the origins the app already relied on", () => {
    const connect = directive(desktopCsp(), "connect-src");
    expect(connect).toContain("'self'");
    expect(connect).toContain("ipc:");
    expect(connect).toContain("https://api.github.com");
  });
});

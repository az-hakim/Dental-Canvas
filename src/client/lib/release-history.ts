/**
 * Release history for the "What's new" page.
 *
 * Changelogs come from the public GitHub releases API (the same source the
 * updater feed is generated from) — no auth needed for a public repo, and the
 * endpoint is CORS-enabled. The response is cached in localStorage so the page
 * still shows recent versions when the clinic machine is offline (the common
 * case for a chamber without internet).
 */

const CACHE_KEY = "dental-canvas:release-history";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // refresh at most daily

export const RELEASES_API_URL =
  "https://api.github.com/repos/az-hakim/Dental-Canvas/releases?per_page=15";

export interface ReleaseEntry {
  /** e.g. "v1.4.19" */
  tag: string;
  /** Release title, e.g. "v1.4.19 — bulletproof scrolling". Falls back to tag. */
  name: string;
  /** Changelog body (markdown-ish plain text from the release notes). */
  notes: string;
  /** ISO date the release was published, e.g. "2026-10-01T12:00:00Z". */
  publishedAt: string;
}

export interface ReleaseHistory {
  releases: ReleaseEntry[];
  /** Epoch ms when the cache was written; 0 for a fresh (uncached) fetch. */
  fetchedAt: number;
}

/** True when the entry's tag matches the running version (ignores the "v"). */
export function isCurrentVersion(tag: string): boolean {
  return tag.replace(/^v/i, "") === __APP_VERSION__;
}

/** Map the GitHub API response to our slim shape, dropping unusable entries. */
export function parseReleases(payload: unknown): ReleaseEntry[] {
  if (!Array.isArray(payload)) return [];
  const entries: ReleaseEntry[] = [];
  for (const raw of payload) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const tag = typeof r.tag_name === "string" ? r.tag_name : "";
    if (!tag) continue; // every entry needs a version to show
    entries.push({
      tag,
      name: typeof r.name === "string" && r.name.trim() ? r.name : tag,
      notes: typeof r.body === "string" ? r.body : "",
      publishedAt: typeof r.published_at === "string" ? r.published_at : "",
    });
  }
  return entries;
}

/** Read the cached history, if any (never throws — private mode etc.). */
export function readCachedHistory(): ReleaseHistory | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { fetchedAt?: number; releases?: ReleaseEntry[] };
    if (!Array.isArray(parsed.releases) || parsed.releases.length === 0) return null;
    return { releases: parsed.releases, fetchedAt: parsed.fetchedAt ?? 0 };
  } catch {
    return null;
  }
}

function writeCache(history: ReleaseHistory): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(history));
  } catch {
    /* best effort — page just re-fetches next time */
  }
}

export function isCacheFresh(history: ReleaseHistory): boolean {
  return history.fetchedAt > 0 && Date.now() - history.fetchedAt < CACHE_TTL_MS;
}

/**
 * Load the release history: cache first (instant render), then a network
 * refresh (skipped when the cache is less than a day old). Returns the newest
 * known history and whether it came from the cache — the page uses that to
 * label stale data as "offline".
 *
 * Network failure is not an error: with a cache the page simply stays on the
 * cached copy; with nothing cached the page shows an empty state.
 */
export async function loadReleaseHistory(): Promise<{
  history: ReleaseHistory | null;
  fromCache: boolean;
}> {
  const cached = readCachedHistory();
  if (cached && isCacheFresh(cached)) {
    return { history: cached, fromCache: true };
  }
  try {
    const res = await fetch(RELEASES_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const releases = parseReleases(await res.json());
    if (releases.length === 0) throw new Error("empty release feed");
    // Cache-freshness: prefer the fresher of the two sources.
    const history: ReleaseHistory = {
      releases,
      fetchedAt: Date.now(),
    };
    writeCache(history);
    return { history, fromCache: false };
  } catch {
    if (cached) return { history: cached, fromCache: true };
    return { history: null, fromCache: false };
  }
}

/** Reset module-level cache state for tests. */
export function __clearReleaseHistoryCacheForTests(): void {
  try {
    window.localStorage.removeItem(CACHE_KEY);
  } catch {
    /* noop */
  }
}

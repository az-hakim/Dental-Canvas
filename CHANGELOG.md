# Changelog

All notable changes to this project will be documented in this file.
See [Release process](docs/release-process.md) for how releases are cut.

## v1.4.28 (unreleased)

- **Optional accounts & cloud sync** — doctors can sign up or sign in with
  email + password, or explicitly skip. Skipping is remembered, and the app
  remains fully local-only and offline forever. A doctor who skips can create
  an account later from Settings → Account; the first sync uploads every
  existing local row without duplicating it.
- **Local-first sync engine** — SQL triggers queue inserts, updates and deletes
  in a local outbox; the browser pushes them to Supabase in the background and
  pulls incremental changes per table with an `updated_at` cursor. Realtime is
  used as a nudge only (plus a 60-second poll). Failures retry with exponential
  backoff; the UI never blocks on the network.
- **Globally unique row ids** — every syncable row gains `sync_id` (UUID),
  `updated_at` and `deleted_at`. Integer primary/foreign keys stay untouched,
  and the runtime migration is idempotent and non-destructive for existing
  databases. Deletes are soft in the cloud and propagate via tombstones.
- **Last-write-wins conflicts** — the cloud stamps `updated_at`; the losing
  version is recorded in the local `sync_conflicts` table (with both payloads),
  never silently discarded.
- **Accounts in the UI** — Account step in first-run setup (Sign up / Sign in /
  Skip), a browser/PWA first-run offer, Settings → Account (status, last sync,
  Sync now, sign out, remove local data, delete cloud account), and a small
  sync indicator in the desktop/mobile chrome.
- **Sign-out safety** — signing out stops sync but keeps local rows, queued
  edits and this device's account claim, so a second doctor signing in on a
  shared clinic machine cannot upload the first practice's patients. Switching
  accounts requires an explicit, typed confirmation; deleting the cloud
  account releases the claim while keeping the local records.
- **Security** — per-user RLS on every cloud table, anon key only in the client,
  no service role in any `VITE_*` variable, a `delete-account` Edge Function
  that verifies the caller's JWT, and a pgTAP test proving a second account
  cannot read or modify the first's data.
- **Docs** — README sections for creating the Supabase project, running the
  migrations locally/hosted, the delete-account function, env vars, the Tauri
  email-link limitation, and exactly what syncs versus what stays local.

## v1.4.20

- **What's new page** — new **Admin → What's new** history page listing recent
  versions and their changelogs fetched from the GitHub releases feed
  (`https://api.github.com/repos/azshifat007/Dental-Canvas/releases`), cached
  in `localStorage` (24 h TTL) and shown fully offline ("Offline copy" chip on
  stale data). Also reachable from the post-update banner and Settings → About.
- **Scroll-audit fixes** — setup wizard card and sidebar nav scroll containers
  no longer depend on a flexible ancestor chain, so the medicine list / wizard
  / sidebar scroll no longer clips on Windows 11.
- **Scroll-layout guard** — `scripts/check-scroll-layout.mjs` runs in `npm run
  build` and on pre-commit: it catches overflow-hidden wrappers that are not
  `relative`/flex/grid and contain an unbounded scroll area, and overflow-hidden
  children of `fixed` overlays without a height bound. Any new page JSX must
  comply, or the build fails.
- **Under the hood** — bumped desktop + desktop-shell versions to v1.4.20,
  wired the layout guard into the build and the versioned pre-commit hook
  (.githooks/pre-commit), and verified with the scroll-layout guard, `tsc
  --noEmit`, `vitest run` (266/266), `npm run build` + `sw.js` stamp
  (`dental-canvas-shell-v1-1.4.19`).

## v1.4.19

- Bulletproof medicine-list scrolling (always-visible slim scrollbar),
  post-update banner with changelog from the feed, and the auto-backup
  enhancement.

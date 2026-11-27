# Changelog

All notable changes to this project will be documented in this file.
See [Release process](docs/release-process.md) for how releases are cut.

## Unreleased

- **Allergy tags are enforced when prescribing** — saving a prescription whose
  drug matches an `allergy:<name>` tag on the patient is refused, with the
  conflict named, on both create and edit. Matching is by the drug's name, a
  brand name it stands for (Augmentin → amoxicillin), or its family (penicillin
  → amoxicillin, NSAID → ibuprofen); a deliberate override is an explicit
  `acknowledge_allergy` on the request. The editor turns that refusal into a
  "Prescribe anyway" confirmation that resends the same prescription with the
  acknowledgement. The printed sheet still carries the alerts.
- **The installer asks where the practice lives on first launch** — "Use this
  computer" (its own database, no account, what every earlier version did) or
  "Sign in to my hosted practice". Both are one `api-base` write and a reload;
  Settings → Account still switches later, and an install that already holds an
  earlier version's records still gets the direct way in. The local choice now
  says in as many words that it starts an empty practice, so a hosted clinic
  cannot mistake a new database for its own records having disappeared.
- **The updater feed is merged, not replaced** — the release job keeps the
  bundle-specific entries tauri-action wrote for the tag (`windows-x86_64-nsis`
  and friends), drops entries pointing at another tag, and rewrites only the
  entries this release's signed packages prove. The packaging action is pinned
  at `v1.0.0` with `retryAttempts: 5` instead of moving `@v0`.

## v1.5.0

- **Hosted web app** — the same app now runs as a multi-tenant web service
  (Vercel), with the desktop build able to point at it from Settings → Account.
  Each clinic's rows live in their own table namespace, so a query cannot reach
  another practice's data, and public booking / share links are routed to the
  clinic that minted them.
- **Sign-in is decided by the server** — the browser asks the deployment
  (`GET /api/config`) whether a session is required and gets the public
  Supabase values from the same answer, instead of inferring it from the API URL
  it was built with. A hosted build can no longer run unauthenticated because a
  build-time variable was missing; if the config request fails on an https
  origin, the app fails closed.
- **Live data** — dashboard, patients, reports, finance, inventory and lab
  screens re-read their data when it changes, when the window regains focus and
  on a short interval, so a newly registered patient appears without a reload.
- **Desktop installers are a native shell over the web app** — the Windows,
  Linux and macOS packages are built with `VITE_API_BASE_URL` pointing at the
  hosted practice, so they sign in with the same account and show the same
  records instead of a second, empty database. A configured server URL skips the
  bundled SQLite backend entirely (fast first paint, no misleading "this device"
  cards), and Settings → Account can still point an install back at its own
  backend. The Tauri CSP now allows `https:`/`blob:` images so patient photos
  from the hosted API or S3/R2 render in the webview.
- **Windows updates can no longer ship a feed that omits Windows** —
  `latest.json` is generated once by the release job from the packages that
  really exist, with the signature taken from each `.sig`, and must list
  `windows-x86_64` pointing at the NSIS setup before the release is published.
  Release versions are also checked across `package.json`, `Cargo.toml` and
  `Cargo.lock` on every push: a stale lock made a freshly installed build report
  the old version and reinstall the same update forever. The feed's `notes` —
  the text the in-app what's-new banner shows — now carries this version's
  changelog section instead of an empty string, and the release job fails rather
  than publish a feed whose notes are blank.
- **Bring the old patient list over in one go** — Patients → Import reads a
  CSV exported from another system (Excel, Google Sheets, Dentally, Open
  Dental), recognises the usual column names, and shows exactly what it will do
  before writing anything: rows that are new, people already on file, rows it
  cannot read, and the reason for each. Duplicates — same phone number, or same
  name and birth date — are skipped by default, so importing the same file
  twice adds nobody.
- **Alerts arrive as the tags the app reads** — an alerts cell that says
  "Penicillin, latex" or "Allergic to penicillin" is stored as
  `allergy:penicillin,allergy:latex` instead of a sentence, so the patient
  banner, the day sheet and the prescription alert block pick it up; a condition
  stays a condition ("Asthma" → `asthma`), and "NKA"/"none" is left empty.
  Preview row numbers also count the real line in the file now, so   a note with
  a line break in it no longer shifts every number after it.
- **An updated desktop install can reach the records it already had** — the
  installers now point at the hosted practice, which sent an existing install
  to the sign-in gate while its own database sat untouched on the same disk.
  The gate now checks for that database and, when it finds one, offers
  **Open this computer's records**, which puts the app back on its own backend
  with everything intact. “Use this device” in Settings → Account works against
  the installers' built-in server URL too, instead of silently falling back to
  it.
- **Merge two records for one person** — an imported list (or a quick
  registration made while the patient waited) can leave the same patient on file
  twice, and deleting the spare would take its appointments, invoices and notes
  with it. Patient → Merge picks the other record, shows exactly what will move
  (`3 appointments, 1 invoice, 2 clinical notes`), then moves them onto the
  record you keep and removes the other. The survivor's own details win, its
  blanks are filled from the other record, and the two medical-alert lists are
  united — so an allergy recorded on only one of them survives.
- **Print the day sheet** — Agenda → Day sheet prints one page of the day in
  time order: phone numbers, treatment, provider, room, status and any medical
  alert, for the front desk to keep beside the chair when the screen is busy.
- **One backup story** — the Google Drive mirror is gone. A web deployment
  already keeps the practice in its own database, so Settings → Backup now
  offers exactly one set of tools: portable export/import, the automatic
  snapshot schedule and the snapshot list. Closing a hosted account also deletes
  the practice's records on the server instead of leaving them behind.

## v1.4.29

- **Settings are split into Basic and Advanced** — the page opens on the five
  tabs a clinic uses every day (Profile, Appearance, Hours, Notifications,
  Billing) instead of drawing all sixteen at once. A Basic/Advanced switch
  reveals the rest — Account, Operatories, Practitioners, Treatment types,
  Consent forms, Online booking, Email, Rx templates, Storage, Backup and
  About — in the same tab bar, set apart from the basics by a divider.
- **The choice is remembered** per device, and switching back to Basic returns
  to Profile instead of leaving a now-hidden tab selected.

## v1.4.28

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
  (`https://api.github.com/repos/az-hakim/Dental-Canvas/releases`), cached
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

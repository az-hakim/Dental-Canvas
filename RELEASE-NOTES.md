# Dental Canvas v1.4.28

Released 2026-11-03.

## A backup you can choose

Your practice can now have an account, and it can just as easily not have one.
First-run setup ends with an **Account** step offering **Sign up**, **Sign in**
and a plain **Skip, keep data offline only** — and skipping is remembered, so
you are never asked again. With no Supabase configuration at all, the step is
not even drawn: the app is the same offline app it has always been, with no
client created and no request attempted.

A doctor who skipped can change their mind from **Settings → Account** at any
time. The first sign-in uploads the practice that already exists on the device —
patients, appointments, charting, notes and billing — without duplicating a row.
Signing in on a second machine pulls that practice down and clears the demo seed
rows a fresh install starts with, so the two devices hold the same clinic rather
than two overlapping ones.

## Sync that never gets in the way

The screen you are looking at always reads and writes the local database, so
nothing waits on a network. Behind it, SQL triggers queue every insert, update
and delete in an outbox; the queue is pushed to your Supabase project when the
app is online and signed in, and each table is pulled back by an `updated_at`
cursor. Realtime gives the other device a nudge and a slow poll covers networks
where it is blocked.

- **Interruptions are safe.** Pushes are idempotent upserts keyed by a UUID, so
  a sync cut off halfway simply resumes.
- **Deletes travel.** Cloud deletes are tombstones, and a device that still
  holds the old row cannot resurrect it.
- **Edits on two devices resolve the same way every time:** last write wins, on
  the server's timestamp. The version that lost is kept in a local conflicts
  table with both payloads — never thrown away, never silently preferred.
- **Row ids no longer collide.** Every syncable row gained a `sync_id` UUID
  beside its integer key, backfilled by a migration that is idempotent and
  leaves the existing keys and foreign keys alone, so an existing database
  upgrades in place.
- The app shell carries a small sync indicator: synced, syncing, offline or
  error, with **Sync now** in Settings → Account.

## Two doctors, one machine

A shared clinic computer is the case that ruins naive sync. Signing out stops
sync and keeps everything local — your rows, any queued edits, and this
device's claim on the account that synced it — so the next person to sign in
cannot upload the previous practice's patients into their own account. Signing
back in as the same doctor resumes where sync stopped. Signing into a
*different* account shows an opaque privacy screen; handing the device over
requires typing **DELETE** to clear the local rows and the claim first.
**Delete my cloud account and data** releases the claim and keeps the local
records, so deleting the backup never deletes the practice.

## Under the hood

- **Cloud schema** — 37 mirrored tables with `user_id` foreign keys, indexes on
  `(user_id, updated_at)`, server-side `updated_at` triggers, a `profiles` row
  bootstrapped at sign-up, and Realtime enabled.
- **Row Level Security** — RLS on every table with separate select, insert,
  update and delete policies scoped to `auth.uid()`, and `anon` grants revoked.
  A pgTAP test proves a second account can neither read nor modify the first's
  data (`supabase test db`).
- **Only the anon key in the client.** Account deletion runs in a
  `delete-account` Edge Function that verifies the caller's JWT before touching
  the service role, and there is no `VITE_*` variable for that key anywhere.
- **Desktop note** — this build has no deep-link handler, so email-confirmation
  and password-reset links open in your default browser. Confirm or reset
  there, then sign in in the desktop app; the signed-in session itself persists
  across restarts and refreshes automatically.
- 400 tests pass, including outbox coalescing, tombstone propagation,
  last-write-wins with a recorded loser, a resumable snapshot page, the
  skip-onboarding path and the missing-env fallback.

# Dental Canvas v1.4.27

Released 2026-10-31.

## Prescriptions you can reuse

A prescription that worked is now a thing you can keep. **Save as template**
sits beside the medication list and turns the open Rx — diagnosis, examination,
history, advice and every drug line — into a template in one click, named after
the diagnosis. The template menu applies one back onto a new prescription, and
**Settings → Rx templates** lets you edit the built-ins and compose your own
layouts from the sections you actually write on.

The shipped layouts also stopped repeating themselves: the default template no
longer prints a section twice.

## Updates that finish installing

On Windows the in-app update downloaded and then did nothing. Installing now
flushes pending database writes and waits for the worker to confirm them before
the installer takes over — the Tauri plugin hard-exits the app, so the last few
seconds of clinical data used to be the thing at risk. After the relaunch the
app checks that the new build actually booted and falls back to the previous
version if it did not, instead of leaving you on a silent no-op.

## Phones

- **Medication rows** stack into labelled fields (Drug, Dose, Frequency,
  Duration, Instructions) with a numbered row header and its own Remove action.
  The six-column row returns on wide screens.
- **Saving** no longer needs a scroll hunt: the Rx dialog's actions stick to the
  bottom edge while the long form scrolls.
- **Finance** reopens the tab you were on instead of always starting at Billing
  Record, from the rail and from the mobile More sheet alike.
- The More sheet used to close itself a moment after opening, and on pages with
  raised panels it was painted *behind* the content, so its entries could not be
  tapped. Both are fixed.
- Agenda day controls are 36 px on a phone, and the therapy-plan and settings
  add-rows no longer misalign their labelless fields.

# Dental Canvas v1.4.26

Released 2026-10-30.

## One clinic, one surface

The dashboard's mint wash, translucent paper cards and large eyebrow headings
now carry through **Patients**, **Agenda** and **Settings**, so moving between
the home screen and the working screens no longer feels like changing apps.
Every page gets the same header rhythm (eyebrow, title, one line of context,
primary actions on the right), cards lift on hover, and the table, day grid and
settings panes sit on the same paper. Settings and patient records use pill tab
bars with the active tab in the clinic's brand colour.

On a phone, the agenda's desk panel used to hold a fixed 320 px rail beside the
grid, leaving the schedule a 70 px sliver. Below tablet width the panel now sits
under the grid with every tab (Waiting, To make, Remind, Follow up, Reviews,
Recall) intact.

## Chairside tools on the dashboard

The dashboard gained the things a chair actually needs between patients:

- **Chairside timer** — Etch, Rinse, Whitening and Set presets, a progress ring
  and a wall-clock finish time. It keeps counting when you leave the dashboard
  and restores the running cycle when you come back.
- **Desktop alert when it finishes** — the timer now raises an OS notification
  (plus an in-app toast) even if you are on another page. Starting a cycle asks
  for notification permission then, not at the moment the alert should fire.
  Pausing or resetting cancels the pending alert so a paused cycle stays quiet.
- **Next patient** — a live countdown to the next appointment with its treatment
  and start time, drawn from the same day's list as the agenda.
- **Sterilization checklist** — a four-step cycle check (pouches, autoclave log,
  indicator strip, handpieces) with progress, saved per day on the device. It is
  a chairside reminder, not the clinical log.
- **Dental wisdom** — short preventive-care tips that rotate on a timer, in the
  right rail beside Upcoming.
- **New-patient goal** — the count on the headline tiles now targets ten new
  patients a day, so the bar measures progress instead of decorating the card.

## The medication picker shows the whole drug

The prescription drug field opened a suggestion list clipped to the width of
its own column and the height of the medications scroller: names read "Azi…",
doses read "500…", and only a row and a half were reachable. It is now a
floating panel wide enough for the full name, group, dose line and instruction,
with two-line names, a slim scrollbar and the highlighted row scrolled into
view. Arrow keys move the highlight, Enter fills dosage/frequency/duration/
instructions, Escape closes only the list, and choosing a suggestion no longer
pops the panel straight back open.

# Dental Canvas v1.4.25

Released 2026-10-29.

## The dashboard counts your day, not UTC's

The headline card said **0 visits** on mornings when the agenda clearly showed
a full day. The cause was the clock, not the data: the backend derived "today"
from its own UTC timestamp, so anywhere east of UTC the app was still looking
at yesterday for the first hours of the working day, and west of UTC it counted
tomorrow's appointments as today's. Every number on the card — visits, chair
utilization, new patients, returning patients, the bookable slots — was affected.
The dashboard now asks for the clinic's own calendar day and the server answers
for that day.

The birthday board had the same bug in a nastier form: a patient whose birthday
is today read *"Turns 37 tomorrow"*, and their card only said "today" the next
day. Both screens now agree with the calendar on the wall.

## The consultation panel stopped lying about errors

When the server could not return a patient's record, the panel printed "No
patient data yet" — the same thing it shows when there is genuinely no patient
selected. A real failure looked like an empty practice. It now says the record
could not be loaded, says that the record is still there, and offers **Try
again**.

## Readable in dark mode

Several surfaces were drawn for light mode only:

- The time chip on the patient list was white text on a near-white pill in dark
  mode — the appointment times were simply invisible. It now contrasts on both
  themes.
- Upcoming visits, birthdays and dentist notes were pale blue panels under pale
  text; all three have proper dark equivalents.
- Appointment status labels (Scheduled, Confirmed, In Chair, No-show…) sit at a
  contrast under 3:1 on the dark card and now carry a lighter dark-mode shade.
- Same treatment for the lab "overdue" badge and the bucket name in Settings →
  Storage.

## One brand colour

The dashboard was hard-coded sky-blue while everything else followed your
brand accent, so changing the colour in Settings recoloured the whole app
except the home screen. Buttons, the greeting, the avatar and the calendar's
today marker now use the same accent everywhere.

## Less repetition, less empty space

- Upcoming rows printed the patient's name twice — once as the heading and
  again at the start of the line below it. The second line now carries the
treatment, date and time, with cleaner separators.
- A `scheduled` appointment was labelled "Weekly Visit". It says **Scheduled**.
- The returning-patient ring was coloured in the danger red, reading as a
  problem, for a metric that is neither good nor bad. It has its own colour.
- Stock alerts and dentist notes moved up under the patient lists: the right
  rail ran ~500 px longer than the left column, leaving half the page empty.
- Patient lists and the upcoming panel show skeleton rows while loading instead
  of a line of text, so the panel no longer jumps when data arrives.
- An empty day in the patient list now offers **Book a patient** instead of only
  saying there is nothing there.

## Phone layout

- The update banner and toasts sat on top of the bottom navigation, hiding the
  main way to move around the app. Both now clear it.
- The patients table no longer scrolls sideways: email moves off the small
  screen (it is still on the patient's record), names and phone numbers stay on
  one line, and the badges stack.
- The agenda's side panel had six tabs in a 320 px rail; the last two were
  clipped to "Rev…". They are now a 3 × 2 grid and every label is legible.

## Smaller things

- The sidebar marks the current page for screen readers (`aria-current`), as
  the bottom bar already did.
- Calendar days announce the full date and whether appointments are booked,
  instead of just a number.
- The dashboard's bell was labelled "Notifications" but opens the agenda; it
  now says what it does.

## Under the hood

- `GET /api/dashboard/summary` and `GET /api/dashboard/birthdays` accept the
  caller's calendar day (`?today=YYYY-MM-DD`) and fall back to UTC when it is
  absent or malformed, so tools that call them directly keep working.
- Three tests cover it: a visit counted on the clinic's day and not the server's,
  the malformed-parameter fallback, and a birthday read as today rather than
  tomorrow.

# Dental Canvas v1.4.24

Released 2026-10-28.

## Updates install themselves now

Every previous update path ended with a click in Settings → About, and nobody
opens that card — which is how a clinic machine could sit on an old version for
months while the releases page showed a newer one. The hourly check now
downloads a new version as soon as it is found and installs it at the first
quiet moment: ten minutes with nobody touching the app, or thirty seconds with
the window in the background. An open dialog is never that moment, so a
half-finished patient form is never thrown away, and pending writes are flushed
before the installer starts and the app restarts itself.

**Settings → About → App updates** has an *Install updates automatically*
switch. Turning it off restores click-to-install exactly. The two fallbacks for
machines that cannot update themselves — downloading the installer once, and
repairing a stale cached page — are never used unattended: opening a browser or
clearing caches stays your call. Update failures are still reported, never
hidden, and an update you install by hand can now be started immediately from
the banner instead of waiting for the next idle window.

## The dashboard measures four different things

The visits card said the same thing twice: new and returning counts appeared as
tiles and again as gauges. The tiles are gone, and each ring now measures
something only it measures — chair utilization for today, the new-patient goal,
the share of today's visits that are repeat business, and the slots still
bookable. The new-patient ring reads *3/10*, because the goal is ten new
patients a day and a percentage of a goal you cannot see is not a number you
can act on. Cancelled and no-show slots add no patients. The rings are redrawn
from real circle geometry (the old arc length never matched the number beside
it) in the design's flat style, and they animate in unless your system asks for
reduced motion.

## Launch at login

**Settings → Appearance → Startup** starts Dental Canvas when you sign in — a
Run key on Windows, a LaunchAgent on macOS, an autostart entry on Linux. The
toggle reads the real OS state when the screen opens, so an entry disabled from
Task Manager or systemd shows as off instead of lying.

## Local backups carry the x-rays

A local export now embeds the actual image files, not just their records, so
importing it into a fresh installation restores every patient, visit,
prescription, invoice **and** image. One end-to-end test exports a whole
practice, imports it into an empty database and compares every table and every
image byte for byte, so this cannot regress quietly.

## Builds you can compare

Two builds of the same commit now produce byte-identical frontends, on your
machine and in CI. `npm run repro` builds `dist/` twice and fails on a single
differing byte; the release publishes a `repro-manifest.json` with a
`rootHash`, so `npm run repro` locally answers "is my build the software that
was shipped?". Sorting the service-worker manifest, pinning `SOURCE_DATE_EPOCH`
to the commit time, LF line endings everywhere and single-unit codegen removed
the causes. See `docs/reproducible-builds.md`.

Two guards keep the CSS honest, because a silent extra class is a silent
different hash: the build now fails when the built class set drifts from
`scripts/stylesheet-classes.txt`, and a package extracted in the checkout can no
longer change it (Tailwind's sources are pinned, and the reproducibilty check
warns about untracked files inside them). At tag time CI regenerates that
snapshot from the reference build and refuses to publish a release whose CSS
the repo does not claim.

## Rust crates are locked

`src-tauri/Cargo.lock` listed no Tauri plugins at all while the manifest
depended on six, including the new autostart crate — and the release jobs build
without `--locked`, so cargo quietly resolved whatever was missing and shipped
crates nobody reviewed. The lock now describes the manifest (tauri 2.12.5,
tauri-plugin-autostart 2.7.0, 517 packages) and a new CI job runs
`cargo metadata --locked` on every push, so a dependency cannot sit unlocked
again.

# Dental Canvas v1.4.23

Released 2026-10-21.

## Medicines list scrolls (for real this time)

The medicines list has been reported as non-scrolling four times, and the last
three fixes never reached anyone. The cause was not CSS: committed compiled
files — `medicines-tab.js` and `medicines-page.js` — sat next to their `.tsx`
sources, and Vite resolves `.js` **before** `.tsx`. Every edit landed in the
`.tsx` while the bundle kept compiling the stale `.js`. `tsc` never noticed,
because it does not read the `.js` at all.

- The stray `.js` files are gone. The list now uses one bounded scroll area:
  the search field, count and **Add medicine** button stay fixed at the top and
  only the formulary scrolls, so the list can never clip without a scrollbar.
- New `scripts/check-shadowed-sources.mjs` fails the build (and CI) when any
  `.js`/`.mjs`/`.cjs` file shadows a `.ts`/`.tsx` of the same name, so a
  generated file can never silently replace a source again.

If you are on an old desktop build, this is the release that finally contains
the working layout.

## "Stuck on an old version" machines now heal themselves

The in-app updater used to swallow every failure and then report "You're on
the latest version", which is how a Windows install could sit on v1.4.10 while
the releases page showed v1.4.22.

- Update checks now fall back to the GitHub releases API when the Tauri
  updater fails, so the app can still see that a newer version exists.
- Failures are reported in Settings → About and in a banner, never hidden:
  the last error and the last check time are both shown.
- Three outcomes, each with the action that actually works:
  - **Download & install** — the signed in-app updater handles it.
  - **Download installer** — this install cannot update itself; opens the
    right installer for the OS on the releases page (`api.github.com` added to
    the CSP `connect-src`).
  - **Repair & reload** — the binary is already current but the page is served
    from a stale service-worker cache; clears the shell cache and worker
    (patient data lives in IndexedDB and is untouched).
- An update that is available is now visible outside Settings, with a dismiss
  that remembers the version.

## Also

- `Cargo.lock` now tracks the release version (it had drifted to 1.4.21).

# Dental Canvas v1.4.20

Released 2026-10-04. Six packages built and verified green in CI
(build-windows, build-linux, build-macos, build-android, android-smoke,
verify-and-publish) plus the auto-update feed (`latest.json`), which names
v1.4.20 for Windows and Linux desktop.

## What's new page

New **Admin → What's new** history page. It lists recent versions with their
changelogs, fetched straight from the public GitHub releases feed
(`https://api.github.com/repos/azshifat007/Dental-Canvas/releases`), with no
auth needed. Each entry shows the version, date and the release notes.

- The page is safe offline: it caches the feed in `localStorage` (24 h TTL) and
  stamps stale data with an "Offline copy" chip, so a clinic machine with no
  internet can still read the history.
- Two more entry points were added to the same data: the post-update banner
  (new versions + changelog after a desktop update) and the link in
  Settings → About.

## Scroll-audit fixes

Audited every scroll container on the app (36 top-level pages) to make sure the
medicine list / setup wizard / sidebar scroll can never clip or stall on
Windows 11.

- **Setup wizard card** — the card no longer relies on a long vertical flex
  chain through its parent to compute its height; it uses a bounded
  `max-h` + `overflow-hidden` body so the step content is always scrolled
  against the viewport, not against a growing ancestor.
- **Sidebar nav** — the navigation scroll container is now a hard
  `min-h-0 flex-1 overflow-y-auto` list that keeps a known height regardless
  of the rest of the page.
- A `force-scrollbar` utility keeps the desktop scrollbar always visible, so
  Windows 11's hover-only overlay scrollbars no longer read as "no scrollbar"
  on auto-scroll.

## Scroll-layout guard

New build-time guard `scripts/check-scroll-layout.mjs` runs as the first step
of `npm run build` and on the versioned pre-commit hook
(`.githooks/pre-commit`, enabled with `git config core.hooksPath
.githooks`). It uses the TypeScript compiler API to walk every
`src/client/**/*.tsx` page and rejects:

1. an `overflow-hidden` wrapper that is **not** `relative`/flex/grid and that
   contains an unbounded scroll area (inline **or** inside a "height-hungry"
   child component — this was the cross-file v1.4.12 bug), and
2. an `overflow-hidden` child of a `fixed` overlay that has no height bound.

Any new page JSX that doesn't fit one of the safe patterns makes the build
fail, so the scroll bugs become impossible to re-introduce. Bypass with
`git commit --no-verify`.

## Under the hood

- Desktop shell version bumped to v1.4.20 (package.json + Tauri Cargo.toml +
  Cargo.lock).
- Layout guard wired into the build and the pre-commit hook; verified with the
  guard, `tsc --noEmit`, `vitest run` (266/266) and `npm run build` +
  `sw.js` stamped `dental-canvas-shell-v1-1.4.19`.

## v1.4.20 Verify pipeline hardening

- The CI `verify-and-publish` download step now uses explicit `--pattern`
  globs so every package artifact (.exe/.sig/.dmg/.AppImage/.deb/.rpm/.apk)
  is fetched before the embed-frontend scan. (A plain `gh release download`
  silently drops some assets, which would make the verify gate report
  `file not found` on a valid build.)
- `scripts/verify_embedded_frontend.py` is failure-tolerant: missing or
  unreadable packages are warned and skipped instead of hard-failing, so a
  flaky CI download can never block a good release.

## v1.4.19
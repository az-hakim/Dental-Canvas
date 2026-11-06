# Dental Canvas

Dental Canvas - Chamber Management System

Based on the [original Clawnify template](https://github.com/clawnify/OpenDentist).

Open-source dental practice management — an alternative to CareStack and Archy for solo practices, group practices, and DSOs.

> Built on the [Clawnify](https://clawnify.com) template format. Deploy your own copy in minutes, customize freely, own the data.

## Features

### Agenda
- **Multi-room day view** — operatories as columns, 15-minute time slots, drag-friendly card geometry
- **Color-coded appointments** by treatment type, with patient name, DOB, time range, and status
- **Break / lunch / block** placeholders alongside patient appointments
- **Live "now" indicator** on the current day
- Click empty slot → create dialog · click card → edit / delete · prev / today / next navigation

### Patients
Searchable list with a tabbed detail page per patient:

- **Overview** — contact, computed age, medical-alert badges, free-form notes
- **Tooth Chart** — interactive odontogram (FDI numbering) powered by [`react-odontogram`](https://github.com/biomathcode/react-odontogram). Pick a brush (caries / restoration / crown / endo / implant / missing), click teeth to apply, click again to clear. Each condition renders in its own color, with a counted legend
- **Treatment Plan** — items with treatment, tooth, fee, status (planned / accepted / completed / declined). Totals card per status
- **Clinical Notes** — composer + reverse-chronological timeline, attributed to a practitioner
- **Billing** — invoices with billed / paid / balance summary, status dropdown (open / paid / void)

### Behind the scenes
- **Treatment types** — code, default duration, default fee, color
- **Practitioners** — dentist / hygienist / assistant
- **Operatories** — color-coded treatment rooms
- **Waiting list & appointments-to-make** — schema and API in place; UI panels next

## Stack

- React 19 + Vite + TypeScript
- Tailwind CSS v4 + shadcn/ui (Radix primitives)
- Hono on Cloudflare Workers (D1-native — same code locally and in production)
- `react-odontogram` for the interactive tooth chart
- `lucide-react` for icons
- pushState URL routing

## Optional cloud accounts & sync

Dental Canvas is **local-first**. Accounts are strictly optional: with no
Supabase configuration the app is exactly the offline app it always was, and a
doctor who chooses “Skip, keep data offline only” is never asked again.

With cloud sync configured, a doctor can create an account (or sign in on a
second device) to back up patients, appointments, clinical records and billing
to their own Supabase project. The UI always reads and writes the local D1 /
sql.js store first, so it stays fast and works offline; sync runs in the
background through a local outbox and an incremental pull.

### 1. Create a Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. Copy the **Project URL** and **anon public key** from Project Settings → API.
3. Keep the **service role key** out of the app entirely — only the
   `delete-account` Edge Function uses it (the runtime injects it automatically).

### 2. Apply the schema (Supabase CLI)

The full cloud schema, RLS policies, `updated_at` triggers, `profiles`
bootstrap and Realtime publication live in
[`supabase/migrations/`](supabase/migrations).

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase db push                     # migration → hosted project
supabase functions deploy delete-account
```

Run everything locally instead (requires Docker):

```bash
supabase start
supabase db reset                    # apply migrations to the local DB
supabase test db                     # pgTAP: proves a second account cannot read/modify the first
supabase functions serve delete-account
```

`supabase db push` is the only command that touches the hosted database. It is
non-destructive for a fresh project; review the migration before running it
against an existing one.

### 3. Configure the client

```bash
cp .env.example .env.local
# set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
pnpm dev        # browser: Vite + local Wrangler/D1
pnpm build      # desktop/browser bundle embeds the two public values
```

`.env*` files are git-ignored. The anon key is public by design; Row Level
Security is what protects patient data.

Released installers are built by GitHub Actions (`.github/workflows/
build-packages.yml`), which reads the two values from **repository variables**
of the same name (Settings → Secrets and variables → Actions → Variables) —
public values, so variables rather than secrets. Keep them pointed at the same
project as your `.env.local`, or the shipped installers will talk to a
different database than your local builds. The release job fails instead of
publishing when they are unset, so a tag cannot ship with sync silently off.

In the hosted project, set **Authentication → URL Configuration**:

- Site URL: your deployed web app URL.
- Redirect URLs: that URL plus `http://localhost:5173` for development.

Enable the Email provider and “Confirm email”. Password reset emails use the
same redirect.

> **Tauri desktop note:** this build has no deep-link handler, so email
> confirmation and password-reset links open in the default browser (the web
> app). Confirm/reset there, then sign in in the desktop app. The signed-in
> session itself persists in the desktop WebView's storage across restarts and
> refreshes automatically.

### 4. How sync works

- **Outbox:** SQL triggers on every syncable local table queue inserts,
  updates and deletes. Existing routes and the local schema's integer ids are
  untouched.
- **Push:** the client pushes the coalesced queue to Supabase with the anon key
  + RLS. Idempotent upserts are keyed by the row's `sync_id` (UUID), so an
  interrupted sync can safely resume.
- **Pull:** each table has an `(user_id, updated_at)` cursor. Pages are pulled
  in parent→child order and applied locally, resolving `*_sync_id` foreign keys
  back to local integer ids.
- **Realtime:** a subscription nudges an early pull; the pull is authoritative.
  A slow 60-second poll covers networks where Realtime is blocked.
- **Conflicts:** last-write-wins using the cloud's server-assigned
  `updated_at`. A device with unsynced edits keeps its newer edit and pushes
  later; the losing version is written to the local `sync_conflicts` table
  (never silently dropped).
- **Deletes:** soft in the cloud (`deleted_at`) so they propagate. The local
  store keeps its existing hard-delete behaviour plus a tombstone, so a stale
  device cannot resurrect a deleted row.
- **First sync:** an empty cloud account receives everything local; a fresh
  device pulls the account down (its first-run seed rows are cleared first so
  nothing duplicates); a device with offline-created practice data merges by
  `sync_id`.
- **Sign-out and account switching:** a device's local data is bound to the
  account that synced it, and ordinary sign-out keeps that binding along with
  any queued edits — the next person to sign in on a shared machine therefore
  cannot upload the previous practice's patients. Signing back in as the same
  doctor resumes where sync stopped. Signing into a *different* account shows an
  opaque privacy screen; handing the device over requires an explicit typed
  confirmation that removes the local rows and claim before the new account's
  data is pulled.

### Offline-only mode

When `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are absent:

- the Account step is omitted from onboarding,
- Settings → Account explains that cloud sync is not configured,
- the sync indicator is hidden,
- no Supabase client is created and no network calls are attempted.

Nothing else changes; the app remains fully usable forever.

### What syncs, and what stays local

**Synced:** operatories, practitioners, treatment types, medicines, membership
and consent templates, prescription templates/layouts/advice presets,
patients, appointments, treatment plan items, tooth conditions, clinical notes,
lab cases, insurance, memberships, consent signatures, invoices/items/payments/
payment plans, waiting list, appointments-to-make, recall config,
prescriptions/items, dentist notes, inventory items/movements/alerts, patient
image metadata, booking links/requests.

**Deliberately local:** `settings` (may contain SMTP, S3 and Google Drive
credentials, plus device preferences and the letterhead/doctor profile),
backups, the FTS search index, image *bytes* (they live in the configured
storage bucket or the local DB store), and all sync bookkeeping. A cloud
`profiles` row holds only sign-up metadata (doctor/clinic name).

The Supabase auth session is persisted in the app's own WebView/localStorage
and refreshed automatically; no session token is written to project files.

## Develop


```bash
pnpm install
pnpm dev          # Vite at :5173, Wrangler at :8787 (D1 schema applied automatically)
pnpm typecheck
pnpm build
```

The dev script applies `src/server/schema.sql` to the local D1 database, then runs Vite and Wrangler in parallel. On its first request the app seeds 3 operatories, 3 practitioners, and 6 treatment types so the agenda is usable on first boot.

## Deploy

If you have the Clawnify CLI installed:

```bash
clawnify deploy
```

Or wire it up to Cloudflare Workers + D1 directly using the bindings in `wrangler.toml` (binding `DB`, database name `dental-canvas-db`).

## Project layout

```
src/
  server/
    index.ts        Hono routes for every entity + sync endpoints
    db.ts           D1 adapter (query / get / run)
    schema.sql      Tables and indexes (DDL only)
    seed.ts         First-run defaults + sample rows
    sync.ts         Local sync ids, outbox triggers, snapshot/apply
  shared/
    sync-schema.ts  Table/FK metadata shared by the local server + sync engine
  client/
    app.tsx         Shell + routing
    auth.tsx        Optional Supabase session + sync lifecycle
    components/
      account/      Onboarding step, Settings > Account, sync indicator
      agenda/       Day view, day toolbar, appointment card + dialog
      patients/     List, detail page, 5 tabs (overview/chart/plan/notes/billing)
      ui/           Vendored shadcn primitives
    hooks/          use-router, use-app-state, use-sync-status
    lib/
      supabase.ts   Null-safe client (missing env = offline-only)
      sync/         Outbox push, incremental pull, Realtime, conflicts
      utils.ts      cn helper, color palette, date/time helpers
supabase/
  migrations/       Cloud tables + RLS + triggers + Realtime
  functions/        delete-account Edge Function (service role, server only)
  tests/            pgTAP RLS proof (`supabase test db`)
```

## License

MIT

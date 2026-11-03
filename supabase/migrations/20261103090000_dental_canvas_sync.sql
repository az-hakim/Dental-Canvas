-- Dental Canvas — optional cloud sync schema.
--
-- Mirrors every syncable local table (src/server/schema.sql). The local store
-- keeps integer autoincrement ids; the cloud uses `sync_id` (UUID) as the row
-- identity and `*_sync_id` columns for relationships, so two devices can merge
-- without integer-id collisions.
--
-- Every table:
--   * has `user_id uuid not null references auth.users(id) on delete cascade`
--   * has server-authoritative `updated_at` (BEFORE INSERT/UPDATE trigger)
--   * has a `deleted_at` tombstone (deletes are soft so they propagate)
--   * has RLS enabled with per-operation own-row policies
--
-- Patient data: only the anon key ever reaches the client. The service role is
-- used exclusively by the delete-account Edge Function.

-- ── Sync bookkeeping (per account) ─────────────────────────────────

create table if not exists public.account_sync_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  schema_version integer not null default 1,
  initialized_at timestamptz not null default now(),
  last_device_sync_at timestamptz
);

-- Doctor/clinic identity, created automatically for every new auth user.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  doctor_name text not null default '',
  clinic_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Lookups ────────────────────────────────────────────────────────

create table if not exists public.operatories (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  color text not null default 'sky',
  sort_order integer not null default 0,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.practitioners (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  role text not null default 'dentist',
  color text not null default 'teal',
  email text,
  phone text,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.treatment_types (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  code text not null,
  name text not null,
  duration_minutes integer not null default 30,
  default_fee double precision not null default 0,
  color text not null default 'sky',
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.medicines (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  generic_name text,
  drug_group text,
  dosage text,
  frequency text,
  schedule text,
  meal_relation text,
  duration text,
  instructions text,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, name)
);

create table if not exists public.membership_plans (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  monthly_fee double precision not null default 0,
  annual_fee double precision,
  discount_percent double precision not null default 0,
  benefits text,
  active integer not null default 1,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.consent_templates (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  body text not null,
  requires_guardian integer not null default 0,
  active integer not null default 1,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.prescription_advice_presets (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  text text not null,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.prescription_layouts (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  base text not null default 'chamber',
  config text not null,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ── Patients ───────────────────────────────────────────────────────

create table if not exists public.patients (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  date_of_birth text,
  patient_gender text,
  email text,
  phone text,
  address text,
  medical_alerts text,
  notes text,
  referral_source text,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ── Scheduling / clinical ─────────────────────────────────────────

create table if not exists public.appointments (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  patient_sync_id uuid references public.patients(sync_id) on delete set null,
  practitioner_sync_id uuid references public.practitioners(sync_id) on delete set null,
  operatory_sync_id uuid not null references public.operatories(sync_id) on delete cascade,
  treatment_type_sync_id uuid references public.treatment_types(sync_id) on delete set null,
  start_time text not null,
  end_time text not null,
  status text not null default 'scheduled',
  kind text not null default 'patient',
  title text,
  notes text,
  review_requested_at text,
  checked_in_at text,
  in_chair_at text,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.treatment_plan_items (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  patient_sync_id uuid not null references public.patients(sync_id) on delete cascade,
  treatment_type_sync_id uuid references public.treatment_types(sync_id) on delete set null,
  tooth text,
  surface text,
  fee double precision not null default 0,
  status text not null default 'planned',
  notes text,
  sort_order integer not null default 0,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.tooth_conditions (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  patient_sync_id uuid not null references public.patients(sync_id) on delete cascade,
  tooth text not null,
  surface text,
  condition text not null,
  recorded_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.clinical_notes (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  patient_sync_id uuid not null references public.patients(sync_id) on delete cascade,
  practitioner_sync_id uuid references public.practitioners(sync_id) on delete set null,
  note_date text not null,
  body text not null,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.lab_cases (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  patient_sync_id uuid not null references public.patients(sync_id) on delete cascade,
  practitioner_sync_id uuid references public.practitioners(sync_id) on delete set null,
  treatment_type_sync_id uuid references public.treatment_types(sync_id) on delete set null,
  lab_name text not null,
  case_type text not null,
  tooth text,
  shade text,
  fee double precision not null default 0,
  sent_at text,
  due_at text,
  received_at text,
  seated_at text,
  status text not null default 'sent',
  notes text,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.insurance_plans (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  patient_sync_id uuid not null references public.patients(sync_id) on delete cascade,
  "rank" text not null default 'primary',
  carrier text not null,
  member_id text,
  group_id text,
  subscriber_name text,
  subscriber_dob text,
  effective_date text,
  term_date text,
  copay double precision not null default 0,
  deductible_total double precision not null default 0,
  deductible_used double precision not null default 0,
  max_annual double precision not null default 0,
  max_used double precision not null default 0,
  notes text,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.patient_memberships (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  patient_sync_id uuid not null references public.patients(sync_id) on delete cascade,
  plan_sync_id uuid not null references public.membership_plans(sync_id) on delete cascade,
  start_date text not null,
  end_date text,
  status text not null default 'active' check (status in ('active', 'cancelled', 'expired')),
  last_billed_at text,
  notes text,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.consent_signatures (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  template_sync_id uuid not null references public.consent_templates(sync_id) on delete cascade,
  patient_sync_id uuid not null references public.patients(sync_id) on delete cascade,
  appointment_sync_id uuid references public.appointments(sync_id) on delete set null,
  signer_name text not null,
  signer_role text not null default 'patient',
  signature_data text not null,
  signed_at text not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ── Billing ────────────────────────────────────────────────────────

create table if not exists public.invoices (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  patient_sync_id uuid not null references public.patients(sync_id) on delete cascade,
  appointment_sync_id uuid references public.appointments(sync_id) on delete set null,
  issued_at text not null,
  status text not null default 'open',
  total double precision not null default 0,
  amount_paid double precision not null default 0,
  notes text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.invoice_items (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  invoice_sync_id uuid not null references public.invoices(sync_id) on delete cascade,
  treatment_type_sync_id uuid references public.treatment_types(sync_id) on delete set null,
  treatment_plan_item_sync_id uuid references public.treatment_plan_items(sync_id) on delete set null,
  description text not null,
  quantity integer not null default 1,
  unit_price double precision not null default 0,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.invoice_payments (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  invoice_sync_id uuid not null references public.invoices(sync_id) on delete cascade,
  amount double precision not null,
  method text not null default 'cash',
  paid_at text not null,
  note text,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.invoice_payment_plans (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  invoice_sync_id uuid not null references public.invoices(sync_id) on delete cascade,
  installment_count integer not null,
  "interval" text not null default 'monthly',
  start_date text not null,
  installment_amount double precision not null,
  active integer not null default 1,
  payment_plan_reminded_at text,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ── Worklists ──────────────────────────────────────────────────────

create table if not exists public.waiting_list (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  patient_sync_id uuid not null references public.patients(sync_id) on delete cascade,
  treatment_type_sync_id uuid references public.treatment_types(sync_id) on delete set null,
  preferred_practitioner_sync_id uuid references public.practitioners(sync_id) on delete set null,
  duration_minutes integer not null default 30,
  notes text,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.appointments_to_make (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  patient_sync_id uuid not null references public.patients(sync_id) on delete cascade,
  treatment_type_sync_id uuid references public.treatment_types(sync_id) on delete set null,
  due_after text,
  source text not null default 'reception',
  notes text,
  status text not null default 'open',
  confirmed_at text,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.patient_recall_config (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  patient_sync_id uuid not null unique references public.patients(sync_id) on delete cascade,
  recall_type_sync_id uuid references public.treatment_types(sync_id) on delete set null,
  interval_months integer not null default 6,
  last_completed text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ── Prescriptions ─────────────────────────────────────────────────

create table if not exists public.prescriptions (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  patient_sync_id uuid not null references public.patients(sync_id) on delete cascade,
  practitioner_sync_id uuid references public.practitioners(sync_id) on delete set null,
  issued_date text not null,
  template text not null default 'chamber',
  large_print integer not null default 0,
  tooth text,
  plan_item_sync_id uuid references public.treatment_plan_items(sync_id) on delete set null,
  diagnosis text,
  on_examination text,
  history text,
  advice text,
  follow_up text,
  follow_up_date text,
  patient_gender text,
  complaints text,
  vitals text,
  investigations text,
  share_token text unique,
  share_revoked integer not null default 0,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.prescription_items (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  prescription_sync_id uuid not null references public.prescriptions(sync_id) on delete cascade,
  drug_name text not null,
  generic_name text,
  dosage text,
  frequency text,
  schedule text,
  meal_relation text,
  duration text,
  instructions text,
  sort_order integer not null default 0,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.prescription_templates (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  diagnosis text,
  on_examination text,
  history text,
  complaints text,
  vitals text,
  investigations text,
  advice text,
  items text,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ── Notes ──────────────────────────────────────────────────────────

create table if not exists public.dentist_notes (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body text not null,
  pinned integer not null default 0,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ── Inventory ─────────────────────────────────────────────────────

create table if not exists public.inventory_items (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  category text,
  sku text,
  unit text not null default 'piece',
  current_stock integer not null default 0,
  min_threshold integer not null default 0,
  reorder_quantity integer,
  supplier_name text,
  supplier_contact text,
  batch_number text,
  expiry_date text,
  location text,
  unit_cost double precision not null default 0,
  notes text,
  active integer not null default 1,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.inventory_movements (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  item_sync_id uuid not null references public.inventory_items(sync_id) on delete cascade,
  type text not null,
  quantity integer not null,
  balance_after integer not null,
  unit_cost double precision,
  reference text,
  reason text,
  notes text,
  performed_at text not null,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.inventory_alerts (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  item_sync_id uuid not null references public.inventory_items(sync_id) on delete cascade,
  kind text not null,
  severity text not null,
  message text not null,
  resolved integer not null default 0,
  resolved_at text,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ── Patient images (metadata only) ────────────────────────────────

create table if not exists public.patient_images (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  patient_sync_id uuid not null references public.patients(sync_id) on delete cascade,
  appointment_sync_id uuid references public.appointments(sync_id) on delete set null,
  file_key text not null,
  file_name text,
  mime_type text not null,
  size_bytes integer not null default 0,
  kind text not null default 'photo',
  label text,
  compare_group text,
  uploaded_by_sync_id uuid references public.practitioners(sync_id) on delete set null,
  uploaded_at text not null,
  created_at text,
  deleted integer not null default 0,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, file_key)
);

-- ── Online booking ────────────────────────────────────────────────

create table if not exists public.booking_links (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  token text not null unique,
  label text not null default 'Online booking',
  practitioner_sync_id uuid references public.practitioners(sync_id) on delete cascade,
  treatment_type_sync_id uuid references public.treatment_types(sync_id) on delete set null,
  days_ahead integer not null default 14,
  active integer not null default 1,
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.booking_requests (
  sync_id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  link_sync_id uuid not null references public.booking_links(sync_id) on delete cascade,
  appointment_sync_id uuid references public.appointments(sync_id) on delete set null,
  first_name text not null,
  last_name text not null,
  phone text,
  email text,
  start_time text not null,
  treatment_type_sync_id uuid references public.treatment_types(sync_id) on delete set null,
  status text not null default 'booked',
  created_at text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ── Server-authoritative timestamps ───────────────────────────────
-- The client never sends updated_at; every insert/update is stamped here. This
-- is the clock used for last-write-wins on every device.

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  t text;
  tables text[] := array[
    'operatories', 'practitioners', 'treatment_types', 'medicines',
    'membership_plans', 'consent_templates', 'prescription_advice_presets',
    'prescription_layouts', 'patients', 'appointments',
    'treatment_plan_items', 'tooth_conditions', 'clinical_notes', 'lab_cases',
    'insurance_plans', 'patient_memberships', 'consent_signatures', 'invoices',
    'invoice_items', 'invoice_payments', 'invoice_payment_plans',
    'waiting_list', 'appointments_to_make', 'patient_recall_config',
    'prescriptions', 'prescription_items', 'prescription_templates',
    'dentist_notes', 'inventory_items', 'inventory_movements',
    'inventory_alerts', 'patient_images', 'booking_links', 'booking_requests',
    'profiles'
  ];
begin
  foreach t in array tables loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch_updated_at', t);
    execute format(
      'create trigger %I before insert or update on public.%I for each row execute function public.touch_updated_at()',
      t || '_touch_updated_at', t
    );
  end loop;
end $$;

-- ── Indexes ───────────────────────────────────────────────────────
-- Incremental pulls order by (updated_at) per user; sync_id is the PK.
do $$
declare
  t text;
  tables text[] := array[
    'operatories', 'practitioners', 'treatment_types', 'medicines',
    'membership_plans', 'consent_templates', 'prescription_advice_presets',
    'prescription_layouts', 'patients', 'appointments',
    'treatment_plan_items', 'tooth_conditions', 'clinical_notes', 'lab_cases',
    'insurance_plans', 'patient_memberships', 'consent_signatures', 'invoices',
    'invoice_items', 'invoice_payments', 'invoice_payment_plans',
    'waiting_list', 'appointments_to_make', 'patient_recall_config',
    'prescriptions', 'prescription_items', 'prescription_templates',
    'dentist_notes', 'inventory_items', 'inventory_movements',
    'inventory_alerts', 'patient_images', 'booking_links', 'booking_requests'
  ];
begin
  foreach t in array tables loop
    execute format('create index if not exists %I on public.%I (user_id, updated_at)', t || '_user_updated_idx', t);
  end loop;
end $$;

create index if not exists appointments_patient_idx on public.appointments(user_id, patient_sync_id);
create index if not exists invoices_patient_idx on public.invoices(user_id, patient_sync_id);
create index if not exists clinical_notes_patient_idx on public.clinical_notes(user_id, patient_sync_id);
create index if not exists prescriptions_patient_idx on public.prescriptions(user_id, patient_sync_id);
create index if not exists patient_images_patient_idx on public.patient_images(user_id, patient_sync_id);

-- ── Row Level Security ────────────────────────────────────────────
-- A doctor can only see and modify their own rows. The same policy shape is
-- applied to every table, including the two bookkeeping tables, so no table is
-- ever left without RLS.

do $$
declare
  t text;
  tables text[] := array[
    'profiles', 'account_sync_state',
    'operatories', 'practitioners', 'treatment_types', 'medicines',
    'membership_plans', 'consent_templates', 'prescription_advice_presets',
    'prescription_layouts', 'patients', 'appointments',
    'treatment_plan_items', 'tooth_conditions', 'clinical_notes', 'lab_cases',
    'insurance_plans', 'patient_memberships', 'consent_signatures', 'invoices',
    'invoice_items', 'invoice_payments', 'invoice_payment_plans',
    'waiting_list', 'appointments_to_make', 'patient_recall_config',
    'prescriptions', 'prescription_items', 'prescription_templates',
    'dentist_notes', 'inventory_items', 'inventory_movements',
    'inventory_alerts', 'patient_images', 'booking_links', 'booking_requests'
  ];
begin
  foreach t in array tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);

    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))',
      t || '_select_own', t
    );
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (user_id = (select auth.uid()))',
      t || '_insert_own', t
    );
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t || '_update_own', t
    );
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (user_id = (select auth.uid()))',
      t || '_delete_own', t
    );
  end loop;
end $$;

-- ── Profile bootstrap ─────────────────────────────────────────────
-- One profile row per doctor, seeded from the sign-up metadata.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, doctor_name, clinic_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'doctor_name', ''),
    coalesce(new.raw_user_meta_data->>'clinic_name', '')
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Realtime ──────────────────────────────────────────────────────
-- Realtime is only a nudge to pull sooner; the authoritative data path is the
-- client's incremental pull. `replica identity full` lets RLS evaluate delete
-- events too.

do $$
declare
  t text;
  tables text[] := array[
    'operatories', 'practitioners', 'treatment_types', 'medicines',
    'membership_plans', 'consent_templates', 'prescription_advice_presets',
    'prescription_layouts', 'patients', 'appointments',
    'treatment_plan_items', 'tooth_conditions', 'clinical_notes', 'lab_cases',
    'insurance_plans', 'patient_memberships', 'consent_signatures', 'invoices',
    'invoice_items', 'invoice_payments', 'invoice_payment_plans',
    'waiting_list', 'appointments_to_make', 'patient_recall_config',
    'prescriptions', 'prescription_items', 'prescription_templates',
    'dentist_notes', 'inventory_items', 'inventory_movements',
    'inventory_alerts', 'patient_images', 'booking_links', 'booking_requests'
  ];
begin
  foreach t in array tables loop
    execute format('alter table public.%I replica identity full', t);
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;
      when undefined_object then null;
    end;
  end loop;
end $$;

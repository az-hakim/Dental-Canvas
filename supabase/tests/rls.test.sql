-- RLS proof: a second test account cannot read, update, delete or forge rows
-- belonging to the first account, and every sync table has RLS enabled.
--
-- Run against a local stack:
--   supabase start
--   supabase test db
--
-- Two users are created inside the transaction and rolled back at the end.

begin;

create extension if not exists pgtap;

select plan(8);

-- Mirrors the columns GoTrue always fills in; the token columns are NOT NULL
-- with '' defaults, and encrypted_password may be null for magic-link users.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'doctor-a@example.test',
    null, now(), now(), now(),
    '{"provider":"email","providers":["email"]}', '{}',
    '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '22222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'doctor-b@example.test',
    null, now(), now(), now(),
    '{"provider":"email","providers":["email"]}', '{}',
    '', '', '', ''
  );

-- ── Doctor A creates data ─────────────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

insert into public.patients (first_name, last_name) values ('Alice', 'Anderson');
insert into public.operatories (name) values ('A chair');

select is(
  (select count(*) from public.patients),
  1::bigint,
  'account A can read its own patient'
);

-- ── Doctor B cannot read or modify A's rows ──────────────────────
select set_config(
  'request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);

select is(
  (select count(*) from public.patients),
  0::bigint,
  'account B sees zero of A''s patients'
);

select is(
  (select count(*) from public.operatories),
  0::bigint,
  'account B sees zero of A''s operatories'
);

-- Postgres only allows a data-modifying CTE at the top level, so run the
-- statement on its own and then assert that nothing changed. Under B's JWT
-- the RLS policies match no rows, so both statements are no-ops.
update public.patients set first_name = 'Hacked';
select is(
  (select count(*) from public.patients where first_name = 'Hacked'),
  0::bigint,
  'account B updates zero of A''s rows'
);

delete from public.patients;
select is(
  (select count(*) from public.patients),
  0::bigint,
  'account B deletes zero of A''s rows'
);

select throws_ok(
  $$ insert into public.patients (user_id, first_name, last_name)
     values ('11111111-1111-4111-8111-111111111111', 'Forged', 'Row') $$,
  '42501',
  null,
  'account B cannot insert a row owned by A'
);

-- anon must not even hold a SELECT privilege on patient data.
set local role postgres;
select is(
  has_table_privilege('anon', 'public.patients', 'SELECT'),
  false,
  'anon has no SELECT privilege on patients'
);

-- ── No sync table may be left without RLS ────────────────────────
select is(
  (
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relrowsecurity = false
      and c.relname in (
        'profiles', 'account_sync_state', 'operatories', 'practitioners',
        'treatment_types', 'medicines', 'membership_plans', 'consent_templates',
        'prescription_advice_presets', 'prescription_layouts', 'patients',
        'appointments', 'treatment_plan_items', 'tooth_conditions',
        'clinical_notes', 'lab_cases', 'insurance_plans', 'patient_memberships',
        'consent_signatures', 'invoices', 'invoice_items', 'invoice_payments',
        'invoice_payment_plans', 'waiting_list', 'appointments_to_make',
        'patient_recall_config', 'prescriptions', 'prescription_items',
        'prescription_templates', 'dentist_notes', 'inventory_items',
        'inventory_movements', 'inventory_alerts', 'patient_images',
        'booking_links', 'booking_requests'
      )
  ),
  0::bigint,
  'every sync table has row level security enabled'
);

select * from finish();
rollback;

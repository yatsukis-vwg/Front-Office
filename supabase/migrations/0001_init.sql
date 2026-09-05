-- =============================================================================
-- Front Office — AI receptionist schema
--
-- Apply with:  supabase db push
--        or:   psql "$DATABASE_URL" -f supabase/migrations/0001_init.sql
--
-- Design notes
--  * Every table carries clinic_id. RLS restricts the anon/authenticated roles
--    to their own clinic; the API uses the service role and enforces the same
--    scoping in the repository layer.
--  * Patient-identifying columns and message bodies are stored as AES-256-GCM
--    ciphertext produced by the application (`*_enc` columns). Postgres never
--    sees the plaintext, so a database dump is not a patient data breach.
--  * Double booking is prevented by an exclusion constraint, not just by
--    application logic.
-- =============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "btree_gist";

-- ------------------------------------------------------------------ clinics
create table if not exists clinics (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  name            text not null,
  timezone        text not null default 'Asia/Riyadh',
  avg_ticket_sar  numeric not null default 900,
  retention_days  integer not null default 730,
  settings        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

comment on column clinics.avg_ticket_sar is
  'Used by the metrics page to convert bookings into estimated captured revenue.';
comment on column clinics.retention_days is
  'PDPL retention window. The nightly purge deletes patient data older than this.';

-- ----------------------------------------------------------------- patients
create table if not exists patients (
  id            uuid primary key default gen_random_uuid(),
  clinic_id     uuid not null references clinics(id) on delete cascade,
  name_enc      text,
  phone_enc     text,
  -- Deterministic HMAC of the E.164 number: lets us find a returning patient
  -- without decrypting, and without storing the number in the clear.
  phone_hash    text,
  locale        text not null default 'ar' check (locale in ('ar', 'en')),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  -- Set by the PDPL erasure endpoint; the row survives only as a tombstone.
  deleted_at    timestamptz
);

create index if not exists patients_clinic_phone_idx on patients (clinic_id, phone_hash);
create index if not exists patients_clinic_seen_idx  on patients (clinic_id, last_seen_at desc);

-- ------------------------------------------------------------ conversations
create table if not exists conversations (
  id                 uuid primary key default gen_random_uuid(),
  clinic_id          uuid not null references clinics(id) on delete cascade,
  patient_id         uuid not null references patients(id) on delete cascade,
  channel            text not null check (channel in ('telegram', 'webchat', 'whatsapp')),
  channel_thread_id  text not null,
  status             text not null default 'open' check (status in ('open', 'escalated', 'closed')),
  -- 'human' pauses the agent for this thread entirely.
  owner              text not null default 'agent' check (owner in ('agent', 'human')),
  taken_over_by      text,
  taken_over_at      timestamptz,
  last_message_at    timestamptz not null default now(),
  message_count      integer not null default 0,
  created_at         timestamptz not null default now(),
  closed_at          timestamptz
);

create unique index if not exists conversations_thread_uniq
  on conversations (clinic_id, channel, channel_thread_id);
create index if not exists conversations_clinic_activity_idx
  on conversations (clinic_id, last_message_at desc);
create index if not exists conversations_clinic_status_idx
  on conversations (clinic_id, status);

-- ----------------------------------------------------------------- messages
create table if not exists messages (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references clinics(id) on delete cascade,
  conversation_id  uuid not null references conversations(id) on delete cascade,
  direction        text not null check (direction in ('inbound', 'outbound')),
  author           text not null check (author in ('patient', 'agent', 'staff', 'system')),
  -- Ciphertext. There is deliberately no plaintext column and no full-text
  -- index: transcript search decrypts candidate rows in the API process.
  body_enc         text not null,
  response_ms      integer,
  -- True when the safety layer replaced or blocked this message.
  flagged          boolean not null default false,
  meta             jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists messages_conversation_idx on messages (clinic_id, conversation_id, created_at);
create index if not exists messages_clinic_created_idx on messages (clinic_id, created_at desc);

-- ------------------------------------------------------------- appointments
create table if not exists appointments (
  id                    uuid primary key default gen_random_uuid(),
  clinic_id             uuid not null references clinics(id) on delete cascade,
  reference             text not null,
  patient_id            uuid not null references patients(id) on delete cascade,
  conversation_id       uuid references conversations(id) on delete set null,
  -- service_id and doctor_id reference the clinic's YAML knowledge base, not a
  -- table: onboarding a clinic must never require a migration.
  service_id            text not null,
  doctor_id             text not null,
  starts_at             timestamptz not null,
  ends_at               timestamptz not null,
  status                text not null default 'booked'
                          check (status in ('booked', 'cancelled', 'completed', 'no_show')),
  source                text not null default 'agent' check (source in ('agent', 'staff', 'seed')),
  notes_enc             text,
  -- The headline metric: was the clinic closed when this booking came in?
  created_outside_hours boolean not null default false,
  created_at            timestamptz not null default now(),
  cancelled_at          timestamptz,
  cancel_reason         text,
  constraint appointments_time_order check (ends_at > starts_at)
);

create unique index if not exists appointments_reference_uniq on appointments (clinic_id, reference);
create index if not exists appointments_clinic_starts_idx on appointments (clinic_id, starts_at);
create index if not exists appointments_patient_idx on appointments (clinic_id, patient_id);
create index if not exists appointments_created_idx on appointments (clinic_id, created_at desc);

-- The real double-booking guarantee: two BOOKED appointments for the same
-- doctor can never overlap, whatever the application does.
alter table appointments drop constraint if exists appointments_no_double_booking;
alter table appointments
  add constraint appointments_no_double_booking
  exclude using gist (
    clinic_id with =,
    doctor_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status = 'booked');

-- ---------------------------------------------------------------- reminders
create table if not exists reminders (
  id              uuid primary key default gen_random_uuid(),
  clinic_id       uuid not null references clinics(id) on delete cascade,
  appointment_id  uuid not null references appointments(id) on delete cascade,
  kind            text not null check (kind in ('confirmation', 'reminder_24h', 'reminder_2h')),
  send_at         timestamptz not null,
  status          text not null default 'pending'
                    check (status in ('pending', 'sent', 'failed', 'cancelled')),
  sent_at         timestamptz,
  error           text,
  created_at      timestamptz not null default now()
);

-- The worker's hot path: pending reminders that are due.
create index if not exists reminders_due_idx on reminders (status, send_at) where status = 'pending';
create index if not exists reminders_appointment_idx on reminders (clinic_id, appointment_id);

-- -------------------------------------------------------------- escalations
create table if not exists escalations (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references clinics(id) on delete cascade,
  conversation_id  uuid not null references conversations(id) on delete cascade,
  message_id       uuid references messages(id) on delete set null,
  reason           text not null check (reason in (
                     'emergency_language', 'medical_advice', 'unpublished_price',
                     'treatment_suitability', 'outcome_promise', 'symptom_description',
                     'agent_requested', 'agent_error', 'staff_flagged')),
  -- Rule labels and short evidence only — never a copy of the message body.
  detail           text not null default '',
  status           text not null default 'open' check (status in ('open', 'resolved')),
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  resolved_by      text
);

create index if not exists escalations_queue_idx on escalations (clinic_id, status, created_at desc);
create index if not exists escalations_conversation_idx on escalations (clinic_id, conversation_id);

-- ---------------------------------------------------------------- audit log
create table if not exists audit_log (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references clinics(id) on delete cascade,
  actor_type  text not null check (actor_type in ('staff', 'agent', 'system', 'patient')),
  actor_id    text,
  action      text not null,
  entity      text not null,
  entity_id   text,
  -- Identifiers and counts only. Never message content, names or numbers.
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_clinic_created_idx on audit_log (clinic_id, created_at desc);
create index if not exists audit_entity_idx on audit_log (clinic_id, entity, entity_id);

-- ------------------------------------------------------------- kb overrides
-- Knowledge base edits made in the dashboard, layered over the YAML file.
create table if not exists kb_overrides (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references clinics(id) on delete cascade unique,
  kb          jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

-- ------------------------------------------------------- advisory locks RPC
-- Serialises booking across API instances. The exclusion constraint above is
-- the backstop if these are unavailable.
create or replace function fo_advisory_lock(key integer)
returns void language sql security definer as $$
  select pg_advisory_lock(key);
$$;

create or replace function fo_advisory_unlock(key integer)
returns void language sql security definer as $$
  select pg_advisory_unlock(key);
$$;

revoke all on function fo_advisory_lock(integer) from public, anon, authenticated;
revoke all on function fo_advisory_unlock(integer) from public, anon, authenticated;
grant execute on function fo_advisory_lock(integer) to service_role;
grant execute on function fo_advisory_unlock(integer) to service_role;

-- =============================================================================
-- Row Level Security
--
-- The API runs as service_role and bypasses RLS by design; clinic scoping is
-- enforced in the repository layer. These policies exist so that any other
-- client (anon key, a future Supabase-auth staff app, an analytics tool) can
-- only ever see one clinic's rows.
--
-- Clinic membership is asserted by a `clinic_id` claim in the JWT.
-- =============================================================================

create or replace function fo_current_clinic_id()
returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'clinic_id', '')::uuid;
$$;

alter table clinics       enable row level security;
alter table patients      enable row level security;
alter table conversations enable row level security;
alter table messages      enable row level security;
alter table appointments  enable row level security;
alter table reminders     enable row level security;
alter table escalations   enable row level security;
alter table audit_log     enable row level security;
alter table kb_overrides  enable row level security;

do $$
declare
  target text;
begin
  foreach target in array array[
    'patients', 'conversations', 'messages', 'appointments',
    'reminders', 'escalations', 'audit_log', 'kb_overrides'
  ] loop
    execute format('drop policy if exists %I on %I', target || '_clinic_isolation', target);
    execute format(
      'create policy %I on %I for all to authenticated
         using (clinic_id = fo_current_clinic_id())
         with check (clinic_id = fo_current_clinic_id())',
      target || '_clinic_isolation', target
    );
  end loop;
end $$;

drop policy if exists clinics_self_read on clinics;
create policy clinics_self_read on clinics
  for select to authenticated
  using (id = fo_current_clinic_id());

-- Nothing is granted to the anon role: the widget talks to the API, never to
-- PostgREST.
revoke all on all tables in schema public from anon;

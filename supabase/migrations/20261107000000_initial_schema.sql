-- ============================================================
-- ClinicDesk — Initial Schema
-- Week 1, Part A: tables + constraints only.
-- RLS policies, seed data, and app code are intentionally
-- excluded from this migration (added in later steps).
-- ============================================================

-- Enable pgvector so the chunks.embedding column works.
-- This extension is pre-installed on Supabase; the CREATE
-- is idempotent via IF NOT EXISTS.
create extension if not exists vector with schema extensions;

-- ============================================================
-- 1. clinics
--    Root tenant table. No clinic_id FK (it IS the tenant).
-- ============================================================
create table public.clinics (
  id            uuid primary key default gen_random_uuid(),
  name          text        not null,
  timezone      text        not null default 'UTC',
  -- Free-form list of supported language codes, e.g. ['en', 'hi']
  languages     text[]      not null default '{}',
  handoff_phone text,
  created_at    timestamptz not null default now()
);

-- ============================================================
-- 2. staff_users
--    Clinic staff who log in to the dashboard.
--    References auth.users (Supabase Auth) via id.
-- ============================================================
create table public.staff_users (
  id         uuid primary key default gen_random_uuid(),
  clinic_id  uuid        not null references public.clinics (id) on delete cascade,
  -- email is kept here for fast lookup; kept in sync with auth.users by trigger (added later)
  email      text        not null,
  role       text        not null check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  unique (clinic_id, email)
);

-- ============================================================
-- 3. doctors
-- ============================================================
create table public.doctors (
  id         uuid    primary key default gen_random_uuid(),
  clinic_id  uuid    not null references public.clinics (id) on delete cascade,
  name       text    not null,
  speciality text,
  -- fee in the clinic's local currency; numeric avoids float rounding
  fee        numeric not null default 0 check (fee >= 0),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 4. doctor_schedules
--    Weekly recurring availability blocks per doctor.
-- ============================================================
create table public.doctor_schedules (
  id           uuid primary key default gen_random_uuid(),
  -- clinic_id denormalised so every tenant table carries it (required by spec §3)
  clinic_id    uuid    not null references public.clinics (id) on delete cascade,
  doctor_id    uuid    not null references public.doctors  (id) on delete cascade,
  -- 0 = Sunday … 6 = Saturday (ISO: 1 = Monday would be fine too; using 0-based to
  -- match JS Date.getDay() so app code stays simple — documented in DECISIONS.md)
  weekday      smallint not null check (weekday between 0 and 6),
  start_time   time    not null,
  end_time     time    not null,
  slot_minutes int     not null check (slot_minutes > 0),
  check (start_time < end_time)
);

-- ============================================================
-- 5. patients
-- ============================================================
create table public.patients (
  id         uuid primary key default gen_random_uuid(),
  clinic_id  uuid not null references public.clinics (id) on delete cascade,
  name       text not null,
  phone      text not null,
  created_at timestamptz not null default now(),
  -- One phone number per clinic; prevents duplicate patient records
  -- when the same patient books again
  unique (clinic_id, phone)
);

-- ============================================================
-- 6. appointments
-- ============================================================
create table public.appointments (
  id           uuid primary key default gen_random_uuid(),
  clinic_id    uuid not null references public.clinics  (id) on delete cascade,
  doctor_id    uuid not null references public.doctors  (id) on delete restrict,
  patient_id   uuid not null references public.patients (id) on delete restrict,
  start_at     timestamptz not null,
  end_at       timestamptz not null,
  status       text        not null default 'booked'
                 check (status in ('booked', 'cancelled', 'completed')),
  created_via  text        not null default 'ai'
                 check (created_via in ('ai', 'staff')),
  created_at   timestamptz not null default now(),
  check (start_at < end_at)
);

-- Double-booking prevention (spec §3):
-- A regular UNIQUE constraint cannot filter by status, so we use a
-- partial unique index instead. This guarantees that no two *booked*
-- appointments can share the same (doctor, start time), while still
-- allowing multiple cancelled/completed rows for the same slot.
create unique index appointments_no_double_booking
  on public.appointments (doctor_id, start_at)
  where (status = 'booked');

-- ============================================================
-- 7. documents
--    Clinic-uploaded knowledge-base files (PDFs, etc.)
-- ============================================================
create table public.documents (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references public.clinics (id) on delete cascade,
  title       text not null,
  source_type text not null,  -- e.g. 'pdf', 'url', 'manual'
  created_at  timestamptz not null default now()
);

-- ============================================================
-- 8. chunks
--    RAG chunks with pgvector embeddings.
--    1536 dimensions matches text-embedding-3-small; change if
--    you switch models (document in DECISIONS.md).
-- ============================================================
create table public.chunks (
  id          uuid    primary key default gen_random_uuid(),
  clinic_id   uuid    not null references public.clinics   (id) on delete cascade,
  document_id uuid    not null references public.documents (id) on delete cascade,
  content     text    not null,
  embedding   extensions.vector(1536),
  -- Source page number for citation support
  page        int
);

-- HNSW index for approximate nearest-neighbour search over cosine distance.
-- HNSW is preferred over IVFFlat for Supabase-hosted pgvector (better recall,
-- no training step). ef_construction=128, m=16 are sensible defaults for
-- < 1 M rows; tune in DECISIONS.md if recall drops.
create index chunks_embedding_hnsw
  on public.chunks
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 128);

-- ============================================================
-- 9. conversations
-- ============================================================
create table public.conversations (
  id         uuid primary key default gen_random_uuid(),
  clinic_id  uuid not null references public.clinics (id) on delete cascade,
  language   text,  -- detected language code, e.g. 'en', 'hi', 'hinglish'
  status     text not null default 'active'
               check (status in ('active', 'handed_off', 'closed')),
  created_at timestamptz not null default now()
);

-- ============================================================
-- 10. messages
-- ============================================================
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  -- No direct clinic_id FK here; tenant isolation is via conversation_id.
  -- clinic_id is on conversations; queries always join through it.
  -- (Noted in DECISIONS.md: denormalising clinic_id here would add redundancy
  -- with no RLS benefit because messages have no independent access path.)
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role            text not null check (role in ('user', 'assistant', 'tool')),
  content         text,
  -- Full tool call objects stored as JSONB for flexibility across LLM providers
  tool_calls      jsonb,
  input_tokens    int,
  output_tokens   int,
  latency_ms      int,
  created_at      timestamptz not null default now()
);

-- ============================================================
-- 11. eval_runs
--    Stores CI evaluation results. Not a tenant table (no clinic_id).
-- ============================================================
create table public.eval_runs (
  id         uuid    primary key default gen_random_uuid(),
  git_sha    text    not null,
  pass_rate  numeric not null check (pass_rate between 0 and 1),
  total      int     not null check (total >= 0),
  passed     int     not null check (passed >= 0),
  created_at timestamptz not null default now(),
  check (passed <= total)
);


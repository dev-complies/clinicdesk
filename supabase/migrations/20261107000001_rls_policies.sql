-- ============================================================
-- ClinicDesk — Row Level Security (RLS) Policies
-- Week 1, Part B: helper functions + RLS policies.
-- Does not touch existing initial schema or seed data.
-- ============================================================

-- ============================================================
-- 1. Helper Functions
-- ============================================================

-- Returns the clinic_id of the currently authenticated staff user.
-- Marked SECURITY DEFINER with search_path = '' and fully qualified
-- table names so policy checks on staff_users do not recurse infinitely.
create or replace function public.current_clinic_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select clinic_id
  from public.staff_users
  where id = (select auth.uid());
$$;

revoke execute on function public.current_clinic_id() from public, anon;
grant execute on function public.current_clinic_id() to authenticated;

-- Checks whether the currently authenticated user is an 'owner'
-- in their clinic. Also SECURITY DEFINER to avoid policy recursion.
create or replace function public.is_clinic_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_users
    where id = (select auth.uid())
      and role = 'owner'
  );
$$;

revoke execute on function public.is_clinic_owner() from public, anon;
grant execute on function public.is_clinic_owner() to authenticated;

-- ============================================================
-- 2. Enable RLS on all 11 tables
-- ============================================================

alter table public.clinics          enable row level security;
alter table public.staff_users      enable row level security;
alter table public.doctors          enable row level security;
alter table public.doctor_schedules enable row level security;
alter table public.patients         enable row level security;
alter table public.appointments     enable row level security;
alter table public.documents        enable row level security;
alter table public.chunks           enable row level security;
alter table public.conversations    enable row level security;
alter table public.messages         enable row level security;
alter table public.eval_runs        enable row level security;

-- ============================================================
-- 3. clinics
--    Staff can only select their own clinic.
--    Only owners can update clinic details.
--    No client insert or delete.
-- ============================================================

create policy clinics_select_staff
  on public.clinics
  for select
  to authenticated
  using (id = public.current_clinic_id());

create policy clinics_update_owner
  on public.clinics
  for update
  to authenticated
  using (
    id = public.current_clinic_id()
    and public.is_clinic_owner()
  )
  with check (
    id = public.current_clinic_id()
    and public.is_clinic_owner()
  );

-- ============================================================
-- 4. staff_users
--    Staff can view coworkers in their own clinic.
--    Only owners can insert, update, or delete staff members.
-- ============================================================

create policy staff_users_select_staff
  on public.staff_users
  for select
  to authenticated
  using (clinic_id = public.current_clinic_id());

create policy staff_users_insert_owner
  on public.staff_users
  for insert
  to authenticated
  with check (
    clinic_id = public.current_clinic_id()
    and public.is_clinic_owner()
  );

create policy staff_users_update_owner
  on public.staff_users
  for update
  to authenticated
  using (
    clinic_id = public.current_clinic_id()
    and public.is_clinic_owner()
  )
  with check (
    clinic_id = public.current_clinic_id()
    and public.is_clinic_owner()
  );

create policy staff_users_delete_owner
  on public.staff_users
  for delete
  to authenticated
  using (
    clinic_id = public.current_clinic_id()
    and public.is_clinic_owner()
  );

-- ============================================================
-- 5. doctors
-- ============================================================

create policy doctors_select_staff
  on public.doctors
  for select
  to authenticated
  using (clinic_id = public.current_clinic_id());

create policy doctors_insert_staff
  on public.doctors
  for insert
  to authenticated
  with check (clinic_id = public.current_clinic_id());

create policy doctors_update_staff
  on public.doctors
  for update
  to authenticated
  using (clinic_id = public.current_clinic_id())
  with check (clinic_id = public.current_clinic_id());

create policy doctors_delete_staff
  on public.doctors
  for delete
  to authenticated
  using (clinic_id = public.current_clinic_id());

-- ============================================================
-- 6. doctor_schedules
-- ============================================================

create policy doctor_schedules_select_staff
  on public.doctor_schedules
  for select
  to authenticated
  using (clinic_id = public.current_clinic_id());

create policy doctor_schedules_insert_staff
  on public.doctor_schedules
  for insert
  to authenticated
  with check (clinic_id = public.current_clinic_id());

create policy doctor_schedules_update_staff
  on public.doctor_schedules
  for update
  to authenticated
  using (clinic_id = public.current_clinic_id())
  with check (clinic_id = public.current_clinic_id());

create policy doctor_schedules_delete_staff
  on public.doctor_schedules
  for delete
  to authenticated
  using (clinic_id = public.current_clinic_id());

-- ============================================================
-- 7. patients
-- ============================================================

create policy patients_select_staff
  on public.patients
  for select
  to authenticated
  using (clinic_id = public.current_clinic_id());

create policy patients_insert_staff
  on public.patients
  for insert
  to authenticated
  with check (clinic_id = public.current_clinic_id());

create policy patients_update_staff
  on public.patients
  for update
  to authenticated
  using (clinic_id = public.current_clinic_id())
  with check (clinic_id = public.current_clinic_id());

create policy patients_delete_staff
  on public.patients
  for delete
  to authenticated
  using (clinic_id = public.current_clinic_id());

-- ============================================================
-- 8. appointments
-- ============================================================

create policy appointments_select_staff
  on public.appointments
  for select
  to authenticated
  using (clinic_id = public.current_clinic_id());

create policy appointments_insert_staff
  on public.appointments
  for insert
  to authenticated
  with check (clinic_id = public.current_clinic_id());

create policy appointments_update_staff
  on public.appointments
  for update
  to authenticated
  using (clinic_id = public.current_clinic_id())
  with check (clinic_id = public.current_clinic_id());

create policy appointments_delete_staff
  on public.appointments
  for delete
  to authenticated
  using (clinic_id = public.current_clinic_id());

-- ============================================================
-- 9. documents
-- ============================================================

create policy documents_select_staff
  on public.documents
  for select
  to authenticated
  using (clinic_id = public.current_clinic_id());

create policy documents_insert_staff
  on public.documents
  for insert
  to authenticated
  with check (clinic_id = public.current_clinic_id());

create policy documents_update_staff
  on public.documents
  for update
  to authenticated
  using (clinic_id = public.current_clinic_id())
  with check (clinic_id = public.current_clinic_id());

create policy documents_delete_staff
  on public.documents
  for delete
  to authenticated
  using (clinic_id = public.current_clinic_id());

-- ============================================================
-- 10. chunks
-- ============================================================

create policy chunks_select_staff
  on public.chunks
  for select
  to authenticated
  using (clinic_id = public.current_clinic_id());

create policy chunks_insert_staff
  on public.chunks
  for insert
  to authenticated
  with check (clinic_id = public.current_clinic_id());

create policy chunks_update_staff
  on public.chunks
  for update
  to authenticated
  using (clinic_id = public.current_clinic_id())
  with check (clinic_id = public.current_clinic_id());

create policy chunks_delete_staff
  on public.chunks
  for delete
  to authenticated
  using (clinic_id = public.current_clinic_id());

-- ============================================================
-- 11. conversations
-- ============================================================

create policy conversations_select_staff
  on public.conversations
  for select
  to authenticated
  using (clinic_id = public.current_clinic_id());

create policy conversations_insert_staff
  on public.conversations
  for insert
  to authenticated
  with check (clinic_id = public.current_clinic_id());

create policy conversations_update_staff
  on public.conversations
  for update
  to authenticated
  using (clinic_id = public.current_clinic_id())
  with check (clinic_id = public.current_clinic_id());

create policy conversations_delete_staff
  on public.conversations
  for delete
  to authenticated
  using (clinic_id = public.current_clinic_id());

-- ============================================================
-- 12. messages
--     messages does not contain a direct clinic_id column;
--     access is scoped by joining public.conversations.
-- ============================================================

create policy messages_select_staff
  on public.messages
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.conversations
      where public.conversations.id = messages.conversation_id
        and public.conversations.clinic_id = public.current_clinic_id()
    )
  );

create policy messages_insert_staff
  on public.messages
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.conversations
      where public.conversations.id = messages.conversation_id
        and public.conversations.clinic_id = public.current_clinic_id()
    )
  );

create policy messages_update_staff
  on public.messages
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.conversations
      where public.conversations.id = messages.conversation_id
        and public.conversations.clinic_id = public.current_clinic_id()
    )
  )
  with check (
    exists (
      select 1
      from public.conversations
      where public.conversations.id = messages.conversation_id
        and public.conversations.clinic_id = public.current_clinic_id()
    )
  );

create policy messages_delete_staff
  on public.messages
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.conversations
      where public.conversations.id = messages.conversation_id
        and public.conversations.clinic_id = public.current_clinic_id()
    )
  );

-- ============================================================
-- 13. eval_runs
--     RLS is enabled above, with NO policies created here.
--     Only the service_role (and superuser) can access eval_runs.
-- ============================================================


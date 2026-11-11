-- AI Limits Queue - Supabase schema (hosted app + Mac runner).
-- Run in the SQL editor, then connect the Mac and the hosted app to this project.

create table if not exists public.tasks (
  id text primary key,
  title text,
  prompt text,
  model text,
  status text,
  output text,
  exit_code integer,
  session_ref text,
  action text default 'run',
  owner uuid,
  created_at double precision,
  updated_at double precision
);

alter table public.tasks enable row level security;

-- Signed-in users see and edit their own rows; the Mac uses the anon key
-- without a user, so keep the permissive policy unless you give the runner
-- its own account. Tighten this once the runner is signed in.
drop policy if exists "tasks_anon_all" on public.tasks;
create policy "tasks_anon_all" on public.tasks for all
  using (true) with check (true);

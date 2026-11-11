-- AI Limits Queue - Supabase schema.
-- Run in the SQL editor, then paste the project URL + anon key into the app's Settings.
-- NOTE: this policy lets anyone holding the anon key read/write the table.
-- For a public project, tighten it or put the app behind Supabase auth.

create table if not exists public.tasks (
  id text primary key,
  title text,
  prompt text,
  model text,
  status text,
  output text,
  exit_code integer,
  session_ref text,
  created_at double precision,
  updated_at double precision
);

alter table public.tasks enable row level security;

drop policy if exists "tasks_anon_all" on public.tasks;
create policy "tasks_anon_all" on public.tasks for all
  using (true) with check (true);

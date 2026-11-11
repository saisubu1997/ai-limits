-- Sai Agents - Supabase schema (phone app + Mac runner). Safe to re-run.
-- Run it in the SQL editor, or let queue/connect-supabase.sh run it for you.
--
-- Security model
--   * The phone signs in with Supabase Auth and only ever sees its own rows.
--   * The anon key alone can read or write nothing (it is public in the page).
--   * The Mac runner uses the service_role key, which stays on the Mac.

-- ------------------------------------------------------------------ tasks
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
alter table public.tasks add column if not exists action text default 'run';
alter table public.tasks add column if not exists owner uuid;
alter table public.tasks add column if not exists resume_id text;
alter table public.tasks alter column owner set default auth.uid();

-- --------------------------------------------------------------- sessions
-- Recent sessions of each app, pushed by the Mac (title + last messages).
create table if not exists public.sessions (
  id text primary key,            -- "<app>:<session id>"
  app text not null,
  session_id text not null,
  title text,
  cwd text,
  can_resume boolean default false,
  preview jsonb default '[]'::jsonb,
  owner uuid default auth.uid(),
  updated_at double precision
);

-- ---------------------------------------------------------------- runners
-- Heartbeat so the phone can show whether the Mac is online.
create table if not exists public.runners (
  id text primary key,
  name text,
  apps jsonb default '{}'::jsonb,
  owner uuid default auth.uid(),
  seen_at double precision
);
-- Usage limits from the Mac widget (same JSON as ~/.limitswidget/data.json).
alter table public.runners add column if not exists limits jsonb;

-- Rows written before sign-in existed belong to the first account.
update public.tasks set owner = (select id from auth.users order by created_at limit 1)
where owner is null;

-- -------------------------------------------------------------------- RLS
alter table public.tasks    enable row level security;
alter table public.sessions enable row level security;
alter table public.runners  enable row level security;

drop policy if exists "tasks_anon_all" on public.tasks;
drop policy if exists "tasks_own"      on public.tasks;
drop policy if exists "sessions_own"   on public.sessions;
drop policy if exists "runners_own"    on public.runners;

create policy "tasks_own" on public.tasks for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
create policy "sessions_own" on public.sessions for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
create policy "runners_own" on public.runners for select to authenticated
  using (owner = auth.uid());

-- --------------------------------------------------------------- realtime
do $$
declare t text;
begin
  foreach t in array array['tasks', 'sessions', 'runners'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

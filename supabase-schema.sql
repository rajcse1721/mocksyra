-- Run this entire file in Supabase Dashboard -> SQL Editor.
-- It is safe to run again when Mocksyra adds fields.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  languages text[] default '{}',
  preferred_slot text,
  availability jsonb default '[]'::jsonb,
  interview_type text,
  experience_level text,
  spoken_language text,
  timezone text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.profiles add column if not exists availability jsonb default '[]'::jsonb;
alter table public.profiles add column if not exists interview_type text;
alter table public.profiles add column if not exists experience_level text;
alter table public.profiles add column if not exists spoken_language text;
alter table public.profiles add column if not exists timezone text;
alter table public.profiles enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'Users can view their own profile') then
    create policy "Users can view their own profile" on public.profiles for select using (auth.uid() = id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'Users can create their own profile') then
    create policy "Users can create their own profile" on public.profiles for insert with check (auth.uid() = id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'Users can update their own profile') then
    create policy "Users can update their own profile" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
  end if;
end $$;

-- The realtime server stores its durable matching/session state here.
-- RLS intentionally has no public policy; only the server-side service-role key can access it.
create table if not exists public.app_state (
  id text primary key,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);
alter table public.app_state enable row level security;

revoke all on public.app_state from anon, authenticated;

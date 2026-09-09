begin;

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  role text not null default 'user' check (role in ('user','admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create table if not exists public.instagram_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  instagram_user_id text not null,
  username text not null,
  full_name text,
  profile_pic_url text,
  is_private boolean not null default false,
  is_verified boolean not null default false,
  last_collection_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, instagram_user_id),
  unique (owner_id, username)
);

create table if not exists public.collection_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.instagram_accounts(id) on delete cascade,
  local_snapshot_id text not null,
  quality_status text not null,
  comparison_eligible boolean not null default false,
  followers_count integer not null default 0,
  following_count integer not null default 0,
  expected_followers integer,
  expected_following integer,
  previous_snapshot_local_id text,
  diff_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (owner_id, local_snapshot_id)
);

create table if not exists public.snapshots (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.instagram_accounts(id) on delete cascade,
  collection_run_id uuid references public.collection_runs(id) on delete set null,
  local_snapshot_id text not null,
  username text not null,
  instagram_user_id text not null,
  profile_info jsonb not null default '{}'::jsonb,
  followers jsonb not null default '[]'::jsonb,
  following jsonb not null default '[]'::jsonb,
  differences jsonb not null default '{}'::jsonb,
  quality jsonb not null default '{}'::jsonb,
  comparison_eligible boolean not null default false,
  created_at timestamptz not null default now(),
  unique (owner_id, local_snapshot_id)
);

create index if not exists instagram_accounts_owner_idx on public.instagram_accounts(owner_id);
create index if not exists collection_runs_account_created_idx on public.collection_runs(account_id, created_at desc);
create index if not exists snapshots_account_created_idx on public.snapshots(account_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.instagram_accounts enable row level security;
alter table public.collection_runs enable row level security;
alter table public.snapshots enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select to authenticated using ((select auth.uid()) = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

drop policy if exists instagram_accounts_all_own on public.instagram_accounts;
create policy instagram_accounts_all_own on public.instagram_accounts for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

drop policy if exists collection_runs_all_own on public.collection_runs;
create policy collection_runs_all_own on public.collection_runs for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

drop policy if exists snapshots_all_own on public.snapshots;
create policy snapshots_all_own on public.snapshots for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

revoke all on public.profiles from anon;
revoke all on public.instagram_accounts from anon;
revoke all on public.collection_runs from anon;
revoke all on public.snapshots from anon;

grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.instagram_accounts to authenticated;
grant select, insert, update, delete on public.collection_runs to authenticated;
grant select, insert, update, delete on public.snapshots to authenticated;

commit;

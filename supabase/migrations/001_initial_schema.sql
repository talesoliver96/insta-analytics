create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  role text not null default 'user' check (role in ('user','admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  max_instagram_accounts integer not null default 1,
  max_snapshots_per_account integer,
  history_days integer,
  unfollow_tracking boolean not null default true,
  new_followers_tracking boolean not null default true,
  export_enabled boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid not null references public.plans(id),
  status text not null default 'active' check (status in ('trialing','active','past_due','canceled','expired')),
  starts_at timestamptz not null default now(), expires_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.instagram_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  instagram_user_id text not null,
  username text not null, full_name text, profile_pic_url text,
  is_private boolean default false, is_verified boolean default false,
  current_followers integer, current_following integer,
  last_collection_at timestamptz, active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(owner_id, instagram_user_id)
);

create table public.collection_runs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.instagram_accounts(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('running','success','suspicious','failed','rate_limited')),
  expected_followers integer, collected_followers integer, expected_following integer, collected_following integer,
  followers_ratio numeric(8,5), following_ratio numeric(8,5), pages_followers integer default 0, pages_following integer default 0,
  duration_ms integer, error_code text, error_message text,
  started_at timestamptz not null default now(), finished_at timestamptz
);

create table public.snapshots (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.instagram_accounts(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  collection_run_id uuid references public.collection_runs(id) on delete set null,
  followers_count integer not null, following_count integer not null,
  expected_followers integer, expected_following integer,
  quality_status text not null check (quality_status in ('valid','suspicious','unknown')),
  comparison_eligible boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.snapshot_users (
  snapshot_id uuid not null references public.snapshots(id) on delete cascade,
  instagram_user_id text not null, username text not null, full_name text,
  relation text not null check (relation in ('follower','following')),
  primary key(snapshot_id, instagram_user_id, relation)
);

create table public.follow_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.instagram_accounts(id) on delete cascade,
  instagram_user_id text not null, username text not null, full_name text,
  event_type text not null check (event_type in ('unfollowed_you','followed_you','you_unfollowed','you_followed')),
  from_snapshot_id uuid references public.snapshots(id), to_snapshot_id uuid references public.snapshots(id),
  detected_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.instagram_accounts enable row level security;
alter table public.collection_runs enable row level security;
alter table public.snapshots enable row level security;
alter table public.snapshot_users enable row level security;
alter table public.follow_events enable row level security;

create policy "profiles own select" on public.profiles for select to authenticated using (id = auth.uid());
create policy "accounts own select" on public.instagram_accounts for select to authenticated using (owner_id = auth.uid());
create policy "accounts own insert" on public.instagram_accounts for insert to authenticated with check (owner_id = auth.uid());
create policy "accounts own update" on public.instagram_accounts for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "runs own select" on public.collection_runs for select to authenticated using (owner_id = auth.uid());
create policy "snapshots own select" on public.snapshots for select to authenticated using (owner_id = auth.uid());
create policy "events own select" on public.follow_events for select to authenticated using (owner_id = auth.uid());

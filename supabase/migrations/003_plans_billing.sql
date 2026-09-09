begin;

create extension if not exists pgcrypto;

create table if not exists public.app_settings (
  id text primary key default 'main' check (id = 'main'),

  guest_enabled boolean not null default true,
  guest_collection_limit integer not null default 10 check (guest_collection_limit >= 0),

  free_enabled boolean not null default false,
  free_monthly_collection_limit integer not null default 10 check (free_monthly_collection_limit >= 0),

  pro_enabled boolean not null default true,
  pro_monthly_collection_limit integer not null default 100 check (pro_monthly_collection_limit >= 0),
  pro_price_brl numeric(10,2) not null default 19.90 check (pro_price_brl >= 1),
  pro_duration_days integer not null default 30 check (pro_duration_days >= 1),

  collection_cooldown_minutes integer not null default 0 check (collection_cooldown_minutes >= 0),

  updated_at timestamptz not null default now()
);

insert into public.app_settings (
  id,
  guest_enabled,
  guest_collection_limit,
  free_enabled,
  free_monthly_collection_limit,
  pro_enabled,
  pro_monthly_collection_limit,
  pro_price_brl,
  pro_duration_days,
  collection_cooldown_minutes
)
values ('main', true, 10, false, 10, true, 100, 19.90, 30, 0)
on conflict (id) do nothing;

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan_code text not null default 'pro' check (plan_code in ('pro')),
  status text not null default 'inactive' check (status in ('active','inactive','canceled','past_due')),
  provider text not null default 'mercadopago',
  paid_until timestamptz,
  provider_payer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'mercadopago',
  provider_payment_id text not null unique,
  status text not null,
  amount numeric(10,2),
  currency text,
  credited_days integer not null default 0,
  credited_at timestamptz,
  reversed_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.collection_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_username text not null,
  snapshot_local_id text not null,
  plan_code text not null check (plan_code in ('free','pro')),
  used_at timestamptz not null default now(),
  unique (user_id, snapshot_local_id)
);

create index if not exists collection_usage_user_month_idx
  on public.collection_usage(user_id, used_at desc);

create index if not exists subscriptions_paid_until_idx
  on public.subscriptions(paid_until);

alter table public.app_settings enable row level security;
alter table public.subscriptions enable row level security;
alter table public.payments enable row level security;
alter table public.collection_usage enable row level security;

drop policy if exists app_settings_public_read on public.app_settings;
create policy app_settings_public_read
on public.app_settings
for select
to anon, authenticated
using (true);

drop policy if exists subscriptions_read_own on public.subscriptions;
create policy subscriptions_read_own
on public.subscriptions
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists payments_read_own on public.payments;
create policy payments_read_own
on public.payments
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists collection_usage_read_own on public.collection_usage;
create policy collection_usage_read_own
on public.collection_usage
for select
to authenticated
using ((select auth.uid()) = user_id);

revoke all on public.app_settings from anon, authenticated;
revoke all on public.subscriptions from anon, authenticated;
revoke all on public.payments from anon, authenticated;
revoke all on public.collection_usage from anon, authenticated;

grant select on public.app_settings to anon, authenticated;
grant select on public.subscriptions to authenticated;
grant select on public.payments to authenticated;
grant select on public.collection_usage to authenticated;

create or replace function public.user_has_data_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce((select free_enabled from public.app_settings where id = 'main'), false)
    or exists (
      select 1
      from public.subscriptions s
      join public.app_settings a on a.id = 'main'
      where s.user_id = p_user_id
        and s.plan_code = 'pro'
        and s.status = 'active'
        and a.pro_enabled = true
        and s.paid_until is not null
        and s.paid_until > now()
    );
$$;

revoke all on function public.user_has_data_access(uuid) from public;

drop policy if exists instagram_accounts_all_own on public.instagram_accounts;
drop policy if exists collection_runs_all_own on public.collection_runs;
drop policy if exists snapshots_all_own on public.snapshots;

drop policy if exists instagram_accounts_read_own on public.instagram_accounts;
create policy instagram_accounts_read_own
on public.instagram_accounts
for select to authenticated
using ((select auth.uid()) = owner_id);

drop policy if exists instagram_accounts_write_with_plan on public.instagram_accounts;
create policy instagram_accounts_write_with_plan
on public.instagram_accounts
for all to authenticated
using (
  (select auth.uid()) = owner_id
  and public.user_has_data_access(owner_id)
)
with check (
  (select auth.uid()) = owner_id
  and public.user_has_data_access(owner_id)
);

drop policy if exists collection_runs_read_own on public.collection_runs;
create policy collection_runs_read_own
on public.collection_runs
for select to authenticated
using ((select auth.uid()) = owner_id);

drop policy if exists collection_runs_write_with_plan on public.collection_runs;
create policy collection_runs_write_with_plan
on public.collection_runs
for all to authenticated
using (
  (select auth.uid()) = owner_id
  and public.user_has_data_access(owner_id)
)
with check (
  (select auth.uid()) = owner_id
  and public.user_has_data_access(owner_id)
);

drop policy if exists snapshots_read_own on public.snapshots;
create policy snapshots_read_own
on public.snapshots
for select to authenticated
using ((select auth.uid()) = owner_id);

drop policy if exists snapshots_write_with_plan on public.snapshots;
create policy snapshots_write_with_plan
on public.snapshots
for all to authenticated
using (
  (select auth.uid()) = owner_id
  and public.user_has_data_access(owner_id)
)
with check (
  (select auth.uid()) = owner_id
  and public.user_has_data_access(owner_id)
);

create or replace function public.get_my_access()
returns table (
  plan_code text,
  can_collect boolean,
  used_collections integer,
  collection_limit integer,
  paid_until timestamptz,
  free_enabled boolean,
  pro_price_brl numeric,
  pro_duration_days integer,
  cooldown_minutes integer,
  message text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_settings public.app_settings%rowtype;
  v_subscription public.subscriptions%rowtype;
  v_plan text := 'pending';
  v_limit integer := 0;
  v_used integer := 0;
  v_last timestamptz;
  v_can boolean := false;
  v_message text := '';
begin
  if v_user is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_settings from public.app_settings where id = 'main';

  select *
  into v_subscription
  from public.subscriptions
  where user_id = v_user;

  if v_settings.pro_enabled
     and v_subscription.user_id is not null
     and v_subscription.status = 'active'
     and v_subscription.paid_until is not null
     and v_subscription.paid_until > now()
  then
    v_plan := 'pro';
    v_limit := v_settings.pro_monthly_collection_limit;
  elsif v_settings.free_enabled then
    v_plan := 'free';
    v_limit := v_settings.free_monthly_collection_limit;
  else
    v_plan := 'pending';
    v_limit := 0;
  end if;

  if v_plan in ('free','pro') then
    select count(*)::integer, max(used_at)
    into v_used, v_last
    from public.collection_usage
    where user_id = v_user
      and used_at >= date_trunc('month', now());

    v_can := (v_limit <= 0 or v_used < v_limit);

    if not v_can then
      v_message := 'Limite mensal de coletas atingido.';
    elsif v_settings.collection_cooldown_minutes > 0
          and v_last is not null
          and v_last + make_interval(mins => v_settings.collection_cooldown_minutes) > now()
    then
      v_can := false;
      v_message := 'Aguarde o intervalo configurado antes de uma nova coleta.';
    end if;
  else
    v_message := 'Sua conta ainda não possui um plano ativo.';
  end if;

  return query
  select
    v_plan,
    v_can,
    coalesce(v_used, 0),
    v_limit,
    case when v_plan = 'pro' then v_subscription.paid_until else null end,
    v_settings.free_enabled,
    v_settings.pro_price_brl,
    v_settings.pro_duration_days,
    v_settings.collection_cooldown_minutes,
    v_message;
end;
$$;

revoke all on function public.get_my_access() from public;
grant execute on function public.get_my_access() to authenticated;

create or replace function public.register_collection_use(
  p_account_username text,
  p_snapshot_local_id text
)
returns table (
  plan_code text,
  used_collections integer,
  collection_limit integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_access record;
begin
  if v_user is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_access from public.get_my_access();

  if not coalesce(v_access.can_collect, false) then
    raise exception '%', coalesce(v_access.message, 'collection_not_allowed');
  end if;

  insert into public.collection_usage (
    user_id,
    account_username,
    snapshot_local_id,
    plan_code
  )
  values (
    v_user,
    lower(trim(leading '@' from p_account_username)),
    p_snapshot_local_id,
    v_access.plan_code
  )
  on conflict (user_id, snapshot_local_id) do nothing;

  return query
  select
    a.plan_code,
    a.used_collections,
    a.collection_limit
  from public.get_my_access() a;
end;
$$;

revoke all on function public.register_collection_use(text, text) from public;
grant execute on function public.register_collection_use(text, text) to authenticated;

commit;


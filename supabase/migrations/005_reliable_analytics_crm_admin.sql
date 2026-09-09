begin;

alter table public.app_settings
  add column if not exists diff_confirmation_runs integer not null default 2 check (diff_confirmation_runs >= 2 and diff_confirmation_runs <= 5);

alter table public.subscriptions
  add column if not exists lifetime boolean not null default false,
  add column if not exists collection_limit_override integer check (collection_limit_override is null or collection_limit_override >= 0);

create table if not exists public.contact_annotations (
  owner_id uuid not null references auth.users(id) on delete cascade,
  instagram_user_id text not null,
  username text not null default '',
  full_name text not null default '',
  profile_pic text not null default '',
  watchlisted boolean not null default false,
  tags text[] not null default '{}',
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, instagram_user_id)
);

alter table public.contact_annotations enable row level security;
drop policy if exists contact_annotations_owner_all on public.contact_annotations;
create policy contact_annotations_owner_all on public.contact_annotations
for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

grant select, insert, update, delete on public.contact_annotations to authenticated;

create table if not exists public.analytics_notifications (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  event_key text not null,
  event_type text not null,
  instagram_user_id text,
  username text not null default '',
  full_name text not null default '',
  snapshot_local_id text,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique(owner_id, event_key)
);

alter table public.analytics_notifications enable row level security;
drop policy if exists analytics_notifications_owner_all on public.analytics_notifications;
create policy analytics_notifications_owner_all on public.analytics_notifications
for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
grant select, insert, update, delete on public.analytics_notifications to authenticated;

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admin_users enable row level security;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path=public,auth as $$
  select exists(select 1 from public.admin_users where user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Atualiza a regra de acesso sem quebrar o contrato usado pela extensão.
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
language plpgsql security definer set search_path=public as $$
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
  v_pro_active boolean := false;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  select * into v_settings from public.app_settings where id='main';
  select * into v_subscription from public.subscriptions where user_id=v_user;

  v_pro_active := v_settings.pro_enabled
    and v_subscription.user_id is not null
    and v_subscription.status='active'
    and (v_subscription.lifetime or (v_subscription.paid_until is not null and v_subscription.paid_until > now()));

  if v_pro_active then
    v_plan := 'pro';
    if v_subscription.collection_limit_override is not null then
      v_limit := v_subscription.collection_limit_override;
    elsif v_settings.pro_unlimited then
      v_limit := 0;
    else
      v_limit := v_settings.pro_monthly_collection_limit;
    end if;
  elsif v_settings.free_enabled then
    v_plan := 'free'; v_limit := v_settings.free_monthly_collection_limit;
  else
    v_plan := 'pending'; v_limit := 0;
  end if;

  if v_plan in ('free','pro') then
    select count(*)::integer, max(used_at) into v_used,v_last
      from public.collection_usage where user_id=v_user and used_at >= date_trunc('month',now());
    v_can := (v_limit <= 0 or v_used < v_limit);
    if not v_can then v_message := 'Limite mensal de coletas atingido.';
    elsif v_settings.collection_cooldown_minutes > 0 and v_last is not null
      and v_last + make_interval(mins=>v_settings.collection_cooldown_minutes) > now() then
      v_can := false; v_message := 'Aguarde o intervalo configurado antes de uma nova coleta.';
    end if;
  else v_message := 'Sua conta ainda não possui um plano ativo.';
  end if;

  return query select v_plan,v_can,coalesce(v_used,0),v_limit,
    case when v_plan='pro' and not v_subscription.lifetime then v_subscription.paid_until else null end,
    v_settings.free_enabled,v_settings.pro_price_brl,v_settings.pro_duration_days,
    v_settings.collection_cooldown_minutes,v_message;
end; $$;
revoke all on function public.get_my_access() from public;
grant execute on function public.get_my_access() to authenticated;

create or replace function public.get_admin_summary()
returns table(total_users bigint, active_pro bigint, approved_payments bigint, approved_revenue numeric)
language plpgsql security definer set search_path=public,auth as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query select
    (select count(*) from auth.users),
    (select count(*) from public.subscriptions s where s.status='active' and (s.lifetime or s.paid_until>now())),
    (select count(*) from public.payments p where p.status='approved'),
    coalesce((select sum(p.amount) from public.payments p where p.status='approved'),0);
end; $$;
revoke all on function public.get_admin_summary() from public;
grant execute on function public.get_admin_summary() to authenticated;

create or replace function public.admin_list_accounts()
returns table(user_id uuid,email text,plan_code text,status text,paid_until timestamptz,lifetime boolean,collection_limit_override integer)
language plpgsql security definer set search_path=public,auth as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query select u.id,u.email,s.plan_code,s.status,s.paid_until,coalesce(s.lifetime,false),s.collection_limit_override
    from auth.users u left join public.subscriptions s on s.user_id=u.id order by u.created_at desc limit 500;
end; $$;
revoke all on function public.admin_list_accounts() from public;
grant execute on function public.admin_list_accounts() to authenticated;

create or replace function public.admin_grant_pro(p_email text,p_days integer default 30,p_lifetime boolean default false,p_collection_limit_override integer default null)
returns void language plpgsql security definer set search_path=public,auth as $$
declare v_user uuid; v_current public.subscriptions%rowtype; v_until timestamptz;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  select id into v_user from auth.users where lower(email)=lower(trim(p_email)) limit 1;
  if v_user is null then raise exception 'user_not_found'; end if;
  select * into v_current from public.subscriptions where user_id=v_user;
  if p_lifetime then v_until := null;
  else v_until := greatest(coalesce(v_current.paid_until,now()),now()) + make_interval(days=>greatest(1,p_days)); end if;
  insert into public.subscriptions(user_id,plan_code,status,provider,paid_until,lifetime,collection_limit_override,updated_at)
  values(v_user,'pro','active','manual',v_until,p_lifetime,p_collection_limit_override,now())
  on conflict(user_id) do update set plan_code='pro',status='active',provider='manual',paid_until=excluded.paid_until,lifetime=excluded.lifetime,collection_limit_override=excluded.collection_limit_override,updated_at=now();
end; $$;
revoke all on function public.admin_grant_pro(text,integer,boolean,integer) from public;
grant execute on function public.admin_grant_pro(text,integer,boolean,integer) to authenticated;

create or replace function public.admin_revoke_pro(p_email text)
returns void language plpgsql security definer set search_path=public,auth as $$
declare v_user uuid;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  select id into v_user from auth.users where lower(email)=lower(trim(p_email)) limit 1;
  if v_user is null then raise exception 'user_not_found'; end if;
  update public.subscriptions set status='inactive',lifetime=false,paid_until=now(),updated_at=now() where user_id=v_user;
end; $$;
revoke all on function public.admin_revoke_pro(text) from public;
grant execute on function public.admin_revoke_pro(text) to authenticated;

commit;

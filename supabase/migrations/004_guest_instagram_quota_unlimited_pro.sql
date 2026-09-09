begin;

alter table public.app_settings
  add column if not exists pro_unlimited boolean not null default false;

create table if not exists public.guest_instagram_usage (
  instagram_user_id text primary key,
  username text not null,
  collections_used integer not null default 0 check (collections_used >= 0),
  last_collection_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.guest_instagram_usage enable row level security;
revoke all on public.guest_instagram_usage from anon, authenticated;

create or replace function public.get_guest_instagram_access(
  p_instagram_user_id text,
  p_username text
)
returns table (
  can_collect boolean,
  used_collections integer,
  collection_limit integer,
  last_collection_at timestamptz,
  message text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.app_settings%rowtype;
  v_usage public.guest_instagram_usage%rowtype;
  v_used integer := 0;
  v_limit integer := 0;
  v_can boolean := false;
  v_message text := '';
begin
  if coalesce(trim(p_instagram_user_id), '') = '' then
    raise exception 'instagram_user_id_required';
  end if;

  select * into v_settings from public.app_settings where id = 'main';
  if not found then raise exception 'app_settings_missing'; end if;

  select * into v_usage
  from public.guest_instagram_usage
  where instagram_user_id = p_instagram_user_id;

  v_used := coalesce(v_usage.collections_used, 0);
  v_limit := greatest(0, coalesce(v_settings.guest_collection_limit, 10));
  v_can := v_settings.guest_enabled and (v_limit <= 0 or v_used < v_limit);

  if not v_settings.guest_enabled then
    v_message := 'Teste sem conta está desativado.';
  elsif not v_can then
    v_message := 'As coletas gratuitas deste perfil do Instagram terminaram.';
  elsif v_settings.collection_cooldown_minutes > 0
        and v_usage.last_collection_at is not null
        and v_usage.last_collection_at + make_interval(mins => v_settings.collection_cooldown_minutes) > now()
  then
    v_can := false;
    v_message := 'Aguarde o intervalo configurado antes de uma nova coleta.';
  end if;

  return query select v_can, v_used, v_limit, v_usage.last_collection_at, v_message;
end;
$$;

create or replace function public.register_guest_instagram_collection(
  p_instagram_user_id text,
  p_username text
)
returns table (
  used_collections integer,
  collection_limit integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.app_settings%rowtype;
  v_usage public.guest_instagram_usage%rowtype;
  v_limit integer;
begin
  if coalesce(trim(p_instagram_user_id), '') = '' then
    raise exception 'instagram_user_id_required';
  end if;

  select * into v_settings from public.app_settings where id = 'main';
  if not found then raise exception 'app_settings_missing'; end if;
  if not v_settings.guest_enabled then raise exception 'guest_disabled'; end if;

  insert into public.guest_instagram_usage (
    instagram_user_id, username, collections_used, created_at, updated_at
  ) values (
    p_instagram_user_id, coalesce(nullif(trim(p_username), ''), p_instagram_user_id), 0, now(), now()
  )
  on conflict (instagram_user_id) do update
    set username = excluded.username,
        updated_at = now();

  select * into v_usage
  from public.guest_instagram_usage
  where instagram_user_id = p_instagram_user_id
  for update;

  v_limit := greatest(0, coalesce(v_settings.guest_collection_limit, 10));

  if v_limit > 0 and v_usage.collections_used >= v_limit then
    raise exception 'guest_limit_reached';
  end if;

  if v_settings.collection_cooldown_minutes > 0
     and v_usage.last_collection_at is not null
     and v_usage.last_collection_at + make_interval(mins => v_settings.collection_cooldown_minutes) > now()
  then
    raise exception 'guest_cooldown_active';
  end if;

  update public.guest_instagram_usage
  set collections_used = collections_used + 1,
      username = coalesce(nullif(trim(p_username), ''), username),
      last_collection_at = now(),
      updated_at = now()
  where instagram_user_id = p_instagram_user_id
  returning collections_used into v_usage.collections_used;

  return query select v_usage.collections_used, v_limit;
end;
$$;

revoke all on function public.get_guest_instagram_access(text,text) from public;
revoke all on function public.register_guest_instagram_collection(text,text) from public;
grant execute on function public.get_guest_instagram_access(text,text) to anon, authenticated;
grant execute on function public.register_guest_instagram_collection(text,text) to anon, authenticated;

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
  if v_user is null then raise exception 'not_authenticated'; end if;
  select * into v_settings from public.app_settings where id = 'main';
  select * into v_subscription from public.subscriptions where user_id = v_user;

  if v_settings.pro_enabled
     and v_subscription.user_id is not null
     and v_subscription.status = 'active'
     and v_subscription.paid_until is not null
     and v_subscription.paid_until > now()
  then
    v_plan := 'pro';
    v_limit := case when v_settings.pro_unlimited then 0 else v_settings.pro_monthly_collection_limit end;
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
    where user_id = v_user and used_at >= date_trunc('month', now());

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

  return query select
    v_plan, v_can, coalesce(v_used,0), v_limit,
    case when v_plan='pro' then v_subscription.paid_until else null end,
    v_settings.free_enabled, v_settings.pro_price_brl,
    v_settings.pro_duration_days, v_settings.collection_cooldown_minutes,
    v_message;
end;
$$;

commit;


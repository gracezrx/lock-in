-- Lock In's usage data (see README → Usage data): the schema of the Supabase project the
-- installed app reports to. The app's publishable key (role anon) can only call ingest() and
-- forget(); every table and view is closed to it.

create table public.installs (
  install_id uuid primary key,                 -- random, made on the Mac; no name, email or account
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  app_version text,
  os_version text,
  arch text,
  locale text,
  timezone text,
  share_apps boolean not null default false,   -- "Share which apps and sites I use"
  traits jsonb not null default '{}'::jsonb    -- how it's set up: persona, keys added, extension…
);

create table public.events (
  id bigint generated always as identity primary key,
  install_id uuid not null references public.installs (install_id) on delete cascade,
  at timestamptz not null,
  name text not null,                          -- session_started, coach_level, talk_opened, ui…
  props jsonb not null default '{}'::jsonb,
  app_version text,
  received_at timestamptz not null default now()
);
create index events_install_at on public.events (install_id, at desc);
create index events_name_at on public.events (name, at desc);

create table public.app_usage (
  install_id uuid not null references public.installs (install_id) on delete cascade,
  day date not null,
  app text not null,                           -- "(private)" for sensitive apps and private windows
  bundle_id text not null default '',
  domain text not null default '',             -- browsers only: the site's domain, never the address
  label text not null,                         -- work | neutral | distraction | private
  in_session boolean not null default false,
  seconds integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (install_id, day, app, bundle_id, domain, label, in_session)
);
create index app_usage_day on public.app_usage (day desc);

alter table public.installs enable row level security;
alter table public.events enable row level security;
alter table public.app_usage enable row level security;
revoke all on public.installs, public.events, public.app_usage from anon, authenticated;

-- One call per flush: { install_id, app_version, os_version, arch, locale, timezone, share_apps,
--   traits: {...}, events: [{ at, name, props }], usage: [{ day, app, bundle_id, domain, label, in_session, seconds }] }
create or replace function public.ingest(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  iid uuid;
  share boolean;
  n_events int := 0;
  n_usage int := 0;
begin
  if jsonb_typeof(payload) <> 'object' or pg_column_size(payload) > 600000 then
    raise exception 'bad payload';
  end if;
  begin
    iid := (payload->>'install_id')::uuid;
  exception when others then
    raise exception 'bad install_id';
  end;
  if iid is null then raise exception 'bad install_id'; end if;
  share := coalesce((payload->>'share_apps')::boolean, false);

  insert into public.installs as i (install_id, app_version, os_version, arch, locale, timezone, share_apps, traits)
  values (
    iid,
    left(payload->>'app_version', 32),
    left(payload->>'os_version', 64),
    left(payload->>'arch', 16),
    left(payload->>'locale', 32),
    left(payload->>'timezone', 64),
    share,
    case when jsonb_typeof(payload->'traits') = 'object' and pg_column_size(payload->'traits') < 8000 then payload->'traits' else '{}'::jsonb end
  )
  on conflict (install_id) do update set
    last_seen = now(),
    app_version = coalesce(excluded.app_version, i.app_version),
    os_version = coalesce(excluded.os_version, i.os_version),
    arch = coalesce(excluded.arch, i.arch),
    locale = coalesce(excluded.locale, i.locale),
    timezone = coalesce(excluded.timezone, i.timezone),
    share_apps = excluded.share_apps,
    traits = i.traits || excluded.traits;

  if jsonb_typeof(payload->'events') = 'array' then
    insert into public.events (install_id, at, name, props, app_version)
    select iid,
           least(greatest(coalesce(case when (e->>'at') ~ '^\d{4}-\d{2}-\d{2}T' then (e->>'at')::timestamptz end, now()), now() - interval '30 days'), now() + interval '1 hour'),
           e->>'name',
           case when jsonb_typeof(e->'props') = 'object' and pg_column_size(e->'props') < 4000 then e->'props' else '{}'::jsonb end,
           left(payload->>'app_version', 32)
    from (select value as e from jsonb_array_elements(payload->'events') limit 1000) x
    where jsonb_typeof(e) = 'object' and coalesce(e->>'name', '') ~ '^[a-z][a-z0-9_:.-]{0,63}$';
    get diagnostics n_events = row_count;
  end if;

  -- App usage only from people who said yes; an install that says no also has its old rows removed.
  if share and jsonb_typeof(payload->'usage') = 'array' then
    insert into public.app_usage as u (install_id, day, app, bundle_id, domain, label, in_session, seconds)
    select iid, day, app, bundle_id, domain, label, in_session, least(sum(seconds), 86400)::int
    from (
      select case when (r->>'day') ~ '^\d{4}-\d{2}-\d{2}$' then (r->>'day')::date end as day,
             left(r->>'app', 120) as app,
             left(coalesce(r->>'bundle_id', ''), 160) as bundle_id,
             left(lower(coalesce(r->>'domain', '')), 160) as domain,
             r->>'label' as label,
             coalesce(r->>'in_session', '') = 'true' as in_session,
             case when (r->>'seconds') ~ '^\d{1,6}$' then (r->>'seconds')::int else 0 end as seconds
      from (select value as r from jsonb_array_elements(payload->'usage') limit 3000) x
      where jsonb_typeof(r) = 'object'
    ) v
    where app <> ''
      and label in ('work', 'neutral', 'distraction', 'private')
      and day between current_date - 30 and current_date + 1
      and seconds > 0
    group by day, app, bundle_id, domain, label, in_session
    on conflict (install_id, day, app, bundle_id, domain, label, in_session)
    do update set seconds = least(u.seconds + excluded.seconds, 86400), updated_at = now();
    get diagnostics n_usage = row_count;
  elsif not share then
    delete from public.app_usage where install_id = iid;
  end if;

  return jsonb_build_object('ok', true, 'events', n_events, 'usage', n_usage);
end;
$$;

-- Settings → Usage data → "Delete what's been shared".
create or replace function public.forget(p_install_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  with d as (delete from public.installs where install_id = p_install_id returning 1)
  select jsonb_build_object('ok', true, 'deleted', (select count(*) from d));
$$;

revoke all on function public.ingest(jsonb) from public;
revoke all on function public.forget(uuid) from public;
grant execute on function public.ingest(jsonb) to anon, authenticated;
grant execute on function public.forget(uuid) to anon, authenticated;

-- ---- Reading it (in the Supabase dashboard; closed to the app's key) ----

-- Every feature: how many people use it, how often, and in the last week.
create view public.feature_usage with (security_invoker = true) as
select name as feature,
       count(distinct install_id) as users,
       count(*) as times_used,
       count(distinct install_id) filter (where at > now() - interval '7 days') as users_last_7d,
       max(at) as last_used
from public.events
group by name
order by users desc, times_used desc;

-- Each person (install) and what they use.
create view public.user_features with (security_invoker = true) as
select install_id, name as feature, count(*) as times_used, min(at) as first_used, max(at) as last_used
from public.events
group by install_id, name
order by install_id, times_used desc;

-- Every button and action in the app, the phone page and the extension.
create view public.ui_actions with (security_invoker = true) as
select props->>'action' as action,
       props->>'from' as from_where,
       count(distinct install_id) as users,
       sum(case when props->>'count' ~ '^\d{1,6}$' then (props->>'count')::int else 1 end) as times_used
from public.events
where name = 'ui'
group by 1, 2
order by users desc, times_used desc;

-- Each person's apps and sites.
create view public.user_apps with (security_invoker = true) as
select install_id,
       app,
       nullif(domain, '') as site,
       round(sum(seconds) / 3600.0, 2) as hours,
       round(sum(seconds) filter (where label = 'distraction') / 3600.0, 2) as distracted_hours,
       round(sum(seconds) filter (where label = 'work') / 3600.0, 2) as work_hours,
       round(sum(seconds) filter (where in_session) / 3600.0, 2) as hours_in_sessions,
       min(day) as first_day,
       max(day) as last_day
from public.app_usage
group by install_id, app, domain
order by install_id, hours desc;

-- The apps and sites everyone spends time in, and how often they're a distraction.
create view public.top_apps with (security_invoker = true) as
select app,
       nullif(domain, '') as site,
       count(distinct install_id) as users,
       round(sum(seconds) / 3600.0, 1) as hours,
       round(100.0 * sum(seconds) filter (where label = 'distraction') / nullif(sum(seconds), 0), 0) as pct_distraction
from public.app_usage
group by app, domain
order by users desc, hours desc;

create view public.daily_active with (security_invoker = true) as
select (at at time zone 'UTC')::date as day,
       count(distinct install_id) as active_users,
       count(*) filter (where name = 'session_started') as sessions,
       count(*) filter (where name = 'coach_level') as coach_interventions,
       count(*) filter (where name = 'talk_opened') as talks,
       count(*) filter (where name = 'bomb_sent') as bombs
from public.events
group by 1
order by 1 desc;

-- How far people get through setup.
create view public.onboarding_funnel with (security_invoker = true) as
select props->>'step' as step,
       min(case when props->>'index' ~ '^\d{1,3}$' then (props->>'index')::int end) as step_index,
       count(distinct install_id) as users
from public.events
where name = 'onboarding_step'
group by 1
order by 2;

-- One row per person: when they started, how they're set up, how much they use it.
create view public.users_overview with (security_invoker = true) as
select i.install_id,
       i.first_seen,
       i.last_seen,
       i.app_version,
       i.share_apps,
       i.traits,
       (select count(*) from public.events e where e.install_id = i.install_id and e.name = 'session_started') as sessions,
       (select count(distinct e.name) from public.events e where e.install_id = i.install_id) as features_used,
       (select round(sum(a.seconds) / 3600.0, 1) from public.app_usage a where a.install_id = i.install_id) as tracked_hours
from public.installs i
order by i.last_seen desc;

revoke all on public.feature_usage, public.user_features, public.ui_actions, public.user_apps, public.top_apps, public.daily_active, public.onboarding_funnel, public.users_overview from anon, authenticated;

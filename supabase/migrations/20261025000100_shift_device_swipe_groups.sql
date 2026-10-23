-- A device owns each Swipe ID group so all accounts sharing that Swipe ID
-- are used from one device. This migration is a local draft; apply only after review.
begin;

create table public.shift_swiper_devices (
  id uuid primary key,
  company_id uuid not null references public.shift_companies(id) on delete restrict,
  swiper_id uuid not null references public.shift_swipers(id) on delete cascade,
  device_name text not null default 'DKASU Shift device',
  platform text not null default 'unknown',
  is_active boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (length(trim(device_name)) between 1 and 100),
  check (platform in ('android', 'ios', 'web', 'unknown')),
  unique (id, company_id)
);

create index shift_swiper_devices_swiper_idx
  on public.shift_swiper_devices (swiper_id, is_active, last_seen_at desc);

create table public.shift_device_swipe_groups (
  company_id uuid not null references public.shift_companies(id) on delete restrict,
  swipe_id_key text not null,
  device_id uuid not null,
  assigned_by uuid not null default auth.uid() references auth.users(id),
  assigned_at timestamptz not null default now(),
  primary key (company_id, swipe_id_key),
  foreign key (device_id, company_id)
    references public.shift_swiper_devices(id, company_id) on delete cascade,
  check (length(trim(swipe_id_key)) between 1 and 320)
);

create index shift_device_swipe_groups_device_idx
  on public.shift_device_swipe_groups (device_id, swipe_id_key);

create or replace function public.shift_current_device_id()
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_header text;
begin
  v_header := current_setting('request.headers', true)::jsonb ->> 'x-dkasu-device-id';
  if v_header is null or v_header !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return null;
  end if;
  return v_header::uuid;
exception when others then
  return null;
end;
$$;

create or replace function public.shift_worker_swipe_key(p_worker_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case
    when nullif(lower(trim(w.swipe_id)), '') is not null
      then 'swipe:' || lower(trim(w.swipe_id))
    else 'worker:' || w.id::text
  end
  from public.shift_workers w
  where w.id = p_worker_id;
$$;

create or replace function public.shift_register_device(
  p_device_id uuid,
  p_device_name text default 'DKASU Shift device',
  p_platform text default 'unknown'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_swiper public.shift_swipers%rowtype;
  v_platform text := lower(coalesce(p_platform, 'unknown'));
  v_name text := coalesce(nullif(trim(p_device_name), ''), 'DKASU Shift device');
begin
  select * into v_swiper from public.shift_swipers s
  where s.auth_user_id = auth.uid() and s.is_active for update;
  if not found then raise exception 'swiper_not_eligible' using errcode = '42501'; end if;
  if p_device_id is null or length(v_name) > 100 then
    raise exception 'invalid_device' using errcode = '22023';
  end if;
  if v_platform not in ('android', 'ios', 'web', 'unknown') then v_platform := 'unknown'; end if;

  insert into public.shift_swiper_devices (id, company_id, swiper_id, device_name, platform)
  values (p_device_id, v_swiper.company_id, v_swiper.id, v_name, v_platform)
  on conflict (id) do update
    set last_seen_at = now(), device_name = excluded.device_name, platform = excluded.platform
    where shift_swiper_devices.company_id = excluded.company_id
      and shift_swiper_devices.swiper_id = excluded.swiper_id
      and shift_swiper_devices.is_active;

  if not found then raise exception 'device_identity_conflict_or_disabled' using errcode = '42501'; end if;
  return jsonb_build_object('device_id', p_device_id, 'swiper_id', v_swiper.id);
end;
$$;

create or replace function public.shift_set_device_swipe_groups(
  p_device_id uuid,
  p_swipe_id_keys text[]
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_company_id uuid := public.shift_current_company_id();
  v_requested integer := coalesce(cardinality(p_swipe_id_keys), 0);
  v_valid integer;
begin
  if auth.uid() is null or not public.shift_is_admin() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_requested > 500 then raise exception 'too_many_assignments' using errcode = '22023'; end if;
  if not exists (
    select 1 from public.shift_swiper_devices d
    join public.shift_swipers s on s.id = d.swiper_id
    where d.id = p_device_id and d.company_id = v_company_id and d.is_active and s.is_active
  ) then raise exception 'device_not_eligible' using errcode = '22023'; end if;

  select count(distinct requested.key)::integer into v_valid
  from unnest(coalesce(p_swipe_id_keys, '{}'::text[])) requested(key)
  where requested.key = lower(trim(requested.key))
    and length(requested.key) between 1 and 320
    and exists (
      select 1 from public.shift_swiper_devices d
      join public.shift_swiper_assignments a on a.swiper_id = d.swiper_id
      join public.shift_workers w on w.id = a.worker_id
      where d.id = p_device_id and d.company_id = v_company_id
        and w.company_id = v_company_id and w.is_active
        and public.shift_worker_swipe_key(w.id) = requested.key
    );
  if v_valid <> v_requested then
    raise exception 'invalid_or_unassigned_swipe_group' using errcode = '22023';
  end if;

  delete from public.shift_device_swipe_groups g where g.device_id = p_device_id;
  insert into public.shift_device_swipe_groups (company_id, swipe_id_key, device_id, assigned_by)
  select v_company_id, requested.key, p_device_id, auth.uid()
  from unnest(coalesce(p_swipe_id_keys, '{}'::text[])) requested(key);
  return v_requested;
end;
$$;

create or replace function public.shift_is_assigned_swiper(p_worker_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1
    from public.shift_swiper_assignments a
    join public.shift_swipers s on s.id = a.swiper_id
    join public.shift_workers w on w.id = a.worker_id
    join public.shift_swiper_devices d
      on d.id = public.shift_current_device_id()
     and d.swiper_id = s.id
     and d.company_id = s.company_id
     and d.is_active
    join public.shift_device_swipe_groups g
      on g.device_id = d.id
     and g.company_id = w.company_id
     and g.swipe_id_key = public.shift_worker_swipe_key(w.id)
    where a.worker_id = p_worker_id
      and s.auth_user_id = auth.uid()
      and s.is_active
      and w.is_active
      and a.company_id = w.company_id
      and a.company_id = s.company_id
  );
$$;

alter table public.shift_swiper_devices enable row level security;
alter table public.shift_device_swipe_groups enable row level security;
revoke all on public.shift_swiper_devices, public.shift_device_swipe_groups from anon, authenticated;
grant select on public.shift_swiper_devices, public.shift_device_swipe_groups to authenticated;

create policy shift_swiper_devices_admin_read on public.shift_swiper_devices
for select to authenticated
using (public.shift_is_admin() and company_id = public.shift_current_company_id());
create policy shift_swiper_devices_self_read on public.shift_swiper_devices
for select to authenticated
using (swiper_id = public.shift_current_swiper_id());

create policy shift_device_swipe_groups_admin_all on public.shift_device_swipe_groups
for all to authenticated
using (public.shift_is_admin() and company_id = public.shift_current_company_id())
with check (
  public.shift_is_admin()
  and company_id = public.shift_current_company_id()
  and assigned_by = auth.uid()
);
create policy shift_device_swipe_groups_self_read on public.shift_device_swipe_groups
for select to authenticated
using (exists (
  select 1 from public.shift_swiper_devices d
  where d.id = shift_device_swipe_groups.device_id
    and d.swiper_id = public.shift_current_swiper_id()
    and d.id = public.shift_current_device_id()
));

revoke all on function public.shift_current_device_id() from public, anon;
revoke all on function public.shift_worker_swipe_key(uuid) from public, anon;
revoke all on function public.shift_register_device(uuid, text, text) from public, anon;
revoke all on function public.shift_set_device_swipe_groups(uuid, text[]) from public, anon;
revoke all on function public.shift_worker_swipe_key(uuid) from authenticated;
grant execute on function public.shift_current_device_id() to authenticated;
grant execute on function public.shift_register_device(uuid, text, text) to authenticated;
grant execute on function public.shift_set_device_swipe_groups(uuid, text[]) to authenticated;

commit;

-- DKASU Shift Dashboard foundation.
-- This migration is intentionally isolated from POS shop_members/shop_pos_staff.
-- It is authored locally and must be compared with the live project before apply.

begin;

create extension if not exists pgcrypto with schema extensions;

create table public.shift_companies (
  id uuid primary key default gen_random_uuid(),
  company_key text not null unique check (company_key = 'dkasu'),
  display_name text not null default 'DKASU',
  created_at timestamptz not null default now()
);

insert into public.shift_companies (company_key, display_name)
values ('dkasu', 'DKASU')
on conflict (company_key) do nothing;

-- Admins are provisioned explicitly after the migration using the known Auth UID.
create table public.shift_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  company_id uuid not null references public.shift_companies (id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.shift_workers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.shift_companies (id) on delete restrict,
  auth_user_id uuid unique references auth.users (id) on delete set null,
  name text not null,
  email text not null,
  ogram_profile_id text not null default '',
  swipe_id text not null default '',
  job_title text not null default '',
  company_name text not null default '',
  location text not null default '',
  address text not null default '',
  contract_start date,
  contract_end date,
  display_timezone text not null default 'Asia/Dubai',
  schedule_timezone text not null default 'Asia/Dubai',
  source_local_id text,
  is_active boolean not null default true,
  created_by uuid not null default auth.uid() references auth.users (id),
  created_at timestamptz not null default now(),
  updated_by uuid not null default auth.uid() references auth.users (id),
  updated_at timestamptz not null default now(),
  linked_at timestamptz,
  check (contract_start is null or contract_end is null or contract_end >= contract_start)
);

create unique index shift_workers_company_email_uq
  on public.shift_workers (company_id, lower(trim(email)));
create unique index shift_workers_source_local_id_uq
  on public.shift_workers (company_id, source_local_id)
  where source_local_id is not null;
create index shift_workers_company_active_idx
  on public.shift_workers (company_id, is_active);

create table public.shift_schedules (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.shift_workers (id) on delete cascade,
  shift_date date not null,
  start_time time not null,
  end_time time not null,
  schedule_timezone text not null,
  revision integer not null default 1 check (revision > 0),
  created_by uuid not null default auth.uid() references auth.users (id),
  created_at timestamptz not null default now(),
  updated_by uuid not null default auth.uid() references auth.users (id),
  updated_at timestamptz not null default now(),
  check (start_time <> end_time),
  unique (worker_id, shift_date)
);

create index shift_schedules_worker_date_idx
  on public.shift_schedules (worker_id, shift_date);

create table public.shift_activation_tokens (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.shift_workers (id) on delete cascade,
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  created_by uuid not null default auth.uid() references auth.users (id),
  created_at timestamptz not null default now(),
  consumed_by uuid references auth.users (id),
  consumed_at timestamptz,
  revoked_at timestamptz,
  check (octet_length(token_hash) = 32),
  check ((consumed_by is null) = (consumed_at is null))
);

create index shift_activation_tokens_worker_idx
  on public.shift_activation_tokens (worker_id, expires_at desc);

create table public.shift_confirmations (
  id uuid primary key default gen_random_uuid(),
  client_event_id uuid not null unique,
  worker_id uuid not null references public.shift_workers (id) on delete restrict,
  shift_date date not null,
  submitted_at timestamptz not null,
  reported_timezone text,
  reported_address text,
  received_at timestamptz not null default now(),
  submitted_by uuid not null default auth.uid() references auth.users (id),
  record_kind text not null default 'worker_self_confirmation'
    check (record_kind = 'worker_self_confirmation'),
  legacy_source_id text,
  created_at timestamptz not null default now()
);

create index shift_confirmations_worker_date_idx
  on public.shift_confirmations (worker_id, shift_date desc);

create or replace function public.shift_current_company_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select a.company_id
  from public.shift_admins a
  where a.user_id = auth.uid()
  limit 1;
$$;

create or replace function public.shift_is_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1 from public.shift_admins a
    where a.user_id = auth.uid()
  );
$$;

create or replace function public.shift_current_worker_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select w.id
  from public.shift_workers w
  where w.auth_user_id = auth.uid()
    and w.is_active
  limit 1;
$$;

create or replace function public.shift_touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, auth
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_table_name = 'shift_schedules' then
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;

create trigger shift_workers_touch_updated_at
before update on public.shift_workers
for each row execute function public.shift_touch_updated_at();

create trigger shift_schedules_touch_updated_at
before update on public.shift_schedules
for each row execute function public.shift_touch_updated_at();

-- The browser supplies only a SHA-256 hash; the raw activation code is never stored.
create or replace function public.shift_create_activation(
  p_worker_id uuid,
  p_token_hash_hex text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_company_id uuid;
  v_token_id uuid;
begin
  if auth.uid() is null or not public.shift_is_admin() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_token_hash_hex !~ '^[0-9a-fA-F]{64}$'
     or p_expires_at <= now()
     or p_expires_at > now() + interval '7 days' then
    raise exception 'invalid_activation_request' using errcode = '22023';
  end if;

  v_company_id := public.shift_current_company_id();
  if not exists (
    select 1 from public.shift_workers w
    where w.id = p_worker_id
      and w.company_id = v_company_id
      and w.is_active
      and w.auth_user_id is null
  ) then
    raise exception 'worker_not_eligible' using errcode = '22023';
  end if;

  update public.shift_activation_tokens
  set revoked_at = now()
  where worker_id = p_worker_id
    and consumed_at is null
    and revoked_at is null;

  insert into public.shift_activation_tokens (worker_id, token_hash, expires_at)
  values (p_worker_id, decode(p_token_hash_hex, 'hex'), p_expires_at)
  returning id into v_token_id;

  return jsonb_build_object('id', v_token_id, 'expires_at', p_expires_at);
end;
$$;

create or replace function public.shift_revoke_activation(p_activation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if auth.uid() is null or not public.shift_is_admin() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  update public.shift_activation_tokens t
  set revoked_at = now()
  from public.shift_workers w
  where t.id = p_activation_id
    and t.worker_id = w.id
    and w.company_id = public.shift_current_company_id()
    and t.consumed_at is null
    and t.revoked_at is null;
  return found;
end;
$$;

-- A Google Auth identity must already exist. The invitation email, Auth email,
-- and verified Google identity email must match before the worker is linked.
create or replace function public.shift_claim_activation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_auth_email text := lower(trim(coalesce(auth.email(), '')));
  v_google_email text;
  v_activation public.shift_activation_tokens%rowtype;
  v_worker public.shift_workers%rowtype;
begin
  if v_uid is null or v_auth_email = '' or coalesce(trim(p_token), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'activation_invalid');
  end if;

  select lower(trim(i.identity_data ->> 'email'))
  into v_google_email
  from auth.identities i
  where i.user_id = v_uid
    and i.provider = 'google'
    and coalesce(i.identity_data ->> 'email', '') <> ''
    and coalesce((i.identity_data ->> 'email_verified')::boolean, true)
  order by i.last_sign_in_at desc nulls last
  limit 1;

  if v_google_email is null or v_google_email <> v_auth_email then
    return jsonb_build_object('ok', false, 'error', 'activation_invalid');
  end if;

  select * into v_activation
  from public.shift_activation_tokens t
  where t.token_hash = digest(convert_to(trim(p_token), 'UTF8'), 'sha256')
  for update;

  if not found
     or v_activation.revoked_at is not null
     or v_activation.consumed_at is not null
     or v_activation.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'activation_invalid');
  end if;

  select * into v_worker
  from public.shift_workers w
  where w.id = v_activation.worker_id
  for update;

  if not found
     or not v_worker.is_active
     or lower(trim(v_worker.email)) <> v_auth_email
     or (v_worker.auth_user_id is not null and v_worker.auth_user_id <> v_uid)
     or exists (
       select 1 from public.shift_workers other
       where other.auth_user_id = v_uid and other.id <> v_worker.id
     ) then
    return jsonb_build_object('ok', false, 'error', 'activation_invalid');
  end if;

  update public.shift_workers
  set auth_user_id = v_uid, linked_at = now()
  where id = v_worker.id;

  update public.shift_activation_tokens
  set consumed_by = v_uid, consumed_at = now()
  where id = v_activation.id;

  return jsonb_build_object('ok', true, 'worker_id', v_worker.id);
end;
$$;

alter table public.shift_companies enable row level security;
alter table public.shift_admins enable row level security;
alter table public.shift_workers enable row level security;
alter table public.shift_schedules enable row level security;
alter table public.shift_activation_tokens enable row level security;
alter table public.shift_confirmations enable row level security;

revoke all on public.shift_companies, public.shift_admins, public.shift_workers,
  public.shift_schedules, public.shift_activation_tokens, public.shift_confirmations
  from anon, authenticated;

grant select on public.shift_companies, public.shift_admins,
  public.shift_workers, public.shift_schedules, public.shift_confirmations to authenticated;
grant insert (company_id, name, email, ogram_profile_id, swipe_id, job_title,
  company_name, location, address, contract_start, contract_end,
  display_timezone, schedule_timezone, source_local_id, is_active)
  on public.shift_workers to authenticated;
grant update (name, email, ogram_profile_id, swipe_id, job_title, company_name,
  location, address, contract_start, contract_end, display_timezone,
  schedule_timezone, is_active)
  on public.shift_workers to authenticated;
grant insert (worker_id, shift_date, start_time, end_time, schedule_timezone)
  on public.shift_schedules to authenticated;
grant update (shift_date, start_time, end_time, schedule_timezone)
  on public.shift_schedules to authenticated;
grant delete on public.shift_schedules to authenticated;
grant insert (client_event_id, worker_id, shift_date, submitted_at, reported_timezone, reported_address)
  on public.shift_confirmations to authenticated;

create policy shift_companies_read_member on public.shift_companies
for select to authenticated
using (
  id = public.shift_current_company_id()
  or exists (
    select 1 from public.shift_workers w
    where w.company_id = shift_companies.id
      and w.auth_user_id = auth.uid()
      and w.is_active
  )
);

create policy shift_admins_read_self on public.shift_admins
for select to authenticated
using (user_id = auth.uid());

create policy shift_workers_admin_read on public.shift_workers
for select to authenticated
using (public.shift_is_admin() and company_id = public.shift_current_company_id());
create policy shift_workers_self_read on public.shift_workers
for select to authenticated
using (auth_user_id = auth.uid() and is_active);
create policy shift_workers_admin_insert on public.shift_workers
for insert to authenticated
with check (
  public.shift_is_admin()
  and company_id = public.shift_current_company_id()
  and auth_user_id is null
  and created_by = auth.uid()
);
create policy shift_workers_admin_update on public.shift_workers
for update to authenticated
using (public.shift_is_admin() and company_id = public.shift_current_company_id())
with check (public.shift_is_admin() and company_id = public.shift_current_company_id());

create policy shift_schedules_admin_all on public.shift_schedules
for all to authenticated
using (
  public.shift_is_admin()
  and exists (
    select 1 from public.shift_workers w
    where w.id = shift_schedules.worker_id
      and w.company_id = public.shift_current_company_id()
  )
)
with check (
  public.shift_is_admin()
  and exists (
    select 1 from public.shift_workers w
    where w.id = shift_schedules.worker_id
      and w.company_id = public.shift_current_company_id()
  )
);
create policy shift_schedules_worker_read on public.shift_schedules
for select to authenticated
using (worker_id = public.shift_current_worker_id());

create policy shift_confirmations_admin_read on public.shift_confirmations
for select to authenticated
using (
  public.shift_is_admin()
  and exists (
    select 1 from public.shift_workers w
    where w.id = shift_confirmations.worker_id
      and w.company_id = public.shift_current_company_id()
  )
);
create policy shift_confirmations_worker_read on public.shift_confirmations
for select to authenticated
using (worker_id = public.shift_current_worker_id());
create policy shift_confirmations_worker_insert on public.shift_confirmations
for insert to authenticated
with check (
  worker_id = public.shift_current_worker_id()
  and submitted_by = auth.uid()
  and record_kind = 'worker_self_confirmation'
  and exists (
    select 1 from public.shift_schedules s
    where s.worker_id = shift_confirmations.worker_id
      and s.shift_date = shift_confirmations.shift_date
  )
);

revoke all on function public.shift_current_company_id() from public, anon;
revoke all on function public.shift_is_admin() from public, anon;
revoke all on function public.shift_current_worker_id() from public, anon;
revoke all on function public.shift_touch_updated_at() from public, anon, authenticated;
revoke all on function public.shift_create_activation(uuid, text, timestamptz) from public, anon;
revoke all on function public.shift_revoke_activation(uuid) from public, anon;
revoke all on function public.shift_claim_activation(text) from public, anon;
grant execute on function public.shift_current_company_id() to authenticated;
grant execute on function public.shift_is_admin() to authenticated;
grant execute on function public.shift_current_worker_id() to authenticated;
grant execute on function public.shift_create_activation(uuid, text, timestamptz) to authenticated;
grant execute on function public.shift_revoke_activation(uuid) to authenticated;
grant execute on function public.shift_claim_activation(text) to authenticated;

commit;

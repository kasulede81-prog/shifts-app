-- Separate the human swiper/operator from the worker account being swiped.
-- Existing shift_workers, schedules, activation tokens, and confirmations are kept.
-- This is a local draft: inspect against the live schema before applying.

begin;

create table public.shift_swipers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.shift_companies (id) on delete restrict,
  auth_user_id uuid unique references auth.users (id) on delete set null,
  name text not null,
  email text not null,
  is_active boolean not null default true,
  created_by uuid not null default auth.uid() references auth.users (id),
  created_at timestamptz not null default now(),
  updated_by uuid not null default auth.uid() references auth.users (id),
  updated_at timestamptz not null default now(),
  linked_at timestamptz
);

create unique index shift_swipers_company_email_uq
  on public.shift_swipers (company_id, lower(trim(email)));
create index shift_swipers_company_active_idx
  on public.shift_swipers (company_id, is_active);

create table public.shift_swiper_assignments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.shift_companies (id) on delete restrict,
  swiper_id uuid not null references public.shift_swipers (id) on delete cascade,
  worker_id uuid not null references public.shift_workers (id) on delete cascade,
  assigned_by uuid not null default auth.uid() references auth.users (id),
  assigned_at timestamptz not null default now(),
  unique (swiper_id, worker_id)
);

create index shift_swiper_assignments_swiper_idx
  on public.shift_swiper_assignments (swiper_id, worker_id);
create index shift_swiper_assignments_worker_idx
  on public.shift_swiper_assignments (worker_id, swiper_id);

create table public.shift_swiper_activation_tokens (
  id uuid primary key default gen_random_uuid(),
  swiper_id uuid not null references public.shift_swipers (id) on delete cascade,
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

create index shift_swiper_activation_tokens_swiper_idx
  on public.shift_swiper_activation_tokens (swiper_id, expires_at desc);

-- Preserve already-linked legacy access by creating one operator per linked
-- worker login and assigning that login to its former worker profile.
insert into public.shift_swipers (company_id, auth_user_id, name, email, is_active, created_by, created_at, updated_by, updated_at, linked_at)
select w.company_id, w.auth_user_id, w.name, lower(trim(w.email)), w.is_active,
       w.created_by, w.created_at, w.updated_by, w.updated_at, w.linked_at
from public.shift_workers w
where w.auth_user_id is not null
   or exists (
     select 1 from public.shift_activation_tokens t
     where t.worker_id = w.id
       and t.consumed_at is null and t.revoked_at is null and t.expires_at > now()
   )
on conflict do nothing;

insert into public.shift_swiper_assignments (company_id, swiper_id, worker_id, assigned_by, assigned_at)
select w.company_id, s.id, w.id, w.created_by, coalesce(w.linked_at, w.created_at)
from public.shift_workers w
join public.shift_swipers s
  on s.company_id = w.company_id and lower(trim(s.email)) = lower(trim(w.email))
where w.auth_user_id is not null
   or exists (
     select 1 from public.shift_activation_tokens t
     where t.worker_id = w.id
       and t.consumed_at is null and t.revoked_at is null and t.expires_at > now()
   )
on conflict (swiper_id, worker_id) do nothing;

-- Carry still-valid legacy codes forward so the migration does not strand an
-- invite already handed to a user. Consumed/expired history stays in its table.
insert into public.shift_swiper_activation_tokens (swiper_id, token_hash, expires_at, created_by, created_at)
select s.id, t.token_hash, t.expires_at, t.created_by, t.created_at
from public.shift_activation_tokens t
join public.shift_workers w on w.id = t.worker_id
join public.shift_swipers s
  on s.company_id = w.company_id and lower(trim(s.email)) = lower(trim(w.email))
where t.consumed_at is null and t.revoked_at is null and t.expires_at > now()
on conflict (token_hash) do nothing;

create trigger shift_swipers_touch_updated_at
before update on public.shift_swipers
for each row execute function public.shift_touch_updated_at();

create or replace function public.shift_current_swiper_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select s.id
  from public.shift_swipers s
  where s.auth_user_id = auth.uid()
    and s.is_active
  limit 1;
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
    where a.worker_id = p_worker_id
      and s.auth_user_id = auth.uid()
      and s.is_active
      and w.is_active
      and a.company_id = w.company_id
      and a.company_id = s.company_id
  );
$$;

create or replace function public.shift_create_swiper_activation(
  p_swiper_id uuid,
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
    select 1 from public.shift_swipers s
    where s.id = p_swiper_id
      and s.company_id = v_company_id
      and s.is_active
      and s.auth_user_id is null
  ) then
    raise exception 'swiper_not_eligible' using errcode = '22023';
  end if;

  update public.shift_swiper_activation_tokens
  set revoked_at = now()
  where swiper_id = p_swiper_id
    and consumed_at is null
    and revoked_at is null;

  insert into public.shift_swiper_activation_tokens (swiper_id, token_hash, expires_at)
  values (p_swiper_id, decode(p_token_hash_hex, 'hex'), p_expires_at)
  returning id into v_token_id;

  return jsonb_build_object('id', v_token_id, 'expires_at', p_expires_at);
end;
$$;

create or replace function public.shift_claim_swiper_activation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_auth_email text := lower(trim(coalesce(auth.email(), '')));
  v_google_email text;
  v_activation public.shift_swiper_activation_tokens%rowtype;
  v_swiper public.shift_swipers%rowtype;
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
  from public.shift_swiper_activation_tokens t
  where t.token_hash = digest(convert_to(trim(p_token), 'UTF8'), 'sha256')
  for update;

  if not found
     or v_activation.revoked_at is not null
     or v_activation.consumed_at is not null
     or v_activation.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'activation_invalid');
  end if;

  select * into v_swiper
  from public.shift_swipers s
  where s.id = v_activation.swiper_id
  for update;

  if not found
     or not v_swiper.is_active
     or lower(trim(v_swiper.email)) <> v_auth_email
     or (v_swiper.auth_user_id is not null and v_swiper.auth_user_id <> v_uid)
     or exists (
       select 1 from public.shift_swipers other
       where other.auth_user_id = v_uid and other.id <> v_swiper.id
     ) then
    return jsonb_build_object('ok', false, 'error', 'activation_invalid');
  end if;

  update public.shift_swipers
  set auth_user_id = v_uid, linked_at = now()
  where id = v_swiper.id;

  update public.shift_swiper_activation_tokens
  set consumed_by = v_uid, consumed_at = now()
  where id = v_activation.id;

  return jsonb_build_object('ok', true, 'swiper_id', v_swiper.id);
end;
$$;

create or replace function public.shift_set_swiper_assignments(
  p_swiper_id uuid,
  p_worker_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_company_id uuid := public.shift_current_company_id();
  v_requested integer := coalesce(cardinality(p_worker_ids), 0);
  v_valid integer;
begin
  if auth.uid() is null or not public.shift_is_admin() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_requested > 100 then
    raise exception 'too_many_assignments' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.shift_swipers s
    where s.id = p_swiper_id and s.company_id = v_company_id and s.is_active
  ) then
    raise exception 'swiper_not_eligible' using errcode = '22023';
  end if;

  select count(distinct w.id)::integer into v_valid
  from unnest(coalesce(p_worker_ids, '{}'::uuid[])) requested(id)
  join public.shift_workers w on w.id = requested.id
  where w.company_id = v_company_id;
  if v_valid <> v_requested then
    raise exception 'invalid_swipe_account_assignment' using errcode = '22023';
  end if;

  delete from public.shift_swiper_assignments a where a.swiper_id = p_swiper_id;
  insert into public.shift_swiper_assignments (company_id, swiper_id, worker_id, assigned_by)
  select v_company_id, p_swiper_id, requested.id, auth.uid()
  from unnest(coalesce(p_worker_ids, '{}'::uuid[])) requested(id);
  return v_requested;
end;
$$;

alter table public.shift_companies enable row level security;
alter table public.shift_swipers enable row level security;
alter table public.shift_swiper_assignments enable row level security;
alter table public.shift_swiper_activation_tokens enable row level security;

revoke all on public.shift_swipers, public.shift_swiper_assignments,
  public.shift_swiper_activation_tokens from anon, authenticated;
grant select on public.shift_swipers, public.shift_swiper_assignments to authenticated;
grant insert (company_id, name, email, is_active) on public.shift_swipers to authenticated;
grant update (name, email, is_active) on public.shift_swipers to authenticated;

drop policy if exists shift_companies_read_member on public.shift_companies;
create policy shift_companies_read_member on public.shift_companies
for select to authenticated
using (
  id = public.shift_current_company_id()
  or exists (
    select 1 from public.shift_swipers s
    where s.company_id = shift_companies.id
      and s.auth_user_id = auth.uid()
      and s.is_active
  )
);

drop policy if exists shift_workers_self_read on public.shift_workers;
create policy shift_workers_assigned_read on public.shift_workers
for select to authenticated
using (is_active and public.shift_is_assigned_swiper(id));

drop policy if exists shift_schedules_worker_read on public.shift_schedules;
create policy shift_schedules_assigned_read on public.shift_schedules
for select to authenticated
using (public.shift_is_assigned_swiper(worker_id));

drop policy if exists shift_daily_rules_worker_read on public.shift_daily_rules;
create policy shift_daily_rules_assigned_read on public.shift_daily_rules
for select to authenticated
using (public.shift_is_assigned_swiper(worker_id));

drop policy if exists shift_confirmations_worker_read on public.shift_confirmations;
create policy shift_confirmations_swiper_read on public.shift_confirmations
for select to authenticated
using (
  submitted_by = auth.uid()
  and public.shift_is_assigned_swiper(worker_id)
);

drop policy if exists shift_confirmations_worker_insert on public.shift_confirmations;
alter table public.shift_confirmations
  drop constraint if exists shift_confirmations_record_kind_check;
alter table public.shift_confirmations
  add constraint shift_confirmations_record_kind_check
  check (record_kind in ('worker_self_confirmation', 'swiper_self_confirmation'));
alter table public.shift_confirmations
  alter column record_kind set default 'swiper_self_confirmation';

create policy shift_confirmations_swiper_insert on public.shift_confirmations
for insert to authenticated
with check (
  public.shift_is_assigned_swiper(worker_id)
  and submitted_by = auth.uid()
  and record_kind = 'swiper_self_confirmation'
  and (
    exists (
      select 1 from public.shift_schedules s
      where s.worker_id = shift_confirmations.worker_id
        and s.shift_date = shift_confirmations.shift_date
        and s.schedule_kind = 'shift'
    )
    or (
      exists (
      select 1 from public.shift_daily_rules r
      where r.worker_id = shift_confirmations.worker_id
        and shift_confirmations.shift_date >= r.effective_from
        and (r.effective_until is null or shift_confirmations.shift_date <= r.effective_until)
      )
      and not exists (
        select 1 from public.shift_schedules s
        where s.worker_id = shift_confirmations.worker_id
          and s.shift_date = shift_confirmations.shift_date
      )
    )
  )
);
grant insert (record_kind) on public.shift_confirmations to authenticated;

create policy shift_swipers_admin_read on public.shift_swipers
for select to authenticated
using (public.shift_is_admin() and company_id = public.shift_current_company_id());
create policy shift_swipers_self_read on public.shift_swipers
for select to authenticated
using (auth_user_id = auth.uid());
create policy shift_swipers_admin_insert on public.shift_swipers
for insert to authenticated
with check (
  public.shift_is_admin()
  and company_id = public.shift_current_company_id()
  and auth_user_id is null
  and created_by = auth.uid()
);
create policy shift_swipers_admin_update on public.shift_swipers
for update to authenticated
using (public.shift_is_admin() and company_id = public.shift_current_company_id())
with check (public.shift_is_admin() and company_id = public.shift_current_company_id());

create policy shift_swiper_assignments_admin_all on public.shift_swiper_assignments
for all to authenticated
using (
  public.shift_is_admin()
  and company_id = public.shift_current_company_id()
)
with check (
  public.shift_is_admin()
  and company_id = public.shift_current_company_id()
  and assigned_by = auth.uid()
  and exists (
    select 1 from public.shift_swipers s
    join public.shift_workers w on w.company_id = s.company_id
    where s.id = shift_swiper_assignments.swiper_id
      and w.id = shift_swiper_assignments.worker_id
      and s.is_active
      and s.company_id = shift_swiper_assignments.company_id
  )
);
create policy shift_swiper_assignments_self_read on public.shift_swiper_assignments
for select to authenticated
using (swiper_id = public.shift_current_swiper_id());

revoke all on function public.shift_current_swiper_id() from public, anon;
revoke all on function public.shift_is_assigned_swiper(uuid) from public, anon;
revoke all on function public.shift_create_swiper_activation(uuid, text, timestamptz) from public, anon;
revoke all on function public.shift_claim_swiper_activation(text) from public, anon;
revoke all on function public.shift_set_swiper_assignments(uuid, uuid[]) from public, anon;
grant execute on function public.shift_current_swiper_id() to authenticated;
grant execute on function public.shift_is_assigned_swiper(uuid) to authenticated;
grant execute on function public.shift_create_swiper_activation(uuid, text, timestamptz) to authenticated;
grant execute on function public.shift_claim_swiper_activation(text) to authenticated;
grant execute on function public.shift_set_swiper_assignments(uuid, uuid[]) to authenticated;

-- Keep legacy activation rows and worker auth links for audit/recovery, but disable
-- the old one-login-to-one-worker activation path for authenticated clients.
revoke all on function public.shift_create_activation(uuid, text, timestamptz) from authenticated;
revoke all on function public.shift_revoke_activation(uuid) from authenticated;
revoke all on function public.shift_claim_activation(text) from authenticated;

commit;

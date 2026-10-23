-- Daily recurring shift defaults with explicit per-date exceptions.
-- Existing dated shift rows remain intact and keep the default kind 'shift'.
alter table public.shift_schedules
  add column schedule_kind text not null default 'shift';

alter table public.shift_schedules
  add constraint shift_schedules_kind_check
    check (schedule_kind in ('shift', 'off')),
  alter column start_time drop not null,
  alter column end_time drop not null;

alter table public.shift_schedules
  add constraint shift_schedules_kind_times_check
    check (
      (schedule_kind = 'shift' and start_time is not null and end_time is not null and start_time <> end_time)
      or (schedule_kind = 'off' and start_time is null and end_time is null)
    );

create table public.shift_daily_rules (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null unique references public.shift_workers (id) on delete cascade,
  effective_from date not null,
  effective_until date,
  start_time time not null,
  end_time time not null,
  schedule_timezone text not null,
  created_by uuid not null default auth.uid() references auth.users (id),
  created_at timestamptz not null default now(),
  updated_by uuid not null default auth.uid() references auth.users (id),
  updated_at timestamptz not null default now(),
  revision integer not null default 1 check (revision > 0),
  check (effective_until is null or effective_until >= effective_from),
  check (start_time <> end_time)
);

create index shift_daily_rules_effective_idx
  on public.shift_daily_rules (worker_id, effective_from, effective_until);

create trigger shift_daily_rules_touch_updated_at
before update on public.shift_daily_rules
for each row execute function public.shift_touch_updated_at();

create or replace function public.shift_touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, auth
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_table_name in ('shift_schedules', 'shift_daily_rules') then
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;

alter table public.shift_daily_rules enable row level security;

revoke all on public.shift_daily_rules from anon, authenticated;
grant select on public.shift_daily_rules to authenticated;
grant insert (worker_id, effective_from, effective_until, start_time, end_time, schedule_timezone)
  on public.shift_daily_rules to authenticated;
grant update (effective_from, effective_until, start_time, end_time, schedule_timezone)
  on public.shift_daily_rules to authenticated;
grant delete on public.shift_daily_rules to authenticated;

grant insert (worker_id, shift_date, start_time, end_time, schedule_timezone, schedule_kind)
  on public.shift_schedules to authenticated;
grant update (shift_date, start_time, end_time, schedule_timezone, schedule_kind)
  on public.shift_schedules to authenticated;

create policy shift_daily_rules_admin_all on public.shift_daily_rules
for all to authenticated
using (
  public.shift_is_admin()
  and exists (
    select 1 from public.shift_workers w
    where w.id = shift_daily_rules.worker_id
      and w.company_id = public.shift_current_company_id()
  )
)
with check (
  public.shift_is_admin()
  and exists (
    select 1 from public.shift_workers w
    where w.id = shift_daily_rules.worker_id
      and w.company_id = public.shift_current_company_id()
  )
);

create policy shift_daily_rules_worker_read on public.shift_daily_rules
for select to authenticated
using (worker_id = public.shift_current_worker_id());

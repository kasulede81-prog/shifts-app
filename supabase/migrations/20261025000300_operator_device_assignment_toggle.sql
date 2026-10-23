-- Let the admin enable strict device-level Swipe ID grouping per operator.
-- Existing operators default to OFF so this rollout does not lock anyone out.
begin;

alter table public.shift_swipers
  add column device_assignment_enabled boolean not null default false;

grant update (device_assignment_enabled) on public.shift_swipers to authenticated;

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
      and (
        not s.device_assignment_enabled
        or exists (
          select 1
          from public.shift_swiper_devices d
          join public.shift_device_swipe_groups g
            on g.device_id = d.id
           and g.company_id = w.company_id
           and g.swipe_id_key = public.shift_worker_swipe_key(w.id)
          where d.id = public.shift_current_device_id()
            and d.swiper_id = s.id
            and d.company_id = s.company_id
            and d.is_active
        )
      )
  );
$$;

create or replace function public.shift_set_swiper_device_assignment(
  p_swiper_id uuid,
  p_enabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_company_id uuid := public.shift_current_company_id();
  v_expected integer;
  v_ready integer;
begin
  if auth.uid() is null or not public.shift_is_admin() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_enabled is null then raise exception 'invalid_toggle_value' using errcode = '22023'; end if;
  if not exists (
    select 1 from public.shift_swipers s
    where s.id = p_swiper_id and s.company_id = v_company_id and s.is_active
  ) then raise exception 'swiper_not_eligible' using errcode = '22023'; end if;

  if p_enabled then
    select count(distinct public.shift_worker_swipe_key(w.id))::integer into v_expected
    from public.shift_swiper_assignments a
    join public.shift_workers w on w.id = a.worker_id
    where a.swiper_id = p_swiper_id and a.company_id = v_company_id
      and w.company_id = v_company_id and w.is_active;

    select count(distinct public.shift_worker_swipe_key(w.id))::integer into v_ready
    from public.shift_swiper_assignments a
    join public.shift_workers w on w.id = a.worker_id
    join public.shift_device_swipe_groups g
      on g.company_id = w.company_id
     and g.swipe_id_key = public.shift_worker_swipe_key(w.id)
    join public.shift_swiper_devices d
      on d.id = g.device_id
     and d.swiper_id = p_swiper_id
     and d.company_id = v_company_id
     and d.is_active
    where a.swiper_id = p_swiper_id and a.company_id = v_company_id
      and w.company_id = v_company_id and w.is_active;

    if v_ready < v_expected then
      raise exception 'device_groups_incomplete'
        using errcode = '22023',
          detail = 'Assign every active Swipe ID group to one of this operator’s registered devices before enabling device assignment.';
    end if;
  end if;

  update public.shift_swipers
  set device_assignment_enabled = p_enabled,
      updated_by = auth.uid(),
      updated_at = now()
  where id = p_swiper_id and company_id = v_company_id;
  return p_enabled;
end;
$$;

revoke all on function public.shift_set_swiper_device_assignment(uuid, boolean) from public, anon;
grant execute on function public.shift_set_swiper_device_assignment(uuid, boolean) to authenticated;

commit;

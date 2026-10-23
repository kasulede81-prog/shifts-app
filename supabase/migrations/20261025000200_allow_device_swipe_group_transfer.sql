-- Allow an admin to move a Swipe ID group directly to another eligible device.
-- The (company_id, swipe_id_key) primary key still guarantees one owning device.
begin;

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
  from unnest(coalesce(p_swipe_id_keys, '{}'::text[])) requested(key)
  on conflict (company_id, swipe_id_key) do update
    set device_id = excluded.device_id,
        assigned_by = excluded.assigned_by,
        assigned_at = now();
  return v_requested;
end;
$$;

revoke all on function public.shift_set_device_swipe_groups(uuid, text[]) from public, anon;
grant execute on function public.shift_set_device_swipe_groups(uuid, text[]) to authenticated;

commit;

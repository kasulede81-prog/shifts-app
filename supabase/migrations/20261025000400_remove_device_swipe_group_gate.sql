-- Swipe account access follows the operator's admin-managed account assignments,
-- not a registration or Swipe ID group mapping for a particular device.
-- Preserve device/group tables and their existing rows for historical recovery.
begin;

-- Do not update shift_swipers here: its audit trigger writes auth.uid() to
-- updated_by, which is NULL when this migration is run from SQL Editor. The
-- predicate below no longer reads this legacy flag, and the toggle RPC is
-- removed, so any existing value is inert and cannot block account access.
revoke update (device_assignment_enabled) on public.shift_swipers from authenticated;

drop function if exists public.shift_set_swiper_device_assignment(uuid, boolean);

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

commit;

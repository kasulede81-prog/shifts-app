-- One-time admin-issued recovery codes for a swiper's on-device app PIN.
-- Codes are bound to the registered Google identity, expire after 15 minutes,
-- and are consumed only after successful identity and swiper checks.

begin;

create table public.shift_swiper_pin_reset_tokens (
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

create index shift_swiper_pin_reset_tokens_swiper_idx
  on public.shift_swiper_pin_reset_tokens (swiper_id, expires_at desc);

alter table public.shift_swiper_pin_reset_tokens enable row level security;
revoke all on public.shift_swiper_pin_reset_tokens from public, anon, authenticated;

create or replace function public.shift_create_swiper_pin_reset(
  p_swiper_id uuid,
  p_token_hash_hex text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_company_id uuid;
  v_expires_at timestamptz := now() + interval '15 minutes';
  v_token_id uuid;
begin
  if auth.uid() is null or not public.shift_is_admin() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if coalesce(p_token_hash_hex, '') !~ '^[0-9a-fA-F]{64}$' then
    raise exception 'invalid_pin_reset_request' using errcode = '22023';
  end if;

  v_company_id := public.shift_current_company_id();
  if not exists (
    select 1 from public.shift_swipers s
    where s.id = p_swiper_id
      and s.company_id = v_company_id
      and s.is_active
      and s.auth_user_id is not null
  ) then
    raise exception 'swiper_not_eligible' using errcode = '22023';
  end if;

  update public.shift_swiper_pin_reset_tokens
  set revoked_at = now()
  where swiper_id = p_swiper_id
    and consumed_at is null
    and revoked_at is null;

  insert into public.shift_swiper_pin_reset_tokens (swiper_id, token_hash, expires_at)
  values (p_swiper_id, decode(p_token_hash_hex, 'hex'), v_expires_at)
  returning id into v_token_id;

  return jsonb_build_object('id', v_token_id, 'expires_at', v_expires_at);
end;
$$;

create or replace function public.shift_claim_swiper_pin_reset(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_auth_email text := lower(trim(coalesce(auth.email(), '')));
  v_google_email text;
  v_reset public.shift_swiper_pin_reset_tokens%rowtype;
  v_swiper public.shift_swipers%rowtype;
begin
  if v_uid is null or v_auth_email = '' or coalesce(trim(p_token), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'pin_reset_invalid');
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
    return jsonb_build_object('ok', false, 'error', 'pin_reset_invalid');
  end if;

  select * into v_reset
  from public.shift_swiper_pin_reset_tokens t
  where t.token_hash = extensions.digest(convert_to(trim(p_token), 'UTF8'), 'sha256')
  for update;

  if not found
     or v_reset.revoked_at is not null
     or v_reset.consumed_at is not null
     or v_reset.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'pin_reset_invalid');
  end if;

  select * into v_swiper
  from public.shift_swipers s
  where s.id = v_reset.swiper_id
  for update;

  if not found
     or not v_swiper.is_active
     or v_swiper.auth_user_id is distinct from v_uid
     or lower(trim(v_swiper.email)) <> v_auth_email then
    return jsonb_build_object('ok', false, 'error', 'pin_reset_invalid');
  end if;

  update public.shift_swiper_pin_reset_tokens
  set consumed_by = v_uid, consumed_at = now()
  where id = v_reset.id;

  return jsonb_build_object('ok', true, 'swiper_id', v_swiper.id);
end;
$$;

revoke all on function public.shift_create_swiper_pin_reset(uuid, text) from public, anon;
revoke all on function public.shift_claim_swiper_pin_reset(text) from public, anon;
grant execute on function public.shift_create_swiper_pin_reset(uuid, text) to authenticated;
grant execute on function public.shift_claim_swiper_pin_reset(text) to authenticated;

commit;

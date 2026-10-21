-- Safe authentication/profile hardening. Run after 01_schema.sql and 04_customer_portal.sql.
-- Existing rows and role values are preserved; only missing profiles are backfilled as customers.
begin;

alter table public.profiles enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid='public.profiles'::regclass
      and conname='profiles_role_allowed_check'
  ) then
    alter table public.profiles
      add constraint profiles_role_allowed_check
      check (role in ('owner','customer')) not valid;
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid='public.profiles'::regclass
      and conname='profiles_role_allowed_check'
      and convalidated
  ) and not exists (
    select 1
    from public.profiles
    where role is null or role not in ('owner','customer')
  ) then
    alter table public.profiles
      validate constraint profiles_role_allowed_check;
  end if;
end;
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path=public
as $$
  select exists (
    select 1 from public.profiles
    where id=auth.uid() and role='owner'
  );
$$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  insert into public.profiles(id,role,display_name)
  values(new.id,'customer',nullif(trim(new.raw_user_meta_data->>'full_name'),''))
  on conflict(id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
revoke all on function public.handle_new_auth_user() from public,anon,authenticated;

insert into public.profiles(id,role)
select u.id,'customer'
from auth.users u
on conflict(id) do nothing;

drop policy if exists "Read own profile or owner" on public.profiles;
create policy "Read own profile or owner" on public.profiles
  for select to authenticated
  using (id=auth.uid() or public.is_owner());

drop policy if exists "Customer update own profile fields" on public.profiles;
create policy "Customer update own profile fields" on public.profiles
  for update to authenticated
  using (id=auth.uid() and role='customer')
  with check (id=auth.uid() and role='customer');

revoke all on public.profiles from anon,authenticated;
grant select on public.profiles to authenticated;
grant update(display_name,telepon,alamat) on public.profiles to authenticated;
revoke all on function public.is_owner() from public,anon;
grant execute on function public.is_owner() to authenticated;

commit;
notify pgrst, 'reload schema';

-- After resolving any existing invalid values, validate the constraint separately:
-- alter table public.profiles validate constraint profiles_role_allowed_check;

-- MilchikTG database setup for Supabase
-- Paste this entire file into Supabase Dashboard > SQL Editor > New query, then Run.
-- This creates a simple direct-message app with Row Level Security.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Пользователь' check (char_length(display_name) between 1 and 40),
  bio text not null default '' check (char_length(bio) <= 180),
  created_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_created_idx
  on public.messages(conversation_id, created_at);
create index if not exists conversation_members_user_idx
  on public.conversation_members(user_id);
create index if not exists profiles_display_name_idx
  on public.profiles using gin (to_tsvector('simple', display_name));

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;

drop policy if exists "Authenticated users can search profiles" on public.profiles;
create policy "Authenticated users can search profiles"
on public.profiles for select to authenticated using (true);

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
on public.profiles for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

-- SECURITY DEFINER helper avoids recursive RLS when membership policies query membership.
create or replace function public.is_conversation_member(target_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = target_conversation_id
      and cm.user_id = auth.uid()
  );
$$;
revoke all on function public.is_conversation_member(uuid) from public;
grant execute on function public.is_conversation_member(uuid) to authenticated;

drop policy if exists "Members can read conversations" on public.conversations;
create policy "Members can read conversations"
on public.conversations for select to authenticated
using (public.is_conversation_member(id));

drop policy if exists "Members can read membership" on public.conversation_members;
create policy "Members can read membership"
on public.conversation_members for select to authenticated
using (public.is_conversation_member(conversation_id));

drop policy if exists "Members can read messages" on public.messages;
create policy "Members can read messages"
on public.messages for select to authenticated
using (public.is_conversation_member(conversation_id));

drop policy if exists "Members can send as themselves" on public.messages;
create policy "Members can send as themselves"
on public.messages for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and public.is_conversation_member(conversation_id)
);

-- Create profile automatically whenever a new Supabase Auth user registers.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1), 'Пользователь')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Secure RPC: create a direct conversation and add both users atomically.
create or replace function public.create_direct_conversation(target_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_id uuid := auth.uid();
  existing_id uuid;
  new_id uuid;
begin
  if current_id is null then
    raise exception 'Нужно войти в аккаунт';
  end if;
  if target_user_id is null or target_user_id = current_id then
    raise exception 'Нельзя создать чат с самим собой';
  end if;
  if not exists (select 1 from auth.users where id = target_user_id) then
    raise exception 'Пользователь не найден';
  end if;

  select c.id into existing_id
  from public.conversations c
  where
    (select count(*) from public.conversation_members cm where cm.conversation_id = c.id) = 2
    and exists (select 1 from public.conversation_members a where a.conversation_id = c.id and a.user_id = current_id)
    and exists (select 1 from public.conversation_members b where b.conversation_id = c.id and b.user_id = target_user_id)
  limit 1;

  if existing_id is not null then
    return existing_id;
  end if;

  insert into public.conversations(created_by) values (current_id) returning id into new_id;
  insert into public.conversation_members(conversation_id, user_id)
  values (new_id, current_id), (new_id, target_user_id);
  return new_id;
end;
$$;

revoke all on function public.create_direct_conversation(uuid) from public;
grant execute on function public.create_direct_conversation(uuid) to authenticated;

-- Explicit grants for the Supabase Data API.
grant select, update on public.profiles to authenticated;
grant select on public.conversations to authenticated;
grant select on public.conversation_members to authenticated;
grant select, insert on public.messages to authenticated;

-- Enable realtime events for messages and new memberships.
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
when undefined_object then raise notice 'Publication supabase_realtime was not found; enable Realtime for messages in the Dashboard.';
end $$;
do $$
begin
  alter publication supabase_realtime add table public.conversation_members;
exception when duplicate_object then null;
when undefined_object then raise notice 'Publication supabase_realtime was not found; enable Realtime for conversation_members in the Dashboard.';
end $$;

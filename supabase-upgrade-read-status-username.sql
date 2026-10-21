-- MilchikTG: add unique usernames and message read receipts.
-- Run once in Supabase Dashboard -> SQL Editor -> New query.
-- This migration keeps existing profiles, chats and messages.

alter table public.profiles add column if not exists username text;

-- Existing accounts can set their username in Profile settings after this migration.
create unique index if not exists profiles_username_unique_ci
  on public.profiles (lower(username))
  where username is not null and length(trim(username)) > 0;

alter table public.profiles drop constraint if exists profiles_username_format_check;
alter table public.profiles add constraint profiles_username_format_check
  check (username is null or username ~ '^[A-Za-z0-9_]{3,24}$');

create table if not exists public.message_reads (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index if not exists message_reads_user_idx on public.message_reads(user_id, read_at desc);

alter table public.message_reads enable row level security;
drop policy if exists "Chat members can view message receipts" on public.message_reads;
create policy "Chat members can view message receipts" on public.message_reads
  for select to authenticated
  using (exists (
    select 1 from public.messages m
    where m.id = message_reads.message_id
      and public.is_conversation_member(m.conversation_id)
  ));

drop policy if exists "Users can mark incoming messages read" on public.message_reads;
create policy "Users can mark incoming messages read" on public.message_reads
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      where m.id = message_reads.message_id
        and m.sender_id <> auth.uid()
        and public.is_conversation_member(m.conversation_id)
    )
  );

grant select, insert on public.message_reads to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.message_reads;
exception when duplicate_object then null;
when undefined_object then raise notice 'Realtime publication not found; enable message_reads in Supabase Dashboard -> Database -> Replication.';
end $$;

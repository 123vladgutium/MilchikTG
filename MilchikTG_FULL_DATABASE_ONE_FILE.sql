-- MilchikTG: ЕДИНЫЙ ПОЛНЫЙ SQL ДЛЯ СУЩЕСТВУЮЩЕГО ПРОЕКТА SUPABASE
-- Запустить один раз: Supabase -> SQL Editor -> New query -> вставить весь файл -> Run.
-- Без DROP TABLE и удаления сообщений/аккаунтов.
-- Включает таблицы, уникальные юзернеймы, read receipts, чаты/группы/каналы,
-- политики безопасности, RPC-функции, Storage для фото/голосовых и Realtime.

begin;
create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────
-- 1. Профили
-- ─────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Пользователь',
  bio text not null default '',
  avatar_url text,
  username text,
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists display_name text not null default 'Пользователь';
alter table public.profiles add column if not exists bio text not null default '';
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists created_at timestamptz not null default now();

-- Старые некорректные/дублирующиеся имена очищаются безопасно:
-- один аккаунт сохраняет юзернейм, у остальных он становится пустым (NULL).
update public.profiles
set username = null
where username is not null and username !~ '^[A-Za-z0-9_]{3,24}$';

with ranked as (
  select id, row_number() over (
    partition by lower(username)
    order by created_at nulls last, id
  ) as rn
  from public.profiles
  where username is not null and length(trim(username)) > 0
)
update public.profiles p
set username = null
from ranked r
where p.id = r.id and r.rn > 1;

alter table public.profiles drop constraint if exists profiles_username_format_check;
alter table public.profiles add constraint profiles_username_format_check
  check (username is null or username ~ '^[A-Za-z0-9_]{3,24}$');
create unique index if not exists profiles_username_unique_ci
  on public.profiles (lower(username))
  where username is not null and length(trim(username)) > 0;

-- Создать недостающие профили для старых аккаунтов.
insert into public.profiles (id, display_name)
select u.id,
       left(coalesce(nullif(trim(u.raw_user_meta_data ->> 'display_name'), ''),
                     nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
                     'Пользователь'), 40)
from auth.users u
on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────
-- 2. Переписки, группы и каналы
-- ─────────────────────────────────────────────────────────────
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  type text not null default 'direct',
  title text
);

alter table public.conversations add column if not exists created_by uuid references auth.users(id) on delete cascade;
alter table public.conversations add column if not exists created_at timestamptz not null default now();
alter table public.conversations add column if not exists updated_at timestamptz not null default now();
alter table public.conversations add column if not exists type text not null default 'direct';
alter table public.conversations add column if not exists title text;

update public.conversations set type = 'direct' where type is null or type not in ('direct','group','channel');
alter table public.conversations drop constraint if exists conversations_type_check;
alter table public.conversations add constraint conversations_type_check
  check (type in ('direct','group','channel'));

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
alter table public.conversation_members add column if not exists joined_at timestamptz not null default now();

-- ВАЖНО: добавляем отдельный FK к profiles, чтобы PostgREST мог получать профиль
-- через profiles!conversation_members_user_profile_fkey (исправляет ошибку связи).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'conversation_members_user_profile_fkey'
      and conrelid = 'public.conversation_members'::regclass
  ) then
    alter table public.conversation_members
      add constraint conversation_members_user_profile_fkey
      foreign key (user_id) references public.profiles(id) on delete cascade;
  end if;
end $$;

create index if not exists conversation_members_user_idx on public.conversation_members(user_id);
create index if not exists conversations_type_created_idx on public.conversations(type, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- 3. Сообщения: текст, фотографии, аудио, редактирование, закрепление
-- ─────────────────────────────────────────────────────────────
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  content text not null default '',
  created_at timestamptz not null default now(),
  attachment_url text,
  attachment_type text,
  edited_at timestamptz,
  is_pinned boolean not null default false
);

alter table public.messages add column if not exists content text not null default '';
alter table public.messages add column if not exists created_at timestamptz not null default now();
alter table public.messages add column if not exists attachment_url text;
alter table public.messages add column if not exists attachment_type text;
alter table public.messages add column if not exists edited_at timestamptz;
alter table public.messages add column if not exists is_pinned boolean not null default false;

update public.messages set content = '' where content is null;
alter table public.messages alter column content set default '';
alter table public.messages alter column content set not null;

-- Старое ограничение могло запрещать сообщения, состоящие только из файла.
alter table public.messages drop constraint if exists messages_content_check;
alter table public.messages drop constraint if exists messages_content_or_attachment_check;
alter table public.messages add constraint messages_content_or_attachment_check
  check (
    char_length(content) <= 4000
    and (length(trim(content)) > 0 or attachment_url is not null)
  );

create index if not exists messages_conversation_created_idx
  on public.messages(conversation_id, created_at desc);
create index if not exists messages_sender_created_idx
  on public.messages(sender_id, created_at desc);
create index if not exists messages_pinned_idx
  on public.messages(conversation_id, is_pinned) where is_pinned = true;

-- ─────────────────────────────────────────────────────────────
-- 4. Прочтение сообщений
-- ─────────────────────────────────────────────────────────────
create table if not exists public.message_reads (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
alter table public.message_reads add column if not exists read_at timestamptz not null default now();
create index if not exists message_reads_user_idx on public.message_reads(user_id, read_at desc);

-- ─────────────────────────────────────────────────────────────
-- 5. Безопасные функции
-- ─────────────────────────────────────────────────────────────
create or replace function public.is_conversation_member(target_conversation_id uuid)
returns boolean
language sql stable security definer
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

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
             nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
             'Пользователь')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.create_direct_conversation(target_user_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  existing_id uuid;
  new_id uuid;
begin
  if caller is null then raise exception 'Сначала войдите в аккаунт'; end if;
  if target_user_id is null or target_user_id = caller then
    raise exception 'Нельзя создать чат с самим собой';
  end if;
  if not exists (select 1 from public.profiles p where p.id = target_user_id) then
    raise exception 'Пользователь не найден';
  end if;

  select c.id into existing_id
  from public.conversations c
  where c.type = 'direct'
    and (select count(*) from public.conversation_members cm where cm.conversation_id = c.id) = 2
    and exists (select 1 from public.conversation_members a where a.conversation_id = c.id and a.user_id = caller)
    and exists (select 1 from public.conversation_members b where b.conversation_id = c.id and b.user_id = target_user_id)
  limit 1;

  if existing_id is not null then return existing_id; end if;

  insert into public.conversations (created_by, type)
  values (caller, 'direct') returning id into new_id;

  insert into public.conversation_members (conversation_id, user_id)
  values (new_id, caller), (new_id, target_user_id);
  return new_id;
end;
$$;

create or replace function public.create_community_space(space_title text, space_type text, member_ids uuid[] default '{}')
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  new_id uuid;
  target uuid;
begin
  if caller is null then raise exception 'Сначала войдите в аккаунт'; end if;
  if space_type not in ('group','channel') then raise exception 'Недопустимый тип сообщества'; end if;
  if char_length(trim(space_title)) < 2 or char_length(trim(space_title)) > 60 then
    raise exception 'Название должно содержать от 2 до 60 символов';
  end if;

  insert into public.conversations (created_by, type, title)
  values (caller, space_type, trim(space_title)) returning id into new_id;

  insert into public.conversation_members (conversation_id, user_id)
  values (new_id, caller);

  if space_type = 'group' then
    foreach target in array coalesce(member_ids, '{}'::uuid[]) loop
      if target <> caller and exists (select 1 from public.profiles p where p.id = target) then
        insert into public.conversation_members (conversation_id, user_id)
        values (new_id, target) on conflict do nothing;
      end if;
    end loop;
  end if;
  return new_id;
end;
$$;

create or replace function public.join_public_channel(target_channel_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare caller uuid := auth.uid();
begin
  if caller is null then raise exception 'Сначала войдите в аккаунт'; end if;
  if not exists (
    select 1 from public.conversations c
    where c.id = target_channel_id and c.type = 'channel'
  ) then raise exception 'Канал не найден'; end if;
  insert into public.conversation_members (conversation_id, user_id)
  values (target_channel_id, caller) on conflict do nothing;
end;
$$;

revoke all on function public.create_direct_conversation(uuid) from public;
revoke all on function public.create_community_space(text, text, uuid[]) from public;
revoke all on function public.join_public_channel(uuid) from public;
grant execute on function public.create_direct_conversation(uuid) to authenticated;
grant execute on function public.create_community_space(text, text, uuid[]) to authenticated;
grant execute on function public.join_public_channel(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────
-- 6. Row Level Security и права доступа
-- ─────────────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_reads enable row level security;

drop policy if exists "Authenticated users can search profiles" on public.profiles;
create policy "Authenticated users can search profiles"
on public.profiles for select to authenticated using (true);

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
on public.profiles for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

drop policy if exists "Members can read conversations" on public.conversations;
create policy "Members can read conversations"
on public.conversations for select to authenticated
using (type = 'channel' or public.is_conversation_member(id));

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

drop policy if exists "Users can update own messages" on public.messages;
create policy "Users can update own messages"
on public.messages for update to authenticated
using (sender_id = (select auth.uid()) and public.is_conversation_member(conversation_id))
with check (sender_id = (select auth.uid()) and public.is_conversation_member(conversation_id));

drop policy if exists "Users can delete own messages" on public.messages;
create policy "Users can delete own messages"
on public.messages for delete to authenticated
using (sender_id = (select auth.uid()) and public.is_conversation_member(conversation_id));

drop policy if exists "Chat members can view message receipts" on public.message_reads;
create policy "Chat members can view message receipts"
on public.message_reads for select to authenticated
using (
  exists (
    select 1 from public.messages m
    where m.id = message_reads.message_id
      and public.is_conversation_member(m.conversation_id)
  )
);

drop policy if exists "Users can mark incoming messages read" on public.message_reads;
create policy "Users can mark incoming messages read"
on public.message_reads for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.messages m
    where m.id = message_reads.message_id
      and m.sender_id <> (select auth.uid())
      and public.is_conversation_member(m.conversation_id)
  )
);

grant select, update on public.profiles to authenticated;
grant select on public.conversations to authenticated;
grant select on public.conversation_members to authenticated;
grant select, insert, delete on public.messages to authenticated;
revoke update on public.messages from authenticated;
grant update (content, edited_at, is_pinned) on public.messages to authenticated;
grant select, insert on public.message_reads to authenticated;

-- ─────────────────────────────────────────────────────────────
-- 7. Storage для фото профиля, фото в чате и голосовых
-- ─────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'milchiktg-media',
  'milchiktg-media',
  true,
  12582912,
  array['image/jpeg','image/png','image/webp','image/gif',
        'audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav',
        'video/webm']
)
on conflict (id) do update
set public = true,
    file_size_limit = 12582912,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "MilchikTG users upload own media" on storage.objects;
create policy "MilchikTG users upload own media"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'milchiktg-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "MilchikTG users update own media" on storage.objects;
create policy "MilchikTG users update own media"
on storage.objects for update to authenticated
using (
  bucket_id = 'milchiktg-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
)
with check (
  bucket_id = 'milchiktg-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "MilchikTG users delete own media" on storage.objects;
create policy "MilchikTG users delete own media"
on storage.objects for delete to authenticated
using (
  bucket_id = 'milchiktg-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

-- Публичный bucket позволяет показывать фото/аудио через getPublicUrl.
drop policy if exists "MilchikTG media is publicly readable" on storage.objects;
create policy "MilchikTG media is publicly readable"
on storage.objects for select to public
using (bucket_id = 'milchiktg-media');

-- ─────────────────────────────────────────────────────────────
-- 8. Realtime
-- ─────────────────────────────────────────────────────────────
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
when undefined_object then raise notice 'Publication supabase_realtime не найдена. Включите Realtime в Supabase Dashboard.';
end $$;

do $$
begin
  alter publication supabase_realtime add table public.conversation_members;
exception when duplicate_object then null;
when undefined_object then raise notice 'Publication supabase_realtime не найдена. Включите Realtime в Supabase Dashboard.';
end $$;

do $$
begin
  alter publication supabase_realtime add table public.message_reads;
exception when duplicate_object then null;
when undefined_object then raise notice 'Publication supabase_realtime не найдена. Включите Realtime в Supabase Dashboard.';
end $$;

commit;

-- После выполнения:
-- 1) В профиле каждый пользователь задаёт username (3-24 символа: a-z, 0-9, _).
-- 2) Дубли username блокируются индексом PostgreSQL без учёта регистра.
-- 3) Статус "Прочитано" появляется после открытия чата получателем и успешной записи в message_reads.
-- 4) Для загрузки участников в JavaScript используется FK profiles!conversation_members_user_profile_fkey.

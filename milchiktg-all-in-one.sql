-- MilchikTG: единая настройка/обновление для уже созданного проекта Supabase.
-- Запустить ОДИН РАЗ целиком: Dashboard -> SQL Editor -> New query -> Run.
-- Для правильной работы нужны отдельные связанные таблицы; этот файл создаёт/обновляет их одним запуском.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Пользователь',
  bio text not null default '',
  avatar_url text,
  created_at timestamptz not null default now()
);
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  type text not null default 'direct',
  title text
);
create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id,user_id)
);
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

alter table public.profiles add column if not exists bio text not null default '';
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists created_at timestamptz not null default now();
alter table public.conversations add column if not exists type text not null default 'direct';
alter table public.conversations add column if not exists title text;
alter table public.conversations add column if not exists updated_at timestamptz not null default now();
alter table public.conversation_members add column if not exists joined_at timestamptz not null default now();
alter table public.conversation_members drop constraint if exists conversation_members_user_id_fkey;
alter table public.conversation_members add constraint conversation_members_user_id_fkey foreign key (user_id) references public.profiles(id) on delete cascade;
alter table public.messages add column if not exists attachment_url text;
alter table public.messages add column if not exists attachment_type text;
alter table public.messages add column if not exists edited_at timestamptz;
alter table public.messages add column if not exists is_pinned boolean not null default false;
alter table public.messages alter column content set default '';
alter table public.messages alter column attachment_type drop not null;
alter table public.messages alter column attachment_type drop default;

alter table public.conversations drop constraint if exists conversations_type_check;
alter table public.conversations add constraint conversations_type_check check(type in ('direct','group','channel'));
alter table public.messages drop constraint if exists messages_content_check;
alter table public.messages add constraint messages_content_check check(char_length(content)<=4000 and (char_length(trim(content))>0 or attachment_url is not null));
alter table public.messages drop constraint if exists messages_attachment_type_check;
alter table public.messages add constraint messages_attachment_type_check check(attachment_type is null or attachment_type in ('image','audio'));
create index if not exists messages_conversation_created_idx on public.messages(conversation_id,created_at);
create index if not exists conversation_members_user_idx on public.conversation_members(user_id);
create index if not exists profiles_display_name_idx on public.profiles(display_name);

create or replace function public.is_conversation_member(target_conversation_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.conversation_members cm where cm.conversation_id=target_conversation_id and cm.user_id=auth.uid());
$$;
revoke all on function public.is_conversation_member(uuid) from public;
grant execute on function public.is_conversation_member(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;

drop policy if exists "Authenticated users can search profiles" on public.profiles;
create policy "Authenticated users can search profiles" on public.profiles for select to authenticated using (true);
drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile" on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
drop policy if exists "Members can read conversations" on public.conversations;
create policy "Members can read conversations" on public.conversations for select to authenticated using(public.is_conversation_member(id));
drop policy if exists "Anyone can discover channels" on public.conversations;
create policy "Anyone can discover channels" on public.conversations for select to authenticated using(type='channel');
drop policy if exists "Members can read membership" on public.conversation_members;
create policy "Members can read membership" on public.conversation_members for select to authenticated using(public.is_conversation_member(conversation_id));
drop policy if exists "Members can read messages" on public.messages;
create policy "Members can read messages" on public.messages for select to authenticated using(public.is_conversation_member(conversation_id));
drop policy if exists "Members can send as themselves" on public.messages;
create policy "Members can send as themselves" on public.messages for insert to authenticated with check(sender_id=auth.uid() and public.is_conversation_member(conversation_id));
drop policy if exists "Users can update own messages" on public.messages;
create policy "Users can update own messages" on public.messages for update to authenticated using(sender_id=auth.uid() and public.is_conversation_member(conversation_id)) with check(sender_id=auth.uid() and public.is_conversation_member(conversation_id));
drop policy if exists "Users can delete own messages" on public.messages;
create policy "Users can delete own messages" on public.messages for delete to authenticated using(sender_id=auth.uid() and public.is_conversation_member(conversation_id));

grant select,update on public.profiles to authenticated;
grant select on public.conversations to authenticated;
grant select on public.conversation_members to authenticated;
grant select,insert,delete on public.messages to authenticated;
revoke update on public.messages from authenticated;
grant update(content,edited_at,is_pinned) on public.messages to authenticated;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id,display_name) values(new.id,coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'),''),split_part(coalesce(new.email,''),'@',1),'Пользователь')) on conflict(id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

create or replace function public.create_direct_conversation(target_user_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare caller uuid:=auth.uid(); existing_id uuid; new_id uuid;
begin
  if caller is null then raise exception 'Сначала войдите в аккаунт'; end if;
  if target_user_id is null or target_user_id=caller then raise exception 'Нельзя создать чат с самим собой'; end if;
  if not exists(select 1 from public.profiles p where p.id=target_user_id) then raise exception 'Пользователь не найден'; end if;
  select c.id into existing_id from public.conversations c where c.type='direct'
    and (select count(*) from public.conversation_members cm where cm.conversation_id=c.id)=2
    and exists(select 1 from public.conversation_members a where a.conversation_id=c.id and a.user_id=caller)
    and exists(select 1 from public.conversation_members b where b.conversation_id=c.id and b.user_id=target_user_id) limit 1;
  if existing_id is not null then return existing_id; end if;
  insert into public.conversations(created_by,type) values(caller,'direct') returning id into new_id;
  insert into public.conversation_members(conversation_id,user_id) values(new_id,caller),(new_id,target_user_id);
  return new_id;
end; $$;
revoke all on function public.create_direct_conversation(uuid) from public;
grant execute on function public.create_direct_conversation(uuid) to authenticated;

create or replace function public.create_community_space(space_title text,space_type text,member_ids uuid[] default '{}')
returns uuid language plpgsql security definer set search_path = '' as $$
declare caller uuid:=auth.uid(); new_id uuid; target uuid;
begin
  if caller is null then raise exception 'Сначала войдите в аккаунт'; end if;
  if space_type not in ('group','channel') then raise exception 'Недопустимый тип сообщества'; end if;
  if char_length(trim(space_title))<2 or char_length(trim(space_title))>60 then raise exception 'Название должно содержать от 2 до 60 символов'; end if;
  insert into public.conversations(created_by,type,title) values(caller,space_type,trim(space_title)) returning id into new_id;
  insert into public.conversation_members(conversation_id,user_id) values(new_id,caller);
  if space_type='group' then foreach target in array coalesce(member_ids,'{}') loop
    if target<>caller and exists(select 1 from public.profiles p where p.id=target) then
      insert into public.conversation_members(conversation_id,user_id) values(new_id,target) on conflict do nothing;
    end if;
  end loop; end if;
  return new_id;
end; $$;
revoke all on function public.create_community_space(text,text,uuid[]) from public;
grant execute on function public.create_community_space(text,text,uuid[]) to authenticated;

create or replace function public.join_public_channel(target_channel_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare caller uuid:=auth.uid();
begin
  if caller is null then raise exception 'Сначала войдите в аккаунт'; end if;
  if not exists(select 1 from public.conversations c where c.id=target_channel_id and c.type='channel') then raise exception 'Канал не найден'; end if;
  insert into public.conversation_members(conversation_id,user_id) values(target_channel_id,caller) on conflict do nothing;
end; $$;
revoke all on function public.join_public_channel(uuid) from public;
grant execute on function public.join_public_channel(uuid) to authenticated;

-- Bucket for profile pictures, images and voice messages. Upload is restricted to the user's own folder.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('milchiktg-media','milchiktg-media',true,12582912,array['image/jpeg','image/png','image/webp','image/gif','audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav','video/webm'])
on conflict(id) do update set public=true,file_size_limit=12582912,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists "MilchikTG users upload own images" on storage.objects;
drop policy if exists "MilchikTG users upload own media" on storage.objects;
create policy "MilchikTG users upload own media" on storage.objects for insert to authenticated with check(bucket_id='milchiktg-media' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists "MilchikTG users update own media" on storage.objects;
create policy "MilchikTG users update own media" on storage.objects for update to authenticated using(bucket_id='milchiktg-media' and (storage.foldername(name))[1]=auth.uid()::text) with check(bucket_id='milchiktg-media' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists "MilchikTG users delete own media" on storage.objects;
create policy "MilchikTG users delete own media" on storage.objects for delete to authenticated using(bucket_id='milchiktg-media' and (storage.foldername(name))[1]=auth.uid()::text);

do $$ begin alter publication supabase_realtime add table public.messages; exception when duplicate_object then null; when undefined_object then raise notice 'Enable Realtime for messages in Supabase Dashboard.'; end $$;
do $$ begin alter publication supabase_realtime add table public.conversation_members; exception when duplicate_object then null; when undefined_object then raise notice 'Enable Realtime for conversation_members in Supabase Dashboard.'; end $$;

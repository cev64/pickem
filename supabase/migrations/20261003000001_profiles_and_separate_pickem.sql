-- Profiles get a unique @username and a photo; the "for fun" board is split
-- from pick'em.
--
-- Before: every pick on the board was also your pick'em entry.
-- After:  the board (picks, playoff picks, coin flips) lives in boards and
--         never counts anywhere; public.picks holds only pick'em entries,
--         which you add a week at a time from the Games tab.

/* ----------------------------------------------------------------
   USERNAMES AND PHOTOS
   ---------------------------------------------------------------- */
alter table public.profiles
  add column username    text,
  add column avatar_path text;

-- a free username built from a name or email: lowercase letters, digits, _
create function private.make_username(seed text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  base text := left(regexp_replace(lower(coalesce(seed, '')), '[^a-z0-9_]', '', 'g'), 15);
  candidate text;
begin
  if char_length(base) < 3 then base := 'player'; end if;
  candidate := base;
  while exists (select 1 from public.profiles where lower(username) = candidate) loop
    candidate := base || (1000 + floor(random() * 9000))::int;
  end loop;
  return candidate;
end;
$$;

update public.profiles set username = private.make_username(display_name) where username is null;

alter table public.profiles
  alter column username set not null,
  add constraint profiles_username_format check (username ~ '^[a-z0-9_]{3,20}$'),
  -- photos live in the avatars bucket under the owner's own folder
  add constraint profiles_avatar_path_own check (
    avatar_path is null or avatar_path ~ ('^' || id::text || '/[0-9]{10,16}\.(webp|jpg|png)$'));
create unique index profiles_username_key on public.profiles (lower(username));

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  name text := left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
                             split_part(new.email, '@', 1),
                             'Player'), 40);
begin
  insert into public.profiles (id, display_name, username)
  values (new.id, name, private.make_username(coalesce(nullif(name, 'Player'), split_part(new.email, '@', 1))));
  return new;
end;
$$;

-- users may change only these columns of their own profile
revoke update on public.profiles from anon, authenticated;
grant update (display_name, username, avatar_path) on public.profiles to authenticated;

create function public.username_available(name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1 from public.profiles
    where lower(username) = lower(btrim(name)) and id <> (select auth.uid())
  );
$$;
revoke execute on function public.username_available(text) from public, anon;
grant execute on function public.username_available(text) to authenticated;

/* photo storage: public to view, each user writes only their own folder */
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 1048576, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

create policy "avatars: read own folder" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "avatars: upload to own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "avatars: replace in own folder" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "avatars: delete from own folder" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

/* ----------------------------------------------------------------
   BOARD PICKS MOVE INTO boards; picks = pick'em entries only
   ---------------------------------------------------------------- */
alter table public.boards add column picks jsonb not null default '{}'::jsonb;

-- copy what everyone had picked onto their board (keys: index into SCHEDULE)
insert into public.boards (user_id, picks)
select user_id, jsonb_object_agg((game_id - 2026000)::text, pick)
from public.picks
where game_id between 2026000 and 2026999
group by user_id
on conflict (user_id) do update set picks = excluded.picks || public.boards.picks;

comment on table public.picks is
  'Pick''em entries: added a week at a time from the Games tab, locked at kickoff, graded on group leaderboards. The "for fun" board lives in boards.';

/* ----------------------------------------------------------------
   LEADERBOARD: now with usernames and photos. A new name, so copies of the
   app still cached on phones keep working with group_leaderboard.
   ---------------------------------------------------------------- */
create function public.group_standings(gid uuid)
returns table (user_id uuid, display_name text, username text, avatar_path text,
               week smallint, picked integer, graded integer, correct integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_group_member(gid) then
    raise exception 'Not a member of this group' using errcode = '42501';
  end if;
  return query
    select m.user_id, pr.display_name, pr.username, pr.avatar_path, g.week,
           count(p.game_id)::integer,
           count(p.game_id) filter (where g.status = 'post' and g.winner is not null)::integer,
           count(p.game_id) filter (where g.status = 'post' and g.winner = p.pick)::integer
    from public.group_members m
    join public.groups gr on gr.id = m.group_id
    join public.profiles pr on pr.id = m.user_id
    left join public.picks p on p.user_id = m.user_id
    left join public.games g on g.id = p.game_id and g.season = gr.season
    where m.group_id = gid
    group by m.user_id, pr.display_name, pr.username, pr.avatar_path, g.week;
end;
$$;
revoke execute on function public.group_standings(uuid) from public, anon;
grant execute on function public.group_standings(uuid) to authenticated;

-- Bracketeer: accounts, synced picks, saved brackets and pick'em groups.
--
-- Game ids are SEASON * 1000 + the game's index in the app's SCHEDULE array
-- (2026000 .. 2026271), so a later season can live alongside this one.

create schema if not exists private;

/* ----------------------------------------------------------------
   PROFILES — one per auth user, created by trigger on sign-up
   ---------------------------------------------------------------- */
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
  created_at   timestamptz not null default now()
);

create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
                  split_part(new.email, '@', 1),
                  'Player'), 40)
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

/* ----------------------------------------------------------------
   GAMES — the schedule plus results, kept fresh by the sync-results
   edge function. Read-only to clients.
   ---------------------------------------------------------------- */
create table public.games (
  id          integer primary key,
  season      smallint not null default 2026,
  week        smallint not null check (week between 1 and 18),
  away        text not null,
  home        text not null,
  kickoff     timestamptz,
  status      text not null default 'pre' check (status in ('pre', 'in', 'post')),
  away_score  smallint,
  home_score  smallint,
  winner      text check (winner in ('a', 'h', 't')),
  updated_at  timestamptz not null default now(),
  unique (season, week, away, home)
);
create index games_season_week_idx on public.games (season, week);

-- a game takes picks until kickoff (or until it's under way, if the kickoff
-- time was never published)
create function private.game_open(gid integer)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.games g
    where g.id = gid
      and g.status = 'pre'
      and (g.kickoff is null or g.kickoff > now())
  );
$$;

/* ----------------------------------------------------------------
   PICKS — one pick per user per game, shared by every group they're in
   ---------------------------------------------------------------- */
create table public.picks (
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  game_id    integer not null references public.games (id) on delete cascade,
  pick       text not null check (pick in ('a', 'h', 't')),
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id)
);
create index picks_game_idx on public.picks (game_id);

/* BOARDS — the rest of a user's board (playoff bracket picks and coin flips) */
create table public.boards (
  user_id    uuid primary key default auth.uid() references public.profiles (id) on delete cascade,
  po         jsonb not null default '{}'::jsonb,
  flips      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

/* BRACKETS — named snapshots of a whole board */
create table public.brackets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  season     smallint not null default 2026,
  name       text not null check (char_length(btrim(name)) between 1 and 60),
  champion   text,
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index brackets_user_idx on public.brackets (user_id, created_at desc);

/* ----------------------------------------------------------------
   GROUPS — friends' pick'em leagues, joined with an invite code
   ---------------------------------------------------------------- */
create function private.invite_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- no 0/O, 1/I
  bytes bytea := extensions.gen_random_bytes(10);
  code text := '';
begin
  for i in 0..9 loop
    code := code || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  return code;
end;
$$;

create table public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 50),
  season      smallint not null default 2026,
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  invite_code text not null unique default private.invite_code(),
  created_at  timestamptz not null default now()
);
create index groups_owner_idx on public.groups (owner_id);

create table public.group_members (
  group_id  uuid not null references public.groups (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  role      text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_members_user_idx on public.group_members (user_id);

create function private.is_group_member(gid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.group_members m
    where m.group_id = gid and m.user_id = (select auth.uid())
  );
$$;

create function private.shares_group_with(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_members a
    join public.group_members b on b.group_id = a.group_id
    where a.user_id = (select auth.uid()) and b.user_id = uid
  );
$$;

grant usage on schema private to authenticated, anon;
revoke all on all functions in schema private from public;
grant execute on function private.game_open(integer)       to authenticated;
grant execute on function private.is_group_member(uuid)    to authenticated;
grant execute on function private.shares_group_with(uuid)  to authenticated;

/* ----------------------------------------------------------------
   ROW LEVEL SECURITY
   ---------------------------------------------------------------- */
alter table public.profiles      enable row level security;
alter table public.games         enable row level security;
alter table public.picks         enable row level security;
alter table public.boards        enable row level security;
alter table public.brackets      enable row level security;
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;

-- profiles: yourself, and anyone you share a group with
create policy "profiles: read self and groupmates" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or private.shares_group_with(id));
create policy "profiles: update self" on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- games: public schedule
create policy "games: anyone can read" on public.games
  for select to anon, authenticated using (true);

-- picks: read yours and your groupmates'; write yours until kickoff
create policy "picks: read self and groupmates" on public.picks
  for select to authenticated
  using (user_id = (select auth.uid()) or private.shares_group_with(user_id));
create policy "picks: insert own before kickoff" on public.picks
  for insert to authenticated
  with check (user_id = (select auth.uid()) and private.game_open(game_id));
create policy "picks: update own before kickoff" on public.picks
  for update to authenticated
  using (user_id = (select auth.uid()) and private.game_open(game_id))
  with check (user_id = (select auth.uid()) and private.game_open(game_id));
create policy "picks: delete own before kickoff" on public.picks
  for delete to authenticated
  using (user_id = (select auth.uid()) and private.game_open(game_id));

-- boards and brackets: private to their owner
create policy "boards: own" on public.boards
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "brackets: own" on public.brackets
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- groups and memberships: visible to members; changed only through the
-- functions below
create policy "groups: members read" on public.groups
  for select to authenticated using (private.is_group_member(id));
create policy "group_members: members read" on public.group_members
  for select to authenticated using (private.is_group_member(group_id));

/* keep updated_at honest */
create function private.touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger picks_touch    before update on public.picks    for each row execute function private.touch();
create trigger boards_touch   before update on public.boards   for each row execute function private.touch();
create trigger brackets_touch before update on public.brackets for each row execute function private.touch();

/* ----------------------------------------------------------------
   GROUP FUNCTIONS (called with supabase.rpc)
   ---------------------------------------------------------------- */
create function public.create_group(group_name text)
returns public.groups
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  g public.groups;
begin
  if me is null then raise exception 'Sign in to create a group' using errcode = '28000'; end if;
  insert into public.groups (name, owner_id) values (btrim(group_name), me) returning * into g;
  insert into public.group_members (group_id, user_id, role) values (g.id, me, 'owner');
  return g;
end;
$$;

-- what an invite link shows before you join (works signed out too)
create function public.group_invite_preview(code text)
returns table (group_id uuid, name text, owner_name text, member_count bigint, is_member boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select g.id, g.name, p.display_name,
         (select count(*) from public.group_members m where m.group_id = g.id),
         exists (select 1 from public.group_members m
                 where m.group_id = g.id and m.user_id = (select auth.uid()))
  from public.groups g
  join public.profiles p on p.id = g.owner_id
  where g.invite_code = upper(btrim(code));
$$;

create function public.join_group(code text)
returns public.groups
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  g public.groups;
begin
  if me is null then raise exception 'Sign in to join a group' using errcode = '28000'; end if;
  select * into g from public.groups where invite_code = upper(btrim(code));
  if not found then raise exception 'That invite link is not valid any more' using errcode = 'P0002'; end if;
  if (select count(*) from public.group_members where group_id = g.id) >= 200 then
    raise exception 'This group is full';
  end if;
  insert into public.group_members (group_id, user_id) values (g.id, me)
  on conflict do nothing;
  return g;
end;
$$;

-- leave a group; an owner leaving hands it to the longest-standing member,
-- and the last one out deletes it
create function public.leave_group(gid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  heir uuid;
begin
  delete from public.group_members where group_id = gid and user_id = me;
  if not found then return; end if;
  if (select owner_id from public.groups where id = gid) = me then
    select user_id into heir from public.group_members
      where group_id = gid order by joined_at, user_id limit 1;
    if heir is null then
      delete from public.groups where id = gid;
    else
      update public.groups set owner_id = heir where id = gid;
      update public.group_members set role = 'owner' where group_id = gid and user_id = heir;
    end if;
  end if;
end;
$$;

create function public.remove_group_member(gid uuid, member uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select owner_id from public.groups where id = gid) is distinct from auth.uid() then
    raise exception 'Only the group owner can remove members' using errcode = '42501';
  end if;
  if member = auth.uid() then
    raise exception 'Use leave_group to leave your own group';
  end if;
  delete from public.group_members where group_id = gid and user_id = member;
end;
$$;

create function public.rename_group(gid uuid, group_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.groups set name = btrim(group_name)
  where id = gid and owner_id = auth.uid();
  if not found then
    raise exception 'Only the group owner can rename it' using errcode = '42501';
  end if;
end;
$$;

-- a fresh invite code; old links stop working
create function public.reset_group_invite(gid uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  code text;
begin
  update public.groups set invite_code = private.invite_code()
  where id = gid and owner_id = auth.uid()
  returning invite_code into code;
  if code is null then
    raise exception 'Only the group owner can reset the invite link' using errcode = '42501';
  end if;
  return code;
end;
$$;

-- every member's picks for one week of the group's season
create function public.group_week_picks(gid uuid, wk integer)
returns table (user_id uuid, game_id integer, pick text)
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
    select p.user_id, p.game_id, p.pick
    from public.group_members m
    join public.groups gr on gr.id = m.group_id
    join public.picks p on p.user_id = m.user_id
    join public.games g on g.id = p.game_id and g.season = gr.season and g.week = wk
    where m.group_id = gid;
end;
$$;

-- per-member, per-week results for the leaderboard: picks made, picks graded
-- (game final) and picks right
create function public.group_leaderboard(gid uuid)
returns table (user_id uuid, display_name text, week smallint, picked integer, graded integer, correct integer)
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
    select m.user_id, pr.display_name, g.week,
           count(p.game_id)::integer,
           count(p.game_id) filter (where g.status = 'post' and g.winner is not null)::integer,
           count(p.game_id) filter (where g.status = 'post' and g.winner = p.pick)::integer
    from public.group_members m
    join public.groups gr on gr.id = m.group_id
    join public.profiles pr on pr.id = m.user_id
    left join public.picks p on p.user_id = m.user_id
    left join public.games g on g.id = p.game_id and g.season = gr.season
    where m.group_id = gid
    group by m.user_id, pr.display_name, g.week;
end;
$$;

/* results sync — service role only (the sync-results edge function) */
create function public.sync_results(payload jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  yr smallint := coalesce((payload ->> 'season')::smallint, 2026);
  r jsonb;
  swap boolean;
  n integer := 0;
begin
  for r in select * from jsonb_array_elements(payload -> 'games') loop
    swap := not exists (select 1 from public.games
                        where season = yr and week = (r ->> 'w')::smallint
                          and away = r ->> 'a' and home = r ->> 'h');
    update public.games g set
      kickoff    = coalesce((r ->> 'kick')::timestamptz, g.kickoff),
      status     = coalesce(r ->> 'st', g.status),
      away_score = case when swap then (r ->> 'hs')::smallint else (r ->> 'as')::smallint end,
      home_score = case when swap then (r ->> 'as')::smallint else (r ->> 'hs')::smallint end,
      winner     = case when not swap then r ->> 'win'
                        when r ->> 'win' = 'a' then 'h'
                        when r ->> 'win' = 'h' then 'a'
                        else r ->> 'win' end,
      updated_at = now()
    where g.season = yr and g.week = (r ->> 'w')::smallint
      and ((not swap and g.away = r ->> 'a' and g.home = r ->> 'h')
        or (swap and g.away = r ->> 'h' and g.home = r ->> 'a'))
      and (g.kickoff, g.status, g.away_score, g.home_score, g.winner)
          is distinct from (
            coalesce((r ->> 'kick')::timestamptz, g.kickoff),
            coalesce(r ->> 'st', g.status),
            case when swap then (r ->> 'hs')::smallint else (r ->> 'as')::smallint end,
            case when swap then (r ->> 'as')::smallint else (r ->> 'hs')::smallint end,
            case when not swap then r ->> 'win'
                 when r ->> 'win' = 'a' then 'h'
                 when r ->> 'win' = 'h' then 'a'
                 else r ->> 'win' end);
    if found then n := n + 1; end if;
  end loop;
  return n;
end;
$$;

-- functions are executable by PUBLIC by default; open up only what's meant to be
revoke execute on function public.create_group(text), public.group_invite_preview(text),
  public.join_group(text), public.leave_group(uuid), public.remove_group_member(uuid, uuid),
  public.rename_group(uuid, text), public.reset_group_invite(uuid),
  public.group_week_picks(uuid, integer), public.group_leaderboard(uuid),
  public.sync_results(jsonb)
  from public, anon, authenticated;
grant execute on function public.create_group(text), public.join_group(text),
  public.leave_group(uuid), public.remove_group_member(uuid, uuid),
  public.rename_group(uuid, text), public.reset_group_invite(uuid),
  public.group_week_picks(uuid, integer), public.group_leaderboard(uuid)
  to authenticated;
grant execute on function public.group_invite_preview(text) to anon, authenticated;
grant execute on function public.sync_results(jsonb) to service_role;

/* Bracketeer accounts — sign-in, picks synced across devices, saved brackets
   and pick'em groups, backed by Supabase (project "Bracketeer"; schema in
   supabase/migrations).

   Loaded after index.html's main script and built on its globals (S, GAMES,
   byWeek, TEAMS, VIEW, HOOKS, render, renderWeek, showTab, isLocked, toast,
   ask, esc, logo, ...). All of it is optional: offline or signed out, the
   board works exactly as before. */
(() => {
'use strict';

const SUPABASE_URL = 'https://zvsldzvialssswvvmkgk.supabase.co';
const SUPABASE_KEY = 'sb_publishable_xz4G8IxLg4kPBVF1AD3rDA_cxRYDzdM';   // public by design; RLS guards the data
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js';
const SITE = 'https://bracketeersports.com/';
const SEASON = 2026;
const gid = i => SEASON * 1000 + i;      // a game's id on the server
const gix = id => id - SEASON * 1000;    // ...and back to its index in GAMES

const LS = {
  get(k){ try{ return JSON.parse(localStorage.getItem(k)); }catch(e){ return null; } },
  set(k, v){ try{ v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
};
const SYNC_KEY  = 'bracketeer.sync.v1';    // {uid, base:{gi:pick} as last seen on the server, board:json}
const GROUP_KEY = 'bracketeer.group.v1';   // the group whose picks show on the Games tab
const JOIN_KEY  = 'bracketeer.join.v1';    // invite code waiting for sign-in
const CTA_KEY   = 'bracketeer.cta.v1';     // signed-out nudge dismissed

let sb = null;           // Supabase client, once the SDK has loaded
let user = null;         // signed-in auth user
let profile = null;      // {id, display_name}
let groups = [];         // [{id, name, owner_id, invite_code, n}]
let groupsLoaded = false;
let active = LS.get(GROUP_KEY);
const detail = {};       // group id -> {members:[{id,name}], by:{uid:{name, c, g, p, wk:{w:{c,g,p}}}}}
let lbWeek = null;       // week shown in the leaderboard's weekly column
let ready = false;       // board pulled from the account; safe to push
const openStats = new Set();   // games whose "who picked what" list is expanded

const groupById = id => groups.find(g => g.id === id);
const inviteLink = g => `${SITE}?join=${g.invite_code}`;
const errText = e => (e && (e.message || e.error_description)) || 'Something went wrong. Try again.';

/* ==========================================================
   AVATARS
   ========================================================== */
function hue(s){ let h = 0; for(const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
const avatar = (name, id) =>
  `<span class="av" style="--c:hsl(${hue(id || name)} 52% 42%)" aria-hidden="true">${esc((name || '?').trim().charAt(0) || '?')}</span>`;

/* ==========================================================
   SHEET (forms: sign in, account, groups, brackets)
   ========================================================== */
const sheet = $('#sheet2'), sheetBody = $('#s2Sheet');
function openSheet(html){
  sheetBody.innerHTML = `<button class="x" type="button" data-close aria-label="Close">×</button>${html}`;
  sheet.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add('open')));
  const f = sheetBody.querySelector('input:not([readonly]),button.primary');
  if(f) setTimeout(() => f.focus({preventScroll:true}), 60);
  return sheetBody;
}
function closeSheet(){
  sheet.classList.remove('open');
  setTimeout(() => { if(!sheet.classList.contains('open')) sheet.hidden = true; }, 320);
}
sheet.addEventListener('click', e => { if(e.target === sheet || e.target.closest('[data-close]')) closeSheet(); });
document.addEventListener('keydown', e => {
  if(e.key === 'Escape' && !sheet.hidden && $('#modal').hidden) closeSheet();
});
function setMsg(box, text, kind){
  const m = box.querySelector('.msg'); if(!m) return;
  m.textContent = text || ''; m.className = 'msg' + (kind ? ' ' + kind : '');
}
function busy(form, on){ form.querySelectorAll('button,input').forEach(el => el.disabled = on); }

/* ==========================================================
   SIGN IN / CREATE ACCOUNT
   ========================================================== */
function authSheet(mode = 'in', note = ''){
  if(!sb){ toast('You’re offline. Connect to sign in.'); return; }
  const up = mode === 'up', link = mode === 'link';
  const box = openSheet(`
    <h4 id="s2Title">${link ? 'Email me a sign-in link' : up ? 'Create your account' : 'Sign in'}</h4>
    ${note ? `<p>${note}</p>` : ''}
    ${link ? '' : `<div class="seg2" role="group">
      <button type="button" data-mode="in" aria-pressed="${!up}">Sign in</button>
      <button type="button" data-mode="up" aria-pressed="${up}">Create account</button></div>`}
    <form novalidate>
      ${up ? `<label>Your name <input type="text" name="nm" maxlength="40" autocomplete="nickname" placeholder="What your friends call you" required></label>` : ''}
      <label>Email <input type="email" name="email" autocomplete="email" required></label>
      ${link ? '' : `<label>Password <input type="password" name="password" minlength="6" autocomplete="${up ? 'new-password' : 'current-password'}" required></label>`}
      <p class="msg" role="status"></p>
      <button class="btn primary" type="submit">${link ? 'Send link' : up ? 'Create account' : 'Sign in'}</button>
    </form>
    <p class="alt">${link ? '<button type="button" class="linkbtn" data-mode="in">Sign in with a password</button>'
      : up ? 'Picks you’ve made on this device come with you.'
      : '<button type="button" class="linkbtn" data-mode="link">Forgot your password? Email me a link</button>'}</p>`);
  box.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
    const email = box.querySelector('[name=email]').value;
    authSheet(b.dataset.mode, note);
    sheetBody.querySelector('[name=email]').value = email;
  }));
  const form = box.querySelector('form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const v = n => (form.querySelector(`[name=${n}]`) || {}).value || '';
    const email = v('email').trim(), pw = v('password'), name = v('nm').trim();
    if(!/^\S+@\S+\.\S+$/.test(email)) return setMsg(box, 'Enter your email address.', 'err');
    if(up && !name) return setMsg(box, 'Enter your name.', 'err');
    if(!link && pw.length < 6) return setMsg(box, 'Passwords need at least 6 characters.', 'err');
    busy(form, true); setMsg(box, '');
    const redirect = location.origin + location.pathname;
    try{
      if(link){
        const {error} = await sb.auth.signInWithOtp({email, options:{emailRedirectTo: redirect, shouldCreateUser: false}});
        if(error) throw error;
        setMsg(box, `Check ${email} for your sign-in link.`, 'ok');
      }else if(up){
        const {data, error} = await sb.auth.signUp({email, password: pw,
          options:{data:{display_name: name}, emailRedirectTo: redirect}});
        if(error) throw error;
        if(data.session){ closeSheet(); toast(`Welcome, ${name}!`); }
        else setMsg(box, `Almost there: open the link we sent to ${email} to finish.`, 'ok');
      }else{
        const {error} = await sb.auth.signInWithPassword({email, password: pw});
        if(error) throw error;
        closeSheet();
      }
    }catch(err){
      setMsg(box, /invalid login/i.test(errText(err)) ? 'That email and password don’t match.' : errText(err), 'err');
    }finally{ busy(form, false); }
  });
}

function accountSheet(){
  const box = openSheet(`
    <h4 id="s2Title">Your account</h4>
    <p>${esc(user.email || '')}</p>
    <form data-f="name">
      <label>Display name <input type="text" name="nm" maxlength="40" value="${esc(profile ? profile.display_name : '')}"></label>
      <label>New password <input type="password" name="password" minlength="6" autocomplete="new-password" placeholder="Leave blank to keep it"></label>
      <p class="msg" role="status"></p>
      <div class="mact"><button class="btn danger" type="button" data-out>Sign out</button><button class="btn primary" type="submit">Save</button></div>
    </form>`);
  const form = box.querySelector('form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = form.nm.value.trim(), pw = form.password.value;
    if(!name) return setMsg(box, 'Your name can’t be blank.', 'err');
    if(pw && pw.length < 6) return setMsg(box, 'Passwords need at least 6 characters.', 'err');
    busy(form, true);
    try{
      if(!profile || name !== profile.display_name){
        const {error} = await sb.from('profiles').update({display_name: name}).eq('id', user.id);
        if(error) throw error;
        profile = Object.assign({}, profile, {display_name: name});
        for(const id in detail) delete detail[id];
      }
      if(pw){ const {error} = await sb.auth.updateUser({password: pw}); if(error) throw error; }
      closeSheet(); toast('Saved.'); paint();
    }catch(err){ setMsg(box, errText(err), 'err'); }
    finally{ busy(form, false); }
  });
  box.querySelector('[data-out]').addEventListener('click', async () => {
    closeSheet();
    await sb.auth.signOut();
    toast('Signed out. Your picks stay on this device.');
  });
}

$('#btnAccount').addEventListener('click', () => user ? accountSheet() : authSheet('in'));
function paintAccountBtn(){
  const b = $('#btnAccount');
  b.hidden = !sb;
  b.classList.toggle('in', !!user);
  b.innerHTML = user
    ? `${avatar(profile && profile.display_name || user.email, user.id)}<span class="nm">${esc(profile ? profile.display_name : 'Account')}</span>`
    : 'Sign in';
  b.setAttribute('aria-label', user ? 'Your account' : 'Sign in');
}

/* ==========================================================
   PICK SYNC
   The device keeps the board as always; signed in, it's mirrored to the
   account. SYNC_KEY remembers what the server had at the last sync, so
   edits made offline (or on another device) merge instead of clobbering.
   ========================================================== */
async function pullBoard(){
  const [picks, board] = await Promise.all([
    sb.from('picks').select('game_id,pick').eq('user_id', user.id).gte('game_id', gid(0)).lt('game_id', gid(1000)),
    sb.from('boards').select('po,flips').eq('user_id', user.id).maybeSingle()
  ]);
  if(picks.error) throw picks.error;
  if(board.error) throw board.error;

  // worked out after the fetch, so picks made while it was in flight count
  const sync = LS.get(SYNC_KEY);
  const first = !sync || sync.uid !== user.id;    // first sign-in on this device
  const base = first ? {} : (sync.base || {});
  const pending = {};                             // local edits not yet on the server
  for(const gi in S.picks) if(first || base[gi] !== S.picks[gi]) pending[gi] = S.picks[gi];
  if(!first) for(const gi in base) if(!(gi in S.picks)) pending[gi] = null;

  const server = {};
  picks.data.forEach(r => { server[gix(r.game_id)] = r.pick; });
  const next = Object.assign({}, server);
  for(const gi in pending){
    if(isLocked(+gi)) continue;                    // kicked off: the account's pick stands
    if(first && gi in server) continue;            // new device: the account's picks win
    if(pending[gi] == null) delete next[gi]; else next[gi] = pending[gi];
  }
  S.picks = next;

  const localBoard = JSON.stringify({po: S.po, flips: S.flips});
  const localDirty = first ? !board.data : localBoard !== sync.board;
  if(board.data && !localDirty){ S.po = board.data.po || {}; S.flips = board.data.flips || {}; }
  LS.set(SYNC_KEY, {uid: user.id, base: server,
    board: board.data ? JSON.stringify({po: board.data.po || {}, flips: board.data.flips || {}}) : null});
}

let pushT = 0, pushing = false, pushAgain = false;
function schedulePush(){ if(!ready || !user) return; clearTimeout(pushT); pushT = setTimeout(push, 600); }
async function push(){
  if(!ready || !user) return;
  if(pushing){ pushAgain = true; return; }
  pushing = true;
  const uid = user.id;
  try{
    const sync = LS.get(SYNC_KEY) || {uid, base: {}};
    const base = sync.base || {};
    const ups = [], dels = [];
    for(const gi in S.picks) if(base[gi] !== S.picks[gi] && !isLocked(+gi)) ups.push({user_id: uid, game_id: gid(+gi), pick: S.picks[gi]});
    for(const gi in base) if(!(gi in S.picks) && !isLocked(+gi)) dels.push(gid(+gi));
    let reverted = false;
    if(ups.length){
      const {error} = await sb.from('picks').upsert(ups, {onConflict: 'user_id,game_id'});
      if(!error) ups.forEach(u => { base[gix(u.game_id)] = u.pick; });
      else if(error.code === '42501'){
        // a game kicked off before this got through: save the rest one by one,
        // and put the locked ones back to what the account has
        for(const u of ups){
          const r = await sb.from('picks').upsert(u, {onConflict: 'user_id,game_id'});
          const gi = gix(u.game_id);
          if(!r.error) base[gi] = u.pick;
          else if(r.error.code === '42501'){
            if(gi in base) S.picks[gi] = base[gi]; else delete S.picks[gi];
            reverted = true;
          }
        }
      }else throw error;
    }
    if(dels.length){
      const {error} = await sb.from('picks').delete().eq('user_id', uid).in('game_id', dels);
      if(error) throw error;
      dels.forEach(id => { delete base[gix(id)]; });
    }
    const bj = JSON.stringify({po: S.po, flips: S.flips});
    if(bj !== sync.board){
      const {error} = await sb.from('boards').upsert({user_id: uid, po: S.po, flips: S.flips});
      if(error) throw error;
      sync.board = bj;
    }
    if(user && user.id === uid) LS.set(SYNC_KEY, {uid, base, board: sync.board});
    if(reverted){ toast('That game has kicked off, so its pick is locked.'); render(); }
  }catch(e){
    // offline or a blip: whatever didn't make it goes with the next change or reconnect
  }finally{
    pushing = false;
    if(pushAgain){ pushAgain = false; schedulePush(); }
  }
}
HOOKS.changed = schedulePush;

let lastPull = 0;
async function resync(){
  if(!user || pushing || Date.now() - lastPull < 30e3) return;
  lastPull = Date.now();
  try{
    ready = false;
    await pullBoard();
    ready = true;
    render();
    gp.key = null;
    if(curTab === 'groups' && active) loadDetail(active, true);
  }catch(e){ ready = true; }
}
document.addEventListener('visibilitychange', () => { if(!document.hidden) resync(); });
window.addEventListener('online', () => { lastPull = 0; resync(); });

/* ==========================================================
   GROUPS
   ========================================================== */
async function loadGroups(){
  const {data, error} = await sb.from('groups')
    .select('id,name,owner_id,invite_code,created_at,group_members(count)')
    .order('created_at');
  if(error) throw error;
  groups = data.map(g => ({id: g.id, name: g.name, owner_id: g.owner_id, invite_code: g.invite_code,
    n: (g.group_members && g.group_members[0] && g.group_members[0].count) || 1}));
  groupsLoaded = true;
  if(!groupById(active)) setActive(groups.length ? groups[0].id : null, true);
}
function setActive(id, quiet){
  active = id; LS.set(GROUP_KEY, id);
  gp.key = null; openStats.clear();
  if(!quiet){ renderWeek(); paintGroups(); if(id) loadDetail(id); }
}

// members and leaderboard for one group (the leaderboard lists every member)
async function loadDetail(id, force){
  if(detail[id] && !force && !detail[id].stale) return detail[id];
  const {data, error} = await sb.rpc('group_leaderboard', {gid: id});
  if(error){ toast(errText(error)); return null; }
  const by = {};
  data.forEach(r => {
    const m = by[r.user_id] || (by[r.user_id] = {id: r.user_id, name: r.display_name, c: 0, g: 0, p: 0, wk: {}});
    if(r.week == null) return;
    m.wk[r.week] = {c: r.correct, g: r.graded, p: r.picked};
    m.c += r.correct; m.g += r.graded; m.p += r.picked;
  });
  const members = Object.values(by).sort((a, b) => a.name.localeCompare(b.name));
  detail[id] = {members, by};
  const g = groupById(id); if(g) g.n = members.length;
  if(curTab === 'groups') paintGroups();
  if(id === active) renderWeek();
  return detail[id];
}

async function createGroupSheet(){
  if(!user) return authSheet('up', 'Create an account to start a pick’em group.');
  const box = openSheet(`
    <h4 id="s2Title">New pick’em group</h4>
    <p>You’ll get an invite link to send your friends.</p>
    <form><label>Group name <input type="text" name="nm" maxlength="50" placeholder="Sunday Squad" required></label>
      <p class="msg" role="status"></p>
      <button class="btn primary" type="submit">Create group</button></form>`);
  const form = box.querySelector('form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = form.nm.value.trim();
    if(!name) return setMsg(box, 'Give your group a name.', 'err');
    busy(form, true);
    const {data, error} = await sb.rpc('create_group', {group_name: name});
    busy(form, false);
    if(error) return setMsg(box, errText(error), 'err');
    groups.push({id: data.id, name: data.name, owner_id: data.owner_id, invite_code: data.invite_code, n: 1});
    closeSheet();
    setActive(data.id);
    showTab('groups', true);
    inviteSheet(groupById(data.id), true);
  });
}

function inviteSheet(g, fresh){
  const link = inviteLink(g);
  const box = openSheet(`
    <h4 id="s2Title">${fresh ? `${esc(g.name)} is ready` : `Invite friends to ${esc(g.name)}`}</h4>
    <p>Anyone with this link can join the group and see everyone’s picks.</p>
    <div class="invite"><input type="text" readonly value="${esc(link)}" aria-label="Invite link">
      <button class="btn primary" type="button" data-copy>Copy</button>
      ${navigator.share ? '<button class="btn" type="button" data-share>Share</button>' : ''}</div>`);
  wireInvite(box, g);
}
function wireInvite(box, g){
  const link = inviteLink(g);
  const c = box.querySelector('[data-copy]'), s = box.querySelector('[data-share]');
  if(c) c.addEventListener('click', async () => {
    try{ await navigator.clipboard.writeText(link); toast('Invite link copied.'); }
    catch(e){ const i = box.querySelector('.invite input'); i.select(); document.execCommand && document.execCommand('copy'); toast('Invite link copied.'); }
  });
  if(s) s.addEventListener('click', () => navigator.share({
    title: `Join ${g.name} on Bracketeer`,
    text: `Join my NFL pick’em group “${g.name}” on Bracketeer`, url: link}).catch(() => {}));
}

function codeFrom(text){
  const t = String(text || '').trim();
  const m = t.match(/[?&]join=([A-Za-z0-9]+)/);
  return (m ? m[1] : t.replace(/[^A-Za-z0-9]/g, '')).toUpperCase();
}
function joinCodeSheet(){
  if(!user) return authSheet('in', 'Sign in to join a group.');
  const box = openSheet(`
    <h4 id="s2Title">Join a group</h4>
    <p>Paste the invite link (or code) a friend sent you.</p>
    <form><label>Invite link or code <input type="text" name="code" autocomplete="off" autocapitalize="characters" required></label>
      <p class="msg" role="status"></p>
      <button class="btn primary" type="submit">Join</button></form>`);
  const form = box.querySelector('form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const code = codeFrom(form.code.value);
    if(code.length < 6) return setMsg(box, 'That doesn’t look like an invite link.', 'err');
    busy(form, true);
    const ok = await joinGroup(code, box);
    busy(form, false);
    if(ok) closeSheet();
  });
}
async function joinGroup(code, box){
  const {data, error} = await sb.rpc('join_group', {code});
  if(error){ box ? setMsg(box, errText(error), 'err') : toast(errText(error)); return false; }
  LS.set(JOIN_KEY, null);
  await loadGroups().catch(() => {});
  setActive(data.id);
  showTab('groups', true);
  toast(`You’re in ${data.name}. Your picks now count on its leaderboard.`);
  return true;
}

// someone opened an invite link
async function invitePrompt(code){
  const {data, error} = await sb.rpc('group_invite_preview', {code});
  const g = !error && data && data[0];
  if(!g){ LS.set(JOIN_KEY, null); toast('That invite link isn’t valid any more.'); return; }
  if(g.is_member){ LS.set(JOIN_KEY, null); setActive(g.group_id); showTab('groups', true); toast(`You’re already in ${g.name}.`); return; }
  if(user) LS.set(JOIN_KEY, null);   // signed in: they decide right here
  const n = Number(g.member_count);
  const box = openSheet(`
    <h4 id="s2Title">Join ${esc(g.name)}</h4>
    <p>${esc(g.owner_name)} invited you to their NFL pick’em group (${n} member${n === 1 ? '' : 's'}).
      Pick every game each week and see how you stack up.</p>
    <div class="mact">
      ${user ? '<button class="btn primary" type="button" data-join>Join group</button>'
        : '<button class="btn" type="button" data-in>Sign in</button><button class="btn primary" type="button" data-up>Create account</button>'}
    </div>
    <p class="msg" role="status"></p>`);
  const j = box.querySelector('[data-join]');
  if(j) j.addEventListener('click', async () => { j.disabled = true; if(await joinGroup(code, box)) closeSheet(); else j.disabled = false; });
  const note = `Then you’ll join <b>${esc(g.name)}</b>.`;
  const i = box.querySelector('[data-in]'), u = box.querySelector('[data-up]');
  if(i) i.addEventListener('click', () => authSheet('in', note));
  if(u) u.addEventListener('click', () => authSheet('up', note));
}

async function leaveGroup(g){
  const owner = g.owner_id === user.id;
  const ok = await ask({title: `Leave ${g.name}?`,
    body: owner && g.n > 1 ? 'You started this group, so it passes to the member who joined first.'
      : g.n <= 1 ? 'You’re the only member, so the group will be deleted.'
      : 'You can rejoin later with an invite link.',
    yes: 'Leave', no: 'Cancel'});
  if(!ok) return;
  const {error} = await sb.rpc('leave_group', {gid: g.id});
  if(error) return toast(errText(error));
  groups = groups.filter(x => x.id !== g.id); delete detail[g.id];
  setActive(groups.length ? groups[0].id : null);
  toast(`You left ${g.name}.`);
}
async function removeMember(g, m){
  const ok = await ask({title: `Remove ${m.name}?`, body: `They’ll leave ${g.name}. They can rejoin only with a new invite link if you reset it.`, yes: 'Remove', no: 'Cancel'});
  if(!ok) return;
  const {error} = await sb.rpc('remove_group_member', {gid: g.id, member: m.id});
  if(error) return toast(errText(error));
  loadDetail(g.id, true);
}
async function renameGroup(g){
  const box = openSheet(`
    <h4 id="s2Title">Rename group</h4>
    <form><label>Group name <input type="text" name="nm" maxlength="50" value="${esc(g.name)}" required></label>
      <p class="msg" role="status"></p><button class="btn primary" type="submit">Save</button></form>`);
  const form = box.querySelector('form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = form.nm.value.trim(); if(!name) return;
    busy(form, true);
    const {error} = await sb.rpc('rename_group', {gid: g.id, group_name: name});
    busy(form, false);
    if(error) return setMsg(box, errText(error), 'err');
    g.name = name; closeSheet(); paintGroups(); renderWeek();
  });
}
async function resetInvite(g){
  const ok = await ask({title: 'Reset the invite link?', body: 'The current link stops working. Members stay in the group.', yes: 'Reset link', no: 'Cancel'});
  if(!ok) return;
  const {data, error} = await sb.rpc('reset_group_invite', {gid: g.id});
  if(error) return toast(errText(error));
  g.invite_code = data; paintGroups(); toast('New invite link ready.');
}

/* ==========================================================
   GROUP PICKS ON THE GAMES TAB
   ========================================================== */
const gp = {key: null, data: null};     // key = group|week; data = {gi: {uid: pick}}
async function loadWeekPicks(w){
  const key = active + '|' + w;
  if(gp.key === key) return;
  gp.key = key; gp.data = null;
  const [{data, error}] = await Promise.all([sb.rpc('group_week_picks', {gid: active, wk: w}), loadDetail(active)]);
  if(gp.key !== key) return;
  if(error){ gp.key = null; return; }
  const m = {};
  data.forEach(r => { (m[gix(r.game_id)] || (m[gix(r.game_id)] = {}))[r.user_id] = r.pick; });
  gp.data = m;
  renderWeek();
}
setInterval(() => {
  if(document.hidden || !user || !active || curTab !== 'picks' || S.mode !== 'week') return;
  gp.key = null; loadWeekPicks(S.week);
}, 3 * 60e3);

function groupStats(g){
  if(!user || !active || S.mode !== 'week' || !gp.data || !detail[active]) return '';
  const fin = isFinal(g.i), res = RES[g.i];
  const sides = {a: [], h: [], t: []};
  detail[active].members.forEach(m => {
    const mine = m.id === user.id;
    const p = mine && !isLocked(g.i) ? S.picks[g.i] : (gp.data[g.i] || {})[m.id];
    if(p) sides[p].push(m);
  });
  const na = sides.a.length, nh = sides.h.length, nt = sides.t.length;
  if(!na && !nh && !nt) return '';
  const open = openStats.has(g.i);
  const seg = (n, t, cls) => n ? `<i class="${cls || ''}" style="flex-grow:${n};background:${t ? TEAMS[t].k : ''}"></i>` : '';
  const names = side => sides[side].map(m => {
    const ok = fin && res.win === side;
    return `<span class="${m.id === user.id ? 'me' : ok ? 'ok' : ''}">${m.id === user.id ? 'You' : esc(m.name)}</span>`;
  }).join('') || '<em>Nobody</em>';
  const total = na + nh + nt;
  return `<div class="gpk${open ? ' open' : ''}">
    <button type="button" data-gs="${g.i}" aria-expanded="${open}" aria-label="Group picks: ${na} ${g.a}, ${nh} ${g.h}${nt ? ', ' + nt + ' tie' : ''}. Show who">
      <span class="n">${g.a} ${na}</span>
      <span class="gbar" title="${total} pick${total === 1 ? '' : 's'} in ${esc((groupById(active) || {}).name || 'your group')}">${seg(na, g.a)}${seg(nt, null, 't')}${seg(nh, g.h)}</span>
      <span class="n r">${nh} ${g.h}</span>
    </button>
    <div class="gwho"><div>${names('a')}</div><div class="r">${names('h')}</div>${nt ? `<div class="tie">Tie: ${names('t')}</div>` : ''}</div>
  </div>`;
}
HOOKS.gameExtra = groupStats;

['#games', '#games2', '#games3'].forEach(id => $(id).addEventListener('click', e => {
  const b = e.target.closest('[data-gs]'); if(!b) return;
  const gi = +b.dataset.gs;
  openStats.has(gi) ? openStats.delete(gi) : openStats.add(gi);
  const box = b.parentElement;
  box.classList.toggle('open', openStats.has(gi));
  b.setAttribute('aria-expanded', openStats.has(gi));
}));

function paintGrpBar(w){
  const bar = $('#grpBar');
  if(w == null || !sb){ bar.hidden = true; return; }
  if(!user){
    if(LS.get(CTA_KEY)){ bar.hidden = true; return; }
    bar.className = 'grpbar cta'; bar.hidden = false;
    bar.innerHTML = `<span>Sign in to keep your picks on every device and play pick’em with friends.</span>
      <span class="sp"><button class="btn primary" type="button" data-act="signin">Sign in</button>
      <button class="btn ghost" type="button" data-act="nocta" aria-label="Dismiss">✕</button></span>`;
    return;
  }
  if(!groupsLoaded){ bar.hidden = true; return; }
  if(!groups.length){
    bar.className = 'grpbar cta'; bar.hidden = false;
    bar.innerHTML = `<span>Play pick’em with friends: start a group and see who they’re picking.</span>
      <span class="sp"><button class="btn primary" type="button" data-act="create">New group</button></span>`;
    return;
  }
  const d = detail[active], n = d ? d.members.length : (groupById(active) || {}).n || 1;
  let picked = '';
  if(gp.data && d){
    const who = new Set();
    byWeek[w].forEach(g => Object.keys(gp.data[g.i] || {}).forEach(u => who.add(u)));
    if(byWeek[w].some(g => S.picks[g.i] && !isLocked(g.i))) who.add(user.id);
    picked = `<span><b>${who.size}</b> of ${n} picked</span>`;
  }
  bar.className = 'grpbar'; bar.hidden = false;
  bar.innerHTML = `<label for="grpSel">Group</label>
    <select id="grpSel">${groups.map(g => `<option value="${g.id}"${g.id === active ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
    ${picked}
    <span class="sp"><button class="btn ghost" type="button" data-act="board">Leaderboard</button></span>`;
}
$('#grpBar').addEventListener('change', e => { if(e.target.id === 'grpSel') setActive(e.target.value); });
$('#grpBar').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if(!b) return;
  const a = b.dataset.act;
  if(a === 'signin') authSheet('in');
  if(a === 'nocta'){ LS.set(CTA_KEY, 1); $('#grpBar').hidden = true; }
  if(a === 'create') createGroupSheet();
  if(a === 'board'){ showTab('groups', true); window.scrollTo(0, 0); }
});

HOOKS.weekShown = w => {
  paintGrpBar(w);
  if(w != null && user && active && groupsLoaded) loadWeekPicks(w);
};

/* ==========================================================
   GROUPS TAB
   ========================================================== */
function defaultLbWeek(){
  const w = currentWeek();
  return byWeek[w].some(g => isFinal(g.i)) || w === 1 ? w : w - 1;
}
function leaderboard(g){
  const d = detail[g.id];
  if(!d) return '<p class="muted">Loading the leaderboard…</p>';
  const w = lbWeek || defaultLbWeek();
  const rows = d.members.slice().sort((x, y) => y.c - x.c || (x.g - x.c) - (y.g - y.c) || x.name.localeCompare(y.name));
  let rank = 0, prev = null;
  const owner = g.owner_id === user.id;
  const body = rows.map((m, i) => {
    if(prev === null || m.c !== prev.c || m.g - m.c !== prev.g - prev.c) rank = i + 1;
    prev = m;
    const wk = m.wk[w] || {c: 0, g: 0, p: 0};
    const wkTxt = wk.g ? `${wk.c}–${wk.g - wk.c}` + (wk.p > wk.g ? ` <small class="muted">+${wk.p - wk.g}</small>` : '')
      : wk.p ? `<span class="muted">${wk.p} picked</span>` : '<span class="muted">—</span>';
    const me = m.id === user.id;
    return `<tr class="${me ? 'me' : ''}">
      <td class="rk">${m.g ? rank : '–'}</td>
      <td class="nm"><div>${avatar(m.name, m.id)}<span class="who">${me ? 'You' : esc(m.name)}</span>${m.id === g.owner_id ? '<small>owner</small>' : ''}
        ${owner && !me ? `<button class="rm" type="button" data-rm="${m.id}" title="Remove from group" aria-label="Remove ${esc(m.name)}">×</button>` : ''}</div></td>
      <td class="wkcol">${wkTxt}</td>
      <td>${m.g ? `${m.c}–${m.g - m.c}` : '—'}</td>
      <td>${m.g ? fmtPct(m.c / m.g) : '—'}</td>
    </tr>`;
  }).join('');
  return `<table class="lb">
    <thead><tr><th></th><th>Player</th>
      <th><span class="wkstep"><button type="button" data-wk="-1" ${w <= 1 ? 'disabled' : ''} aria-label="Previous week">‹</button>Wk ${w}<button type="button" data-wk="1" ${w >= WEEKS ? 'disabled' : ''} aria-label="Next week">›</button></span></th>
      <th>Season</th><th>Pct</th></tr></thead>
    <tbody>${body}</tbody></table>
    <p class="muted" style="margin:10px 0 0;font-size:12px">One point per correct pick, graded as games go final. A tie counts only if you picked the tie. Picks lock at kickoff.</p>`;
}

function paintGroups(){
  const box = $('#groupsBody');
  if(!sb){
    box.innerHTML = `<div class="card hero"><h3>Pick’em groups</h3><p>Connect to the internet to sign in and play with friends.</p></div>`;
    return;
  }
  if(!user){
    box.innerHTML = `<div class="card hero">
      <h3>Pick’em with friends</h3>
      <ul>
        <li>Start a group and send your friends the invite link.</li>
        <li>Everyone picks every game, every week. The leaderboard keeps score.</li>
        <li>See how your group picked each game while you make your picks.</li>
        <li>Your picks and saved brackets follow you to every device.</li>
      </ul>
      <div class="mact" style="justify-content:flex-start">
        <button class="btn primary" type="button" data-act="up">Create account</button>
        <button class="btn" type="button" data-act="in">Sign in</button></div>
    </div>`;
    return;
  }
  if(!groupsLoaded){ box.innerHTML = '<p class="muted">Loading your groups…</p>'; return; }
  const g = groupById(active);
  box.innerHTML = `
    <div class="ghead"><h2>Groups</h2>
      <div class="acts"><button class="btn" type="button" data-act="join">Join</button>
        <button class="btn primary" type="button" data-act="create">New group</button></div></div>
    ${groups.length ? `<div class="glist" role="group" aria-label="Your groups">${groups.map(x => `
      <button type="button" data-g="${x.id}" aria-pressed="${x.id === active}"><b>${esc(x.name)}</b>
        <span>${x.n} member${x.n === 1 ? '' : 's'}${x.owner_id === user.id ? ' · owner' : ''}</span></button>`).join('')}</div>`
    : `<div class="card"><h3>No groups yet</h3><p>Start one and invite your friends, or join one with a link a friend sent you.</p></div>`}
    ${g ? `
    <div class="card">
      <div class="gtitle"><h3>${esc(g.name)}</h3>
        <div class="acts"><button class="btn" type="button" data-act="pick">Make Week ${currentWeek()} picks</button></div></div>
      ${leaderboard(g)}
    </div>
    <div class="card">
      <h3>Invite friends</h3>
      <p>Anyone with this link can join ${esc(g.name)}.</p>
      <div class="invite"><input type="text" readonly value="${esc(inviteLink(g))}" aria-label="Invite link">
        <button class="btn primary" type="button" data-copy>Copy</button>
        ${navigator.share ? '<button class="btn" type="button" data-share>Share</button>' : ''}</div>
    </div>
    <div class="gfoot">
      ${g.owner_id === user.id ? `<button class="btn" type="button" data-act="rename">Rename</button>
        <button class="btn" type="button" data-act="reset">Reset invite link</button>` : ''}
      <button class="btn danger" type="button" data-act="leave">Leave group</button>
    </div>` : ''}`;
  if(g){ wireInvite(box, g); if(!detail[g.id]) loadDetail(g.id); }
}
$('#groupsBody').addEventListener('click', e => {
  const t = e.target;
  const gb = t.closest('.glist [data-g]');
  if(gb){ if(gb.dataset.g !== active){ lbWeek = null; setActive(gb.dataset.g); } return; }
  const wk = t.closest('[data-wk]');
  if(wk){ lbWeek = Math.max(1, Math.min(WEEKS, (lbWeek || defaultLbWeek()) + +wk.dataset.wk)); paintGroups(); return; }
  const rm = t.closest('[data-rm]');
  const g = groupById(active);
  if(rm && g){ const m = detail[g.id] && detail[g.id].by[rm.dataset.rm]; if(m) removeMember(g, m); return; }
  const b = t.closest('[data-act]'); if(!b) return;
  const a = b.dataset.act;
  if(a === 'up') authSheet('up');
  else if(a === 'in') authSheet('in');
  else if(a === 'create') createGroupSheet();
  else if(a === 'join') joinCodeSheet();
  else if(g && a === 'rename') renameGroup(g);
  else if(g && a === 'reset') resetInvite(g);
  else if(g && a === 'leave') leaveGroup(g);
  else if(a === 'pick'){
    S.mode = 'week'; goWeek(currentWeek()); placeInd($('#modeSeg'));
    showTab('picks', true); window.scrollTo(0, 0);
  }
});
// fresh standings whenever the tab is opened
document.querySelector('.tab[data-tab="groups"]').addEventListener('click', () => {
  if(user && active) loadDetail(active, true);
});

/* ==========================================================
   SAVED BRACKETS
   ========================================================== */
function paintBracketBtns(){
  $('#btnSavePo').hidden = !sb;
  $('#btnBrackets').hidden = !user;
}
$('#btnSavePo').addEventListener('click', () => {
  if(!user) return authSheet('up', 'Create an account to save your brackets.');
  const champ = S.po.sb;
  const def = champ ? `${TEAMS[champ].n} win it all` : `My bracket, ${new Date().toLocaleDateString(undefined, {month: 'short', day: 'numeric'})}`;
  const box = openSheet(`
    <h4 id="s2Title">Save this bracket</h4>
    <p>Saves your picks, seeds and bracket as they are now, so you can come back to them.</p>
    <form><label>Name <input type="text" name="nm" maxlength="60" value="${esc(def)}" required></label>
      <p class="msg" role="status"></p><button class="btn primary" type="submit">Save bracket</button></form>`);
  const form = box.querySelector('form');
  form.nm.select();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = form.nm.value.trim(); if(!name) return setMsg(box, 'Give it a name.', 'err');
    busy(form, true);
    const {error} = await sb.from('brackets').insert({
      user_id: user.id, season: SEASON, name, champion: champ || null,
      data: {picks: S.picks, po: S.po, flips: S.flips,
             seeds: {AFC: VIEW.conf.AFC.seeds, NFC: VIEW.conf.NFC.seeds}, saved: new Date().toISOString()}
    });
    busy(form, false);
    if(error) return setMsg(box, errText(error), 'err');
    closeSheet(); toast(`Saved “${name}”.`);
  });
});
$('#btnBrackets').addEventListener('click', bracketsSheet);
async function bracketsSheet(){
  const box = openSheet(`<h4 id="s2Title">Your saved brackets</h4><p class="msg muted">Loading…</p>`);
  const {data, error} = await sb.from('brackets').select('id,name,champion,created_at,data')
    .eq('season', SEASON).order('created_at', {ascending: false});
  if(error) return setMsg(box, errText(error), 'err');
  if(!data.length){
    box.querySelector('.msg').outerHTML = '<p>Nothing saved yet. Fill in a bracket and tap <b>Save</b> to keep a copy.</p>';
    return;
  }
  box.querySelector('.msg').outerHTML = `<ul class="blist">${data.map(b => `
    <li>${b.champion && TEAMS[b.champion] ? logo(b.champion) : ''}
      <div class="bi"><b>${esc(b.name)}</b><span>${b.champion && TEAMS[b.champion] ? esc(TEAMS[b.champion].c + ' ' + TEAMS[b.champion].n) + ' · ' : ''}${new Date(b.created_at).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})}</span></div>
      <button class="btn" type="button" data-open="${b.id}">Open</button>
      <button class="btn ghost" type="button" data-del="${b.id}" aria-label="Delete ${esc(b.name)}">Delete</button></li>`).join('')}</ul>`;
  const byId = Object.fromEntries(data.map(b => [b.id, b]));
  box.querySelector('.blist').addEventListener('click', async e => {
    const o = e.target.closest('[data-open]'), d = e.target.closest('[data-del]');
    if(o){
      const b = byId[o.dataset.open];
      const ok = await ask({title: `Open “${b.name}”?`,
        body: 'This replaces your current bracket, and your picks for games that haven’t kicked off, with the saved ones.',
        yes: 'Open', no: 'Cancel'});
      if(!ok) return;
      const snap = b.data || {};
      for(const gi in S.picks) if(!isLocked(+gi)) delete S.picks[gi];
      for(const gi in snap.picks || {}) if(GAMES[gi] && !isLocked(+gi)) S.picks[gi] = snap.picks[gi];
      S.po = Object.assign({}, snap.po); S.flips = Object.assign({}, snap.flips);
      closeSheet(); render(); showTab('playoffs', true);
      toast(`Opened “${b.name}”.`);
    }
    if(d){
      const b = byId[d.dataset.del];
      const ok = await ask({title: `Delete “${b.name}”?`, body: 'This can’t be undone.', yes: 'Delete', no: 'Cancel'});
      if(!ok) return;
      const {error} = await sb.from('brackets').delete().eq('id', b.id);
      if(error) return toast(errText(error));
      d.closest('li').remove(); toast('Deleted.');
    }
  });
}

/* ==========================================================
   SESSION
   ========================================================== */
function paint(){
  paintAccountBtn(); paintBracketBtns(); paintGroups();
  if(S.mode === 'week') paintGrpBar(S.week); else paintGrpBar(null);
}

async function onSession(session){
  const u = session ? session.user : null;
  if((u && u.id) === (user && user.id)) return;
  user = u; ready = false; profile = null; groups = []; groupsLoaded = false;
  for(const id in detail) delete detail[id];
  gp.key = null; gp.data = null;
  HOOKS.lockStarted = !!user;
  if(!user){ LS.set(SYNC_KEY, null); render(); paint(); return; }
  paint();
  try{
    const [p] = await Promise.all([
      sb.from('profiles').select('id,display_name').eq('id', user.id).maybeSingle(),
      pullBoard()
    ]);
    profile = p.data;
    ready = true; lastPull = Date.now();
  }catch(e){
    toast('Couldn’t reach your account. Your picks are saved on this device.');
  }
  try{ await loadGroups(); }catch(e){ groupsLoaded = true; }
  render(); paint();
  if(ready) schedulePush();   // anything from this device the account doesn't have yet
  const code = LS.get(JOIN_KEY);
  if(code) invitePrompt(code);
}

function loadSdk(){
  return new Promise((resolve, reject) => {
    if(window.supabase && window.supabase.createClient) return resolve();
    const sc = document.createElement('script');
    sc.src = SDK_URL; sc.async = true; sc.crossOrigin = 'anonymous';
    sc.onload = resolve; sc.onerror = reject;
    document.head.appendChild(sc);
  });
}

async function start(){
  // invite links look like https://bracketeersports.com/?join=CODE
  const q = new URLSearchParams(location.search), code = q.get('join');
  if(code){
    LS.set(JOIN_KEY, codeFrom(code));
    q.delete('join');
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
    showTab('groups', true);
  }
  paintGroups();
  try{ await loadSdk(); }catch(e){ paint(); return; }   // offline: the board carries on
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true}
  });
  paint();
  let first = true;
  sb.auth.onAuthStateChange((event, session) => {
    // never await Supabase calls inside this callback
    setTimeout(async () => {
      await onSession(session);
      if(first){
        first = false;
        const pending = LS.get(JOIN_KEY);
        if(pending && !user) invitePrompt(pending);
      }
    }, 0);
  });
}
start();
})();

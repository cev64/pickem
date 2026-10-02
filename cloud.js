/* Bracketeer accounts — sign-in, profiles, the board synced across devices,
   pick'em, saved brackets and groups, backed by Supabase (project
   "Bracketeer"; schema in supabase/migrations).

   Two kinds of picks, kept apart on purpose:
   - the BOARD (S.picks, S.po, S.flips) is for fun: simulate the season, run
     the bracket. Signed in, it syncs across devices; it never counts anywhere.
   - PICK'EM entries (PK) are what groups score. You add a week from the
     Games tab ("Add Week 5 to pick'em"), which copies that week's board picks
     for games that haven't kicked off. Each entry locks at kickoff.

   Loaded after index.html's main script and built on its globals (S, GAMES,
   byWeek, TEAMS, RES, VIEW, HOOKS, render, renderWeek, showTab, isFinal,
   hasStarted, toast, ask, esc, logo, ...). All of it is optional: offline or
   signed out, the board works exactly as before. */
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
const BOARD_KEY = 'bracketeer.board.v2';   // {uid, base:{picks,po,flips}} as the server had it at the last sync
const GROUP_KEY = 'bracketeer.group.v1';   // the group whose picks show on the Games tab
const JOIN_KEY  = 'bracketeer.join.v1';    // invite code waiting for sign-in
const CTA_KEY   = 'bracketeer.cta.v1';     // signed-out nudge dismissed
LS.set('bracketeer.sync.v1', null);        // the old combined board + pick'em sync state

let sb = null;           // Supabase client, once the SDK has loaded
let user = null;         // signed-in auth user
let profile = null;      // {id, display_name, username, avatar_path, created_at}
let PK = {};             // your pick'em entries: game index -> 'a' | 'h' | 't'
let pkLoaded = false;
let groups = [];         // [{id, name, owner_id, invite_code, n}]
let groupsLoaded = false;
let active = LS.get(GROUP_KEY);
const detail = {};       // group id -> {members:[...], by:{uid: member}}; member = {id, name, username, path, c, g, p, wk:{w:{c,g,p}}}
let lbWeek = null;       // week shown in the leaderboard's weekly column
let ready = false;       // board pulled from the account; safe to push
const openStats = new Set();   // games whose "who picked what" list is expanded

const groupById = id => groups.find(g => g.id === id);
const inviteLink = g => `${SITE}?join=${g.invite_code}`;
const errText = e => (e && (e.message || e.error_description)) || 'Something went wrong. Try again.';
const photoUrl = path => `${SUPABASE_URL}/storage/v1/object/public/avatars/${path}`;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

/* ==========================================================
   AVATARS: your photo, or your initial on a colour of its own
   ========================================================== */
function hue(s){ let h = 0; for(const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
function avatar(p, cls = ''){
  const name = (p && (p.display_name || p.name)) || '?', id = p && p.id, path = p && (p.avatar_path || p.path);
  if(path) return `<img class="av ${cls}" src="${esc(photoUrl(path))}" alt="" loading="lazy" decoding="async">`;
  return `<span class="av ${cls}" style="--c:hsl(${hue(id || name)} 52% 42%)" aria-hidden="true">${esc(name.trim().charAt(0) || '?')}</span>`;
}

/* ==========================================================
   SHEET (forms: sign in, profile, groups, brackets)
   ========================================================== */
const sheet = $('#sheet2'), sheetBody = $('#s2Sheet');
function openSheet(html){
  sheetBody.innerHTML = `<button class="x" type="button" data-close aria-label="Close">×</button>${html}`;
  sheet.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add('open')));
  const f = sheetBody.querySelector('input:not([readonly]):not([type=file]),button.primary');
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
      : up ? 'Your board comes with you. You can pick a username and photo after.'
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

$('#btnAccount').addEventListener('click', () => {
  if(!user) return authSheet('in');
  showTab('profile', true); window.scrollTo(0, 0); openProfile();
});
function paintAccountBtn(){
  const b = $('#btnAccount');
  b.hidden = !sb;
  b.classList.toggle('in', !!user);
  b.innerHTML = user
    ? `${avatar(profile || {id: user.id, name: user.email})}<span class="nm">${esc(profile ? profile.display_name : 'Account')}</span>`
    : 'Sign in';
  b.setAttribute('aria-label', user ? 'Your profile' : 'Sign in');
}

/* ==========================================================
   BOARD SYNC
   The device keeps the board as always; signed in, it's mirrored to the
   account. BOARD_KEY remembers what the server had at the last sync, so
   edits made offline or on another device merge instead of clobbering.
   ========================================================== */
const boardOf = x => ({picks: (x && x.picks) || {}, po: (x && x.po) || {}, flips: (x && x.flips) || {}});
const clone = o => JSON.parse(JSON.stringify(o));
// keys changed here since the last sync win; everything else comes from the server
function merge3(base, mine, theirs){
  const out = Object.assign({}, theirs);
  for(const k of new Set([...Object.keys(base), ...Object.keys(mine)])){
    if(mine[k] === base[k]) continue;
    if(mine[k] == null) delete out[k]; else out[k] = mine[k];
  }
  return out;
}
async function pullBoard(){
  const {data, error} = await sb.from('boards').select('picks,po,flips').eq('user_id', user.id).maybeSingle();
  if(error) throw error;
  const server = boardOf(data);
  const sync = LS.get(BOARD_KEY);
  if(!sync || sync.uid !== user.id){
    // first sign-in on this device: the account's picks win; this device fills the gaps
    S.picks = Object.assign({}, S.picks, server.picks);
    if(Object.keys(server.po).length) S.po = server.po;
    S.flips = Object.assign({}, S.flips, server.flips);
  }else{
    const base = boardOf(sync.base);
    S.picks = merge3(base.picks, S.picks, server.picks);
    S.po = merge3(base.po, S.po, server.po);
    S.flips = merge3(base.flips, S.flips, server.flips);
  }
  LS.set(BOARD_KEY, {uid: user.id, base: data ? server : null});
}

let pushT = 0, pushing = false, pushAgain = false;
function schedulePush(){ if(!ready || !user) return; clearTimeout(pushT); pushT = setTimeout(push, 600); }
async function push(){
  if(!ready || !user) return;
  if(pushing){ pushAgain = true; return; }
  pushing = true;
  const uid = user.id;
  try{
    const sync = LS.get(BOARD_KEY) || {uid, base: null};
    const now = boardOf(S);
    if(JSON.stringify(now) !== JSON.stringify(sync.base && boardOf(sync.base))){
      const {error} = await sb.from('boards').upsert({user_id: uid, picks: now.picks, po: now.po, flips: now.flips});
      if(error) throw error;
      if(user && user.id === uid) LS.set(BOARD_KEY, {uid, base: clone(now)});
    }
  }catch(e){
    // offline or a blip: it goes with the next change or reconnect
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
  ready = false;
  try{ await Promise.all([pullBoard(), loadPickem()]); }catch(e){}
  ready = true;
  gp.key = null;
  render();
  if(curTab === 'groups' && active) loadDetail(active, true);
}
document.addEventListener('visibilitychange', () => { if(!document.hidden) resync(); });
window.addEventListener('online', () => { lastPull = 0; resync(); });

/* ==========================================================
   PICK'EM ENTRIES
   ========================================================== */
async function loadPickem(){
  const {data, error} = await sb.from('picks').select('game_id,pick')
    .eq('user_id', user.id).gte('game_id', gid(0)).lt('game_id', gid(1000));
  if(error) throw error;
  PK = {};
  data.forEach(r => { PK[gix(r.game_id)] = r.pick; });
  pkLoaded = true;
}
function weekStatus(w){
  const gs = byWeek[w];
  const open = gs.filter(g => !hasStarted(g.i));
  const entered = gs.filter(g => PK[g.i]).length;
  const enteredOpen = open.filter(g => PK[g.i]).length;
  const boardOpen = open.filter(g => S.picks[g.i]).length;
  const changes = open.filter(g => (S.picks[g.i] || null) !== (PK[g.i] || null)).length;
  let c = 0, gr = 0;
  gs.forEach(g => { if(PK[g.i] && isFinal(g.i)){ gr++; if(RES[g.i].win === PK[g.i]) c++; } });
  return {gs, open, entered, enteredOpen, boardOpen, changes, c, g: gr};
}

// copy this week's board picks (games not yet kicked off) into pick'em
async function submitWeek(w, btn){
  const st = weekStatus(w);
  if(!st.boardOpen && !st.enteredOpen) return toast('Pick some of this week’s games first, then add them.');
  const ups = st.open.filter(g => S.picks[g.i] && S.picks[g.i] !== PK[g.i])
    .map(g => ({user_id: user.id, game_id: gid(g.i), pick: S.picks[g.i]}));
  const dels = st.open.filter(g => PK[g.i] && !S.picks[g.i]).map(g => gid(g.i));
  if(btn) btn.disabled = true;
  try{
    if(ups.length){
      const {error} = await sb.from('picks').upsert(ups, {onConflict: 'user_id,game_id'});
      if(error && error.code !== '42501') throw error;
      if(error){   // a game kicked off on the way: save the rest
        for(const u of ups){ const r = await sb.from('picks').upsert(u, {onConflict: 'user_id,game_id'}); if(r.error && r.error.code !== '42501') throw r.error; }
      }
    }
    if(dels.length){
      const {error} = await sb.from('picks').delete().eq('user_id', user.id).in('game_id', dels);
      if(error) throw error;
    }
    const had = st.entered;
    await loadPickem();
    const now = weekStatus(w);
    haptic('bulk');
    toast(had ? `Week ${w} pick’em updated.` : `Week ${w} is in your pick’em: ${now.entered} pick${now.entered === 1 ? '' : 's'}. Each one locks at kickoff.`);
  }catch(e){ toast(errText(e)); }
  finally{ if(btn) btn.disabled = false; gp.key = null; renderWeek(); }
}
async function withdrawWeek(w){
  const st = weekStatus(w);
  const ids = st.open.filter(g => PK[g.i]).map(g => gid(g.i));
  if(!ids.length) return;
  const ok = await ask({title: `Take Week ${w} out of pick’em?`,
    body: `Your ${ids.length} pick’em pick${ids.length === 1 ? '' : 's'} for games that haven’t kicked off will be removed. Your board stays as it is.`,
    yes: 'Remove', no: 'Cancel'});
  if(!ok) return;
  const {error} = await sb.from('picks').delete().eq('user_id', user.id).in('game_id', ids);
  if(error) return toast(errText(error));
  await loadPickem().catch(() => {});
  gp.key = null; renderWeek();
  toast(`Week ${w} removed from your pick’em.`);
}

// your pick'em pick in a game card's top line
HOOKS.gameMeta = g => {
  if(!user || !pkLoaded || !PK[g.i]) return '';
  const p = PK[g.i], t = p === 't' ? 'Tie' : g[p];
  let cls = '', tip = 'Your pick’em pick';
  if(isFinal(g.i)){ const ok = RES[g.i].win === p; cls = ok ? ' ok' : ' bad'; tip += ok ? ': right' : ': wrong'; }
  else if(!hasStarted(g.i) && (S.picks[g.i] || null) !== p){ cls = ' off'; tip = 'Your board pick is different. Update pick’em to change it.'; }
  else if(hasStarted(g.i)) tip += ' (locked)';
  return `<span class="pkm${cls}" title="${tip}">Pick’em: ${t}</span>`;
};

/* ==========================================================
   PROFILES: name, @username, photo
   ========================================================== */
async function loadProfile(){
  const {data, error} = await sb.from('profiles').select('id,display_name,username,avatar_path,created_at').eq('id', user.id).maybeSingle();
  if(error) throw error;
  profile = data;
}

function editProfileSheet(){
  const box = openSheet(`
    <h4 id="s2Title">Edit profile</h4>
    <form novalidate>
      <label>Display name <input type="text" name="nm" maxlength="40" value="${esc(profile.display_name)}" autocomplete="nickname" required></label>
      <label>Username
        <span class="uname"><i>@</i><input type="text" name="un" maxlength="20" value="${esc(profile.username)}" autocomplete="username" autocapitalize="none" spellcheck="false" required></span>
        <small class="hint" data-hint>3–20 letters, numbers or underscores.</small></label>
      <p class="msg" role="status"></p>
      <button class="btn primary" type="submit">Save</button>
    </form>`);
  const form = box.querySelector('form'), un = form.un, hint = box.querySelector('[data-hint]');
  let checkT = 0, seq = 0;
  const setHint = (t, k) => { hint.textContent = t; hint.className = 'hint' + (k ? ' ' + k : ''); };
  un.addEventListener('input', () => {
    const v = un.value = un.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
    clearTimeout(checkT);
    if(v === profile.username) return setHint('That’s your username.');
    if(!USERNAME_RE.test(v)) return setHint('3–20 letters, numbers or underscores.', v ? 'err' : '');
    setHint('Checking…');
    const n = ++seq;
    checkT = setTimeout(async () => {
      const {data} = await sb.rpc('username_available', {name: v});
      if(n !== seq) return;
      data === false ? setHint(`@${v} is taken.`, 'err') : setHint(`@${v} is available.`, 'ok');
    }, 350);
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = form.nm.value.trim(), username = un.value.trim().toLowerCase();
    if(!name) return setMsg(box, 'Your display name can’t be blank.', 'err');
    if(!USERNAME_RE.test(username)) return setMsg(box, 'Usernames are 3–20 letters, numbers or underscores.', 'err');
    busy(form, true);
    const {error} = await sb.from('profiles').update({display_name: name, username}).eq('id', user.id);
    busy(form, false);
    if(error) return setMsg(box, error.code === '23505' ? `@${username} is taken. Try another.` : errText(error), 'err');
    Object.assign(profile, {display_name: name, username});
    for(const id in detail) delete detail[id];
    closeSheet(); toast('Profile saved.'); paint();
  });
}

// square-crop to 320px and save as WebP (JPEG where the browser can't)
async function photoBlob(file){
  const url = URL.createObjectURL(file);
  try{
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(img.naturalWidth, img.naturalHeight), N = 320;
    const cv = document.createElement('canvas'); cv.width = cv.height = N;
    const c = cv.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, N, N);
    const as = (type, q) => new Promise(res => cv.toBlob(res, type, q));
    let blob = await as('image/webp', .86);
    if(!blob || blob.type !== 'image/webp') blob = await as('image/jpeg', .88);
    return blob;
  }finally{ URL.revokeObjectURL(url); }
}
function choosePhoto(){
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0]; if(!f) return;
    if(!/^image\//.test(f.type)) return toast('That isn’t an image.');
    let blob;
    try{ blob = await photoBlob(f); }catch(e){ return toast('Couldn’t read that image. Try a JPEG or PNG.'); }
    const preview = URL.createObjectURL(blob);
    const box = openSheet(`
      <h4 id="s2Title">New profile photo</h4>
      <div class="pf-preview"><img src="${preview}" alt="Preview of your new photo"></div>
      <p class="msg" role="status"></p>
      <div class="mact"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" data-use>Use photo</button></div>`);
    box.querySelector('[data-use]').addEventListener('click', async ev => {
      ev.target.disabled = true; setMsg(box, 'Uploading…');
      try{
        await savePhoto(blob);
        closeSheet(); toast('Photo updated.');
      }catch(e){ setMsg(box, errText(e), 'err'); ev.target.disabled = false; }
      finally{ URL.revokeObjectURL(preview); }
    });
  });
  inp.click();
}
async function savePhoto(blob){
  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${user.id}/${Date.now()}.${ext}`, old = profile.avatar_path;
  const up = await sb.storage.from('avatars').upload(path, blob, {contentType: blob.type, cacheControl: '31536000', upsert: false});
  if(up.error) throw up.error;
  const {error} = await sb.from('profiles').update({avatar_path: path}).eq('id', user.id);
  if(error){ sb.storage.from('avatars').remove([path]); throw error; }
  profile.avatar_path = path;
  if(old) sb.storage.from('avatars').remove([old]);
  for(const id in detail) delete detail[id];
  paint();
}
async function removePhoto(){
  const ok = await ask({title: 'Remove your photo?', body: 'Your initial will show instead.', yes: 'Remove', no: 'Cancel'});
  if(!ok) return;
  const old = profile.avatar_path;
  const {error} = await sb.from('profiles').update({avatar_path: null}).eq('id', user.id);
  if(error) return toast(errText(error));
  profile.avatar_path = null;
  if(old) sb.storage.from('avatars').remove([old]);
  for(const id in detail) delete detail[id];
  paint(); toast('Photo removed.');
}

function passwordSheet(){
  const box = openSheet(`
    <h4 id="s2Title">Change password</h4>
    <form><label>New password <input type="password" name="password" minlength="6" autocomplete="new-password" required></label>
      <p class="msg" role="status"></p><button class="btn primary" type="submit">Save password</button></form>`);
  const form = box.querySelector('form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const pw = form.password.value;
    if(pw.length < 6) return setMsg(box, 'Passwords need at least 6 characters.', 'err');
    busy(form, true);
    const {error} = await sb.auth.updateUser({password: pw});
    busy(form, false);
    if(error) return setMsg(box, errText(error), 'err');
    closeSheet(); toast('Password changed.');
  });
}

/* ==========================================================
   PROFILE PAGE
   ========================================================== */
let brackets = null;     // saved brackets, loaded with the profile page
const ordinal = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

function pickemByWeek(){
  const wk = {};
  for(const gi in PK){
    const g = GAMES[gi]; if(!g) continue;
    const r = wk[g.w] || (wk[g.w] = {c: 0, g: 0, p: 0});
    r.p++;
    if(isFinal(+gi)){ r.g++; if(RES[gi].win === PK[gi]) r.c++; }
  }
  return wk;
}
function rankIn(g){
  const d = detail[g.id]; if(!d) return null;
  const me = d.by[user.id]; if(!me || !me.g) return null;
  const better = d.members.filter(m => m.c > me.c || (m.c === me.c && m.g - m.c < me.g - me.c)).length;
  return better + 1;
}

function weekChart(wk){
  const W = WEEKS, cur = currentWeek();
  const bars = Array.from({length: W}, (_, i) => {
    const w = i + 1, r = wk[w];
    const pct = r && r.g ? r.c / r.g : null;
    const tip = !r ? `Week ${w}: not entered`
      : r.g ? `Week ${w}: ${r.c}–${r.g - r.c} (${Math.round(pct * 100)}%)${r.p > r.g ? `, ${r.p - r.g} still to play` : ''}`
      : `Week ${w}: ${r.p} pick${r.p === 1 ? '' : 's'} in, none graded yet`;
    return `<div class="wc-col${w === cur ? ' now' : ''}" title="${tip}" aria-label="${tip}" role="img">
      <div class="wc-bar${pct == null ? (r ? ' wait' : ' none') : ''}" style="--h:${pct == null ? 0 : Math.max(.04, pct)}"></div>
      <span>${w}</span></div>`;
  }).join('');
  return `<div class="wchart" aria-label="Pick’em accuracy by week">
    <div class="wc-grid"><i style="--y:1">100%</i><i style="--y:.5">50%</i><i style="--y:0"></i></div>
    <div class="wc-cols">${bars}</div></div>`;
}

function paintProfile(){
  const box = $('#profileBody');
  if(!sb){ box.innerHTML = `<div class="card hero"><h3>Your profile</h3><p>Connect to the internet to sign in.</p></div>`; return; }
  if(!user){
    box.innerHTML = `<div class="card hero"><h3>Your profile</h3>
      <p>Sign in to keep your board on every device, play pick’em with friends and save your brackets.</p>
      <div class="mact" style="justify-content:flex-start"><button class="btn primary" type="button" data-act="up">Create account</button>
      <button class="btn" type="button" data-act="in">Sign in</button></div></div>`;
    return;
  }
  if(!profile){ box.innerHTML = '<p class="muted">Loading your profile…</p>'; return; }
  const wk = pickemByWeek();
  let c = 0, gr = 0, p = 0, best = null;
  for(const w in wk){
    const r = wk[w]; c += r.c; gr += r.g; p += r.p;
    if(r.g && (!best || r.c > best.c || (r.c === best.c && r.g < best.g))) best = Object.assign({w}, r);
  }
  const joined = profile.created_at ? new Date(profile.created_at).toLocaleDateString(undefined, {month: 'long', year: 'numeric'}) : '';
  const tile = (v, l, sub) => `<div class="pf-tile"><b>${v}</b><span>${l}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const myGroups = groups.map(g => {
    const r = rankIn(g), d = detail[g.id];
    return `<li><button type="button" data-open-group="${g.id}">
      <span class="gi"><b>${esc(g.name)}</b><span>${g.n} member${g.n === 1 ? '' : 's'}${g.owner_id === user.id ? ' · owner' : ''}</span></span>
      <span class="rk">${r ? `<b>${ordinal(r)}</b><span>of ${d.members.length}</span>` : '<span class="muted">No graded picks yet</span>'}</span></button></li>`;
  }).join('');
  const bl = brackets == null ? '<p class="muted">Loading…</p>'
    : !brackets.length ? '<p class="muted">Nothing saved yet. Fill in a bracket on the Playoffs tab and tap <b>Save</b>.</p>'
    : `<ul class="blist">${brackets.map(bracketRow).join('')}</ul>`;
  box.innerHTML = `
    <div class="card pf-hero">
      <div class="pf-photo">
        ${avatar(profile, 'xl')}
        <button class="pf-cam" type="button" data-act="photo" aria-label="Change photo" title="Change photo">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
        </button>
      </div>
      <div class="pf-id">
        <h2>${esc(profile.display_name)}</h2>
        <p>@${esc(profile.username)}${joined ? ` · Joined ${joined}` : ''}</p>
        <div class="pf-acts">
          <button class="btn" type="button" data-act="edit">Edit profile</button>
          ${profile.avatar_path ? '<button class="btn ghost" type="button" data-act="rmphoto">Remove photo</button>' : '<button class="btn ghost" type="button" data-act="photo">Add a photo</button>'}
        </div>
      </div>
    </div>
    <div class="pf-tiles">
      ${tile(gr ? `${c}–${gr - c}` : '—', 'Pick’em record', p > gr ? `${p - gr} still to play` : '')}
      ${tile(gr ? fmtPct(c / gr) : '—', 'Win rate')}
      ${tile(best ? `${best.c}/${best.g}` : '—', 'Best week', best ? `Week ${best.w}` : '')}
      ${tile(groups.length, groups.length === 1 ? 'Group' : 'Groups')}
    </div>
    <div class="card">
      <div class="pf-head"><h3>Pick’em by week</h3><span class="muted">share of graded picks you got right</span></div>
      ${p ? weekChart(wk) : `<p class="muted">You haven’t entered any weeks yet. Make your picks on the Games tab, then tap <b>Add Week ${currentWeek()} to pick’em</b>.</p>`}
    </div>
    <div class="card">
      <div class="pf-head"><h3>Your groups</h3><button class="btn ghost" type="button" data-act="groups">${groups.length ? 'All groups' : 'Start or join one'}</button></div>
      ${groups.length ? `<ul class="pf-groups">${myGroups}</ul>` : '<p class="muted">Groups compare everyone’s weekly pick’em picks.</p>'}
    </div>
    <div class="card">
      <div class="pf-head"><h3>Saved brackets</h3></div>
      <div data-brackets>${bl}</div>
    </div>
    <div class="card">
      <div class="pf-head"><h3>Account</h3></div>
      <p>${esc(user.email || '')}</p>
      <div class="pf-acts"><button class="btn" type="button" data-act="password">Change password</button>
        <button class="btn danger" type="button" data-act="signout">Sign out</button></div>
    </div>`;
}
async function openProfile(){
  paintProfile();
  if(!user) return;
  const tasks = [loadBrackets()];
  groups.forEach(g => tasks.push(loadDetail(g.id)));
  await Promise.all(tasks.map(t => t.catch(() => {})));
  if(curTab === 'profile') paintProfile();
}
$('#profileBody').addEventListener('click', async e => {
  const g = e.target.closest('[data-open-group]');
  if(g){ setActive(g.dataset.openGroup); showTab('groups', true); window.scrollTo(0, 0); return; }
  if(bracketClick(e)) return;
  const b = e.target.closest('[data-act]'); if(!b) return;
  const a = b.dataset.act;
  if(a === 'up') authSheet('up');
  else if(a === 'in') authSheet('in');
  else if(a === 'edit') editProfileSheet();
  else if(a === 'photo') choosePhoto();
  else if(a === 'rmphoto') removePhoto();
  else if(a === 'password') passwordSheet();
  else if(a === 'groups'){ showTab('groups', true); window.scrollTo(0, 0); }
  else if(a === 'signout'){
    await sb.auth.signOut();
    showTab('picks', true);
    toast('Signed out. Your board stays on this device.');
  }
});

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

// members and standings for one group (every member is listed)
async function loadDetail(id, force){
  if(detail[id] && !force) return detail[id];
  const {data, error} = await sb.rpc('group_standings', {gid: id});
  if(error){ toast(errText(error)); return null; }
  const by = {};
  data.forEach(r => {
    const m = by[r.user_id] || (by[r.user_id] = {id: r.user_id, name: r.display_name, username: r.username, path: r.avatar_path, c: 0, g: 0, p: 0, wk: {}});
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
    <p>Anyone with this link can join the group and see everyone’s pick’em picks.</p>
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
  toast(`You’re in ${data.name}. Add a week to your pick’em to get on the board.`);
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
      Pick the games each week and see how you stack up.</p>
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
   GAMES TAB: the pick'em bar, and how your group picked each game
   ========================================================== */
const gp = {key: null, data: null};     // key = group|week; data = {gi: {uid: pick}} (pick'em entries)
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

HOOKS.gameExtra = g => {
  if(!user || !active || S.mode !== 'week' || !gp.data || !detail[active]) return '';
  const fin = isFinal(g.i), res = RES[g.i];
  const sides = {a: [], h: [], t: []};
  detail[active].members.forEach(m => {
    const p = m.id === user.id ? PK[g.i] : (gp.data[g.i] || {})[m.id];
    if(p) sides[p].push(m);
  });
  const na = sides.a.length, nh = sides.h.length, nt = sides.t.length;
  if(!na && !nh && !nt) return '';
  const open = openStats.has(g.i);
  const seg = (n, t, cls) => n ? `<i class="${cls || ''}" style="flex-grow:${n};background:${t ? TEAMS[t].k : ''}"></i>` : '';
  const names = side => sides[side].map(m => {
    const me = m.id === user.id, ok = fin && res.win === side;
    return `<span class="${me ? 'me' : ok ? 'ok' : ''}">${avatar(m, 'xs')}${me ? 'You' : esc(m.name)}</span>`;
  }).join('') || '<em>Nobody</em>';
  const total = na + nh + nt;
  return `<div class="gpk${open ? ' open' : ''}">
    <button type="button" data-gs="${g.i}" aria-expanded="${open}" aria-label="Group pick’em: ${na} ${g.a}, ${nh} ${g.h}${nt ? ', ' + nt + ' tie' : ''}. Show who">
      <span class="n">${g.a} ${na}</span>
      <span class="gbar" title="${total} pick’em pick${total === 1 ? '' : 's'} in ${esc((groupById(active) || {}).name || 'your group')}">${seg(na, g.a)}${seg(nt, null, 't')}${seg(nh, g.h)}</span>
      <span class="n r">${nh} ${g.h}</span>
    </button>
    <div class="gwho"><div>${names('a')}</div><div class="r">${names('h')}</div>${nt ? `<div class="tie">Tie: ${names('t')}</div>` : ''}</div>
  </div>`;
};

['#games', '#games2', '#games3'].forEach(id => $(id).addEventListener('click', e => {
  const b = e.target.closest('[data-gs]'); if(!b) return;
  const gi = +b.dataset.gs;
  openStats.has(gi) ? openStats.delete(gi) : openStats.add(gi);
  b.parentElement.classList.toggle('open', openStats.has(gi));
  b.setAttribute('aria-expanded', openStats.has(gi));
}));

const PK_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>';

function paintPkBar(w){
  const bar = $('#grpBar');
  if(w == null || !sb){ bar.hidden = true; return; }
  if(!user){
    if(LS.get(CTA_KEY)){ bar.hidden = true; return; }
    bar.className = 'pkbar cta'; bar.hidden = false;
    bar.innerHTML = `<div class="pk-main"><span class="pk-ic">${PK_ICON}</span>
      <div class="pk-txt"><b>Play pick’em with friends</b><span>Sign in to enter weeks, join groups and keep your board on every device.</span></div>
      <div class="pk-acts"><button class="btn primary" type="button" data-act="signin">Sign in</button>
      <button class="btn ghost" type="button" data-act="nocta" aria-label="Dismiss">✕</button></div></div>`;
    return;
  }
  if(!pkLoaded){ bar.hidden = true; return; }
  const st = weekStatus(w);
  let line, sub, btns = '', cls = '';
  if(!st.open.length){
    cls = st.entered ? ' in' : ' closed';
    line = st.entered ? `Week ${w} pick’em: ${st.g ? `${st.c}–${st.g - st.c}` : `${st.entered} picks locked in`}` : `Week ${w} pick’em is closed`;
    sub = st.entered ? (st.g < st.entered ? `${st.entered - st.g} game${st.entered - st.g === 1 ? '' : 's'} still to play` : 'All graded') : 'Every game has kicked off.';
  }else if(!st.entered){
    line = `Week ${w} isn’t in your pick’em yet`;
    sub = st.boardOpen
      ? `Adds your ${st.boardOpen} board pick${st.boardOpen === 1 ? '' : 's'} for games that haven’t kicked off. Each one locks at kickoff.`
      : 'Pick the games below, then add them. Your board on its own never counts.';
    btns = `<button class="btn primary" type="button" data-act="add"${st.boardOpen ? '' : ' disabled'}>Add Week ${w} to pick’em</button>`;
  }else if(st.changes){
    cls = ' warn';
    line = `Week ${w} is in your pick’em · ${st.entered} of ${st.gs.length} games`;
    sub = `${st.changes} board change${st.changes === 1 ? '' : 's'} not in your pick’em yet.`;
    btns = `<button class="btn primary" type="button" data-act="add">Update pick’em</button>
      ${st.enteredOpen ? '<button class="btn ghost" type="button" data-act="withdraw">Remove</button>' : ''}`;
  }else{
    cls = ' in';
    line = `Week ${w} is in your pick’em · ${st.entered} of ${st.gs.length} games`;
    sub = 'Matches your board. Change a pick below and update before kickoff.';
    btns = st.enteredOpen ? '<button class="btn ghost" type="button" data-act="withdraw">Remove</button>' : '';
  }

  let grp = '';
  if(groupsLoaded && groups.length){
    const d = detail[active], n = d ? d.members.length : (groupById(active) || {}).n || 1;
    let entered = '';
    if(gp.data && d){
      const who = new Set();
      byWeek[w].forEach(g => Object.keys(gp.data[g.i] || {}).forEach(u => who.add(u)));
      entered = `<span><b>${who.size}</b> of ${n} entered</span>`;
    }
    grp = `<div class="pk-grp"><label for="grpSel">Group</label>
      <select id="grpSel">${groups.map(g => `<option value="${g.id}"${g.id === active ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
      ${entered}<button class="linkbtn" type="button" data-act="board">Leaderboard</button></div>`;
  }else if(groupsLoaded){
    grp = `<div class="pk-grp"><span>Compete with friends:</span><button class="linkbtn" type="button" data-act="create">Start a group</button></div>`;
  }
  bar.className = 'pkbar' + cls; bar.hidden = false;
  bar.innerHTML = `<div class="pk-main"><span class="pk-ic">${PK_ICON}</span>
    <div class="pk-txt"><b>${line}</b><span>${sub}</span></div>
    ${btns ? `<div class="pk-acts">${btns}</div>` : ''}</div>${grp}`;
}
$('#grpBar').addEventListener('change', e => { if(e.target.id === 'grpSel') setActive(e.target.value); });
$('#grpBar').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if(!b) return;
  const a = b.dataset.act;
  if(a === 'signin') authSheet('in');
  if(a === 'nocta'){ LS.set(CTA_KEY, 1); $('#grpBar').hidden = true; }
  if(a === 'create') createGroupSheet();
  if(a === 'add') submitWeek(S.week, b);
  if(a === 'withdraw') withdrawWeek(S.week);
  if(a === 'board'){ showTab('groups', true); window.scrollTo(0, 0); }
});

HOOKS.weekShown = w => {
  paintPkBar(w);
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
      : wk.p ? `<span class="muted">${wk.p} in</span>` : '<span class="muted">—</span>';
    const me = m.id === user.id;
    return `<tr class="${me ? 'me' : ''}">
      <td class="rk">${m.g ? rank : '–'}</td>
      <td class="nm"><div>${avatar(m)}<span class="who"><span>${me ? 'You' : esc(m.name)}</span><small>@${esc(m.username || '')}${m.id === g.owner_id ? ' · owner' : ''}</small></span>
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
    <p class="muted" style="margin:10px 0 0;font-size:12px">Scores count pick’em entries only: one point per correct pick, graded as games go final (a tie counts only if you picked the tie). Add a week from the Games tab; each pick locks at kickoff.</p>`;
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
        <li>Play with your board as much as you like; add a week to pick’em when you’re ready to count it.</li>
        <li>See how your group picked each game, and who’s leading.</li>
        <li>Your board, profile and saved brackets follow you to every device.</li>
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
        <div class="acts"><button class="btn" type="button" data-act="pick">Week ${currentWeek()} picks</button></div></div>
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

/* ==========================================================
   SAVED BRACKETS (snapshots of the board; nothing to do with pick'em)
   ========================================================== */
function paintBracketBtns(){
  $('#btnSavePo').hidden = !sb;
  $('#btnBrackets').hidden = !user;
}
async function loadBrackets(){
  const {data, error} = await sb.from('brackets').select('id,name,champion,created_at,data')
    .eq('season', SEASON).order('created_at', {ascending: false});
  if(error) throw error;
  brackets = data;
  return data;
}
const bracketRow = b => `
  <li>${b.champion && TEAMS[b.champion] ? logo(b.champion) : ''}
    <div class="bi"><b>${esc(b.name)}</b><span>${b.champion && TEAMS[b.champion] ? esc(TEAMS[b.champion].c + ' ' + TEAMS[b.champion].n) + ' · ' : ''}${new Date(b.created_at).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})}</span></div>
    <button class="btn" type="button" data-open="${b.id}">Open</button>
    <button class="btn ghost" type="button" data-del="${b.id}" aria-label="Delete ${esc(b.name)}">Delete</button></li>`;
// Open / Delete on a bracket row, wherever the list is shown; true if handled
function bracketClick(e){
  const o = e.target.closest('[data-open]'), d = e.target.closest('[data-del]');
  if(!o && !d) return false;
  const b = (brackets || []).find(x => x.id === (o || d).dataset[o ? 'open' : 'del']);
  if(!b) return true;
  (async () => {
    if(o){
      const ok = await ask({title: `Open “${b.name}”?`,
        body: 'This replaces your board and bracket with the saved ones. Your pick’em entries don’t change.',
        yes: 'Open', no: 'Cancel'});
      if(!ok) return;
      const snap = b.data || {};
      S.picks = Object.assign({}, snap.picks); S.po = Object.assign({}, snap.po); S.flips = Object.assign({}, snap.flips);
      closeSheet(); render(); showTab('playoffs', true); window.scrollTo(0, 0);
      toast(`Opened “${b.name}”.`);
    }else{
      const ok = await ask({title: `Delete “${b.name}”?`, body: 'This can’t be undone.', yes: 'Delete', no: 'Cancel'});
      if(!ok) return;
      const {error} = await sb.from('brackets').delete().eq('id', b.id);
      if(error) return toast(errText(error));
      brackets = brackets.filter(x => x.id !== b.id);
      d.closest('li').remove(); toast('Deleted.');
      if(curTab === 'profile') paintProfile();
    }
  })();
  return true;
}
$('#btnSavePo').addEventListener('click', () => {
  if(!user) return authSheet('up', 'Create an account to save your brackets.');
  const champ = S.po.sb;
  const def = champ ? `${TEAMS[champ].n} win it all` : `My bracket, ${new Date().toLocaleDateString(undefined, {month: 'short', day: 'numeric'})}`;
  const box = openSheet(`
    <h4 id="s2Title">Save this bracket</h4>
    <p>Saves your board, seeds and bracket as they are now, so you can come back to them.</p>
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
    brackets = null;
    closeSheet(); toast(`Saved “${name}”.`);
  });
});
$('#btnBrackets').addEventListener('click', async () => {
  const box = openSheet(`<h4 id="s2Title">Your saved brackets</h4><div data-list><p class="msg muted">Loading…</p></div>`);
  try{ await loadBrackets(); }catch(e){ return setMsg(box, errText(e), 'err'); }
  box.querySelector('[data-list]').innerHTML = brackets.length
    ? `<ul class="blist">${brackets.map(bracketRow).join('')}</ul>`
    : '<p>Nothing saved yet. Fill in a bracket and tap <b>Save</b> to keep a copy.</p>';
});
sheetBody.addEventListener('click', bracketClick);

/* ==========================================================
   SESSION
   ========================================================== */
function paint(){
  paintAccountBtn(); paintBracketBtns(); paintGroups();
  if(curTab === 'profile') paintProfile();
  paintPkBar(S.mode === 'week' ? S.week : null);
}
// keep the Groups and Profile pages fresh when they're opened
const onTab = name => {
  if(name === 'groups' && user && active) loadDetail(active, true);
  if(name === 'profile') openProfile();
};
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => onTab(t.dataset.tab)));
window.addEventListener('hashchange', () => onTab(location.hash.slice(1)));

async function onSession(session){
  const u = session ? session.user : null;
  if((u && u.id) === (user && user.id)) return;
  user = u; ready = false; profile = null; PK = {}; pkLoaded = false; groups = []; groupsLoaded = false; brackets = null;
  for(const id in detail) delete detail[id];
  gp.key = null; gp.data = null;
  if(!user){ LS.set(BOARD_KEY, null); render(); paint(); return; }
  paint();
  try{
    await Promise.all([loadProfile(), pullBoard(), loadPickem()]);
    ready = true; lastPull = Date.now();
  }catch(e){
    toast('Couldn’t reach your account. Your board is saved on this device.');
  }
  try{ await loadGroups(); }catch(e){ groupsLoaded = true; }
  render(); paint();
  if(curTab === 'profile') openProfile();
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
  paintGroups(); paintProfile();
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

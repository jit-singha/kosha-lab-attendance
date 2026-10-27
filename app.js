// Kosha Lab Attendance Tracker
import { createStore } from './store.js';
import { OWNER_EMAIL } from './firebase-config.js';

const PAGES = {
  punch: ['Check In', "Record today's attendance with time and location."],
  history: ['My Attendance', 'Your check-in history, late arrivals and locations.'],
  dashboard: ['Dashboard', 'Daily overview of attendance, late arrivals and locations.'],
  laptops: ['Laptops', 'Requests to take company laptops home, approvals and returns.'],
  members: ['Team & Access', 'Add members and choose who has admin access.'],
  settings: ['Settings', 'Configure shift timings and manage data.'],
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ---------- Helpers ----------
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const niceDate = (k) => new Date(k + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fmtMin = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(Math.round(m) % 60)}`;
const coords = (loc) => `${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`;
const hasPhoto = (u) => typeof u?.photo === 'string' && u.photo.startsWith('data:image/');
const avatar = (u, cls = '') => hasPhoto(u)
  ? `<img class="av ${cls}" src="${esc(u.photo)}" alt="${esc(u.name)}">`
  : `<div class="av ${cls}" style="background:${u?.color || '#8b5cff'}">${esc(initials(u?.name))}</div>`;

// Center-crop and shrink a picked image to a small JPEG data URL (kept in the user's profile).
function resizePhoto(file, size = 192) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('Please choose an image file.'));
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.width, img.height);
      const c = document.createElement('canvas');
      c.width = c.height = size;
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('Could not read that image. Try a JPG or PNG.'));
    img.src = URL.createObjectURL(file);
  });
}
const isOwner = (u) => !!OWNER_EMAIL && u?.email === OWNER_EMAIL.toLowerCase();

let store, me = null, settings = { start: '09:30', grace: 10 }, users = [];
const isAdmin = () => me?.role === 'admin';
const userById = (id) => users.find((u) => u.uid === id);
const lateCutoff = () => toMin(settings.start) + Number(settings.grace || 0);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

async function guard(fn, errEl) {
  try { if (errEl) errEl.textContent = ''; return await fn(); }
  catch (e) { errEl ? (errEl.textContent = e.message) : toast(e.message); }
}

// ---------- Location ----------
const GOOD_ACCURACY = 25;   // metres: stop sampling once a fix is this precise
const PRECISE_LIMIT = 100;  // metres: fixes worse than this are flagged as approximate

// Watch GPS for up to `ms`, keeping the most accurate fix.
function getPrecisePosition(onUpdate, ms = 15000) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject({ code: 0 });
    let best = null;
    const finish = () => { navigator.geolocation.clearWatch(watch); clearTimeout(timer); best ? resolve(best) : reject({ code: 3 }); };
    const watch = navigator.geolocation.watchPosition((p) => {
      if (!best || p.coords.accuracy < best.coords.accuracy) { best = p; onUpdate?.(Math.round(p.coords.accuracy)); }
      if (p.coords.accuracy <= GOOD_ACCURACY) finish();
    }, (err) => { if (err.code === 1 || !best) { navigator.geolocation.clearWatch(watch); clearTimeout(timer); reject(err); } },
    { enableHighAccuracy: true, timeout: ms, maximumAge: 0 });
    const timer = setTimeout(finish, ms);
  });
}

async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lng}`);
    const j = await r.json();
    const a = j.address || {};
    const street = [a.house_number, a.road].filter(Boolean).join(' ');
    const parts = [a.building || a.amenity || a.office, street, a.neighbourhood || a.suburb || a.quarter, a.city || a.town || a.village || a.county, a.state, a.postcode].filter(Boolean);
    return parts.join(', ') || j.display_name || null;
  } catch { return null; }
}

const GEO_ERRORS = {
  0: 'This browser does not support location.',
  1: 'Location permission was denied. Allow location access for this site, then try again.',
  2: 'Location is unavailable. Turn on device location / GPS and try again.',
  3: 'Could not get a GPS fix in time. Move near a window or outdoors and try again.',
};

async function locate() {
  if (!window.isSecureContext) throw new Error('Precise location needs HTTPS. Open the app from its https:// link.');
  try {
    const p = await getPrecisePosition((acc) => setStatus(`Getting precise location… current accuracy ±${acc} m`));
    const { latitude: lat, longitude: lng, accuracy } = p.coords;
    setStatus('Resolving address…');
    const place = await reverseGeocode(lat, lng);
    return { lat, lng, acc: Math.round(accuracy), place, source: 'gps', precise: accuracy <= PRECISE_LIMIT };
  } catch (e) {
    throw new Error(GEO_ERRORS[e.code] || e.message || GEO_ERRORS[2]);
  }
}

// ---------- Check in / out ----------
const setStatus = (msg, cls = '') => { const s = $('#punchStatus'); s.className = 'status-box ' + cls; s.innerHTML = msg; };

async function punch(kind) {
  const today = dayKey();
  const id = `${me.uid}_${today}`;
  let existing;
  try { existing = await store.getAttendance(id); } catch (e) { return setStatus(esc(e.message), 'err'); }
  if (kind === 'in' && existing) return setStatus(`You already checked in today at <b>${hm(existing.inTs)}</b>.`, 'err');
  if (kind === 'out' && !existing) return setStatus("You haven't checked in today.", 'err');
  if (kind === 'out' && existing.outTs) return setStatus(`You already checked out at <b>${hm(existing.outTs)}</b>.`, 'err');

  $('#btnIn').disabled = $('#btnOut').disabled = true;
  setStatus('Getting precise location…');
  try {
    const loc = await locate();
    const now = Date.now();
    if (kind === 'in') {
      const d = new Date(now);
      const mins = d.getHours() * 60 + d.getMinutes();
      const lateBy = Math.max(0, mins - toMin(settings.start));
      const late = mins > lateCutoff();
      await store.saveAttendance({ id, uid: me.uid, name: me.name, date: today, inTs: now, outTs: null, late, lateBy: late ? lateBy : 0, loc });
      const where = ` from <b>${esc(loc.place || coords(loc))}</b> <span class="muted">(${coords(loc)}, ±${loc.acc} m)</span>`;
      setStatus(late
        ? `Checked in at <b>${hm(now)}</b>${where} — <b>late by ${lateBy} min</b>.`
        : `Checked in at <b>${hm(now)}</b>${where} — on time.`, late ? 'late' : 'ok');
      toast(late ? 'Checked in (late)' : 'Checked in');
    } else {
      await store.saveAttendance({ id, outTs: now, outLoc: loc });
      setStatus(`Checked out at <b>${hm(now)}</b> from <b>${esc(loc.place || coords(loc))}</b>. Have a good evening, ${esc(me.name.split(' ')[0])}.`, 'ok');
      toast('Checked out');
    }
    renderRecent();
  } catch (e) {
    setStatus(`Not recorded — ${esc(e.message)}`, 'err');
  } finally {
    $('#btnIn').disabled = $('#btnOut').disabled = false;
  }
}

// ---------- Shared bits ----------
function statusPill(r) {
  if (!r) return '<span class="pill absent">Absent</span>';
  return r.late ? `<span class="pill late">Late · ${r.lateBy}m</span>` : '<span class="pill ontime">On time</span>';
}

function locCell(r) {
  const loc = r?.loc;
  if (!loc) return '<span class="muted">—</span>';
  const approx = loc.source === 'ip' || loc.precise === false;
  const acc = loc.acc != null ? `±${loc.acc} m` : 'IP based';
  return `<button class="loc" data-map="${esc(r.id)}">📍 ${esc(loc.place || coords(loc))}</button>
    <small class="coords">${coords(loc)} · <span class="${approx ? 'acc-bad' : 'acc-good'}">${approx ? 'approximate ' : ''}${acc}</span></small>`;
}

const mapRecords = new Map();
function openMap(r) {
  const loc = r.loc, d = 0.002;
  $('#mapTitle').textContent = `${userById(r.uid)?.name || r.name || 'Member'} — ${r.date} ${hm(r.inTs)}`;
  $('#mapAddr').textContent = loc.place || 'Address not available';
  $('#mapMeta').textContent = `${coords(loc)} · accuracy ±${loc.acc ?? '?'} m`;
  $('#mapFrame').src = `https://www.openstreetmap.org/export/embed.html?bbox=${loc.lng - d},${loc.lat - d},${loc.lng + d},${loc.lat + d}&layer=mapnik&marker=${loc.lat},${loc.lng}`;
  $('#mapGoogle').href = `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
  $('#mapModal').classList.add('open');
}
const closeMap = () => { $('#mapModal').classList.remove('open'); $('#mapFrame').src = 'about:blank'; };

// ---------- Renderers ----------
function renderPolicy() {
  $('#shiftLabel').textContent = settings.start;
  $('#graceLabel').textContent = settings.grace;
  $('#lateAfterLabel').textContent = fmtMin(lateCutoff());
}

async function myRecords() {
  return (await store.attendanceByUser(me.uid)).sort((a, b) => b.inTs - a.inTs);
}

async function renderRecent() {
  const recs = await guard(myRecords) || [];
  const events = recs.flatMap((r) => [{ t: r.inTs, label: r.late ? 'Late in' : 'In', cls: r.late ? 'late' : 'ontime', date: r.date }, ...(r.outTs ? [{ t: r.outTs, label: 'Out', cls: 'ontime', date: r.date }] : [])])
    .sort((a, b) => b.t - a.t).slice(0, 6);
  $('#recentList').innerHTML = events.length
    ? events.map((e) => `<li><span><span class="pill ${e.cls}">${e.label}</span></span><span class="t">${e.date.slice(5)} ${hm(e.t)}</span></li>`).join('')
    : '<li class="muted">No activity yet.</li>';
}

async function renderHistory() {
  const recs = await guard(myRecords) || [];
  recs.forEach((r) => mapRecords.set(r.id, r));
  $('#myPresent').textContent = recs.length;
  $('#myLate').textContent = recs.filter((r) => r.late).length;
  const avg = recs.length ? recs.reduce((s, r) => { const d = new Date(r.inTs); return s + d.getHours() * 60 + d.getMinutes(); }, 0) / recs.length : null;
  $('#myAvg').textContent = avg == null ? '—' : fmtMin(avg);
  $('#myBody').innerHTML = recs.length
    ? recs.map((r) => `<tr><td class="nowrap">${niceDate(r.date)}</td><td class="mono">${hm(r.inTs)}</td><td class="mono">${r.outTs ? hm(r.outTs) : '—'}</td><td>${statusPill(r)}</td><td>${locCell(r)}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">No attendance yet. Check in from the Check In page.</td></tr>';
}

async function renderDashboard() {
  const date = $('#dashDate').value || dayKey();
  const [logs, late] = await Promise.all([guard(() => store.attendanceByDate(date)), guard(() => store.lateRecords())]);
  if (!logs) return;
  logs.forEach((r) => mapRecords.set(r.id, r));
  const byUid = new Map(logs.map((l) => [l.uid, l]));
  const present = users.filter((u) => byUid.has(u.uid));
  const lateCount = present.filter((u) => byUid.get(u.uid).late).length;
  $('#stTotal').textContent = users.length;
  $('#stOnTime').textContent = present.length - lateCount;
  $('#stLate').textContent = lateCount;
  $('#stAbsent').textContent = users.length - present.length;
  $('#rateBadge').textContent = `${users.length ? Math.round((present.length / users.length) * 100) : 0}% present`;

  const rows = users.map((u) => {
    const l = byUid.get(u.uid);
    const who = `<div class="who">${avatar(u)}<div>${esc(u.name)}<small>${esc(u.dept || u.email)}</small></div></div>`;
    return { sort: l ? l.inTs : Infinity, html: `<tr><td>${who}</td><td class="mono">${l ? hm(l.inTs) : '—'}</td><td class="mono">${l?.outTs ? hm(l.outTs) : '—'}</td><td>${statusPill(l)}</td><td>${locCell(l)}</td></tr>` };
  }).sort((a, b) => a.sort - b.sort);
  $('#logBody').innerHTML = rows.length ? rows.map((r) => r.html).join('') : '<tr><td colspan="5" class="empty">No members yet.</td></tr>';

  const counts = users.map((u) => {
    const ls = (late || []).filter((l) => l.uid === u.uid);
    return { u, n: ls.length, mins: ls.reduce((s, l) => s + (l.lateBy || 0), 0) };
  }).filter((x) => x.n).sort((a, b) => b.n - a.n || b.mins - a.mins);
  const max = counts[0]?.n || 1;
  $('#lateBoard').innerHTML = counts.length
    ? counts.map((c) => `<div class="bar-row"><div class="who">${avatar(c.u)}<div>${esc(c.u.name)}<small>${c.mins} min total</small></div></div><div class="bar"><i style="width:${(c.n / max) * 100}%"></i></div><div class="n">${c.n}×</div></div>`).join('')
    : '<div class="empty">No late arrivals recorded.</div>';
}

function renderMembers() {
  const sorted = [...users].sort((a, b) => (b.role === 'admin') - (a.role === 'admin') || a.name.localeCompare(b.name));
  $('#memberList').innerHTML = sorted.map((u) => {
    const self = u.uid === me.uid, owner = isOwner(u);
    const roleBtn = owner || self ? '' : u.role === 'admin'
      ? `<button class="btn btn-ghost btn-xs" data-role="${u.uid}" data-to="member">Remove admin</button>`
      : `<button class="btn btn-ghost btn-xs" data-role="${u.uid}" data-to="admin">Make admin</button>`;
    const delBtn = owner || self ? '' : `<button class="del" data-del="${u.uid}" title="Remove member">✕</button>`;
    return `<div class="card member">
      <button class="photo-btn" data-photo="${u.uid}" title="Change photo">${avatar(u)}<span class="cam">📷</span></button>
      <div class="meta">
        <b>${esc(u.name)}${self ? ' <span class="muted">(you)</span>' : ''}</b>
        <small>${esc(u.email)}</small>
        <small>${esc([u.dept, u.empId].filter(Boolean).join(' · ') || 'Team member')}</small>
        <div class="member-actions"><span class="pill ${u.role === 'admin' ? 'admin' : 'member'}">${owner ? 'Owner' : u.role === 'admin' ? 'Admin' : 'Member'}</span>${roleBtn}</div>
      </div>
      ${delBtn}
    </div>`;
  }).join('') || '<div class="card empty">No members yet.</div>';
}

// Laptop request status, including derived "overdue".
function lpState(r) {
  if (r.status === 'approved') return r.returnBy < dayKey() ? 'overdue' : 'out';
  return r.status;
}
const LP_PILL = {
  pending: ['absent', 'Pending'], out: ['info', 'At home'], overdue: ['late', 'Overdue'],
  returned: ['ontime', 'Returned'], rejected: ['muted-pill', 'Rejected'],
};

async function renderLaptops() {
  const list = await guard(() => store.listLaptops(isAdmin() ? null : me.uid));
  if (!list) return;
  list.sort((a, b) => b.createdAt - a.createdAt);
  const states = list.map(lpState);
  $('#lpPending').textContent = states.filter((s) => s === 'pending').length;
  $('#lpOut').textContent = states.filter((s) => s === 'out' || s === 'overdue').length;
  $('#lpOverdue').textContent = states.filter((s) => s === 'overdue').length;
  $('#lpTitle').textContent = isAdmin() ? 'All laptop requests' : 'My laptop requests';

  const f = isAdmin() ? $('#lpFilter').value : 'all';
  const rows = list.filter((r) => f === 'all' || (f === 'out' ? ['out', 'overdue'].includes(lpState(r)) : lpState(r) === f));
  const cols = isAdmin() ? 6 : 4;
  $('#lpBody').innerHTML = rows.length ? rows.map((r) => {
    const st = lpState(r), [cls, label] = LP_PILL[st];
    const u = userById(r.uid);
    let extra = '';
    if (r.status === 'returned' && r.returnedAt) extra = `<small class="coords">on ${niceDate(dayKey(new Date(r.returnedAt)))}</small>`;
    if (r.decidedByName && r.status !== 'pending') extra += `<small class="coords">by ${esc(r.decidedByName)}</small>`;
    let action = '';
    if (st === 'pending') action = `<button class="btn btn-xs btn-approve" data-lp="${r.id}" data-act="approve">Approve</button><button class="btn btn-xs btn-ghost" data-lp="${r.id}" data-act="reject">Reject</button>`;
    else if (st === 'out' || st === 'overdue') action = `<button class="btn btn-xs btn-ghost" data-lp="${r.id}" data-act="return">Mark returned</button>`;
    return `<tr>
      ${isAdmin() ? `<td><div class="who">${avatar(u || { name: r.name })}<div>${esc(u?.name || r.name)}<small>${esc(u?.dept || '')}</small></div></div></td>` : ''}
      <td class="mono">${esc(r.asset)}</td>
      <td class="nowrap">${niceDate(r.takeOn)} →<br>${niceDate(r.returnBy)}</td>
      <td class="reason">${esc(r.reason)}</td>
      <td><span class="pill ${cls}">${label}</span>${extra}</td>
      ${isAdmin() ? `<td class="actions">${action}</td>` : ''}
    </tr>`;
  }).join('') : `<tr><td colspan="${cols}" class="empty">No laptop requests${f !== 'all' ? ' in this view' : ''}.</td></tr>`;
}

// ---------- Navigation ----------
let currentTab = 'punch';
function showTab(tab) {
  currentTab = tab;
  $$('.nav-item').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + tab));
  const [t, s] = PAGES[tab];
  $('#pageTitle').textContent = t; $('#pageSub').textContent = s;
  ({ punch: renderRecent, history: renderHistory, dashboard: renderDashboard, laptops: renderLaptops, members: renderMembers }[tab] || (() => {}))();
}

async function loadShared() {
  settings = (await guard(() => store.getSettings())) || settings;
  users = isAdmin() ? (await guard(() => store.listUsers())) || [] : [me];
  renderPolicy();
  $('#setStart').value = settings.start;
  $('#setGrace').value = settings.grace;
}

function renderMe() {
  $('#meAvatarBtn').innerHTML = avatar(me);
  $('#meName').textContent = me.name;
  $('#profileAvatar').innerHTML = avatar(me, 'av-xl');
  $('#profileName').textContent = me.name;
  $('#profileEmail').textContent = me.email;
  $('#btnRemovePhoto').hidden = !hasPhoto(me);
}

// ---------- Logo ----------
const LOGO_CACHE = 'koshalab.logo';
const DEFAULT_FAVICON = $('#favicon').href;
let logo = '';
try { logo = localStorage.getItem(LOGO_CACHE) || ''; } catch {}

// Shrink a logo to fit within `max` px, keeping its shape and transparency.
function resizeLogo(file, max = 256) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('Please choose an image file.'));
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Could not read that image. Try a PNG, JPG or SVG.'));
    img.src = URL.createObjectURL(file);
  });
}

function applyLogo(src) {
  logo = typeof src === 'string' && src.startsWith('data:image/') ? src : '';
  try { logo ? localStorage.setItem(LOGO_CACHE, logo) : localStorage.removeItem(LOGO_CACHE); } catch {}
  $$('.logo-mark').forEach((m) => {
    m.classList.toggle('has-logo', !!logo);
    m.innerHTML = logo ? `<img src="${esc(logo)}" alt="Kosha Lab logo">` : '<span></span>';
  });
  $('#logoPreview').innerHTML = logo ? `<img src="${esc(logo)}" alt="Current logo">` : '<span class="muted small">No logo yet</span>';
  $('#btnRemoveLogo').hidden = !logo;
  $('#favicon').href = logo || DEFAULT_FAVICON;
}

async function saveLogo(src) {
  if (await guard(async () => { await store.saveBranding({ logo: src }); return true; })) {
    applyLogo(src);
    toast(src ? 'Logo updated' : 'Logo removed');
  }
}

$('#btnUploadLogo').addEventListener('click', () => { $('#logoInput').value = ''; $('#logoInput').click(); });
$('#btnRemoveLogo').addEventListener('click', () => { if (confirm('Remove the logo?')) saveLogo(''); });
$('#logoInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const src = await guard(() => resizeLogo(file));
  if (src) await saveLogo(src);
});
applyLogo(logo);

// ---------- Profile photos ----------
let photoTarget = null; // uid whose photo is being changed

function pickPhoto(uid) {
  photoTarget = uid;
  $('#photoInput').value = '';
  $('#photoInput').click();
}

async function setPhoto(uid, photo) {
  const ok = await guard(async () => { await store.updateUser(uid, { photo }); return true; });
  if (!ok) return;
  const u = userById(uid);
  if (u) u.photo = photo;
  if (uid === me.uid) { me.photo = photo; renderMe(); }
  if (currentTab === 'members') renderMembers();
  if (currentTab === 'dashboard') renderDashboard();
  toast(photo ? 'Photo updated' : 'Photo removed');
}

$('#photoInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file || !photoTarget) return;
  const photo = await guard(() => resizePhoto(file));
  if (photo) await setPhoto(photoTarget, photo);
});

$('#meAvatarBtn').addEventListener('click', () => $('#profileModal').classList.add('open'));
$('#profileClose').addEventListener('click', () => $('#profileModal').classList.remove('open'));
$('#profileModal').addEventListener('click', (e) => { if (e.target.id === 'profileModal') $('#profileModal').classList.remove('open'); });
$('#btnUploadPhoto').addEventListener('click', () => pickPhoto(me.uid));
$('#btnRemovePhoto').addEventListener('click', () => setPhoto(me.uid, ''));

async function enterApp(profile) {
  me = profile;
  $('#boot').hidden = true;
  $('#authScreen').hidden = true;
  $('#removedScreen').hidden = true;
  $('#appShell').hidden = false;
  $('#demoBanner').hidden = store.mode !== 'demo';
  renderMe();
  $('#meRole').textContent = isOwner(me) ? 'Owner' : isAdmin() ? 'Admin' : 'Member';
  $('#meRole').className = 'pill ' + (isAdmin() ? 'admin' : 'member');
  $('#helloName').textContent = me.name.split(' ')[0];
  $$('[data-admin-only]').forEach((el) => { el.hidden = !isAdmin(); });
  $$('[data-member-only]').forEach((el) => { el.hidden = isAdmin(); });
  await loadShared();
  const allowed = [...$$('.nav-item')].filter((n) => !n.hidden).map((n) => n.dataset.tab);
  showTab(allowed.includes(currentTab) ? currentTab : 'punch');
}

function showAuth() {
  me = null;
  $('#boot').hidden = true;
  $('#appShell').hidden = true;
  $('#removedScreen').hidden = true;
  $('#authScreen').hidden = false;
  $('#authNote').textContent = store.mode === 'demo'
    ? 'Demo mode: accounts are stored in this browser only. The first account created becomes the admin.'
    : 'New here? Create an account, then ask an admin if you need admin access.';
}

// ---------- Events ----------
let authMode = 'signin';
$$('.seg-btn').forEach((b) => b.addEventListener('click', () => {
  authMode = b.dataset.auth;
  $$('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  $('.signup-only').hidden = authMode !== 'signup';
  $('#aName').required = authMode === 'signup';
  $('#aPass').autocomplete = authMode === 'signup' ? 'new-password' : 'current-password';
  $('#authBtn').textContent = authMode === 'signup' ? 'Create account' : 'Sign in';
  $('#authErr').textContent = '';
}));

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#authBtn');
  btn.disabled = true;
  await guard(() => authMode === 'signup'
    ? store.signUp({ name: $('#aName').value.trim(), email: $('#aEmail').value, password: $('#aPass').value })
    : store.signIn($('#aEmail').value, $('#aPass').value), $('#authErr'));
  btn.disabled = false;
});

$$('.js-signout').forEach((b) => b.addEventListener('click', () => { $('#aPass').value = ''; store.signOut(); }));
$$('.nav-item').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('#btnIn').addEventListener('click', () => punch('in'));
$('#btnOut').addEventListener('click', () => punch('out'));
$('#dashDate').addEventListener('change', renderDashboard);

$('#btnExport').addEventListener('click', async () => {
  const date = $('#dashDate').value || dayKey();
  const logs = await guard(() => store.attendanceByDate(date));
  if (!logs) return;
  const byUid = new Map(logs.map((l) => [l.uid, l]));
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Date', 'Name', 'Email', 'Employee ID', 'Department', 'Check in', 'Check out', 'Status', 'Late by (min)', 'Address', 'Latitude', 'Longitude', 'Accuracy (m)', 'Google Maps'].join(',')];
  [...users].sort((a, b) => a.name.localeCompare(b.name)).forEach((u) => {
    const l = byUid.get(u.uid), loc = l?.loc;
    lines.push([date, u.name, u.email, u.empId, u.dept, l ? hm(l.inTs) : '', l?.outTs ? hm(l.outTs) : '',
      l ? (l.late ? 'Late' : 'On time') : 'Absent', l?.late ? l.lateBy : '',
      loc?.place, loc?.lat, loc?.lng, loc?.acc, loc ? `https://www.google.com/maps?q=${loc.lat},${loc.lng}` : ''].map(q).join(','));
  });
  // The BOM makes Excel read the file as UTF-8 so addresses keep their characters.
  const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `kosha-lab-attendance-${date}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${users.length} member${users.length === 1 ? '' : 's'} for ${niceDate(date)}`);
});

document.addEventListener('click', (e) => {
  const id = e.target.closest('[data-map]')?.dataset.map;
  const r = id && mapRecords.get(id);
  if (r?.loc) openMap(r);
});
$('#mapClose').addEventListener('click', closeMap);
$('#mapModal').addEventListener('click', (e) => { if (e.target.id === 'mapModal') closeMap(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMap(); $('#profileModal').classList.remove('open'); } });

// Team
$('#memberForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  const name = $('#mName').value.trim();
  const ok = await guard(async () => {
    await store.createMember({ name, email: $('#mEmail').value, empId: $('#mId').value.trim(), dept: $('#mDept').value.trim(), role: $('#mRole').value }, $('#mPass').value);
    return true;
  }, $('#memberErr'));
  btn.disabled = false;
  if (!ok) return;
  e.target.reset();
  users = await store.listUsers();
  renderMembers();
  toast(`${name} added`);
});

$('#memberList').addEventListener('click', async (e) => {
  const photoBtn = e.target.closest('[data-photo]');
  if (photoBtn) return pickPhoto(photoBtn.dataset.photo);
  const roleBtn = e.target.closest('[data-role]');
  const delBtn = e.target.closest('[data-del]');
  if (roleBtn) {
    const u = userById(roleBtn.dataset.role), to = roleBtn.dataset.to;
    const q = to === 'admin' ? `Give admin access to ${u.name}? They will be able to see everyone's attendance and manage the team.` : `Remove admin access from ${u.name}?`;
    if (!confirm(q)) return;
    if (await guard(async () => { await store.updateUser(u.uid, { role: to }); return true; })) {
      u.role = to; renderMembers(); toast(to === 'admin' ? `${u.name} is now an admin` : `${u.name} is now a member`);
    }
  } else if (delBtn) {
    const u = userById(delBtn.dataset.del);
    if (!confirm(`Remove ${u.name} from Kosha Lab? They will no longer be able to use the app.`)) return;
    if (await guard(async () => { await store.removeUser(u.uid); return true; })) {
      users = users.filter((x) => x.uid !== u.uid); renderMembers(); toast(`${u.name} removed`);
    }
  }
});

// Laptops
$('#lpFrom').value = dayKey();
$('#laptopForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const takeOn = $('#lpFrom').value, returnBy = $('#lpTo').value;
  if (returnBy < takeOn) return toast('Return date must be on or after the take-home date.');
  const ok = await guard(async () => {
    await store.addLaptop({ uid: me.uid, name: me.name, asset: $('#lpAsset').value.trim().toUpperCase(), reason: $('#lpReason').value.trim(), takeOn, returnBy, status: 'pending', createdAt: Date.now() });
    return true;
  });
  if (!ok) return;
  e.target.reset();
  $('#lpFrom').value = dayKey();
  renderLaptops();
  toast('Request submitted for admin approval');
});

$('#lpFilter').addEventListener('change', renderLaptops);
$('#lpBody').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-lp]');
  if (!b) return;
  const act = b.dataset.act;
  const patch = act === 'return'
    ? { status: 'returned', returnedAt: Date.now() }
    : { status: act === 'approve' ? 'approved' : 'rejected', decidedBy: me.uid, decidedByName: me.name, decidedAt: Date.now() };
  if (act === 'return' && !confirm('Confirm the laptop has been returned?')) return;
  if (await guard(async () => { await store.updateLaptop(b.dataset.lp, patch); return true; })) {
    renderLaptops();
    toast({ approve: 'Request approved', reject: 'Request rejected', return: 'Marked as returned' }[act]);
  }
});

// Settings
$('#btnSave').addEventListener('click', async () => {
  const v = { start: $('#setStart').value || '09:30', grace: Math.max(0, parseInt($('#setGrace').value, 10) || 0) };
  if (await guard(async () => { await store.saveSettings(v); return true; })) { settings = { ...settings, ...v }; renderPolicy(); toast('Settings saved'); }
});
$('#btnWipe').addEventListener('click', async () => {
  if (!confirm('Delete ALL attendance logs for everyone? This cannot be undone.')) return;
  if (await guard(async () => { await store.clearAttendance(); return true; })) toast('Logs cleared');
});

// ---------- Clock ----------
function tick() {
  const d = new Date();
  $('#clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  $('#ringTime').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $('#date').textContent = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
setInterval(tick, 1000); tick();

// ---------- Background: animated particle network ----------
const cv = $('#bg'), ctx = cv.getContext('2d');
let W, H, pts;
function resize() {
  W = cv.width = innerWidth; H = cv.height = innerHeight;
  const n = Math.min(90, Math.floor((W * H) / 18000));
  pts = Array.from({ length: n }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35 }));
}
function frame() {
  ctx.clearRect(0, 0, W, H);
  for (const p of pts) {
    p.x += p.vx; p.y += p.vy;
    if (p.x < 0 || p.x > W) p.vx *= -1;
    if (p.y < 0 || p.y > H) p.vy *= -1;
  }
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < 140) { ctx.strokeStyle = `rgba(139,92,255,${(1 - d / 140) * .25})`; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
    ctx.fillStyle = 'rgba(34,230,255,.7)';
    ctx.beginPath(); ctx.arc(pts[i].x, pts[i].y, 1.6, 0, Math.PI * 2); ctx.fill();
  }
  requestAnimationFrame(frame);
}
addEventListener('resize', resize); resize(); frame();

// ---------- Boot ----------
$('#dashDate').value = dayKey();
try {
  store = await createStore();
  // Public read; if it fails (e.g. rules not updated yet) keep the cached logo.
  store.getBranding().then((b) => applyLogo(b.logo)).catch(() => {});
  store.onAuth((s) => {
    if (!s) return showAuth();
    if (!s.profile) {
      $('#boot').hidden = true; $('#authScreen').hidden = true; $('#appShell').hidden = true;
      $('#removedScreen').hidden = false;
      return;
    }
    enterApp(s.profile);
  });
} catch (e) {
  $('#boot').textContent = 'Could not start the app: ' + e.message;
}

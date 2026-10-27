// Kosha Lab Attendance Tracker
import { createStore } from './store.js';
import { OWNER_EMAIL } from './firebase-config.js';

const PAGES = {
  punch: ['Check In', "Record today's attendance with time and location."],
  history: ['My Attendance', 'Your check-in history, late arrivals and locations.'],
  dashboard: ['Dashboard', 'Daily overview of attendance, late arrivals and locations.'],
  laptops: ['Laptops', 'Requests to take company laptops home, approvals and returns.'],
  devices: ['Devices', 'Daily device deployments, where they went, and damage reports.'],
  members: ['Team & Access', 'Add members and choose their access: member, operator or admin.'],
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
const initials = (n) => String(n || '?').split(/\s+/).map((w) => w.match(/[\p{L}\p{N}]/u)?.[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
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

let store, me = null, settings = { start: '09:30', nightStart: '21:00', grace: 10 }, users = [];
const isAdmin = () => me?.role === 'admin';
const DEPTS = ['Operations', 'IT', 'Data Analysis'];
const deptOf = (u) => DEPTS.find((d) => d.toLowerCase() === String(u?.dept || '').trim().toLowerCase()) || '';
// Everyone in Operations (and admins) logs devices and damage; the IT department can view them.
const isOperator = () => isAdmin() || deptOf(me) === 'Operations';
const canSeeDevices = () => isOperator() || deptOf(me) === 'IT';
const ROLE_LABEL = { admin: 'Admin', operator: 'Operator', member: 'Member' };
const ROLE_RANK = { admin: 0, operator: 1, member: 2 };
const roleLabel = (u) => (isOwner(u) ? 'Owner' : ROLE_LABEL[u.role] || 'Member');
const userById = (id) => users.find((u) => u.uid === id);

// ---------- Shifts ----------
const SHIFT_LABEL = { day: '☀ Day', night: '☾ Night' };
const shiftOf = (u) => (u?.shift === 'night' ? 'night' : 'day');
const shiftStart = (s) => (s === 'night' ? settings.nightStart || '21:00' : settings.start);
const lateCutoff = (s = shiftOf(me)) => toMin(shiftStart(s)) + Number(settings.grace || 0);
const fmtLate = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
const shiftPill = (s) => `<span class="pill shift-${s}">${SHIFT_LABEL[s]}</span>`;

// Where a moment falls relative to a shift's start. Minutes are wrapped to ±12 h, so a night-shift
// check-out at 06:00 belongs to the shift that started at 21:00 the evening before.
function shiftTiming(ts, s) {
  const d = new Date(ts);
  let diff = d.getHours() * 60 + d.getMinutes() - toMin(shiftStart(s));
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;
  return { diff, date: dayKey(new Date(ts - diff * 60000)), late: diff > Number(settings.grace || 0), lateBy: Math.max(0, diff) };
}

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

async function locate(onStatus = setStatus) {
  if (!window.isSecureContext) throw new Error('Precise location needs HTTPS. Open the app from its https:// link.');
  try {
    const p = await getPrecisePosition((acc) => onStatus(`Getting precise location… current accuracy ±${acc} m`));
    const { latitude: lat, longitude: lng, accuracy } = p.coords;
    onStatus('Resolving address…');
    const place = await reverseGeocode(lat, lng);
    return { lat, lng, acc: Math.round(accuracy), place, source: 'gps', precise: accuracy <= PRECISE_LIMIT };
  } catch (e) {
    throw new Error(GEO_ERRORS[e.code] || e.message || GEO_ERRORS[2]);
  }
}

// ---------- Check in / out ----------
const setStatus = (msg, cls = '') => { const s = $('#punchStatus'); s.className = 'status-box ' + cls; s.innerHTML = msg; };

const OPEN_SHIFT_MS = 20 * 3600 * 1000; // a check-in older than this no longer counts as the current shift

async function punch(kind) {
  let shift = shiftOf(me);
  let id, existing;
  try {
    if (kind === 'in') {
      const date = shiftTiming(Date.now(), shift).date; // night shifts after midnight belong to the previous date
      id = `${me.uid}_${date}`;
      existing = await store.getAttendance(id);
      if (existing) return setStatus(`You already checked in for this ${SHIFT_LABEL[existing.shift || shift]} shift at <b>${hm(existing.inTs)}</b>.`, 'err');
    } else {
      // Check out of the most recent shift, whichever shift and date it was recorded on.
      existing = (await myRecords()).find((r) => Date.now() - r.inTs < OPEN_SHIFT_MS);
      if (!existing) return setStatus("You haven't checked in for a shift yet.", 'err');
      if (existing.outTs) return setStatus(`You already checked out at <b>${hm(existing.outTs)}</b>.`, 'err');
      id = existing.id;
      shift = existing.shift || shift;
    }
  } catch (e) { return setStatus(esc(e.message), 'err'); }

  $('#btnIn').disabled = $('#btnOut').disabled = true;
  setStatus('Getting precise location…');
  try {
    const loc = await locate();
    const now = Date.now();
    if (kind === 'in') {
      const { late, lateBy, date } = shiftTiming(now, shift);
      await store.saveAttendance({ id, uid: me.uid, name: me.name, date, shift, inTs: now, outTs: null, late, lateBy: late ? lateBy : 0, loc });
      const where = ` from <b>${esc(loc.place || coords(loc))}</b> <span class="muted">(${coords(loc)}, ±${loc.acc} m)</span>`;
      setStatus(late
        ? `Checked in at <b>${hm(now)}</b>${where} — <b>late by ${fmtLate(lateBy)}</b>.`
        : `Checked in at <b>${hm(now)}</b>${where} — on time.`, late ? 'late' : 'ok');
      toast(late ? 'Checked in (late)' : 'Checked in');
    } else {
      await store.saveAttendance({ id, outTs: now, outLoc: loc });
      setStatus(`Checked out at <b>${hm(now)}</b> from <b>${esc(loc.place || coords(loc))}</b>. ${shift === 'night' ? 'Get some good rest' : 'Have a good evening'}, ${esc(me.name.split(' ')[0])}.`, 'ok');
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
  return r.late ? `<span class="pill late">Late · ${fmtLate(r.lateBy)}</span>` : '<span class="pill ontime">On time</span>';
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
  const s = shiftOf(me);
  $$('.seg-btn[data-shift]').forEach((b) => b.classList.toggle('active', b.dataset.shift === s));
  $('#myShiftLabel').textContent = `${SHIFT_LABEL[s]} shift`;
  $('#shiftLabel').textContent = shiftStart(s);
  $('#graceLabel').textContent = settings.grace;
  $('#lateAfterLabel').textContent = fmtMin(lateCutoff(s));
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

const inDashDept = (u) => {
  const d = $('#dashDept').value;
  return d === 'all' || (d === 'none' ? !deptOf(u) : deptOf(u) === d);
};

// Everyone for the selected date, department and shift filters. A person's shift is the one their
// check-in was recorded on; people who haven't checked in are listed under their current shift.
function dashRoster(logs) {
  const byUid = new Map(logs.map((l) => [l.uid, l]));
  const f = $('#dashShift').value;
  return users.filter(inDashDept).map((u) => {
    const rec = byUid.get(u.uid);
    return { u, rec, shift: rec?.shift || shiftOf(u) };
  }).filter((x) => f === 'all' || x.shift === f);
}

async function renderDashboard() {
  const date = $('#dashDate').value || dayKey();
  const [logs, late] = await Promise.all([guard(() => store.attendanceByDate(date)), guard(() => store.lateRecords())]);
  if (!logs) return;
  logs.forEach((r) => mapRecords.set(r.id, r));
  const roster = dashRoster(logs);
  const present = roster.filter((x) => x.rec);
  const lateCount = present.filter((x) => x.rec.late).length;
  $('#stTotal').textContent = roster.length;
  $('#stOnTime').textContent = present.length - lateCount;
  $('#stLate').textContent = lateCount;
  $('#stAbsent').textContent = roster.length - present.length;
  $('#rateBadge').textContent = `${roster.length ? Math.round((present.length / roster.length) * 100) : 0}% present`;

  const rows = roster.map(({ u, rec: l, shift }) => {
    const who = `<div class="who">${avatar(u)}<div>${esc(u.name)}<small>${esc(deptOf(u) || u.email)}</small></div></div>`;
    return { sort: l ? l.inTs : Infinity, html: `<tr><td>${who}</td><td>${shiftPill(shift)}</td><td class="mono">${l ? hm(l.inTs) : '—'}</td><td class="mono">${l?.outTs ? hm(l.outTs) : '—'}</td><td>${statusPill(l)}</td><td>${locCell(l)}</td></tr>` };
  }).sort((a, b) => a.sort - b.sort);
  $('#logBody').innerHTML = rows.length ? rows.map((r) => r.html).join('') : `<tr><td colspan="6" class="empty">${users.length ? 'Nobody matches these filters.' : 'No members yet.'}</td></tr>`;

  const counts = users.filter(inDashDept).map((u) => {
    const ls = (late || []).filter((l) => l.uid === u.uid);
    return { u, n: ls.length, mins: ls.reduce((s, l) => s + (l.lateBy || 0), 0) };
  }).filter((x) => x.n).sort((a, b) => b.n - a.n || b.mins - a.mins);
  const max = counts[0]?.n || 1;
  $('#lateBoard').innerHTML = counts.length
    ? counts.map((c) => `<div class="bar-row"><div class="who">${avatar(c.u)}<div>${esc(c.u.name)}<small>${c.mins} min total</small></div></div><div class="bar"><i style="width:${(c.n / max) * 100}%"></i></div><div class="n">${c.n}×</div></div>`).join('')
    : '<div class="empty">No late arrivals recorded.</div>';
}

function renderRotation() {
  $('#rotDay').textContent = users.filter((u) => shiftOf(u) === 'day').length;
  $('#rotNight').textContent = users.filter((u) => shiftOf(u) === 'night').length;
  const r = settings.lastRotation;
  $('#rotLast').textContent = r ? `Last rotated on ${niceDate(dayKey(new Date(r.at)))} at ${hm(r.at)} by ${r.by}.` : '';
}

function renderMembers() {
  renderRotation();
  const sorted = [...users].sort((a, b) => (ROLE_RANK[a.role] ?? 2) - (ROLE_RANK[b.role] ?? 2) || a.name.localeCompare(b.name));
  $('#memberList').innerHTML = sorted.map((u) => {
    const self = u.uid === me.uid, owner = isOwner(u);
    const roleBtn = owner || self ? '' : `<select class="small-select role-select" data-role-select="${u.uid}" title="Change access">
        ${Object.entries(ROLE_LABEL).map(([v, l]) => `<option value="${v}"${(u.role || 'member') === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select>`;
    const shiftSel = `<select class="small-select dept-select shift-sel-${shiftOf(u)}" data-shift-select="${u.uid}" title="Shift">
        ${Object.entries(SHIFT_LABEL).map(([v, l]) => `<option value="${v}"${shiftOf(u) === v ? ' selected' : ''}>${l} shift</option>`).join('')}
      </select>`;
    const dept = deptOf(u);
    const deptSel = `<select class="small-select dept-select" data-dept-select="${u.uid}" title="Department">
        <option value=""${dept ? '' : ' selected'}>No department</option>
        ${DEPTS.map((d) => `<option${dept === d ? ' selected' : ''}>${d}</option>`).join('')}
      </select>`;
    const delBtn = owner || self ? '' : `<button class="del" data-del="${u.uid}" title="Remove member">✕</button>`;
    return `<div class="card member">
      <button class="photo-btn" data-photo="${u.uid}" title="Change photo">${avatar(u)}<span class="cam">📷</span></button>
      <div class="meta">
        <b>${esc(u.name)}${self ? ' <span class="muted">(you)</span>' : ''}</b>
        <small>${esc(u.email)}</small>
        ${u.empId ? `<small>${esc(u.empId)}</small>` : ''}
        <div class="member-actions"><span class="pill role-${u.role || 'member'}">${roleLabel(u)}</span>${roleBtn}${deptSel}${shiftSel}</div>
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

const lpFilterValue = () => (isAdmin() ? $('#lpFilter').value : 'all');
const lpMatches = (r, f) => f === 'all' || (f === 'out' ? ['out', 'overdue'].includes(lpState(r)) : lpState(r) === f);

async function exportLaptops() {
  const list = await guard(() => store.listLaptops(isAdmin() ? null : me.uid));
  if (!list) return;
  const f = lpFilterValue();
  const d = (ts) => (ts ? niceDate(dayKey(new Date(ts))) : '');
  const t = (ts) => (ts ? hm(ts) : '');
  const rows = list.filter((r) => lpMatches(r, f)).sort((a, b) => b.createdAt - a.createdAt).map((r) => {
    const u = userById(r.uid);
    const decided = ['approved', 'rejected', 'returned'].includes(r.status);
    return [u?.name || r.name, u?.email, u?.empId, u?.dept, r.asset, r.reason,
      d(r.createdAt), t(r.createdAt), niceDate(r.takeOn), niceDate(r.returnBy), LP_PILL[lpState(r)][1],
      decided ? r.decidedByName : '', decided ? d(r.decidedAt) : '', decided ? t(r.decidedAt) : '',
      d(r.returnedAt), t(r.returnedAt)];
  });
  const label = f === 'all' ? 'all' : $('#lpFilter').selectedOptions[0].text.toLowerCase().replace(/\s+/g, '-');
  downloadCsv(`kosha-lab-laptops-${label}-${dayKey()}.csv`,
    ['Name', 'Email', 'Employee ID', 'Department', 'Laptop ID', 'Reason', 'Requested date', 'Requested time',
      'Taking home on', 'Return by', 'Status', 'Approved / rejected by', 'Decision date', 'Decision time', 'Returned date', 'Returned time'], rows);
  toast(`Exported ${rows.length} laptop request${rows.length === 1 ? '' : 's'}`);
}

async function renderLaptops() {
  const list = await guard(() => store.listLaptops(isAdmin() ? null : me.uid));
  if (!list) return;
  list.sort((a, b) => b.createdAt - a.createdAt);
  const states = list.map(lpState);
  $('#lpPending').textContent = states.filter((s) => s === 'pending').length;
  $('#lpOut').textContent = states.filter((s) => s === 'out' || s === 'overdue').length;
  $('#lpOverdue').textContent = states.filter((s) => s === 'overdue').length;
  $('#lpTitle').textContent = isAdmin() ? 'All laptop requests' : 'My laptop requests';

  const f = lpFilterValue();
  const rows = list.filter((r) => lpMatches(r, f));
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
  ({ punch: renderRecent, history: renderHistory, dashboard: renderDashboard, laptops: renderLaptops, devices: loadDevices, members: renderMembers }[tab] || (() => {}))();
}

async function loadShared() {
  settings = (await guard(() => store.getSettings())) || settings;
  users = isAdmin() ? (await guard(() => store.listUsers())) || [] : [me];
  renderPolicy();
  $('#setStart').value = settings.start;
  $('#setNightStart').value = settings.nightStart || '21:00';
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

let deptSkipped = false;
$$('[data-pick-dept]').forEach((b) => b.addEventListener('click', async () => {
  const dept = b.dataset.pickDept;
  if (!confirm(`Set your department to ${dept}? Only an admin can change it after this.`)) return;
  if (await guard(async () => { await store.updateUser(me.uid, { dept }); return true; })) {
    me.dept = dept;
    const u = userById(me.uid);
    if (u) u.dept = dept;
    $('#deptModal').classList.remove('open');
    toast(`Department set to ${dept}`);
    enterApp(me); // refresh what this department can see (e.g. Devices for IT)
  }
}));
$('#deptLater').addEventListener('click', () => { deptSkipped = true; $('#deptModal').classList.remove('open'); });

async function enterApp(profile) {
  me = profile;
  $('#boot').hidden = true;
  $('#authScreen').hidden = true;
  $('#removedScreen').hidden = true;
  $('#appShell').hidden = false;
  $('#demoBanner').hidden = store.mode !== 'demo';
  renderMe();
  $('#meRole').textContent = roleLabel(me);
  $('#meRole').className = 'pill role-' + (me.role || 'member');
  $('#helloName').textContent = me.name.split(' ')[0];
  setStatus('Ready when you are.'); // don't show the previous person's message on a shared device
  $$('[data-admin-only]').forEach((el) => { el.hidden = !isAdmin(); });
  $$('[data-devices-nav]').forEach((el) => { el.hidden = !canSeeDevices(); });
  $$('[data-logger-only]').forEach((el) => { el.hidden = !isOperator(); });
  $('#devViewOnly').hidden = isOperator();
  $$('[data-member-only]').forEach((el) => { el.hidden = isAdmin(); });
  await loadShared();
  // People who signed up before departments existed choose theirs once. Admins can skip.
  $('#deptLater').hidden = !isAdmin();
  $('#deptModal').classList.toggle('open', !deptOf(me) && !deptSkipped);
  const allowed = [...$$('.nav-item')].filter((n) => !n.hidden).map((n) => n.dataset.tab);
  showTab(allowed.includes(currentTab) ? currentTab : 'punch');
}

function showAuth() {
  me = null;
  deptSkipped = false;
  $('#deptModal').classList.remove('open');
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
$$('.seg-btn[data-auth]').forEach((b) => b.addEventListener('click', () => {
  authMode = b.dataset.auth;
  $$('.seg-btn[data-auth]').forEach((x) => x.classList.toggle('active', x === b));
  $$('.signup-only').forEach((el) => { el.hidden = authMode !== 'signup'; });
  $('#aName').required = $('#aDept').required = authMode === 'signup';
  $('#aPass').autocomplete = authMode === 'signup' ? 'new-password' : 'current-password';
  $('#authBtn').textContent = authMode === 'signup' ? 'Create account' : 'Sign in';
  $('#authErr').textContent = '';
}));

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#authBtn');
  btn.disabled = true;
  await guard(() => authMode === 'signup'
    ? store.signUp({ name: $('#aName').value.trim(), email: $('#aEmail').value, password: $('#aPass').value, dept: $('#aDept').value })
    : store.signIn($('#aEmail').value, $('#aPass').value), $('#authErr'));
  btn.disabled = false;
});

$$('.js-signout').forEach((b) => b.addEventListener('click', () => { $('#aPass').value = ''; store.signOut(); }));
$$('.nav-item').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
// Members pick the shift they're working; it's saved on their profile so it stays selected next time.
$$('.seg-btn[data-shift]').forEach((b) => b.addEventListener('click', async () => {
  const to = b.dataset.shift;
  if (to === shiftOf(me)) return;
  if (await guard(async () => { await store.updateUser(me.uid, { shift: to }); return true; })) {
    me.shift = to;
    const u = userById(me.uid);
    if (u) u.shift = to;
    renderPolicy();
    setStatus(`You're on the <b>${SHIFT_LABEL[to]} shift</b> — starts ${shiftStart(to)}, late after ${fmtMin(lateCutoff(to))}.`);
  }
}));
$('#btnIn').addEventListener('click', () => punch('in'));
$('#btnOut').addEventListener('click', () => punch('out'));
$('#dashDate').addEventListener('change', renderDashboard);
$('#dashShift').addEventListener('change', renderDashboard);
$('#dashDept').addEventListener('change', renderDashboard);

$('#btnExport').addEventListener('click', async () => {
  const date = $('#dashDate').value || dayKey();
  const logs = await guard(() => store.attendanceByDate(date));
  if (!logs) return;
  const f = $('#dashShift').value;
  const rows = dashRoster(logs).sort((a, b) => a.u.name.localeCompare(b.u.name)).map(({ u, rec: l, shift }) => {
    const loc = l?.loc;
    return [date, u.name, u.email, u.empId, deptOf(u), shift === 'night' ? 'Night' : 'Day', l ? hm(l.inTs) : '', l?.outTs ? hm(l.outTs) : '',
      l ? (l.late ? 'Late' : 'On time') : 'Absent', l?.late ? l.lateBy : '',
      loc?.place, loc?.lat, loc?.lng, loc?.acc, loc ? `https://www.google.com/maps?q=${loc.lat},${loc.lng}` : ''];
  });
  const d = $('#dashDept').value;
  const deptPart = d === 'all' ? '' : `-${(d === 'none' ? 'no-department' : d).toLowerCase().replace(/\s+/g, '-')}`;
  downloadCsv(`kosha-lab-attendance-${date}${deptPart}${f === 'all' ? '' : `-${f}-shift`}.csv`,
    ['Date', 'Name', 'Email', 'Employee ID', 'Department', 'Shift', 'Check in', 'Check out', 'Status', 'Late by (min)', 'Address', 'Latitude', 'Longitude', 'Accuracy (m)', 'Google Maps'], rows);
  toast(`Exported ${rows.length} member${rows.length === 1 ? '' : 's'} for ${niceDate(date)}`);
});

function downloadCsv(filename, header, rows) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const text = [header, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
  // The BOM makes Excel read the file as UTF-8 so names and addresses keep their characters.
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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
    if ($('#mRole').value === 'operator' && $('#mDept').value !== 'Operations') throw new Error('Operators must be in the Operations department.');
    await store.createMember({ name, email: $('#mEmail').value, empId: $('#mId').value.trim(), dept: $('#mDept').value, role: $('#mRole').value, shift: $('#mShift').value }, $('#mPass').value);
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
  const delBtn = e.target.closest('[data-del]');
  if (delBtn) {
    const u = userById(delBtn.dataset.del);
    if (!confirm(`Remove ${u.name} from Kosha Lab? They will no longer be able to use the app.`)) return;
    if (await guard(async () => { await store.removeUser(u.uid); return true; })) {
      users = users.filter((x) => x.uid !== u.uid); renderMembers(); toast(`${u.name} removed`);
    }
  }
});

const ROLE_CONFIRM = {
  admin: (n) => `Give admin access to ${n}? They will see everyone's attendance, devices and laptops, and can manage the team.`,
  operator: (n, d) => `Make ${n} an operator?${d !== 'Operations' ? '\n\nOperators are part of Operations, so their department will be set to Operations — which also lets them log device deployments and damage reports.' : ''}`,
  member: (n) => `Make ${n} a regular member? They will lose any admin or operator access.`,
};

async function changeMember(u, patch, msg) {
  if (await guard(async () => { await store.updateUser(u.uid, patch); return true; })) {
    Object.assign(u, patch);
    if (u.uid === me.uid) Object.assign(me, patch);
    toast(msg);
  }
  renderMembers();
}

$('#memberList').addEventListener('change', async (e) => {
  const roleSel = e.target.closest('[data-role-select]');
  const deptSel = e.target.closest('[data-dept-select]');
  const shiftSel = e.target.closest('[data-shift-select]');
  if (shiftSel) {
    const u = userById(shiftSel.dataset.shiftSelect), to = shiftSel.value;
    await changeMember(u, { shift: to }, `${u.name} is now on ${SHIFT_LABEL[to]} shift`);
    if (u.uid === me.uid) renderPolicy();
  } else if (roleSel) {
    const u = userById(roleSel.dataset.roleSelect), to = roleSel.value;
    if (!confirm(ROLE_CONFIRM[to](u.name, deptOf(u)))) return renderMembers();
    const patch = to === 'operator' ? { role: to, dept: 'Operations' } : { role: to };
    await changeMember(u, patch, `${u.name} is now ${to === 'admin' || to === 'operator' ? 'an' : 'a'} ${ROLE_LABEL[to].toLowerCase()}`);
  } else if (deptSel) {
    const u = userById(deptSel.dataset.deptSelect), to = deptSel.value;
    const patch = { dept: to };
    if (u.role === 'operator' && to !== 'Operations') {
      if (!confirm(`Operators are part of Operations. Moving ${u.name} to ${to || 'no department'} will make them a regular member. Continue?`)) return renderMembers();
      patch.role = 'member';
    }
    await changeMember(u, patch, `${u.name} moved to ${to || 'no department'}`);
  }
});

// Rotate: everyone on Day moves to Night and vice versa.
$('#btnRotate').addEventListener('click', async () => {
  const day = users.filter((u) => shiftOf(u) === 'day').length, night = users.length - day;
  if (!users.length) return;
  if (!confirm(`Rotate shifts for all ${users.length} people?\n\n${day} on Day shift → Night\n${night} on Night shift → Day\n\nPast attendance keeps the shift it was recorded on.`)) return;
  const btn = $('#btnRotate');
  btn.disabled = true;
  const ok = await guard(async () => {
    await Promise.all(users.map((u) => store.updateUser(u.uid, { shift: shiftOf(u) === 'day' ? 'night' : 'day' })));
    const lastRotation = { at: Date.now(), by: me.name };
    await store.saveSettings({ lastRotation });
    settings.lastRotation = lastRotation;
    return true;
  });
  btn.disabled = false;
  users = (await guard(() => store.listUsers())) || users;
  const mine = userById(me.uid);
  if (mine) me.shift = mine.shift;
  renderPolicy();
  renderMembers();
  if (ok) toast('Shifts rotated');
});

// Picking Operator in the add form puts the new member in Operations.
$('#mRole').addEventListener('change', () => { if ($('#mRole').value === 'operator') $('#mDept').value = 'Operations'; });
$('#mDept').addEventListener('change', () => { if ($('#mDept').value !== 'Operations' && $('#mRole').value === 'operator') $('#mRole').value = 'member'; });

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
$('#btnExportLaptops').addEventListener('click', exportLaptops);
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

// ---------- Devices (operators + admins) ----------
const DEVICE_TYPES = ['03W', 'Pi', 'Cubic'];
const DAMAGE_STATUS = {
  reported: ['late', 'Reported'], repair: ['absent', 'Under repair'],
  repaired: ['ontime', 'Repaired'], scrapped: ['muted-pill', 'Scrapped'],
};
const devData = { deployments: [], damages: [] };
const devEditing = { deployments: null, damages: null };
let devView = 'deployments';
let depGeo = null; // GPS fix attached to the deployment being entered
let devFormsFor = null; // uid the device forms were last prepared for

const canEditRec = (r) => isAdmin() || (isOperator() && r.uid === me.uid);
const devScopeDate = () => $('#devDate').value || dayKey();
const inDevScope = (r) => $('#devAll').checked || r.date === devScopeDate();
const byNewest = (a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0));
const stamp = (ts) => (ts ? `${niceDate(dayKey(new Date(ts)))} ${hm(ts)}` : '');
const mapsUrl = (g) => `https://www.google.com/maps?q=${g.lat},${g.lng}`;

// One record can hold a mix of device types, e.g. { '03W': 5, Pi: 12, Cubic: 3 }.
// Older single-type records ({ type, qty }) are read the same way.
const countsOf = (r) => r.counts || (r.type ? { [r.type]: r.qty } : {});
const totalOf = (r) => DEVICE_TYPES.reduce((s, t) => s + (countsOf(r)[t] || 0), 0);
// The operator who took the devices; older records fall back to whoever logged them.
const cleanName = (n) => String(n || '').trim().replace(/\s+/g, ' ');
const takenOf = (r) => cleanName(r.takenBy) || r.name || '';
const userByName = (n) => users.find((u) => u.name.toLowerCase() === n.toLowerCase());
// Match a typed name to a known spelling ("asha rao" -> "Asha Rao") so totals group together.
const canonName = (n) => {
  const c = cleanName(n);
  const known = [...$('#operatorNames').options].map((o) => o.value).find((v) => v.toLowerCase() === c.toLowerCase());
  return known || userByName(c)?.name || c;
};
const deviceChips = (r) => DEVICE_TYPES.filter((t) => countsOf(r)[t] > 0)
  .map((t) => `<span class="pill dev">${t} × ${countsOf(r)[t]}</span>`).join(' ');

function buildCounts(box) {
  box.innerHTML = DEVICE_TYPES.map((t) => `<label class="count"><span>${t}</span><input type="number" min="0" step="1" inputmode="numeric" placeholder="0" data-type="${t}"></label>`).join('')
    + '<div class="count-total">Total <b>0</b></div>';
  box.addEventListener('input', () => { box.querySelector('.count-total b').textContent = readCounts(box).total; });
}
function readCounts(box) {
  const counts = {};
  let total = 0, bad = false;
  box.querySelectorAll('input[data-type]').forEach((i) => {
    const v = i.value.trim() === '' ? 0 : Number(i.value);
    if (!Number.isInteger(v) || v < 0) bad = true;
    counts[i.dataset.type] = Number.isInteger(v) && v > 0 ? v : 0;
    total += counts[i.dataset.type];
  });
  return { counts, total, bad };
}
function fillCounts(box, counts = {}) {
  box.querySelectorAll('input[data-type]').forEach((i) => { i.value = counts[i.dataset.type] || ''; });
  box.querySelector('.count-total b').textContent = DEVICE_TYPES.reduce((s, t) => s + (counts[t] || 0), 0);
}
buildCounts($('#depCounts'));
buildCounts($('#dmgCounts'));

const DEV_FORMS = {
  deployments: {
    title: '#depFormTitle', titles: ['Log a deployment', 'Edit deployment'],
    submit: '#depSubmit', submits: ['Add deployment', 'Save changes'], cancel: '#depCancel', counts: '#depCounts',
    by: '#depBy',
    read: () => ({ date: $('#depDate').value, takenBy: canonName($('#depBy').value), location: $('#depLoc').value.trim(), notes: $('#depNotes').value.trim(), geo: depGeo }),
    fill: (r) => { $('#depDate').value = r.date; $('#depBy').value = takenOf(r); fillCounts($('#depCounts'), countsOf(r)); $('#depLoc').value = r.location; $('#depNotes').value = r.notes || ''; depGeo = r.geo || null; },
    clear: () => { $('#depForm').reset(); fillCounts($('#depCounts')); $('#depDate').value = devScopeDate(); $('#depBy').value = me?.name || ''; depGeo = null; },
  },
  damages: {
    title: '#dmgFormTitle', titles: ['Report damaged devices', 'Edit damage report'],
    submit: '#dmgSubmit', submits: ['Add damage report', 'Save changes'], cancel: '#dmgCancel', counts: '#dmgCounts',
    by: '#dmgBy',
    read: () => ({ date: $('#dmgDate').value, takenBy: canonName($('#dmgBy').value), ids: $('#dmgIds').value.trim(), issue: $('#dmgIssue').value.trim(), status: $('#dmgStatus').value }),
    fill: (r) => { $('#dmgDate').value = r.date; $('#dmgBy').value = takenOf(r); fillCounts($('#dmgCounts'), countsOf(r)); $('#dmgIds').value = r.ids || ''; $('#dmgIssue').value = r.issue; $('#dmgStatus').value = r.status || 'reported'; },
    clear: () => { $('#dmgForm').reset(); fillCounts($('#dmgCounts')); $('#dmgDate').value = devScopeDate(); $('#dmgBy').value = me?.name || ''; },
  },
};

// Suggest known names in the "Taken by" fields: team members (admins see everyone) and names used before.
function refreshOperatorNames() {
  const names = new Map();
  const add = (n) => { const c = cleanName(n); if (c) names.set(c.toLowerCase(), c); };
  users.filter((u) => deptOf(u) === 'Operations' || u.role === 'operator' || u.uid === me.uid).forEach((u) => add(u.name));
  [...devData.deployments, ...devData.damages].forEach((r) => add(takenOf(r)));
  $('#operatorNames').innerHTML = [...names.values()].sort((a, b) => a.localeCompare(b)).map((n) => `<option value="${esc(n)}"></option>`).join('');
}

function setDevEditing(c, rec) {
  const f = DEV_FORMS[c];
  devEditing[c] = rec?.id || null;
  rec ? f.fill(rec) : f.clear();
  $(f.title).textContent = f.titles[rec ? 1 : 0];
  $(f.submit).textContent = f.submits[rec ? 1 : 0];
  $(f.cancel).hidden = !rec;
  if (rec) $(f.title).scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function loadDevices() {
  const [dep, dmg] = await Promise.all([guard(() => store.listRecords('deployments')), guard(() => store.listRecords('damages'))]);
  devData.deployments = dep || [];
  devData.damages = dmg || [];
  // A different person signed in on this device: start their forms fresh with their own name.
  if (devFormsFor !== me.uid) {
    devFormsFor = me.uid;
    setDevEditing('deployments', null);
    setDevEditing('damages', null);
  }
  for (const c of ['deployments', 'damages']) {
    if (!devEditing[c] && !$(DEV_FORMS[c].by).value) $(DEV_FORMS[c].by).value = me.name;
  }
  refreshOperatorNames();
  renderDevices();
}

function operatorCell(r) {
  const who = takenOf(r);
  const u = userByName(who) || { name: who, color: '#5b8cff' };
  const notes = [];
  if (r.name && r.name.toLowerCase() !== who.toLowerCase()) notes.push(`logged by ${esc(r.name)}`);
  if (r.updatedByName && r.updatedByName !== r.name) notes.push(`edited by ${esc(r.updatedByName)}`);
  return `<div class="who">${avatar(u)}<div>${esc(who)}${notes.map((n) => `<small>${n}</small>`).join('')}</div></div>`;
}

const recActions = (c, r) => (canEditRec(r)
  ? `<button class="btn btn-xs btn-ghost" data-dev-edit="${c}:${r.id}">Edit</button><button class="del" data-dev-del="${c}:${r.id}" title="Delete">✕</button>`
  : '');

function renderDevices() {
  const scoped = { deployments: devData.deployments.filter(inDevScope), damages: devData.damages.filter(inDevScope) };
  $('#sumTitle').textContent = $('#devAll').checked ? 'Summary — all dates' : `Summary — ${niceDate(devScopeDate())}`;
  for (const c of ['deployments', 'damages']) {
    let total = 0;
    for (const t of DEVICE_TYPES) {
      const n = scoped[c].reduce((s, r) => s + (countsOf(r)[t] || 0), 0);
      total += n;
      $(`[data-sum="${c}:${t}"]`).textContent = n;
    }
    $(`[data-sum="${c}:total"]`).textContent = total;
  }

  renderOperatorSummary(scoped);

  const dep = scoped.deployments.sort(byNewest);
  $('#depBody').innerHTML = dep.length ? dep.map((r) => `<tr>
      <td class="nowrap">${niceDate(r.date)}</td>
      <td>${operatorCell(r)}</td>
      <td class="chips">${deviceChips(r)}</td>
      <td class="mono">${totalOf(r)}</td>
      <td class="reason">${r.geo ? `<a class="loc" href="${mapsUrl(r.geo)}" target="_blank" rel="noopener">📍 ${esc(r.location)}</a><small class="coords">${coords(r.geo)} · ±${r.geo.acc} m</small>` : esc(r.location)}</td>
      <td class="reason">${esc(r.notes || '')}</td>
      <td class="actions">${recActions('deployments', r)}</td>
    </tr>`).join('') : `<tr><td colspan="7" class="empty">No deployments logged${$('#devAll').checked ? '' : ' for this date'}.</td></tr>`;

  const dmg = scoped.damages.sort(byNewest);
  $('#dmgBody').innerHTML = dmg.length ? dmg.map((r) => {
    const [cls, label] = DAMAGE_STATUS[r.status] || DAMAGE_STATUS.reported;
    const status = canEditRec(r)
      ? `<select class="small-select status-select st-${r.status || 'reported'}" data-dmg-status="${r.id}">${Object.entries(DAMAGE_STATUS).map(([v, [, l]]) => `<option value="${v}"${(r.status || 'reported') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`
      : `<span class="pill ${cls}">${label}</span>`;
    return `<tr>
      <td class="nowrap">${niceDate(r.date)}</td>
      <td>${operatorCell(r)}</td>
      <td class="chips">${deviceChips(r)}</td>
      <td class="mono">${totalOf(r)}</td>
      <td class="mono small-cell">${esc(r.ids || '—')}</td>
      <td class="reason">${esc(r.issue)}</td>
      <td>${status}</td>
      <td class="actions">${recActions('damages', r)}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="8" class="empty">No damage reported${$('#devAll').checked ? '' : ' for this date'}.</td></tr>`;
}

// Totals per operator (the person who took the devices), per device type.
function operatorTotals(scoped) {
  const ops = new Map();
  const row = (r) => {
    const name = takenOf(r), key = name.toLowerCase();
    if (!ops.has(key)) ops.set(key, { name: userByName(name)?.name || name, deployments: {}, damages: {} });
    return ops.get(key);
  };
  for (const c of ['deployments', 'damages']) {
    for (const r of scoped[c]) {
      const o = row(r), counts = countsOf(r);
      for (const t of DEVICE_TYPES) o[c][t] = (o[c][t] || 0) + (counts[t] || 0);
    }
  }
  const tot = (m) => DEVICE_TYPES.reduce((s, t) => s + (m[t] || 0), 0);
  return [...ops.values()]
    .map((o) => ({ ...o, depTotal: tot(o.deployments), dmgTotal: tot(o.damages) }))
    .sort((a, b) => b.depTotal - a.depTotal || b.dmgTotal - a.dmgTotal || a.name.localeCompare(b.name));
}

function renderOperatorSummary(scoped) {
  $('#opSumTitle').textContent = $('#devAll').checked ? 'By operator — all dates' : `By operator — ${niceDate(devScopeDate())}`;
  const ops = operatorTotals(scoped);
  const cells = (m, total, cls) => DEVICE_TYPES.map((t) => `<td class="${cls}${m[t] ? '' : ' zero'}">${m[t] || 0}</td>`).join('') + `<td class="${cls} tot">${total}</td>`;
  $('#opSumBody').innerHTML = ops.length ? ops.map((o) => {
    const u = userByName(o.name) || { name: o.name, color: '#5b8cff' };
    return `<tr><td><div class="who">${avatar(u)}<div>${esc(o.name)}</div></div></td>${cells(o.deployments, o.depTotal, 'dep')}${cells(o.damages, o.dmgTotal, 'dmg')}</tr>`;
  }).join('') : `<tr><td colspan="9" class="empty">No records${$('#devAll').checked ? '' : ' for this date'}.</td></tr>`;
}

$('#btnExportOps').addEventListener('click', () => {
  const ops = operatorTotals({ deployments: devData.deployments.filter(inDevScope), damages: devData.damages.filter(inDevScope) });
  const scope = $('#devAll').checked ? 'All dates' : niceDate(devScopeDate());
  const rows = ops.map((o) => [scope, o.name,
    ...DEVICE_TYPES.map((t) => o.deployments[t] || 0), o.depTotal,
    ...DEVICE_TYPES.map((t) => o.damages[t] || 0), o.dmgTotal]);
  downloadCsv(`kosha-lab-operators-${$('#devAll').checked ? 'all' : devScopeDate()}.csv`,
    ['Date', 'Operator', ...DEVICE_TYPES.map((t) => `${t} deployed`), 'Total deployed', ...DEVICE_TYPES.map((t) => `${t} damaged`), 'Total damaged'], rows);
  toast(`Exported ${rows.length} operator${rows.length === 1 ? '' : 's'}`);
});

function showDevView(v) {
  devView = v;
  $$('.seg-btn[data-dev]').forEach((b) => b.classList.toggle('active', b.dataset.dev === v));
  $$('.dev-view').forEach((el) => { el.hidden = el.id !== 'dev-' + v; });
}

async function saveDevRecord(c) {
  const { counts, total, bad } = readCounts($(DEV_FORMS[c].counts));
  if (bad) return toast('Device numbers must be whole numbers (0 or more).');
  if (!total) return toast('Enter how many 03W, Pi or Cubic devices — at least one.');
  const data = { ...DEV_FORMS[c].read(), counts, qty: total };
  if (!data.date) return toast('Please pick a date.');
  if (!data.takenBy) return toast('Please enter the name of the operator.');
  const id = devEditing[c];
  const ok = await guard(async () => {
    if (id) await store.updateRecord(c, id, { ...data, updatedAt: Date.now(), updatedBy: me.uid, updatedByName: me.name });
    else await store.addRecord(c, { ...data, uid: me.uid, name: me.name, createdAt: Date.now() });
    return true;
  });
  if (!ok) return;
  toast(id ? 'Changes saved' : c === 'deployments' ? 'Deployment logged' : 'Damage report added');
  setDevEditing(c, null);
  await loadDevices();
}

$$('.seg-btn[data-dev]').forEach((b) => b.addEventListener('click', () => showDevView(b.dataset.dev)));
$('#devDate').addEventListener('change', () => {
  // New entries default to the date being viewed; half-filled forms keep their other fields.
  if (!devEditing.deployments) $('#depDate').value = devScopeDate();
  if (!devEditing.damages) $('#dmgDate').value = devScopeDate();
  renderDevices();
});
$('#devAll').addEventListener('change', renderDevices);
$('#depForm').addEventListener('submit', (e) => { e.preventDefault(); saveDevRecord('deployments'); });
$('#dmgForm').addEventListener('submit', (e) => { e.preventDefault(); saveDevRecord('damages'); });
$('#depCancel').addEventListener('click', () => setDevEditing('deployments', null));
$('#dmgCancel').addEventListener('click', () => setDevEditing('damages', null));
$('#depLoc').addEventListener('input', () => { depGeo = null; }); // typed location replaces any GPS fix

$('#depGps').addEventListener('click', async () => {
  const btn = $('#depGps'), label = btn.textContent;
  btn.disabled = true;
  try {
    const loc = await locate((msg) => { btn.textContent = msg.replace('Getting precise location… current accuracy', 'GPS'); });
    depGeo = { lat: loc.lat, lng: loc.lng, acc: loc.acc };
    $('#depLoc').value = loc.place || coords(loc);
    toast(`Location captured (±${loc.acc} m)`);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

$('#tab-devices').addEventListener('click', async (e) => {
  const ed = e.target.closest('[data-dev-edit]'), del = e.target.closest('[data-dev-del]');
  if (ed) {
    const [c, id] = ed.dataset.devEdit.split(':');
    showDevView(c);
    setDevEditing(c, devData[c].find((r) => r.id === id));
  } else if (del) {
    const [c, id] = del.dataset.devDel.split(':');
    if (!confirm(c === 'deployments' ? 'Delete this deployment record?' : 'Delete this damage report?')) return;
    if (await guard(async () => { await store.deleteRecord(c, id); return true; })) {
      if (devEditing[c] === id) setDevEditing(c, null);
      toast('Record deleted');
      loadDevices();
    }
  }
});

$('#dmgBody').addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-dmg-status]');
  if (!sel) return;
  const r = devData.damages.find((x) => x.id === sel.dataset.dmgStatus);
  const status = sel.value;
  if (await guard(async () => { await store.updateRecord('damages', r.id, { status, updatedAt: Date.now(), updatedBy: me.uid, updatedByName: me.name }); return true; })) {
    Object.assign(r, { status, updatedAt: Date.now(), updatedByName: me.name });
    toast(`Status set to ${DAMAGE_STATUS[status][1]}`);
    renderDevices();
  } else sel.value = r.status || 'reported';
});

$('#btnExportDep').addEventListener('click', () => {
  const rows = devData.deployments.filter(inDevScope).sort(byNewest).map((r) => [
    niceDate(r.date), takenOf(r), ...DEVICE_TYPES.map((t) => countsOf(r)[t] || 0), totalOf(r),
    r.location, r.geo?.lat, r.geo?.lng, r.geo?.acc, r.geo ? mapsUrl(r.geo) : '',
    r.notes, r.name, stamp(r.createdAt), stamp(r.updatedAt), r.updatedByName]);
  downloadCsv(`kosha-lab-deployments-${$('#devAll').checked ? 'all' : devScopeDate()}.csv`,
    ['Date', 'Taken by (operator)', ...DEVICE_TYPES, 'Total devices', 'Location', 'Latitude', 'Longitude', 'Accuracy (m)', 'Google Maps', 'Notes', 'Logged by', 'Logged at', 'Last edited at', 'Last edited by'], rows);
  toast(`Exported ${rows.length} deployment record${rows.length === 1 ? '' : 's'}`);
});

$('#btnExportDmg').addEventListener('click', () => {
  const rows = devData.damages.filter(inDevScope).sort(byNewest).map((r) => [
    niceDate(r.date), takenOf(r), ...DEVICE_TYPES.map((t) => countsOf(r)[t] || 0), totalOf(r),
    r.ids, r.issue, (DAMAGE_STATUS[r.status] || DAMAGE_STATUS.reported)[1],
    r.name, stamp(r.createdAt), stamp(r.updatedAt), r.updatedByName]);
  downloadCsv(`kosha-lab-damage-${$('#devAll').checked ? 'all' : devScopeDate()}.csv`,
    ['Date', 'Operator', ...DEVICE_TYPES.map((t) => `${t} damaged`), 'Total damaged', 'Device IDs', 'Issue', 'Status', 'Reported by', 'Reported at', 'Last updated at', 'Last updated by'], rows);
  toast(`Exported ${rows.length} damage report${rows.length === 1 ? '' : 's'}`);
});

$('#devDate').value = dayKey();
DEV_FORMS.deployments.clear();
DEV_FORMS.damages.clear();

// Settings
$('#btnSave').addEventListener('click', async () => {
  const v = { start: $('#setStart').value || '09:30', nightStart: $('#setNightStart').value || '21:00', grace: Math.max(0, parseInt($('#setGrace').value, 10) || 0) };
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

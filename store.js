// Data layer. Uses Firebase (Auth + Firestore) when configured, otherwise a local demo store.
// Both implement the same async API so the UI doesn't care which one is active.
import { firebaseConfig, OWNER_EMAIL } from './firebase-config.js';

const DEFAULT_SETTINGS = { start: '09:30', nightStart: '21:00', grace: 10 };
const COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
const pickColor = (s) => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const isOwnerEmail = (email) => !!OWNER_EMAIL && email.toLowerCase() === OWNER_EMAIL.toLowerCase();

function profileFor(uid, { name, email, empId = '', dept = '', role = 'member', shift = 'day' }) {
  return { uid, name, email: email.toLowerCase(), empId, dept, shift, role: isOwnerEmail(email) ? 'admin' : role, color: pickColor(email), createdAt: Date.now() };
}

const friendly = (e) => {
  const code = e?.code || '';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'Incorrect email or password.';
  if (code.includes('email-already-in-use')) return 'An account with this email already exists.';
  if (code.includes('weak-password')) return 'Password must be at least 6 characters.';
  if (code.includes('invalid-email')) return 'Please enter a valid email address.';
  if (code.includes('permission-denied')) return 'You do not have permission to do that.';
  if (code.includes('too-many-requests')) return 'Too many attempts. Please wait a minute and try again.';
  return e?.message || 'Something went wrong.';
};

export async function createStore() {
  // ?demo in the URL forces the local demo store (handy for trying things without touching real data).
  const configured = !!firebaseConfig.apiKey && !new URLSearchParams(location.search).has('demo');
  const store = configured ? await firebaseStore() : localStore();
  // Normalise error messages for the UI.
  for (const k of Object.keys(store)) {
    if (typeof store[k] !== 'function' || k === 'onAuth') continue;
    const fn = store[k];
    store[k] = async (...a) => { try { return await fn(...a); } catch (e) { throw new Error(friendly(e)); } };
  }
  return store;
}

// ---------------------------------------------------------------- Local demo store
function localStore() {
  const KEY = 'koshalab.demo.v1';
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  let s = { accounts: {}, users: {}, attendance: {}, laptops: {}, settings: { ...DEFAULT_SETTINGS }, session: null, ...read() };
  const write = () => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const err = (code) => Object.assign(new Error(code), { code });
  let listener = () => {};
  const emit = () => listener(s.session && s.users[s.session] ? { uid: s.session, profile: s.users[s.session] } : s.session ? { uid: s.session, profile: null } : null);

  function makeAccount(data, password) {
    const email = data.email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw err('invalid-email');
    if (password.length < 6) throw err('weak-password');
    if (s.accounts[email]) throw err('email-already-in-use');
    const id = uid();
    // In demo mode the very first account becomes the admin.
    const role = Object.keys(s.users).length === 0 ? 'admin' : data.role || 'member';
    s.accounts[email] = { uid: id, password };
    s.users[id] = profileFor(id, { ...data, email, role });
    write();
    return id;
  }

  return {
    mode: 'demo',
    onAuth(cb) { listener = cb; setTimeout(emit, 0); },
    async signUp({ name, email, password, dept = '' }) { s.session = makeAccount({ name, email, dept }, password); write(); emit(); },
    async signIn(email, password) {
      const a = s.accounts[email.trim().toLowerCase()];
      if (!a || a.password !== password) throw err('invalid-credential');
      s.session = a.uid; write(); emit();
    },
    async signOut() { s.session = null; write(); emit(); },
    async createMember(data, password) { makeAccount(data, password); },
    async listUsers() { return Object.values(s.users); },
    async updateUser(id, patch) { Object.assign(s.users[id], patch); write(); },
    async removeUser(id) {
      const u = s.users[id];
      delete s.users[id];
      if (u) delete s.accounts[u.email];
      write();
    },
    async getSettings() { return { ...DEFAULT_SETTINGS, ...s.settings }; },
    async saveSettings(v) { s.settings = { ...s.settings, ...v }; write(); },
    async getBranding() { return s.branding || {}; },
    async saveBranding(v) { s.branding = { ...s.branding, ...v }; write(); },
    async getAttendance(id) { return s.attendance[id] || null; },
    async saveAttendance(rec) { s.attendance[rec.id] = { ...s.attendance[rec.id], ...rec }; write(); },
    async attendanceByDate(date) { return Object.values(s.attendance).filter((r) => r.date === date); },
    async attendanceByUser(id) { return Object.values(s.attendance).filter((r) => r.uid === id); },
    async lateRecords() { return Object.values(s.attendance).filter((r) => r.late); },
    async clearAttendance() { s.attendance = {}; write(); },
    async addLaptop(rec) { const id = uid(); s.laptops[id] = { ...rec, id }; write(); },
    async listLaptops(forUid) { return Object.values(s.laptops).filter((r) => !forUid || r.uid === forUid); },
    async updateLaptop(id, patch) { Object.assign(s.laptops[id], patch); write(); },
    // Generic records (device deployments, damage reports).
    async listRecords(c) { return Object.values(s[c] || {}); },
    async addRecord(c, rec) { const id = uid(); s[c] = { ...s[c], [id]: { ...rec, id } }; write(); },
    async updateRecord(c, id, patch) { Object.assign(s[c][id], patch); write(); },
    async deleteRecord(c, id) { delete s[c][id]; write(); },
  };
}

// ---------------------------------------------------------------- Firebase store
async function firebaseStore() {
  const V = '10.12.2';
  const base = `https://www.gstatic.com/firebasejs/${V}`;
  const [{ initializeApp, deleteApp }, A, F] = await Promise.all([
    import(`${base}/firebase-app.js`), import(`${base}/firebase-auth.js`), import(`${base}/firebase-firestore.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  const col = (n) => F.collection(db, n);
  const ref = (n, id) => F.doc(db, n, id);
  const all = async (q) => (await F.getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));
  let signingUp = null;

  return {
    mode: 'firebase',
    onAuth(cb) {
      A.onAuthStateChanged(auth, async (u) => {
        if (!u) return cb(null);
        if (signingUp) await signingUp.catch(() => {});
        const snap = await F.getDoc(ref('users', u.uid)).catch(() => null);
        let profile = snap?.exists() ? snap.data() : null;
        // The owner gets a profile automatically if theirs is missing.
        if (!profile && isOwnerEmail(u.email)) {
          profile = profileFor(u.uid, { name: u.email.split('@')[0], email: u.email });
          await F.setDoc(ref('users', u.uid), profile);
        }
        cb({ uid: u.uid, profile });
      });
    },
    async signUp({ name, email, password, dept = '' }) {
      signingUp = (async () => {
        const cred = await A.createUserWithEmailAndPassword(auth, email.trim(), password);
        await F.setDoc(ref('users', cred.user.uid), profileFor(cred.user.uid, { name, email: email.trim(), dept }));
      })();
      try { await signingUp; } finally { signingUp = null; }
    },
    async signIn(email, password) { await A.signInWithEmailAndPassword(auth, email.trim(), password); },
    async signOut() { await A.signOut(auth); },
    async createMember(data, password) {
      // A second app instance creates the account without signing the admin out.
      const app2 = initializeApp(firebaseConfig, 'create-' + Date.now());
      try {
        const a2 = A.getAuth(app2);
        const cred = await A.createUserWithEmailAndPassword(a2, data.email.trim(), password);
        await F.setDoc(ref('users', cred.user.uid), profileFor(cred.user.uid, { ...data, email: data.email.trim() }));
        await A.signOut(a2);
      } finally { await deleteApp(app2); }
    },
    async listUsers() { return all(col('users')); },
    async updateUser(id, patch) { await F.updateDoc(ref('users', id), patch); },
    async removeUser(id) { await F.deleteDoc(ref('users', id)); },
    async getSettings() { const d = await F.getDoc(ref('settings', 'app')); return { ...DEFAULT_SETTINGS, ...(d.exists() ? d.data() : {}) }; },
    async saveSettings(v) { await F.setDoc(ref('settings', 'app'), v, { merge: true }); },
    // Branding (logo) is public so the sign-in page can show it.
    async getBranding() { const d = await F.getDoc(ref('branding', 'app')); return d.exists() ? d.data() : {}; },
    async saveBranding(v) { await F.setDoc(ref('branding', 'app'), v, { merge: true }); },
    async getAttendance(id) { const d = await F.getDoc(ref('attendance', id)); return d.exists() ? d.data() : null; },
    async saveAttendance(rec) { await F.setDoc(ref('attendance', rec.id), rec, { merge: true }); },
    async attendanceByDate(date) { return all(F.query(col('attendance'), F.where('date', '==', date))); },
    async attendanceByUser(id) { return all(F.query(col('attendance'), F.where('uid', '==', id))); },
    async lateRecords() { return all(F.query(col('attendance'), F.where('late', '==', true))); },
    async clearAttendance() {
      const docs = await F.getDocs(col('attendance'));
      await Promise.all(docs.docs.map((d) => F.deleteDoc(d.ref)));
    },
    async addLaptop(rec) { await F.addDoc(col('laptops'), rec); },
    async listLaptops(forUid) { return all(forUid ? F.query(col('laptops'), F.where('uid', '==', forUid)) : col('laptops')); },
    async updateLaptop(id, patch) { await F.updateDoc(ref('laptops', id), patch); },
    // Generic records (device deployments, damage reports).
    async listRecords(c) { return all(col(c)); },
    async addRecord(c, rec) { await F.addDoc(col(c), rec); },
    async updateRecord(c, id, patch) { await F.updateDoc(ref(c, id), patch); },
    async deleteRecord(c, id) { await F.deleteDoc(ref(c, id)); },
  };
}

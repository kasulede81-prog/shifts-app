import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { Preferences } from '@capacitor/preferences';

const gate = document.getElementById('pinGate');
const appRoot = document.getElementById('appRoot');
const pinTitle = document.getElementById('pinTitle');
const pinHelp = document.getElementById('pinHelp');
const pinInput = document.getElementById('pinInput');
const pinConfirm = document.getElementById('pinConfirm');
const pinSubmit = document.getElementById('pinSubmit');
const pinError = document.getElementById('pinError');
let setupMode = false;
let db;

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}

function makeLocalStorageShim(initial) {
  const map = new Map(initial);
  let writeChain = Promise.resolve();
  const persist = (key, value, remove = false) => {
    if (!db) return;
    writeChain = writeChain.then(async () => {
      if (remove) await db.run('DELETE FROM app_kv WHERE key = ?', [key]);
      else await db.run('INSERT INTO app_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
    }).catch(err => console.error('SQLite save failed', err));
  };
  const shim = {
    get length() { return map.size; },
    key(index) { return [...map.keys()][index] ?? null; },
    getItem(key) { key = String(key); return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { key = String(key); value = String(value); map.set(key, value); persist(key, value); },
    removeItem(key) { key = String(key); map.delete(key); persist(key, '', true); },
    clear() { const keys = [...map.keys()]; map.clear(); keys.forEach(k => persist(k, '', true)); }
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: shim });
}

async function initDatabase() {
  if (!Capacitor.isNativePlatform()) {
    // Development fallback only; production Android APK uses SQLite.
    db = null;
    const old = window.localStorage;
    const initial = [];
    for (let i = 0; i < old.length; i++) { const key = old.key(i); initial.push([key, old.getItem(key)]); }
    makeLocalStorageShim(initial);
    return;
  }
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  db = await sqlite.createConnection('dkasu_shift', false, 'no-encryption', 1, false);
  await db.open();
  await db.execute('CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
  const result = await db.query('SELECT key, value FROM app_kv');
  makeLocalStorageShim((result.values || []).map(row => [row.key, row.value]));
}

async function pinGate() {
  const saved = await Preferences.get({ key: 'dkasu_pin_sha256' });
  setupMode = !saved.value;
  if (setupMode) {
    pinTitle.textContent = 'Create your app PIN';
    pinHelp.textContent = 'Set a 4–12 digit PIN. You will need it whenever you open the app.';
    pinConfirm.style.display = 'block';
    pinSubmit.textContent = 'Create PIN';
  }
  pinSubmit.addEventListener('click', async () => {
    pinError.textContent = '';
    const pin = pinInput.value.trim();
    if (!/^\d{4,12}$/.test(pin)) { pinError.textContent = 'Use 4–12 digits.'; return; }
    if (setupMode) {
      if (pin !== pinConfirm.value.trim()) { pinError.textContent = 'PINs do not match.'; return; }
      await Preferences.set({ key: 'dkasu_pin_sha256', value: await sha256(pin) });
    } else if (await sha256(pin) !== saved.value) {
      pinError.textContent = 'Incorrect PIN. Try again.';
      pinInput.value = '';
      return;
    }
    gate.style.display = 'none';
    appRoot.style.display = 'block';
    const script = document.createElement('script');
    script.src = './app.js';
    script.onerror = () => { gate.style.display = 'flex'; appRoot.style.display = 'none'; pinError.textContent = 'Could not load the dashboard. Restart the app.'; };
    document.body.appendChild(script);
  });
  pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') pinSubmit.click(); });
}

try {
  await initDatabase();
  await pinGate();
} catch (error) {
  console.error(error);
  pinTitle.textContent = 'App startup failed';
  pinHelp.textContent = 'Close and reopen the app. If this continues, check the SQLite setup and build instructions.';
  pinError.textContent = String(error?.message || error);
}

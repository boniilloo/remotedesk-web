// localStorage that never throws (private mode, blocked site data, quota). Everything read
// back is untrusted: other pages of the same origin (<user>.github.io) can write here.

export const KEYS = Object.freeze({
  account: 'remotedesk.account',    // "c1.…" secret link data (README contract)
  master: 'remotedesk.master',      // remembered master key (hex), only with "Recordar"
  device: 'remotedesk.device',      // name sent to the hosts as viewer name
  machines: 'remotedesk.machines',  // last-seen cache of known machines
  prefs: 'remotedesk.prefs',        // per-device view preferences
  lastSession: 'remotedesk.last',   // {machine_id, alive}: a session of this browser may linger on the host
});

function ls() {
  try { return window.localStorage; } catch { return null; }
}

export function getRaw(key) {
  try { return ls()?.getItem(key) ?? null; } catch { return null; }
}

export function setRaw(key, value) {
  try { const s = ls(); if (!s) return false; s.setItem(key, value); return true; } catch { return false; }
}

export function remove(key) {
  try { ls()?.removeItem(key); } catch { /* blocked */ }
}

export function getJSON(key, fallback) {
  const v = getRaw(key);
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

export function setJSON(key, value) {
  return setRaw(key, JSON.stringify(value));
}

/** Small typed preferences: prefs.get('quality', 'auto', ['auto', 'low', …]). */
export const prefs = {
  get(name, fallback, allowed = null) {
    const all = getJSON(KEYS.prefs, null);
    if (!all || typeof all !== 'object' || !Object.prototype.hasOwnProperty.call(all, name)) return fallback;
    const v = all[name];
    if (allowed && !allowed.includes(v)) return fallback;
    if (!allowed && typeof v !== typeof fallback) return fallback;
    return v;
  },
  set(name, value) {
    let all = getJSON(KEYS.prefs, null);
    if (!all || typeof all !== 'object' || Array.isArray(all)) all = {};
    all[name] = value;
    setJSON(KEYS.prefs, all);
  },
};

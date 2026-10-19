// Secret account link: "<page>#c1.<base64url(salt32 | check16 | log2N, r, p)>"
// (format of remotedesk/account.py web_secret / parse_web_secret).
//
// The fragment never leaves the browser in HTTP requests or Referer headers, but it IS
// written to the local browser history (replaceState does not erase that entry) and to
// synced history if browser sync is on. Every page on the same origin
// (<user>.github.io serves ALL of a user's project sites) can read localStorage, so
// everything read back from storage is validated and treated as untrusted text.
import { KEYS, getRaw, setRaw, remove } from './storage.js?v=7a6ac4ad45';

export const PREFIX = 'c1.';

// scrypt bounds for a link opened here (anyone can send a link to the official page): what
// the desktop app generates (2^17, 8, 1) plus headroom, never a cost that freezes or kills a
// phone. Same numbers in web/crate/proto/src/account.rs (WEB_LOG_N, WEB_MAX_R, WEB_MAX_P,
// WEB_MAX_KDF_MEMORY).
export const KDF_BOUNDS = Object.freeze({ logN: [14, 20], r: [1, 16], p: [1, 4], memory: 256 * 1024 * 1024 });

function b64urlDecode(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

/** Inverse of account.py web_secret(). Throws on malformed input or out-of-bounds scrypt costs. */
export function parseWebSecret(text) {
  if (typeof text !== 'string' || !text.startsWith(PREFIX)) throw new Error('Enlace no válido.');
  const blob = b64urlDecode(text.slice(PREFIX.length));
  if (blob.length !== 32 + 16 + 3) throw new Error('Enlace no válido.');
  const [logN, r, p] = blob.slice(48);
  const B = KDF_BOUNDS;
  const inside = (v, [a, b]) => v >= a && v <= b;
  if (!inside(logN, B.logN) || !inside(r, B.r) || !inside(p, B.p) || 128 * r * 2 ** logN > B.memory) {
    throw new Error('Parámetros de scrypt no válidos.');
  }
  return { salt: blob.slice(0, 32), check: blob.slice(32, 48), n: 2 ** logN, r, p };
}

/** Finds "c1.…" in a pasted text: the whole link, the fragment or the bare secret. */
export function extractSecret(text) {
  if (typeof text !== 'string') return null;
  let t = text.trim();
  try { t = decodeURIComponent(t); } catch { /* keep as is */ }
  const m = /(?:^|[#\s])(c1\.[A-Za-z0-9_-]+)/.exec(t);
  if (!m) return null;
  try { parseWebSecret(m[1]); return m[1]; } catch { return null; }
}

/**
 * Call once, as early as possible (and on hashchange): if the address has "#c1.…", remove it
 * from the address bar (before anything else can read or log it) and validate it. It is
 * stored right away only when this browser has no account yet or already has this one;
 * replacing a different stored account is the caller's decision (ask the user first: anyone
 * can send a link to the official page).
 * Returns {} (nothing in the URL) | {error} | {imported: true} | {same: true} |
 *         {replace: secret} (a different account is stored: ask, then replaceAccount()).
 */
export function importFromLocation() {
  const hash = location.hash || '';
  if (!hash.slice(1).startsWith(PREFIX)) return {};
  try { history.replaceState(history.state, '', location.pathname + location.search); } catch { /* sandboxed */ }
  const secret = extractSecret(hash.slice(1));
  if (!secret) return { error: 'El enlace no es válido o está incompleto. Cópialo otra vez desde la app de escritorio.' };
  const stored = loadSecret();
  if (stored === secret) return { same: true };
  if (stored) return { replace: secret };
  if (!saveSecret(secret)) return { error: 'Este navegador no deja guardar datos (¿modo privado?). Sin eso no se puede recordar la cuenta.' };
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* unsupported */ }
  return { imported: true };
}

export function saveSecret(secret) {
  return setRaw(KEYS.account, secret);
}

/** Another account replaces the stored one: nothing of the old one may stay behind. */
export function replaceAccount(secret) {
  forgetAccount();
  return saveSecret(secret);
}

/** The stored secret ("c1.…") or null if there is none or it is not valid. */
export function loadSecret() {
  const s = getRaw(KEYS.account);
  if (!s) return null;
  try { parseWebSecret(s); return s; } catch { return null; }
}

/** "Recordar en este dispositivo": the derived master key (hex), never the password. */
export function loadRememberedMaster() {
  const v = getRaw(KEYS.master);
  return typeof v === 'string' && /^[0-9a-f]{32,128}$/i.test(v) ? v : null;
}
export function rememberMaster(hex) { return typeof hex === 'string' && setRaw(KEYS.master, hex); }
export function forgetMaster() { remove(KEYS.master); }

/** "Olvidar la cuenta en este navegador": the link, the remembered key and the machine cache. */
export function forgetAccount() {
  remove(KEYS.account);
  remove(KEYS.master);
  remove(KEYS.machines);
  remove(KEYS.lastSession);
}

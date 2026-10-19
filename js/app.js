// RemoteDesk web client: entry point. Screens: import (secret link) -> login (master
// password) -> machines -> session. See web/README.md for the wasm contract (core.js).

import './guard.js?v=7a6ac4ad45';                 // first: refuse to run inside a frame
import * as account from './account.js?v=7a6ac4ad45';
import { loadCore, errorCode, errorMessage, MOCK } from './core.js?v=7a6ac4ad45';
import { $, h, showScreen, activeScreen, toast, confirmDialog, menuDialog, modal, nextPaint } from './dom.js?v=7a6ac4ad45';
import { KEYS, getRaw, setRaw } from './storage.js?v=7a6ac4ad45';
import { detectDevice, isIOS, isStandalone, iosDevice, defaultDeviceName } from './device.js?v=7a6ac4ad45';
import { MachinesScreen } from './machines.js?v=7a6ac4ad45';
import { SessionView } from './sessionview.js?v=7a6ac4ad45';

// The secret leaves the address bar before anything else runs.
const imported = account.importFromLocation();

// Published on an origin used only by RemoteDesk? build.sh writes it from web/site.json. On a
// shared origin (<user>.github.io with other project sites) every other page there can read
// localStorage, so the master key is never stored ("Recordar" is not offered).
// A copy served from another origin than the one site.json names is never trusted with it
// (except a local test server).
const SITE_ORIGIN = document.documentElement.dataset.siteOrigin || '';
const ISOLATED = document.documentElement.dataset.isolatedOrigin === '1'
  && (!SITE_ORIGIN || location.origin === SITE_ORIGIN || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname));

const kind = detectDevice();
document.body.classList.add('ui-' + kind);
if (MOCK) document.title = 'RemoteDesk (simulación)';
for (const el of document.querySelectorAll('.ios-device')) el.textContent = iosDevice() || 'iPhone';

let corePromise = loadCore();
corePromise.catch(() => {});
// The unlocked Account (wasm object). Module-private on purpose: nothing reachable from
// `window` may lead to it (it can export the master key). The screens get functions instead.
let acct = null;
let netPromise = null;

const app = {
  kind,
  isolated: ISOLATED,
  get accountCode() { return acct ? String(acct.code) : ''; },
  get loggedIn() { return !!acct; },
  getNet() { return getNet(); },
  /** The network may have changed (back online, page visible again): let iroh re-check its
   *  relay connection and paths now instead of after its own backoff. */
  networkChange() {
    netPromise?.then(n => n.networkChange?.()).catch(() => {});
  },
  resetNet() {
    const old = netPromise;
    netPromise = null;
    machines.onlineChecked = false;
    old?.then(n => n.close()).catch(() => {});
  },
  /**
   * Probe / connect a slot with the unlocked account (never handed out) over the app's own
   * network endpoint. No `net` parameter on purpose: whatever a caller passes is never given
   * the account (and core.probe/connect are the Net methods as the core loaded them).
   */
  async probe(slot, timeoutMs) {
    const { a, net, core } = await withAccount(slot);
    return core.probe(net, a, slot, timeoutMs);
  },
  async connect(slot, name, timeoutMs) {
    const { a, net, core } = await withAccount(slot);
    return core.connect(net, a, slot, String(name), timeoutMs);
  },
  deviceName() {
    return cleanName(getRaw(KEYS.device)) || defaultDeviceName();   // storage is untrusted (shared origin)
  },
  onConnect(machine) { machines.hide(); session.open(machine); },
  onSessionClosed() { machines.show(); },
};

/** The page's network endpoint (one per page; spawned on first use, again after resetNet). */
function getNet() {
  if (!netPromise) {
    netPromise = (async () => (await getCore()).spawnNet())();
    netPromise.catch(() => { netPromise = null; });
  }
  return netPromise;
}

/**
 * The unlocked account, the app's own Net and the core for a probe/connect of `slot`. Uses the
 * module's getNet(), not app.getNet (a property anyone holding `app` could replace).
 */
async function withAccount(slot) {
  const closed = () => Object.assign(new Error('Sesión cerrada.'), { code: 'closed' });
  if (!Number.isInteger(slot) || slot < 0 || slot > 15) throw new TypeError('slot');
  if (!acct) throw closed();
  const a = acct;
  const net = await getNet();
  const core = await getCore();
  if (acct !== a) throw closed();              // logged out (or another account) meanwhile
  return { a, net, core };
}

/** No control or bidi-override characters: the desktop shows this name in its prompts. */
function cleanName(v) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 64) : '';
}

const machines = new MachinesScreen(app);
const session = new SessionView(app);
// Debugging and tests only: with ?mock=1 or in a browser driven by automation (the headless
// Chrome of web/tests). No secrets reachable from here: no Account, no key, no link.
if (MOCK || navigator.webdriver === true) window.__rd = { app, machines, session };

async function getCore() {
  try {
    return await corePromise;
  } catch (e) {
    corePromise = loadCore();
    throw e;
  }
}

// ------------------------------------------------------------------ import screen
function showImport(error = '') {
  showScreen('import');
  const err = $('#importError');
  err.textContent = error;
  err.hidden = !error;
  const standaloneIos = isIOS() && isStandalone();
  // Desktop: pasting is the way (opening the link would leave it in the browser history).
  // Phone: the camera opens the QR's link. iOS Home Screen app: no address bar, no camera link.
  $('#importSteps').dataset.mode = standaloneIos ? 'standalone' : kind === 'desktop' ? 'desktop' : 'mobile';
  $('#importIos').hidden = !isIOS() || standaloneIos;
  const canPaste = !!navigator.clipboard?.readText;
  $('#importPaste').hidden = !canPaste;
  $('#importPaste').classList.toggle('primary', standaloneIos && canPaste);
  $('#importSave').classList.toggle('primary', !(standaloneIos && canPaste));
  if (kind === 'desktop') $('#importField').focus();
}

function saveLink(text) {
  const secret = account.extractSecret(text);
  if (!secret) { showImport('Ese texto no es un enlace de RemoteDesk válido. Cópialo otra vez desde la app de escritorio.'); return; }
  if (!account.saveSecret(secret)) { showImport('Este navegador no deja guardar datos (¿modo privado?).'); return; }
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* unsupported */ }
  $('#importField').value = '';
  showLogin('Cuenta añadida a este navegador.');
}

$('#importForm').addEventListener('submit', e => { e.preventDefault(); saveLink($('#importField').value); });
$('#importPaste').addEventListener('click', async () => {
  try { saveLink(await navigator.clipboard.readText()); }
  catch { showImport('El navegador no ha dejado leer el portapapeles: mantén pulsado el cuadro y elige Pegar.'); }
});

// ------------------------------------------------------------------ login screen
let rememberTouched = false;
$('#remember').addEventListener('change', () => { rememberTouched = true; });

function showLogin(notice = '') {
  showScreen('login');
  const n = $('#loginNotice');
  n.textContent = notice;
  n.hidden = !notice;
  $('#loginStatus').textContent = '';
  $('#loginStatus').classList.remove('error');
  $('#loginSpinner').hidden = true;
  $('#iosInstall').hidden = !(isIOS() && !isStandalone());
  $('#rememberRow').hidden = !ISOLATED;
  $('#rememberNote').hidden = ISOLATED;
  if (!ISOLATED) $('#remember').checked = false;
  // Installed app: asking for the password at every launch is the main annoyance.
  else if (!rememberTouched) $('#remember').checked = isStandalone();
  if (kind === 'desktop') $('#password').focus();
}

// The password is checked in a Worker (seconds), so the page keeps handling events meanwhile.
// Anything that changes which account is in use (forget, replace, log out) bumps this token
// and the result of an unlock started before is thrown away: it never logs into, or stores
// the key of, an account the user has just forgotten or replaced.
let accountEpoch = 0;
let unlocking = null;                 // { abort: AbortController } while a check runs

function loginBusy(on) {
  $('#loginBtn').disabled = on;
  $('#loginMenu').disabled = on;      // "Olvidar la cuenta" waits until the check ends
  $('#loginSpinner').hidden = !on;
}

/** The account in use changes: drop any unlock in progress (and end its Worker). */
function cancelUnlock() {
  accountEpoch += 1;
  if (unlocking) {
    unlocking.abort.abort();
    unlocking = null;
    loginBusy(false);
    $('#loginStatus').textContent = '';
  }
}

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (unlocking) return;
  const pw = $('#password').value;
  const status = $('#loginStatus');
  status.classList.remove('error');
  if (pw.length < 4) { loginError('La contraseña maestra tiene al menos 4 caracteres.'); return; }
  const secret = account.loadSecret();
  if (!secret) { showImport('No hay ninguna cuenta guardada en este navegador.'); return; }
  const epoch = accountEpoch;
  const job = unlocking = { abort: new AbortController() };
  // still the same account, nobody forgot or replaced it while the password was checked?
  const current = () => unlocking === job && epoch === accountEpoch && account.loadSecret() === secret;
  loginBusy(true);
  status.textContent = 'Comprobando…';
  await nextPaint();
  const stale = () => { if (unlocking === job) status.textContent = ''; };
  let unlocked, master;
  try {
    const core = await getCore();
    if (!current()) return stale();
    master = await core.unlockMaster(secret, pw, job.abort.signal);   // scrypt in a Worker
    if (!current()) return stale();
    unlocked = core.fromMaster(secret, master);
  } catch (err) {
    if (!current()) return stale();
    const code = errorCode(err);
    if (code === 'bad_password') loginError('Contraseña incorrecta.', true);
    else if (code === 'bad_link') loginError('El enlace guardado no es válido. Olvida la cuenta (⋯) y ábrelo otra vez.');
    else loginError(errorMessage(err, 'No se ha podido cargar RemoteDesk. Recarga la página.'));
    return;
  } finally {
    if (unlocking === job) { unlocking = null; loginBusy(false); }
  }
  if (ISOLATED && $('#remember').checked) account.rememberMaster(master);
  try { acct?.free?.(); } catch { /* already freed */ }
  acct = unlocked;
  $('#password').value = '';
  status.textContent = '';
  machines.show();
});

function loginError(text, shake = false) {
  const status = $('#loginStatus');
  status.textContent = text;
  status.classList.add('error');
  if (shake) {
    const f = $('#loginForm');
    f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake');
    $('#password').select();
  }
}

$('#pwToggle').addEventListener('click', () => {
  const pw = $('#password');
  const show = pw.type === 'password';
  pw.type = show ? 'text' : 'password';
  $('#pwToggle').setAttribute('aria-pressed', String(show));
  $('#pwToggle').setAttribute('aria-label', show ? 'Ocultar la contraseña' : 'Mostrar la contraseña');
});

$('#copyLink').addEventListener('click', async () => {
  const secret = account.loadSecret();
  if (!secret) return;
  const link = location.origin + location.pathname + '#' + secret;
  try { await navigator.clipboard.writeText(link); toast('Enlace copiado. Pégalo en la app de la pantalla de inicio.'); }
  catch { toast('No se ha podido copiar el enlace.'); }
});

async function forgetAccountFlow() {
  const yes = await confirmDialog({
    title: '¿Olvidar la cuenta en este navegador?',
    text: 'Se borran el enlace secreto, la contraseña recordada y la lista de equipos de este navegador. Tus equipos no cambian; para volver a entrar necesitarás el enlace de la app de escritorio.',
    ok: 'Olvidar', danger: true,
  });
  if (!yes) return;
  account.forgetAccount();
  logoutLocal();
  showImport();
}

function logoutLocal() {
  cancelUnlock();
  machines.forget();
  try { acct?.free?.(); } catch { /* already freed */ }
  acct = null;
  app.resetNet();
}

$('#loginMenu').addEventListener('click', () => menuDialog('Opciones', [
  { label: 'Olvidar la cuenta en este navegador', danger: true, onClick: forgetAccountFlow },
]));

// ------------------------------------------------------------------ another account's link
let replacing = false, queuedLink = null;
/**
 * A link of a different account was opened while one is stored. Anyone can send a link to
 * the official page, so never replace silently: say what would be lost and let the user choose.
 */
async function confirmReplace(secret) {
  if (replacing) { queuedLink = secret; return false; }
  replacing = true;
  try {
    const code = acct ? ` (${acct.code})` : '';
    const yes = await confirmDialog({
      title: '¿Sustituir la cuenta guardada?',
      text: `Has abierto el enlace secreto de otra cuenta de RemoteDesk (o de la misma con una contraseña nueva). Si la sustituyes, este navegador olvida la cuenta actual${code}, su contraseña recordada y su lista de equipos. Si no esperabas este enlace, conserva la actual.`,
      ok: 'Sustituir', cancel: 'Conservar la actual', danger: true,
    });
    if (!yes) { toast('Se conserva la cuenta actual.'); return false; }
    if (activeScreen() === 'session') await session.disconnect();
    logoutLocal();
    if (!account.replaceAccount(secret)) { showImport('Este navegador no deja guardar datos (¿modo privado?).'); return true; }
    showLogin('Cuenta sustituida. Escribe la contraseña maestra de la nueva cuenta.');
    return true;
  } finally {
    replacing = false;
    // another link opened while this question was on screen: ask about that one now
    const next = queuedLink; queuedLink = null;
    if (next && next !== account.loadSecret()) setTimeout(() => confirmReplace(next), 0);
  }
}

// ------------------------------------------------------------------ machines menu
async function renameDevice() {
  const current = app.deviceName();
  const name = await modal(done => {
    const input = h('input', { attrs: { type: 'text', maxlength: 64, autocomplete: 'off', 'aria-label': 'Nombre', autofocus: true }, value: current });
    return [
      h('h2', { text: 'Nombre de este dispositivo' }),
      h('p', { class: 'small muted', text: 'Es el nombre que verán tus equipos cuando te conectes.' }),
      h('form', { on: { submit: e => { e.preventDefault(); done(input.value); } } }, input,
        h('div', { class: 'dlg-actions' },
          h('button', { class: 'btn', attrs: { type: 'button' }, text: 'Cancelar', on: { click: () => done(null) } }),
          h('button', { class: 'btn primary', attrs: { type: 'submit' }, text: 'Guardar' }))),
    ];
  });
  if (name == null) return;
  setRaw(KEYS.device, cleanName(name));
  $('#deviceNameLabel').textContent = app.deviceName();
}
$('#mRename').addEventListener('click', renameDevice);

$('#mMenu').addEventListener('click', () => menuDialog('Opciones', [
  { label: 'Nombre de este dispositivo…', onClick: renameDevice },
  { label: 'Cerrar sesión', onClick: () => { account.forgetMaster(); logoutLocal(); showLogin('Sesión cerrada en este dispositivo.'); } },
  { label: 'Olvidar la cuenta en este navegador', danger: true, onClick: forgetAccountFlow },
]));

// The link opened (or pasted in the address bar) while the page is already open: only the
// fragment changes, there is no reload.
window.addEventListener('hashchange', () => {
  const r = account.importFromLocation();
  // a broken or hostile link never throws the stored account's user out of what they are doing
  if (r.error) { if (account.loadSecret()) toast(r.error, { ms: 8000 }); else showImport(r.error); return; }
  if (r.replace) { confirmReplace(r.replace); return; }
  if (r.same) { toast('Este enlace ya está guardado en este navegador.'); return; }
  if (!r.imported) return;
  showLogin('Cuenta añadida a este navegador. Escribe tu contraseña maestra.');
});

// ------------------------------------------------------------------ network changes
window.addEventListener('online', () => app.networkChange());
document.addEventListener('visibilitychange', () => { if (!document.hidden) app.networkChange(); });

// ------------------------------------------------------------------ history (back gesture)
window.addEventListener('popstate', async () => {
  // A secret link opened in this tab (pasted in the address bar, a QR, location.hash) is a
  // fragment navigation: it fires popstate before hashchange. It is not the back gesture, and
  // the hashchange handler deals with it (a question or a toast, never "¿Desconectar?").
  if (location.hash.slice(1).startsWith(account.PREFIX)) return;
  if (activeScreen() === 'session' || session.ignorePop) await session.onPopState();
});

// ------------------------------------------------------------------ boot
async function boot() {
  $('#deviceNameLabel').textContent = app.deviceName();
  if (!ISOLATED) account.forgetMaster();             // e.g. stored by an older build: not here
  if (imported.replace && await confirmReplace(imported.replace)) return;
  const secret = account.loadSecret();
  if (imported.error) {
    if (!secret) { showImport(imported.error); return; }
    toast(imported.error, { ms: 8000 });             // keep using the stored account
  }
  if (!secret) { showImport(); return; }
  const master = ISOLATED ? account.loadRememberedMaster() : null;
  if (master) {
    const epoch = accountEpoch;
    try {
      const core = await getCore();
      // the wasm may take a while to download: a link replaced or an account forgotten
      // meanwhile wins (that flow already showed its screen)
      if (epoch !== accountEpoch) return;
      acct = core.fromMaster(secret, master);
      machines.show();
      return;
    } catch (e) {
      if (epoch !== accountEpoch) return;
      if (errorCode(e) === 'bad_password' || errorCode(e) === 'bad_link') account.forgetMaster();
      showLogin('No se ha podido usar la contraseña recordada. Escríbela otra vez.');
      return;
    }
  }
  showLogin(imported.imported ? 'Cuenta añadida a este navegador. Escribe tu contraseña maestra.' : '');
}

boot().catch(e => {
  $('#bootText').textContent = 'No se ha podido iniciar RemoteDesk: ' + errorMessage(e, 'error desconocido.');
});

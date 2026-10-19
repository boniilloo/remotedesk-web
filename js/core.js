// The ONLY module of the page that imports the wasm glue (js/unlockworker.js, a worker, is the
// other one). build.sh rewrites the literal "../pkg/rdweb.js" below to the hashed file name,
// so keep it exactly like that. With ?mock=1 in the URL the page uses mockcore.js instead
// (same API, fake desktops), which is what the tests in web/tests/app use.
//
// Uniform API for the rest of the app (see web/README.md for the wasm contract):
//   const core = await loadCore();
//   await core.unlockMaster(secret, password, signal?) -> masterHex   (scrypt in a Worker;
//                                                         an aborted signal ends the Worker)
//   core.fromMaster(secret, masterHex) -> Account             (fast: HKDF + check)
//   await core.spawnNet() -> Net                             (net.online / networkChange / close)
//   core.probe(net, account, slot, ms) / core.connect(net, account, slot, name, ms)
//       Net.probe / Net.connect as they were when the core loaded (see below)
//   errorCode(err) -> "bad_password" | "bad_link" | "offline" | "timeout" | "busy" | ...
//   errorMessage(err, fallback) -> Spanish text

export const MOCK = new URLSearchParams(location.search).get('mock') === '1';

const WORKER_TIMEOUT_MS = 120000;     // scrypt within the link bounds takes seconds, not minutes

let loading = null;

export function loadCore() {
  if (!loading) {
    loading = (async () => {
      const mod = MOCK ? await import('./mockcore.js?v=7a6ac4ad45') : await import("../pkg/rdweb.22e690c851.js?v=7a6ac4ad45");
      await mod.default();
      // The only calls that receive the unlocked Account. Taken from the class now, so a script
      // that later swaps probe/connect on a Net (window.__rd.app.getNet() hands it out in
      // tests) or on its prototype never gets the Account passed to it.
      const { probe, connect } = mod.Net.prototype;
      const call = Function.prototype.call.bind(Function.prototype.call);
      return {
        mock: MOCK,
        unlockMaster: (secret, password, signal) => (MOCK ? mod.unlockMaster(secret, password) : unlockInWorker(mod, secret, password, signal)),
        fromMaster: (secret, masterHex) => mod.Account.fromMaster(secret, masterHex),
        spawnNet: () => mod.Net.spawn(),
        probe: (net, account, slot, ms) => call(probe, net, account, slot, ms),
        connect: (net, account, slot, name, ms) => call(connect, net, account, slot, name, ms),
      };
    })();
    loading.catch(() => { loading = null; });   // allow a retry after a failed download
  }
  return loading;
}

function codeError(code, message) {
  const e = new Error(message || 'Error');
  if (code) e.code = code;
  return e;
}

/** URL of the worker module with this module's ?v=<build> (one build per page load). */
function workerUrl() {
  const url = new URL('./unlockworker.js', import.meta.url);
  url.search = new URL(import.meta.url).search;
  return url;
}

/**
 * scrypt in a module Worker that loads its own copy of the wasm. Falls back to this thread
 * (the old, blocking way) only if the browser cannot start module workers at all.
 * `signal` (AbortSignal, optional): the page no longer wants this result (the account was
 * forgotten or replaced meanwhile): the Worker is terminated and the promise rejects.
 */
function unlockInWorker(mod, secret, password, signal) {
  if (signal?.aborted) return Promise.reject(codeError('aborted', 'Cancelado.'));
  const onThisThread = () => {
    const account = mod.Account.unlock(secret, password);
    try { return account.masterHex(); } finally { account.free(); }
  };
  let worker;
  try { worker = new Worker(workerUrl(), { type: 'module', name: 'rd-unlock' }); }
  catch { return Promise.resolve().then(onThisThread); }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();                 // gives scrypt's memory back right away
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, codeError('error', 'El navegador no ha terminado de comprobar la contraseña.')), WORKER_TIMEOUT_MS);
    worker.onmessage = e => {
      const d = e.data || {};
      if (d.ok && typeof d.masterHex === 'string') finish(resolve, d.masterHex);
      else finish(reject, codeError(d.code, d.message));
    };
    // The module could not be loaded as a worker (very old browser): do it here instead.
    worker.onerror = e => {
      e.preventDefault?.();
      if (settled) return;
      try { finish(resolve, onThisThread()); } catch (err) { finish(reject, err); }
    };
    signal?.addEventListener('abort', () => finish(reject, codeError('aborted', 'Cancelado.')), { once: true });
    worker.postMessage({ id: 1, secret, password });
  });
}

const KNOWN_CODES = new Set(['bad_password', 'bad_link', 'offline', 'timeout', 'busy', 'denied',
  'rate_limited', 'auth', 'protocol', 'closed']);

/** Error code from the core (Error.code), tolerant with strings and plain objects. */
export function errorCode(err) {
  const c = err && typeof err === 'object' ? err.code : null;
  if (typeof c === 'string' && KNOWN_CODES.has(c)) return c;
  return 'error';
}

const MESSAGES = {
  bad_password: 'Contraseña incorrecta.',
  bad_link: 'El enlace guardado no es válido. Ábrelo otra vez desde la app de escritorio.',
  offline: 'El equipo no está en línea.',
  timeout: 'El equipo no responde. Inténtalo de nuevo.',
  busy: 'Ocupado: otra persona lo está controlando.',
  denied: 'En el equipo han rechazado la conexión.',
  rate_limited: 'Demasiados intentos. Espera un minuto.',
  auth: 'No se ha podido verificar el equipo (¿contraseña de otra cuenta?).',
  protocol: 'El equipo usa una versión incompatible de RemoteDesk.',
  closed: 'La conexión se ha cerrado.',
};

/** Spanish message: the core's own text when it gives one, else ours. Plain text only. */
export function errorMessage(err, fallback = 'Algo ha fallado.') {
  const code = errorCode(err);
  let msg = err && typeof err === 'object' && typeof err.message === 'string' ? err.message : (typeof err === 'string' ? err : '');
  msg = msg.trim().slice(0, 300);
  if (msg && !/^(Error|RuntimeError|TypeError)\b/.test(msg) && !/unreachable|panicked/i.test(msg)) return msg;
  return MESSAGES[code] || fallback;
}

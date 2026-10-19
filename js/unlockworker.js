// Module worker: Account.unlock (scrypt, 0.5-3 s with the desktop app's cost) off the page's
// thread, so the login screen keeps animating and a hostile link cannot freeze the page.
// It answers {id, ok: true, masterHex} or {id, ok: false, code, message}; the page then calls
// Account.fromMaster(secret, masterHex) on its own thread (HKDF only: instant) and terminates
// this worker, which gives scrypt's memory back right away.
//
// Like js/core.js, this file imports the wasm glue by the literal "../pkg/rdweb.js", which
// build.sh rewrites to the hashed file name: keep it exactly like that.
import init, { Account } from "../pkg/rdweb.22e690c851.js?v=7a6ac4ad45";

let ready = null;

self.onmessage = async (event) => {
  const { id, secret, password } = event.data || {};
  try {
    ready ||= init();
    await ready;
    const account = Account.unlock(String(secret), String(password));
    let masterHex;
    try { masterHex = account.masterHex(); } finally { account.free(); }
    self.postMessage({ id, ok: true, masterHex });
  } catch (err) {
    const code = err && typeof err === 'object' && typeof err.code === 'string' ? err.code : null;
    const message = err && typeof err === 'object' && typeof err.message === 'string' ? err.message : String(err);
    self.postMessage({ id, ok: false, code, message });
  }
};

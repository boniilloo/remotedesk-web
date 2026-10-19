// Session protocol, as in remotedesk/viewer.py, on top of a connected core session
// (handshake done, encrypted channel; see web/README.md):
//   core.recv() -> null (closed) | [type, Uint8Array]   type 1 = JSON, 2 = frame
//   core.sendJson(string) / core.send(1, bytes), core.path(), core.close()
//
// Host -> viewer: hello, screen, frames (ack after drawing), cursor, cursor_pos, clipboard,
// pong, bye. Viewer -> host: settings, refresh, ack, mouse_*, wheel, key, text, release_all,
// clipboard, ping, bye. Pings every 2 s; no pong for 20 s while visible = connection lost.
import { unpackFrame, frameId } from './frames.js?v=7a6ac4ad45';

export const MSG_JSON = 1;
export const MSG_FRAME = 2;
export const PING_MS = 2000;
export const LIVENESS_TIMEOUT_MS = 20000;   // viewer.py LIVENESS_TIMEOUT
export const SILENT_WARN_MS = 6000;         // viewer.py: "El equipo remoto no responde…"
export const MAX_CLIPBOARD = 1024 * 1024;   // protocol.py, in characters (code points), like host.py
const MOVE_COALESCE_MS = 16;
const FRAME_DRAW_TIMEOUT_MS = 4000;

/** Characters (code points) of `text`, stopping early once past `limit` (cheap for huge texts). */
export function codePoints(text, limit = Infinity) {
  if (text.length <= limit) {                        // n code points <= n UTF-16 units
    let n = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < text.length) { const d = text.charCodeAt(i + 1); if (d >= 0xDC00 && d <= 0xDFFF) i++; }
      n++;
    }
    return n;
  }
  let n = 0;
  for (const _ch of text) if (++n > limit) break;
  return n;
}

/** The first `max` characters of `text`, never splitting a surrogate pair. */
export function cutCodePoints(text, max) {
  if (text.length <= max) return text;
  let n = 0, i = 0;
  while (i < text.length && n < max) {
    const c = text.charCodeAt(i);
    i += c >= 0xD800 && c <= 0xDBFF && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xFC00) === 0xDC00 ? 2 : 1;
    n++;
  }
  return text.slice(0, i);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/**
 * handlers: onHello(msg), onScreen(info), onFrame(frame, bytes) -> Promise (draw),
 * onCursor(msg), onCursorPos(x|null, y|null), onClipboard(text), onLatency(ms), onPath(text|null),
 * onSilent(bool), onEnd({kind: 'user'|'bye'|'lost', reason})
 */
export class RemoteSession {
  constructor(core, handlers) {
    this.core = core;
    this.h = handlers;
    this.closed = false;
    this.ended = false;
    this.lastPong = performance.now();
    this.lastMsg = performance.now();
    this.visibleSince = performance.now();
    this.rtt = null;
    this.silent = false;
    this._pendingMove = null;
    this._moveTimer = 0;
    this._pinger = 0;
    this.bytes = 0;
    this.frames = 0;
  }

  start() {
    this._loop();
    this._pinger = setInterval(() => this._tick(), PING_MS);
    this._tick();
  }

  /** Page became visible again: background timers may have been throttled, restart the clock. */
  markVisible() { this.visibleSince = performance.now(); }

  // -------------------------------------------------------------------- receive
  async _loop() {
    let kind = 'lost', reason = null;
    try {
      while (!this.closed) {
        const m = await this.core.recv();
        if (m == null) break;
        const type = m[0], payload = m[1];
        this.lastMsg = performance.now();
        if (type === MSG_FRAME) {
          await this._frame(payload);
        } else if (type === MSG_JSON) {
          const bye = this._json(payload);
          if (bye != null) { kind = 'bye'; reason = bye; break; }
        }
      }
    } catch (e) {
      reason = e && e.message ? String(e.message) : null;
    }
    if (this.closed && this.closeKind) { kind = this.closeKind; reason = this.closeReason; }
    this._finish(kind, reason || 'Se ha perdido la conexión con el equipo.');
  }

  async _frame(payload) {
    let frame;
    try {
      frame = unpackFrame(payload);
    } catch {
      const id = frameId(payload);                  // corrupt: still ack so the host keeps going
      if (id != null) this._raw({ t: 'ack', frame: id });
      return;
    }
    this.bytes += payload.byteLength;
    this.frames += 1;
    // never let a stuck decoder stall the stream: the host stops sending without acks
    let timer = 0, timedOut = false;
    try {
      await Promise.race([
        this.h.onFrame?.(frame, payload.byteLength),
        new Promise(r => { timer = setTimeout(() => { timedOut = true; r(); }, FRAME_DRAW_TIMEOUT_MS); }),
      ]);
    } catch { /* drawing failed: ack anyway */ }
    clearTimeout(timer);
    if (!this.closed) this._raw({ t: 'ack', frame: frame.id });
    // The slow frame's tiles are dropped when it finishes late (FrameRenderer keeps the order),
    // so its areas are stale: ask for a full image.
    if (timedOut && !this.closed) { this.slowDraws = (this.slowDraws || 0) + 1; this._raw({ t: 'refresh' }); }
  }

  _json(payload) {
    let msg;
    try { msg = JSON.parse(dec.decode(payload)); } catch { return null; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
    switch (msg.t) {
      case 'hello':
        this.h.onHello?.(msg);
        break;
      case 'screen':
        if (isInt(msg.width, 1, 65535) && isInt(msg.height, 1, 65535) && isInt(msg.fw, 1, 65535) && isInt(msg.fh, 1, 65535)) {
          this.h.onScreen?.({ monitor: Number.isInteger(msg.monitor) ? msg.monitor : null,
            width: msg.width, height: msg.height, fw: msg.fw, fh: msg.fh });
        }
        break;
      case 'cursor':
        if (typeof msg.shape === 'string' || typeof msg.img === 'string') this.h.onCursor?.(msg);
        break;
      case 'cursor_pos':
        if (isNum(msg.x) && isNum(msg.y)) this.h.onCursorPos?.(Math.min(1, Math.max(0, msg.x)), Math.min(1, Math.max(0, msg.y)));
        else this.h.onCursorPos?.(null, null);
        break;
      case 'clipboard':
        if (typeof msg.text === 'string' && codePoints(msg.text, MAX_CLIPBOARD) <= MAX_CLIPBOARD) this.h.onClipboard?.(msg.text);
        break;
      case 'pong': {
        const now = performance.now();
        this.lastPong = now;
        if (isNum(msg.ts)) {
          const rtt = now - msg.ts * 1000;
          if (rtt >= 0 && rtt < 120000) { this.rtt = rtt; this.h.onLatency?.(rtt); }
        }
        if (this.silent) { this.silent = false; this.h.onSilent?.(false); }
        break;
      }
      case 'bye':
        return String(msg.reason || 'El equipo remoto ha cerrado la sesión.').slice(0, 300);
      default:
        break;
    }
    return null;
  }

  // -------------------------------------------------------------------- liveness
  _tick() {
    if (this.closed) return;
    this._raw({ t: 'ping', ts: performance.now() / 1000 });
    try { this.h.onPath?.(typeof this.core.path === 'function' ? this.core.path() : null); } catch { /* closed */ }
    if (document.hidden) return;                    // throttled timers: judge only while visible
    const now = performance.now();
    const silentFor = now - Math.max(this.lastPong, this.visibleSince);
    if (silentFor > LIVENESS_TIMEOUT_MS) {
      this.abort('El equipo remoto ha dejado de responder.');
      return;
    }
    const silent = silentFor > SILENT_WARN_MS;
    if (silent !== this.silent) { this.silent = silent; this.h.onSilent?.(silent); }
  }

  /** Sends a ping right away (page back from the background: is the session still alive?). */
  pingNow() { this._raw({ t: 'ping', ts: performance.now() / 1000 }); }

  // -------------------------------------------------------------------- send
  /** JSON message. mouse_move is coalesced (<= 1 per 16 ms) and flushed before anything else. */
  send(obj) {
    if (this.closed) return false;
    if (obj.t === 'mouse_move') {
      this._pendingMove = obj;
      if (!this._moveTimer) this._moveTimer = setTimeout(() => this._flushMove(), MOVE_COALESCE_MS);
      return true;
    }
    this._flushMove();
    return this._raw(obj);
  }

  _flushMove() {
    clearTimeout(this._moveTimer); this._moveTimer = 0;
    const m = this._pendingMove;
    this._pendingMove = null;
    if (m) this._raw(m);
  }

  _raw(obj) {
    if (this.closed) return false;
    const text = JSON.stringify(obj);
    try {
      if (typeof this.core.sendJson === 'function') this.core.sendJson(text);
      else this.core.send(MSG_JSON, enc.encode(text));
      return true;
    } catch {
      this.abort('Se ha perdido la conexión con el equipo.');
      return false;
    }
  }

  // -------------------------------------------------------------------- end
  /**
   * The user disconnects: bye, then close the channel. Resolves to true only if the core
   * confirmed that the host got the end of the session (its ack of the bye, or the host
   * closed the connection itself); false if that is unknown (dead network, already closed).
   */
  async close() {
    if (this.closed) return false;
    this._flushMove();
    this._raw({ t: 'bye' });
    this.closeKind = 'user'; this.closeReason = 'Sesión cerrada.';
    this.closed = true;
    let confirmed = false;
    try { confirmed = (await this.core.close()) === true; } catch { /* already closed */ }
    this._finish('user', 'Sesión cerrada.');
    return confirmed;
  }

  /** Local decision that the connection is dead (liveness, watchdog, send failure). */
  abort(reason) {
    if (this.closed) return;
    this.closeKind = 'lost'; this.closeReason = reason;
    this.closed = true;
    try { const p = this.core.close(); p?.catch?.(() => {}); } catch { /* already closed */ }
    this._finish('lost', reason);
  }

  _finish(kind, reason) {
    if (this.ended) return;
    this.ended = true;
    this.closed = true;
    clearInterval(this._pinger);
    clearTimeout(this._moveTimer);
    this.h.onEnd?.({ kind, reason });
  }
}

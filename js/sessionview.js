// Session screen: renderer, input (mouse, physical keyboard, touch gestures, soft keyboard,
// extra keys), toolbar / bottom bar / options sheet, settings, lifecycle and auto-reconnect.
// One instance for the page; open() starts a session with a machine and disconnect() ends it.
import { View } from './view.js?v=7a6ac4ad45';
import { Gestures } from './gestures.js?v=7a6ac4ad45';
import { Modifiers } from './modifiers.js?v=7a6ac4ad45';
import { SoftKeyboard, chunks } from './textinput.js?v=7a6ac4ad45';
import { NAMED, keyMsg, sendCombo } from './keys.js?v=7a6ac4ad45';
import { KeyTracker } from './keymap.js?v=7a6ac4ad45';
import { WheelAccumulator, ClipboardBridge, attachMouse } from './input.js?v=7a6ac4ad45';
import { AutoQuality, QUALITY, initialRung } from './quality.js?v=7a6ac4ad45';
import { FrameRenderer, MAX_CANVAS_AREA, pngSize } from './frames.js?v=7a6ac4ad45';
import { RemoteSession, MAX_CLIPBOARD, cutCodePoints } from './session.js?v=7a6ac4ad45';
import { errorCode, errorMessage } from './core.js?v=7a6ac4ad45';
import { $, $$, h, toast, modal, confirmDialog, anyDialogOpen, activeScreen, showScreen } from './dom.js?v=7a6ac4ad45';
import { KEYS, prefs, getJSON, setJSON } from './storage.js?v=7a6ac4ad45';
import { isIOS, iosDevice, isStandalone } from './device.js?v=7a6ac4ad45';

// Protocol cursor shapes (remotedesk/cursor.py) -> CSS cursors for the local pointer.
const CSS_CURSORS = {
  arrow: 'default', ibeam: 'text', hand: 'pointer', wait: 'wait', busy: 'progress', cross: 'crosshair',
  forbidden: 'not-allowed', help: 'help', size_ver: 'ns-resize', size_hor: 'ew-resize',
  size_fdiag: 'nwse-resize', size_bdiag: 'nesw-resize', size_all: 'move', split_h: 'col-resize',
  split_v: 'row-resize', open_hand: 'grab', closed_hand: 'grabbing', up_arrow: 'default',
  drag_copy: 'copy', drag_link: 'alias', drag_move: 'move', blank: 'none',
};
const MAX_CURSOR_CACHE = 64;
const BACKOFF_MS = [0, 1000, 2000, 4000, 8000, 15000, 30000];
const MAX_RETRIES = 9;
const WATCHDOG_MS = 5000;           // back from background: no answer to a ping in 5 s = dead
const TEXT_CHUNK = 500;             // host MAX_TEXT is 2000 characters per "text" message
const APPROVAL_HINT_MS = 5000;      // still connecting after this: someone may have to accept at the PC
// A session of this browser that vanished without its bye (killed tab, lost network) stays on
// the host for a while: "busy" for that machine during this window is most likely our own
// ghost, so retry instead of giving up. The host (remotedesk/host.py _watchdog) ends a session
// whose viewer sent nothing for VIEWER_TIMEOUT = 12 s, checked every 2 s.
const HOST_VIEWER_TIMEOUT_MS = 12000 + 2000;
const GHOST_MS = 35000;              // no bye at all (the tab crashed or was killed)
// bye sent, delivery unknown (offline?): watchdog + the host's own teardown of the dead session
// (up to ~7 s on hosts older than the fast-abort change) + margin.
const GHOST_AFTER_BYE_MS = HOST_VIEWER_TIMEOUT_MS + 7000 + 5000;
const GHOST_AFTER_ACK_MS = 10000;    // close() confirmed the host got it: freed in ~3 s
const GHOST_RETRY_MS = 2500;
const ALIVE_EVERY_MS = 3000;
const MAX_CURSOR_PX = 256;          // bigger cursor images are dropped (decoding cost)
const PILL_IDLE_MS = 3000;          // landscape pill fades after this long untouched

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round5 = v => Math.round(v * 1e5) / 1e5;
const fmtMB = bytes => (bytes / 1e6).toLocaleString('es-ES', { maximumFractionDigits: bytes < 1e7 ? 1 : 0 }) + ' MB';

export class SessionView {
  /**
   * app: { kind, getNet(), resetNet(), connect(slot, name, ms), deviceName(), onSessionClosed() }
   */
  constructor(app) {
    this.app = app;
    this.kind = app.kind;                       // 'phone' | 'tablet' | 'desktop'
    this.touchUi = this.kind !== 'desktop';
    this.root = $('#session');
    this.stage = $('#stage');
    this.stageWrap = $('#stagewrap');           // #stage + the overlay and the pill on top of it
    this.pill = $('#pill');
    this.fb = $('#fb');
    this.cursorEl = $('#rcursor');
    this.cursorImg = $('#rcImg');
    this.kbdEl = $('#kbd');
    this.sinkEl = $('#sink');
    this.root.classList.add('ui-' + this.kind);
    document.body.classList.toggle('touch-ui', this.touchUi);

    this.prefs = {
      mode: prefs.get('mode', this.kind === 'phone' ? 'trackpad' : 'direct', ['trackpad', 'direct']),
      quality: prefs.get('quality', this.touchUi ? 'auto' : 'medium', ['auto', 'low', 'medium', 'high']),
      scale: prefs.get('scale', this.touchUi ? 'auto' : 1, ['auto', 1, 0.75, 0.5]),
      fps: prefs.get('fps', this.touchUi ? 'auto' : 25, ['auto', 10, 15, 25, 30]),
      keysPinned: prefs.get('keysPinned', false),
      remoteCursor: prefs.get('remoteCursor', false),
      localCursor: prefs.get('localCursor', true),
      pillX: prefs.get('pillX', 0.5),
    };
    if (!this.touchUi) this.prefs.mode = 'direct';  // touchscreen laptops: direct touch

    this.view = new View();
    this.pointer = { x: this.view.W / 2, y: this.view.H / 2 };
    this.renderer = new FrameRenderer(this.fb);
    this.aq = new AutoQuality({
      rung: initialRung({ connection: navigator.connection, touch: this.touchUi, relay: true }),
      now: performance.now(),
    });
    this.cursorCache = new Map();
    this.cursorShape = null; this.cursorEntry = null; this.remotePos = null;
    this.rs = null; this.gen = 0; this.machine = null; this.hello = null; this.screenInfo = null;
    this.canControl = true; this.monitors = []; this.currentMonitor = null; this.chosenMonitor = null;
    this.sentSettings = {}; this.forcedScale = null;
    this.retries = 0; this.failures = 0; this.retryTimer = 0; this.userClosed = true;
    this.state = 'idle';
    this.statFrames = 0; this.statT = performance.now(); this.totalBytes = 0; this.rtt = null; this.path = null; this.fps = 0;
    this.wakeLock = null;
    this.ignorePop = false;

    const send = m => this.sendInput(m);
    this.mods = new Modifiers(send);
    this.kbd = new SoftKeyboard(this.kbdEl, {
      send, modifiers: this.mods,
      onOpenChange: open => {
        this.root.classList.toggle('kbd-open', open);
        this._syncKeysBar();
        $('#btnKbd').classList.toggle('on', open);
        $('#tbKbd').classList.toggle('on', open);
        requestAnimationFrame(() => this.layout());
      },
    });
    this.gestures = new Gestures(this.stage, {
      view: this.view, send, pointer: this.pointer, mode: this.prefs.mode, modifiers: this.mods,
      feedback: (k, x, y) => this._ripple(k, x, y),
      onCursor: () => this.renderCursor(),
      onKeyboardToggle: () => this.kbd.toggle(),
      mouse: false, wheel: false,               // mice go through attachMouse + WheelAccumulator
    });
    this.mouse = attachMouse(this.stage, send, (cx, cy) => this.toNorm(cx, cy), {
      canControl: () => this.canControl && this.isLive(),
      onPos: (p, e) => this._onMousePos(p, e),
      onDown: e => { e.preventDefault(); this.focusSink(); },   // no text selection, keep the sink focused
    });
    this.wheel = new WheelAccumulator();
    this.stage.addEventListener('wheel', e => this._onWheel(e), { passive: false });
    this.stage.addEventListener('pointerleave', () => this._stopEdgePan());
    this.stage.addEventListener('pointerdown', () => this._hideHint(), true);
    this.tracker = new KeyTracker(send);
    this.bridge = new ClipboardBridge(m => this.send(m), e => this.tracker.keydown(e), {
      onPending: text => this._offerClipboard(text),
      onTooBig: () => toast(`El texto copiado es demasiado largo para enviarlo (máximo ${MAX_CLIPBOARD.toLocaleString('es-ES')} caracteres): se pega lo que ya hubiera en el equipo.`, { ms: 6000 }),
    });

    this.view.onChange(() => this._onViewChange());
    this._wireWindow();
    this._wireToolbar();
    this._prepareKeysBar();
    this._wireKeysBar();
    this._wireSheet();
    this._wirePill();
    this._applyModeUi();
    this._syncKeysBar();
    this._syncCursorButtons();
  }

  // ======================================================================= helpers
  active() { return activeScreen() === 'session'; }
  isLive() { return !!(this.rs && !this.rs.closed && this.hello); }

  send(msg) { if (this.rs && !this.rs.closed) this.rs.send(msg); }
  sendInput(msg) { if (this.canControl && this.isLive()) this.rs.send(msg); }

  toNorm(cx, cy) {
    if (!this.screenInfo) return null;
    const r = this.stage.getBoundingClientRect();
    const p = this.view.toRemote(cx - r.left, cy - r.top);
    return [round5(clamp(p.x / this.view.W, 0, 1)), round5(clamp(p.y / this.view.H, 0, 1))];
  }

  focusSink() {
    if (this.kind === 'desktop' && this.active() && !anyDialogOpen() && document.activeElement !== this.sinkEl) {
      try { this.sinkEl.focus({ preventScroll: true }); } catch { /* detached */ }
    }
  }

  // ======================================================================= open / connect
  open(machine) {
    this.machine = { slot: machine.slot, name: String(machine.name || 'Equipo'), os: String(machine.os || ''), machine_id: machine.machine_id };
    this.userClosed = false;
    this.retries = 0; this.failures = 0; this.everConnected = false;
    this.hello = null; this.screenInfo = null; this.chosenMonitor = null; this.forcedScale = null;
    this.cursorCache.clear(); this.cursorShape = null; this.cursorEntry = null; this.remotePos = null;
    this.totalBytes = 0; this.rtt = null; this.path = null;
    this.root.classList.add('noimg');
    this.root.classList.remove('lost', 'view-only');
    $('#title').textContent = this.machine.name;
    $('#sheetTitle').textContent = this.machine.name;
    $('#stats').textContent = '';
    $('#viewOnly').hidden = true;
    this._fillMonitors();
    showScreen('session');
    try { if (history.state?.rd !== 'session') history.pushState({ rd: 'session' }, ''); } catch { /* sandbox */ }
    this.layout();
    this.view.fit();
    this._statsTimer = setInterval(() => this._stats(), 1000);
    if (this.kind === 'desktop') this.focusSink();
    this.connect(false);
  }

  async connect(isRetry) {
    clearTimeout(this.retryTimer);
    const gen = ++this.gen;
    const old = this.rs;                         // never two sessions with the same host
    this.rs = null;
    if (old && !old.closed) old.abort('Sustituida por una conexión nueva.');
    this._setState(this.ghostUntil ? 'waiting' : isRetry ? 'reconnecting' : 'connecting');
    let core;
    try {
      await this.app.getNet();                   // the endpoint first (its errors are network errors)
      if (gen !== this.gen || this.userClosed) return;
      this.connectPending = gen;                 // net.connect includes waiting for the approval
      core = await this.app.connect(this.machine.slot, this.app.deviceName(), 30000);
    } catch (e) {
      if (this.connectPending === gen) this.connectPending = 0;
      if (gen !== this.gen || this.userClosed) return;
      this._onConnectError(e, isRetry);
      return;
    }
    if (this.connectPending === gen) this.connectPending = 0;
    if (gen !== this.gen || this.userClosed) { try { await core.close(); } catch { /* ignore */ } return; }
    this.failures = 0;
    this.firstFrame = false;
    this.sentSettings = {};
    this.rs = new RemoteSession(core, this._handlers(gen));
    $('#ovText').textContent = 'Recibiendo imagen…';
    this.rs.start();
  }

  _handlers(gen) {
    const live = () => gen === this.gen;
    return {
      onHello: m => live() && this._onHello(m),
      onScreen: i => live() && this._onScreen(i),
      onFrame: (f, n) => (live() ? this._onFrame(f, n) : undefined),
      onCursor: m => live() && this._onCursor(m),
      onCursorPos: (x, y) => live() && this._onCursorPos(x, y),
      onClipboard: t => live() && this.bridge.remote(t),
      onLatency: ms => { if (!live()) return; this.rtt = ms; this.aq.onRtt(ms, performance.now()); },
      onPath: p => { if (live()) this.path = typeof p === 'string' ? p : null; },
      onSilent: s => { if (live() && this.state === 'live') this._setDot(s ? 'warn' : 'ok', s ? 'El equipo remoto no responde…' : ''); },
      onEnd: e => { if (live()) this._onEnd(e); },
    };
  }

  _onConnectError(e, isRetry) {
    const code = errorCode(e);
    const msg = errorMessage(e, 'No se ha podido conectar.');
    if (code === 'busy' && this._ghostWait()) return;
    if (['offline', 'timeout', 'error'].includes(code)) {
      this.failures += 1;
      if (this.failures >= 2) { this.failures = 0; this.app.resetNet(); }   // the endpoint may be dead (suspended page)
    }
    // first connection (or a manual retry of one): say why and let the user decide
    if (!isRetry || !this.everConnected || ['denied', 'auth', 'rate_limited', 'protocol'].includes(code)) {
      this._setState('failed', msg, isRetry && this.everConnected);
      return;
    }
    this._scheduleReconnect(msg);
  }

  _scheduleReconnect(reason) {
    if (this.userClosed) return;
    if (this.retries >= MAX_RETRIES) { this._setState('failed', 'No se ha podido reconectar. ' + (reason || ''), true); return; }
    this._setState('reconnecting', reason);
    if (document.hidden) { this.reconnectWhenVisible = true; return; }
    const delay = BACKOFF_MS[Math.min(this.retries, BACKOFF_MS.length - 1)];
    this.retries += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(true), delay);
  }

  _retryNow() {
    if (this.userClosed || !this.machine) return;
    if (this.isLive()) return;
    this.reconnectWhenVisible = false;
    this.retries = 0;
    this.ghostUntil = 0;
    this.connect(this.everConnected);
  }

  // ---------------------------------------------------------------- our own ghost session
  /** Remember that this browser has a session with the machine (and when it was last alive). */
  _noteAlive() {
    if (!this.machine?.machine_id) return;
    this._aliveWritten = performance.now();
    setJSON(KEYS.lastSession, { machine_id: String(this.machine.machine_id).slice(0, 128), alive: Date.now(), closed: false });
  }

  /**
   * Closes `rs` with a bye. Until the core confirms that the host got it, the ghost window is
   * longer than the host's own watchdog (the bye may be lost: no network, page closing); once
   * confirmed it is shortened. The confirmation keeps the same `alive`, so a tab already waiting
   * on this ghost does not mistake it for another tab keeping the session alive.
   */
  _closeWithBye(rs) {
    const id = this.machine?.machine_id ? String(this.machine.machine_id).slice(0, 128) : null;
    const alive = Date.now();
    if (id) setJSON(KEYS.lastSession, { machine_id: id, alive, closed: true, acked: false });
    let p;
    try { p = rs.close(); } catch { return; }
    p?.then?.(acked => {
      if (acked !== true || !id) return;
      const last = getJSON(KEYS.lastSession, null);
      if (last && last.machine_id === id && last.alive === alive && last.closed === true) {
        setJSON(KEYS.lastSession, { machine_id: id, alive, closed: true, acked: true });
      }
    }).catch(() => {});
  }
  _forgetAlive() {
    const last = getJSON(KEYS.lastSession, null);
    if (last && this.machine && last.machine_id === this.machine.machine_id) setJSON(KEYS.lastSession, null);
  }

  /**
   * "busy" from a machine this browser was connected to moments ago: the host has not noticed
   * yet that our old session is gone. Retry every few seconds for a while ("Cerrando la sesión
   * anterior…") instead of failing. Returns true if a retry was scheduled.
   */
  _ghostWait() {
    if (this.userClosed || !this.machine) return false;
    const now = Date.now();
    const last = getJSON(KEYS.lastSession, null);
    const ours = last && typeof last === 'object' && last.machine_id === this.machine.machine_id && Number.isFinite(last.alive);
    if (!this.ghostUntil) {
      if (!ours) return false;
      const until = last.alive + (last.closed !== true ? GHOST_MS : last.acked === true ? GHOST_AFTER_ACK_MS : GHOST_AFTER_BYE_MS);
      if (until <= now || last.alive > now + 60000) return false;
      this.ghostUntil = until;
      this.ghostAlive = last.alive;
    } else if (ours && last.alive > this.ghostAlive) {
      // still being refreshed: another tab of this browser has that session alive, not a ghost
      this.ghostUntil = 0;
      return false;
    }
    if (now >= this.ghostUntil) { this.ghostUntil = 0; return false; }
    this._setState('waiting');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { if (!this.userClosed && this.state === 'waiting') this.connect(this.everConnected); }, GHOST_RETRY_MS);
    return true;
  }

  // ======================================================================= protocol events
  _onHello(msg) {
    this.hello = msg;
    this.everConnected = true;
    this.ghostUntil = 0;
    this._noteAlive();
    this.canControl = msg.can_control !== false;
    this.hostOs = typeof msg.os === 'string' ? msg.os : (this.machine.os || '');
    const mons = Array.isArray(msg.monitors) ? msg.monitors : [];
    this.monitors = mons.filter(m => m && Number.isInteger(m.index) && Number.isInteger(m.width) && Number.isInteger(m.height))
      .slice(0, 17).map(m => ({ index: m.index, width: m.width, height: m.height, name: typeof m.name === 'string' ? m.name.slice(0, 60) : `Pantalla ${m.index}` }));
    this.currentMonitor = Number.isInteger(msg.monitor) ? msg.monitor : null;
    this._fillMonitors();
    const isWin = /^win/i.test(this.hostOs);
    for (const b of $$('#keysbar [data-os]')) b.hidden = (b.dataset.os === 'windows') !== isWin;
    this._layoutKeys();
    this.root.classList.toggle('view-only', !this.canControl);
    $('#viewOnly').hidden = this.canControl;
    if (!this.canControl) this.kbd.close();
    this.sentSettings = {};
    this.applySettings(true);
    if (this.chosenMonitor != null && this.chosenMonitor !== this.currentMonitor) this.send({ t: 'settings', monitor: this.chosenMonitor });
  }

  _onScreen(info) {
    const firstScreen = !this.screenInfo;
    this.screenInfo = info;
    if (info.monitor != null) { this.currentMonitor = info.monitor; this._syncMonitorUi(); }
    if (info.fw * info.fh > MAX_CANVAS_AREA) {
      // iOS: canvases above 16.7 Mpx fail. Ask for a smaller transmitted size.
      this.forcedScale = info.fw * info.fh * 0.5625 <= MAX_CANVAS_AREA ? 0.75 : 0.5;
      toast('Pantalla demasiado grande para este dispositivo: se envía a menor resolución.');
      this.applySettings();
    }
    const W = this.view.W, H = this.view.H;
    this.view.setRemoteSize(info.width, info.height);
    if (firstScreen) { this.pointer.x = info.width / 2; this.pointer.y = info.height / 2; }
    else { this.pointer.x = clamp(this.pointer.x * info.width / W, 0, info.width - 1); this.pointer.y = clamp(this.pointer.y * info.height / H, 0, info.height - 1); }
    this.renderer.resize(info.fw, info.fh);
    this.render();
  }

  async _onFrame(frame, bytes) {
    const w = this.renderer.w, hh = this.renderer.h;
    const painted = await this.renderer.draw(frame);
    if (w !== this.renderer.w || hh !== this.renderer.h) this.render();
    this.totalBytes += bytes;
    this.aq.onFrame(bytes);
    // dropped (too big for this canvas, a newer one painted first): RemoteSession acks it anyway
    if (!painted) return;
    this.statFrames += 1;
    if (!this.firstFrame) {
      this.firstFrame = true;
      this.retries = 0;
      this.root.classList.remove('noimg', 'lost');
      this._setState('live');
      this._requestWakeLock();
      this._maybeHint();
    }
  }

  _onCursor(msg) {
    const shape = typeof msg.shape === 'string' && /^[a-z_]{1,24}$/.test(msg.shape) ? msg.shape : null;
    let entry = null;
    if (typeof msg.img === 'string' && msg.img.length <= 64) {
      entry = this.cursorCache.get(msg.img) || null;
      // A cursor is small: an image declaring more than 256x256 is refused before decoding
      // (a few KB of PNG can declare gigabytes of pixels).
      const size = !entry && typeof msg.png === 'string' ? pngSize(msg.png) : null;
      if (!entry && size && size.w >= 1 && size.h >= 1 && size.w <= MAX_CURSOR_PX && size.h <= MAX_CURSOR_PX
          && msg.png.length <= 512 * 1024 && /^[A-Za-z0-9+/]+=*$/.test(msg.png)) {
        entry = { url: 'data:image/png;base64,' + msg.png, hx: Number(msg.hx) | 0, hy: Number(msg.hy) | 0, w: 0, h: 0 };
        if (this.cursorCache.size >= MAX_CURSOR_CACHE) this.cursorCache.clear();
        this.cursorCache.set(msg.img, entry);
        const im = new Image();
        im.onload = () => {
          entry.w = Math.min(MAX_CURSOR_PX, im.naturalWidth); entry.h = Math.min(MAX_CURSOR_PX, im.naturalHeight);
          entry.hx = clamp(entry.hx, 0, Math.max(0, entry.w - 1)); entry.hy = clamp(entry.hy, 0, Math.max(0, entry.h - 1));
          if (this.cursorEntry === entry) { this._applyLocalCursor(); this.renderCursor(); }
        };
        im.src = entry.url;
      }
    }
    this.cursorShape = shape;
    this.cursorEntry = shape === 'blank' ? null : entry;
    this._applyLocalCursor();
    this.renderCursor();
  }

  _onCursorPos(x, y) {
    this.remotePos = x == null ? null : { x, y };
    if (x != null && this._trackpad() && performance.now() - this.gestures.lastLocalMove > 600) {
      // the app warped the pointer or someone moved the mouse at the PC: follow it
      this.pointer.x = x * this.view.W; this.pointer.y = y * this.view.H;
    }
    this.renderCursor();
  }

  _onEnd({ kind, reason }) {
    this.rs = null;
    this.hello = null;
    this._releaseLocal();
    if (kind === 'user' || this.userClosed) return;
    this._releaseWakeLock();
    if (kind === 'bye') { this._forgetAlive(); this._setState('ended', reason); return; }
    this._scheduleReconnect(reason);
  }

  // ======================================================================= UI state
  _setState(state, text = '', wasRetry = false) {
    this.state = state;
    const ov = $('#overlay'), title = $('#ovTitle'), body = $('#ovText'), actions = $('#ovActions');
    const name = this.machine?.name || 'el equipo';
    const btn = (label, fn, cls = '') => h('button', { class: 'btn ' + cls, attrs: { type: 'button' }, text: label, on: { click: fn } });
    const toList = () => this.disconnect();
    actions.replaceChildren();
    clearTimeout(this._approvalTimer);
    if (state === 'connecting' || state === 'reconnecting') {
      // The host may be waiting for someone at the PC to accept (up to a minute): say so.
      const gen = this.gen;
      this._approvalTimer = setTimeout(() => {
        if (this.state === state && this.connectPending === gen && this.gen === gen) {
          body.textContent = `Si RemoteDesk pide confirmación en ${name}, acéptala allí. Puede tardar hasta un minuto.`;
        }
      }, APPROVAL_HINT_MS);
    }
    this._pillWake();
    $('#ovSpinner').hidden = !(state === 'connecting' || state === 'reconnecting' || state === 'waiting');
    this.root.classList.toggle('lost', ['reconnecting', 'ended', 'failed'].includes(state) && !this.root.classList.contains('noimg'));
    switch (state) {
      case 'live':
        ov.hidden = true;
        this._setDot('ok');
        return;
      case 'connecting':
        title.textContent = `Conectando con ${name}…`;
        body.textContent = 'Buscando el equipo y estableciendo una conexión cifrada (vía relay).';
        actions.append(btn('Cancelar', toList));
        this._setDot('warn');
        break;
      case 'waiting':
        title.textContent = 'Cerrando la sesión anterior…';
        body.textContent = `${name} aún tiene abierta la sesión que este navegador tenía hace un momento. Se vuelve a intentar enseguida.`;
        actions.append(btn('Volver a la lista', toList));
        this._setDot('warn');
        break;
      case 'reconnecting':
        title.textContent = 'Conexión perdida';
        body.textContent = this.retries > 0 ? `Reconectando… (intento ${this.retries + 1})` : 'Reconectando…';
        actions.append(btn('Volver a la lista', toList));
        this._setDot('warn');
        break;
      case 'ended':
        title.textContent = 'Sesión terminada';
        body.textContent = text || `${name} ha cerrado la sesión.`;
        actions.append(btn('Volver a la lista', toList), btn('Volver a conectar', () => this._retryNow(), 'primary'));
        this._setDot('bad');
        break;
      case 'failed':
        title.textContent = wasRetry ? 'No se ha podido reconectar' : `No se ha podido conectar con ${name}`;
        body.textContent = text;
        actions.append(btn('Volver a la lista', toList), btn('Reintentar', () => this._retryNow(), 'primary'));
        this._setDot('bad');
        break;
      default:
        break;
    }
    ov.hidden = false;
  }

  _setDot(cls, status = '') {
    for (const d of $$('#topbar .dot, #pill .dot')) { d.classList.remove('ok', 'warn', 'bad'); d.classList.add(cls); }
    if (status) $('#stats').textContent = status;
  }

  // ======================================================================= rendering
  render() {
    const v = this.view;
    const k = v.z * v.W / Math.max(1, this.renderer.w);       // CSS px per frame px
    this.fb.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${k})`;
    this.stage.classList.toggle('pixelated', v.z * devicePixelRatio >= 2);
    this.renderCursor();
    const fitLabel = v.isFit ? (this.kind === 'desktop' ? '1:1' : 'Ampliar') : 'Ajustar';
    $('#zoomLabel').textContent = fitLabel;
    $('#tbFit').textContent = fitLabel;
  }

  _trackpad() { return this.touchUi && this.prefs.mode === 'trackpad'; }

  renderCursor() {
    const el = this.cursorEl;
    const v = this.view;
    let pos = null;
    if (this.screenInfo) {
      if (this._trackpad()) pos = this.pointer;
      else if (this.prefs.remoteCursor && this.remotePos) pos = { x: this.remotePos.x * v.W, y: this.remotePos.y * v.H };
    }
    if (!pos) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const blank = this.cursorShape === 'blank';
    const e = this.cursorEntry && this.cursorEntry.w ? this.cursorEntry : null;
    let w, hh, hx, hy;
    el.classList.toggle('ring', blank);
    if (blank) { w = 14; hh = 14; hx = 7; hy = 7; }
    else if (e) { w = e.w; hh = e.h; hx = e.hx; hy = e.hy; }
    else { w = 12; hh = 19; hx = 0.5; hy = 0.5; }
    this.cursorImg.hidden = blank || !e;
    $('#rcArrow').style.display = blank || e ? 'none' : '';
    if (e && this.cursorImg.getAttribute('src') !== e.url) this.cursorImg.src = e.url;
    // touch screens: a comfortable size whatever the zoom; desktop: the image's own size (like the Qt viewer)
    const k = this.touchUi && !blank ? clamp(hh * v.z * 1.5, 20, 32) / hh : 1;
    const s = v.toScreen(pos.x, pos.y);
    el.style.width = `${w * k}px`;
    el.style.height = `${hh * k}px`;
    el.style.transform = `translate(${s.x - hx * k}px, ${s.y - hy * k}px)`;
  }

  _applyLocalCursor() {
    let css = 'default';
    if (!this.prefs.localCursor) css = 'none';
    else if (this.cursorShape && CSS_CURSORS[this.cursorShape]) css = CSS_CURSORS[this.cursorShape];
    else if (this.cursorEntry && this.cursorEntry.w && this.cursorEntry.w <= 128 && this.cursorEntry.h <= 128) {
      css = `url("${this.cursorEntry.url}") ${this.cursorEntry.hx} ${this.cursorEntry.hy}, default`;
    }
    this.stage.style.cursor = css;
  }

  layout() {
    const vv = window.visualViewport;
    const hgt = vv ? vv.height : window.innerHeight;
    const top = vv ? vv.offsetTop : 0;
    document.documentElement.style.setProperty('--vvh', `${hgt}px`);
    document.documentElement.style.setProperty('--vvtop', `${top}px`);
    if (!this.active()) return;
    const r = this.stage.getBoundingClientRect();
    // portrait phone/tablet: desktop pinned to the top, so the soft keyboard (bottom half) never covers it
    this.view.alignTop = this.touchUi && window.innerHeight > window.innerWidth * 1.2;
    this.view.setViewport(r.width, r.height, this.kbd.isOpen ? { x: this.pointer.x, y: this.pointer.y } : null);
    this.render();
    this._fitToolbar();
    this._layoutKeys();
    this._placePill();
    // Toasts sit just above whatever is under the remote screen (keys bar, bottom bar, keyboard).
    const wr = this.stageWrap.getBoundingClientRect();
    document.documentElement.style.setProperty('--toast-bottom', `${Math.round(Math.max(12, window.innerHeight - wr.bottom + 12))}px`);
  }

  /** Desktop/tablet toolbar: drop the button labels when they do not fit (icons + tooltips). */
  _fitToolbar() {
    const t = $('#tools');
    if (!this.active() || getComputedStyle(t).display === 'none') return;
    t.classList.remove('compact');
    if (t.scrollWidth > t.clientWidth + 1) t.classList.add('compact');
  }

  _onViewChange() {
    this.render();
    clearTimeout(this._zoomTimer);
    this._zoomTimer = setTimeout(() => {         // more pixels only after the pinch settles
      this.aq.setZoom(this.view.z, devicePixelRatio);
      this.applySettings();
    }, 600);
  }

  _ripple(kind, x, y) {
    const d = h('div', { class: 'ripple ' + kind });
    d.style.left = x + 'px'; d.style.top = y + 'px';
    $('#fx').appendChild(d);
    setTimeout(() => d.remove(), kind === 'drag' ? 900 : 600);
  }

  _maybeHint() {
    if (this.kind !== 'phone' || this.prefs.mode !== 'trackpad' || prefs.get('hintShown', false)) return;
    $('#hint').hidden = false;
  }
  _hideHint() {
    if ($('#hint').hidden) return;
    $('#hint').hidden = true;
    prefs.set('hintShown', true);
  }

  // ======================================================================= settings
  _wantCursorPos() { return this._trackpad() || !!this.prefs.remoteCursor; }

  desiredSettings() {
    const t = this.aq.target();
    const p = this.prefs;
    const quality = p.quality === 'auto' ? t.quality : QUALITY[p.quality];
    let scale = p.scale === 'auto' ? t.scale : Number(p.scale);
    if (this.forcedScale) scale = Math.min(scale, this.forcedScale);
    const fps = document.hidden ? 1 : (p.fps === 'auto' ? t.fps : Number(p.fps));
    return { quality, scale, fps, cursor_pos: this._wantCursorPos() };
  }

  /** Sends the settings that changed (all of them with force, e.g. after hello). */
  applySettings(force = false) {
    if (!this.isLive()) return;
    const d = this.desiredSettings();
    const out = { t: 'settings' };
    let n = 0;
    for (const [k, v] of Object.entries(d)) {
      if (force || this.sentSettings[k] !== v) { out[k] = v; n += 1; }
    }
    if (n) { this.send(out); Object.assign(this.sentSettings, d); }
  }

  _setPref(name, value) {
    this.prefs[name] = value;
    prefs.set(name, value);
  }

  _stats() {
    const now = performance.now();
    const dt = Math.max(0.001, (now - this.statT) / 1000);
    this.fps = this.statFrames / dt;
    this.statFrames = 0; this.statT = now;
    const si = this.screenInfo;
    if (this.state === 'live') {
      if (performance.now() - (this._aliveWritten || 0) >= ALIVE_EVERY_MS) this._noteAlive();
      const parts = [];
      if (this.rtt != null) parts.push(`${Math.round(this.rtt)} ms`);
      if (this.path) parts.push(this.kind === 'phone' ? this.path.replace(/^vía /, '') : this.path);
      if (this.kind !== 'phone') parts.push(`${Math.round(this.fps)} fps`);
      if (!this.rs?.silent) $('#stats').textContent = parts.join(' · ');
      if (this.kind === 'desktop') {
        const head = `Conectado a ${this.machine?.name || '?'}${this.hostOs ? ` (${this.hostOs})` : ''}`;
        const status = this.rs?.silent ? 'El equipo remoto no responde…' : parts.join(' · ');
        $('#statusText').textContent = [head, si ? `${si.width}×${si.height}` : '', status, fmtMB(this.totalBytes)].filter(Boolean).join('  ·  ');
      }
    } else if (this.kind === 'desktop') {
      $('#statusText').textContent = $('#ovTitle').textContent;
    }
    $('#dataUsed').textContent = fmtMB(this.totalBytes);
    $('#connInfo').textContent = [this.hostOs, si ? `${si.width}×${si.height}` : '', this.path || ''].filter(Boolean).join(' · ');
    this.applySettings();
  }

  // ======================================================================= monitors
  _fillMonitors() {
    const sel = $('#selMonitor'), seg = $('#segMonitor');
    sel.replaceChildren(); seg.replaceChildren();
    const mons = this.monitors;
    const items = mons.filter(m => m.index > 0).map(m => ({ index: m.index, label: `${m.index}: ${m.name} (${m.width}×${m.height})`, short: `${m.index}` }));
    const all = mons.find(m => m.index === 0);
    if (all && items.length > 1) items.push({ index: 0, label: `Todas las pantallas (${all.width}×${all.height})`, short: 'Todas' });
    for (const it of items) {
      sel.appendChild(h('option', { value: String(it.index), text: it.label }));
      seg.appendChild(h('button', { attrs: { type: 'button', title: it.label }, dataset: { v: String(it.index) }, text: it.short,
        on: { click: () => this.chooseMonitor(it.index) } }));
    }
    sel.hidden = items.length <= 1;
    $('#rowMonitor').hidden = items.length <= 1;
    this._syncMonitorUi();
    this._fitToolbar();
  }

  _syncMonitorUi() {
    if (this.currentMonitor == null) return;
    $('#selMonitor').value = String(this.currentMonitor);
    for (const b of $$('#segMonitor button')) b.classList.toggle('on', b.dataset.v === String(this.currentMonitor));
  }

  chooseMonitor(index) {
    this.chosenMonitor = index;
    this.currentMonitor = index;
    this._syncMonitorUi();
    this.send({ t: 'settings', monitor: index });
  }

  // ======================================================================= input
  _onMousePos(p, e) {
    this.pointer.x = p[0] * this.view.W;
    this.pointer.y = p[1] * this.view.H;
    this.gestures.lastLocalMove = performance.now();
    if (this._trackpad() || this.prefs.remoteCursor) this.renderCursor();
    if (!this.view.isFit) this._edgePan(e.clientX, e.clientY);
  }

  // 1:1 view with a mouse: moving to an edge of the stage pans the view (like scrollbars).
  _edgePan(cx, cy) {
    const r = this.stage.getBoundingClientRect();
    const m = 32;
    const dx = cx < r.left + m ? (r.left + m - cx) : cx > r.right - m ? -(cx - (r.right - m)) : 0;
    const dy = cy < r.top + m ? (r.top + m - cy) : cy > r.bottom - m ? -(cy - (r.bottom - m)) : 0;
    this._pan = { dx, dy, cx, cy };
    if ((dx || dy) && !this._panRaf) {
      const step = () => {
        const p = this._pan;
        if (!p || (!p.dx && !p.dy) || this.view.isFit) { this._panRaf = 0; return; }
        const tx = this.view.tx, ty = this.view.ty;
        this.view.panBy(p.dx * 0.4, p.dy * 0.4);
        if (tx === this.view.tx && ty === this.view.ty) { this._panRaf = 0; return; }
        const n = this.toNorm(p.cx, p.cy);         // the point under the mouse changed
        if (n) { this.pointer.x = n[0] * this.view.W; this.pointer.y = n[1] * this.view.H; this.sendInput({ t: 'mouse_move', x: n[0], y: n[1] }); }
        this._panRaf = requestAnimationFrame(step);
      };
      this._panRaf = requestAnimationFrame(step);
    }
  }
  _stopEdgePan() { this._pan = null; }

  _onWheel(e) {
    e.preventDefault();
    const ctrlHeld = this.tracker.pressed.has('ControlLeft') || this.tracker.pressed.has('ControlRight');
    if (e.ctrlKey && !ctrlHeld) {               // touchpad pinch (synthetic ctrlKey): local zoom
      const r = this.stage.getBoundingClientRect();
      this.view.zoomAt(Math.exp(-e.deltaY / 100), e.clientX - r.left, e.clientY - r.top);
      return;
    }
    const m = this.wheel.push(e);
    if (m) this.sendInput(m);
  }

  _isEditable(t) {
    if (!t || t === this.sinkEl) return false;
    return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
  }

  _onKeyDown(e) {
    if (!this.active() || anyDialogOpen() || !$('#sheet').hidden) return;
    if (e.target === this.kbdEl || this._isEditable(e.target)) return;   // soft keyboard / forms
    if (!this.isLive() || !this.canControl) return;
    if (this.bridge.keydown(e)) return;         // Ctrl+V: let the browser fire 'paste' first
    if (this.tracker.keydown(e)) e.preventDefault();
  }

  _onKeyUp(e) {
    if (!this.active()) return;
    if (e.target === this.kbdEl || this._isEditable(e.target)) return;
    this.bridge.keyup(e);
    if (this.tracker.keyup(e)) e.preventDefault();
  }

  _onPaste(e) {
    if (!this.active() || anyDialogOpen()) return;
    if (e.target === this.kbdEl || this._isEditable(e.target)) return;   // soft keyboard: typed as text
    this.bridge.paste(e);
  }

  _offerClipboard(text) {
    if (!this.active()) return;
    const name = this.machine?.name || 'el equipo';
    toast(`Texto copiado en ${name}`, {
      action: 'Copiar aquí', ms: 12000,
      onAction: async () => { const ok = await this.bridge.flushPending(); toast(ok ? 'Copiado en este dispositivo.' : 'No se ha podido copiar.'); },
    });
  }

  /** Lift everything held and tell the host (blur, hidden page, disconnect, mode switch). */
  releaseInputs() {
    this.gestures.releaseAll();
    this.mouse.releaseHeld();
    this.tracker.releaseAll();
    this.mods.releaseAll();
    this.send({ t: 'release_all' });
  }
  _releaseLocal() {                              // the session is gone: forget local state only
    this.gestures.releaseAll();
    this.mouse.releaseHeld();
    this.tracker.releaseAll();
    this.mods.releaseAll();
  }

  typeText(text) {
    for (const part of chunks(String(text).replace(/\r\n?/g, '\n'), TEXT_CHUNK)) this.sendInput({ t: 'text', s: part });
  }

  // ======================================================================= lifecycle
  _wireWindow() {
    window.addEventListener('keydown', e => this._onKeyDown(e), true);
    window.addEventListener('keyup', e => this._onKeyUp(e), true);
    window.addEventListener('paste', e => this._onPaste(e), true);
    window.addEventListener('blur', () => { if (this.isLive()) this.releaseInputs(); });
    document.addEventListener('visibilitychange', () => this._onVisibility());
    document.addEventListener('resume', () => this._onVisibility());
    window.addEventListener('pagehide', () => {
      // the page may be gone before the host acknowledges the bye: the longer window stays
      if (this.rs && !this.rs.closed && !this.userClosed) { this.reconnectOnShow = true; this._closeWithBye(this.rs); }
    });
    window.addEventListener('pageshow', e => {
      if (e.persisted && this.reconnectOnShow && this.machine && !this.userClosed) { this.reconnectOnShow = false; this._retryNow(); }
    });
    window.addEventListener('online', () => { if (['reconnecting', 'failed'].includes(this.state) && this.active()) this._retryNow(); });
    const relayout = () => this.layout();
    window.visualViewport?.addEventListener('resize', relayout);
    window.visualViewport?.addEventListener('scroll', relayout);
    window.addEventListener('resize', relayout);
    window.addEventListener('orientationchange', () => setTimeout(relayout, 250));
    document.addEventListener('fullscreenchange', () => {
      const on = !!document.fullscreenElement;
      $('#tbFull').classList.toggle('on', on);
      $('#tbFull').setAttribute('aria-pressed', String(on));
      if (!on) { try { navigator.keyboard?.unlock?.(); } catch { /* unsupported */ } }
      setTimeout(relayout, 100);
    });
    this.sinkEl.addEventListener('input', () => { this.sinkEl.value = ''; });
  }

  _onVisibility() {
    if (!this.machine || this.userClosed) return;
    if (document.hidden) {
      if (this.isLive()) { this.releaseInputs(); this.applySettings(); this._noteAlive(); }   // fps 1 in the background
      return;
    }
    this.rs?.markVisible();
    if (this.reconnectWhenVisible) { this._retryNow(); return; }
    if (this.isLive()) {
      const rs = this.rs;
      rs.pingNow();
      this.applySettings();
      this.send({ t: 'refresh' });
      this._requestWakeLock();
      const before = rs.lastMsg;
      clearTimeout(this._watchdog);
      this._watchdog = setTimeout(() => {         // iOS/Android may have killed the connection
        if (this.rs === rs && !rs.closed && rs.lastMsg === before) rs.abort('Se ha perdido la conexión mientras la página estaba en segundo plano.');
      }, WATCHDOG_MS);
    }
  }

  async _requestWakeLock() {
    if (!navigator.wakeLock || document.hidden || this.wakeLock || this.kind === 'desktop') return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener?.('release', () => { this.wakeLock = null; });
    } catch { this.wakeLock = null; }
  }
  _releaseWakeLock() {
    try { this.wakeLock?.release?.(); } catch { /* gone */ }
    this.wakeLock = null;
  }

  /**
   * The user leaves the session (button, back gesture, "Volver a la lista"). Back to the list
   * at once: the bye and the bounded close (up to a few seconds on a dead network) go on in
   * the background.
   */
  async disconnect(fromHistory = false) {
    if (this.userClosed && !this.machine) return;
    this.userClosed = true;
    this.gen += 1;
    clearTimeout(this.retryTimer); clearTimeout(this._watchdog); clearInterval(this._statsTimer);
    clearTimeout(this._approvalTimer);
    this.reconnectWhenVisible = false;
    this.ghostUntil = 0;
    // Una pregunta «¿Desconectar…?» pendiente (gesto de atrás) ya no tiene sentido.
    for (const dlg of document.querySelectorAll('dialog.dlg-leave')) { try { dlg.close(); } catch { /* ignore */ } }
    const rs = this.rs;
    const bye = !!(rs && !rs.closed);
    if (bye) this.releaseInputs();
    this.rs = null; this.hello = null;
    $('#sheet').hidden = true;
    this.kbd.close();
    if (document.fullscreenElement) { try { document.exitFullscreen().catch(() => {}); } catch { /* ignore */ } }
    this._releaseWakeLock();
    if (bye) this._closeWithBye(rs);       // needs this.machine: before it is cleared below
    else if (rs) { try { rs.close().catch(() => {}); } catch { /* ignore */ } }
    this.renderer.release();
    this.root.classList.add('noimg');
    $('#overlay').hidden = true;
    this.state = 'idle';
    this.machine = null;
    if (!fromHistory && history.state?.rd === 'session') { this.ignorePop = true; history.back(); }
    this.app.onSessionClosed();
  }

  // ======================================================================= toolbar, bars, sheet
  _applyModeUi() {
    const m = this.prefs.mode;
    $('#modeLabel').textContent = m === 'trackpad' ? 'Ratón' : 'Táctil';
    $('#tbMode').textContent = m === 'trackpad' ? 'Ratón' : 'Táctil';
    for (const b of $$('#segMode button')) b.classList.toggle('on', b.dataset.v === m);
    this.root.classList.toggle('mode-trackpad', m === 'trackpad');
  }

  setMode(m) {
    if (m !== 'trackpad' && m !== 'direct') return;
    if (this.isLive()) this.releaseInputs();
    this._setPref('mode', m);
    this.gestures.setMode(m);
    this._applyModeUi();
    this.applySettings();
    this.render();
  }

  /**
   * The keys bar: the groups of index.html (main keys, editing keys, F1-F12, shortcuts) are
   * split into as many pages as the width needs, so every key is reachable without scrolling
   * (the buttons cancel touchstart to keep the soft keyboard open, so the bar cannot scroll).
   * One fixed "⋯" button at the right end cycles through the pages.
   */
  _prepareKeysBar() {
    const bar = $('#keysbar');
    const pages = $$('#keysbar .kpage');
    const more = pages[0].querySelector('[data-nextpage]');
    for (const b of $$('#keysbar [data-nextpage]')) if (b !== more) b.remove();
    more.classList.add('kmore');
    bar.appendChild(more);
    this._keyGroups = pages.map(pg => [...pg.children]);
    this._keysLayoutFor = '';
  }

  _layoutKeys() {
    const bar = $('#keysbar');
    const width = bar.clientWidth;
    if (!width) return;                          // not shown: laid out when it appears
    const hidden = this._keyGroups.flat().map(b => (b.hidden ? 1 : 0)).join('');
    const key = `${width}|${hidden}`;
    if (key === this._keysLayoutFor) return;
    this._keysLayoutFor = key;
    const more = bar.querySelector('.kmore');
    const old = $$('#keysbar .kpage');
    const shown = old.find(pg => !pg.hidden)?.querySelector('button:not([hidden])') || null;
    // natural width of every key, all on one invisible line
    const measure = h('div', { class: 'kpage kmeasure', attrs: { 'aria-hidden': 'true' } });
    bar.appendChild(measure);
    const all = this._keyGroups.flat();
    measure.append(...all);
    const widths = new Map(all.map(b => [b, b.hidden ? 0 : b.getBoundingClientRect().width]));
    measure.remove();
    more.hidden = false;
    const avail = width - more.getBoundingClientRect().width - 1;
    // keys are >= 44 px wide (CSS): the four arrows stay together on one page
    const isArrow = b => /^Arrow/.test(b.dataset.key || '');
    const units = group => group.reduce((out, b) => {
      const last = out[out.length - 1];
      if (last && isArrow(b) && isArrow(last[last.length - 1])) last.push(b); else out.push([b]);
      return out;
    }, []);
    const unitWidth = u => u.reduce((a, b) => a + widths.get(b), 0);
    const split = (group, limit) => {          // greedy: as many keys per page as fit in `limit`
      const out = [];
      let cur = [], used = 0;
      for (const u of units(group)) {
        const w = unitWidth(u);
        if (w && used > 0 && used + w > limit) { out.push(cur); cur = []; used = 0; }
        cur.push(...u); used += w;
      }
      if (cur.length) out.push(cur);
      return out;
    };
    const pages = [];
    for (const group of this._keyGroups) {
      let parts = split(group, avail);
      if (parts.length > 1) {                    // same number of pages, keys spread evenly
        const ws = units(group).map(unitWidth);
        const even = split(group, Math.min(avail, ws.reduce((a, x) => a + x, 0) / parts.length + Math.max(...ws) / 2));
        if (even.length === parts.length) parts = even;
      }
      pages.push(...parts);
    }
    for (const pg of old) pg.remove();
    let show = 0;
    pages.forEach((list, i) => {
      const pg = h('div', { class: 'kpage', dataset: { page: String(i) } }, list);
      if (shown && list.includes(shown)) show = i;
      bar.insertBefore(pg, more);
    });
    $$('#keysbar .kpage').forEach((pg, i) => { pg.hidden = i !== show; });
    more.hidden = pages.length < 2;
  }

  _syncKeysBar() {
    this.root.classList.toggle('keys-open', this.kbd.isOpen || this.prefs.keysPinned);
    this._layoutKeys();
    $('#btnKeys').classList.toggle('on', this.prefs.keysPinned);
    $('#tbKeys').classList.toggle('on', this.prefs.keysPinned);
    $('#chkKeys').checked = this.prefs.keysPinned;
  }

  _syncCursorButtons() {
    const r = $('#tbRemoteCursor'), l = $('#tbLocalCursor');
    r.setAttribute('aria-pressed', String(!!this.prefs.remoteCursor)); r.classList.toggle('on', !!this.prefs.remoteCursor);
    l.setAttribute('aria-pressed', String(!!this.prefs.localCursor)); l.classList.toggle('on', !!this.prefs.localCursor);
    $('#chkRemoteCursor').checked = !!this.prefs.remoteCursor;
  }

  _setCursorOptions(remote, local) {
    if (!local && !remote) remote = true;        // without any cursor you can't see the mouse
    this._setPref('remoteCursor', remote);
    this._setPref('localCursor', local);
    this._syncCursorButtons();
    this._applyLocalCursor();
    this.applySettings();
    this.renderCursor();
  }

  _syncQualityUi() {
    $('#selQuality').value = String(this.prefs.quality);
    $('#selScale').value = String(this.prefs.scale);
    for (const b of $$('#segQuality button')) b.classList.toggle('on', b.dataset.v === String(this.prefs.quality));
    for (const b of $$('#segScale button')) b.classList.toggle('on', b.dataset.v === String(this.prefs.scale));
    for (const b of $$('#segFps button')) b.classList.toggle('on', b.dataset.v === String(this.prefs.fps));
  }

  setQuality(v) { this._setPref('quality', v); this._syncQualityUi(); this.applySettings(); }
  setScale(v) { this._setPref('scale', v === 'auto' ? 'auto' : Number(v)); this._syncQualityUi(); this.applySettings(); }
  setFps(v) { this._setPref('fps', v === 'auto' ? 'auto' : Number(v)); this._syncQualityUi(); this.applySettings(); }

  toggleZoom() {
    const oneToOne = this.kind === 'desktop' ? 1 / (devicePixelRatio || 1) : 1;
    this.view.toggleZoom(this._trackpad() ? this.pointer : null, oneToOne);
  }

  async toggleFullscreen() {
    if (document.fullscreenElement) {
      try { navigator.keyboard?.unlock?.(); } catch { /* unsupported */ }
      try { await document.exitFullscreen(); } catch { /* ignore */ }
      return;
    }
    if (isIOS()) {
      // iPhone and iPad: element fullscreen blocks the keyboard (iPadOS) or does not exist
      // (iPhone). The Home Screen app is the way.
      toast(isStandalone()
        ? 'Ya estás en la app de la pantalla de inicio: RemoteDesk ocupa toda la pantalla.'
        : `En el ${iosDevice() || 'iPhone'}: Compartir → Añadir a pantalla de inicio, y abre RemoteDesk desde allí.`, { ms: 8000 });
      return;
    }
    const el = document.documentElement;
    if (el.requestFullscreen && document.fullscreenEnabled) {
      try {
        await el.requestFullscreen({ navigationUI: 'hide' });
        // Keyboard Lock (Chromium desktop): Alt+Tab, Win, Esc… go to the remote while fullscreen
        if (this.kind === 'desktop') { try { await navigator.keyboard?.lock?.(); } catch { /* unsupported */ } }
        else { try { await screen.orientation?.lock?.('landscape'); } catch { /* not allowed */ } }
      } catch { toast('El navegador no ha permitido la pantalla completa.'); }
    } else {
      toast('Este navegador no permite la pantalla completa.');
    }
  }

  _afterToolbar() { if (this.kind === 'desktop') this.focusSink(); }

  _wireToolbar() {
    const click = (sel, fn) => $(sel).addEventListener('click', e => { fn(e); this._afterToolbar(); });
    // Keyboard toggles must call focus() synchronously inside the user gesture (iOS). The tap
    // itself may blur the hidden input before `click`, so remember the state at pointerdown.
    const keyboardButton = btn => {
      let wasOpen = false;
      btn.addEventListener('pointerdown', () => { wasOpen = this.kbd.isOpen; });
      btn.addEventListener('click', () => { if (!this.canControl) return; if (wasOpen) this.kbd.close(); else this.kbd.open(); });
    };
    keyboardButton($('#btnKbd')); keyboardButton($('#pillKbd')); keyboardButton($('#tbKbd'));
    // controls used while typing must not steal the focus from the hidden input
    for (const b of $$('#pill button, #topbar .icon')) b.addEventListener('mousedown', e => { if (this.kbd.isOpen) e.preventDefault(); });

    click('#btnMode', () => this.setMode(this.prefs.mode === 'trackpad' ? 'direct' : 'trackpad'));
    click('#tbMode', () => this.setMode(this.prefs.mode === 'trackpad' ? 'direct' : 'trackpad'));
    const toggleKeys = () => {
      this._setPref('keysPinned', !this.prefs.keysPinned);
      this._syncKeysBar();
      requestAnimationFrame(() => this.layout());
    };
    click('#btnKeys', toggleKeys);
    click('#tbKeys', toggleKeys);
    click('#btnZoom', () => this.toggleZoom());
    click('#tbFit', () => this.toggleZoom());
    click('#tbFull', () => this.toggleFullscreen());
    click('#tbRemoteCursor', () => this._setCursorOptions(!this.prefs.remoteCursor, this.prefs.localCursor));
    click('#tbLocalCursor', () => this._setCursorOptions(this.prefs.remoteCursor, !this.prefs.localCursor));
    click('#tbCad', () => { if (this.isLive() && this.canControl) sendCombo(m => this.sendInput(m), 'ctrl+alt+Delete'); });
    click('#btnClose', () => this.disconnect());
    $('#selMonitor').addEventListener('change', e => { this.chooseMonitor(Number(e.target.value)); this._afterToolbar(); });
    $('#selQuality').addEventListener('change', e => { this.setQuality(e.target.value); this._afterToolbar(); });
    $('#selScale').addEventListener('change', e => { this.setScale(e.target.value); this._afterToolbar(); });
    this._syncQualityUi();

    const sheet = $('#sheet');
    const openSheet = () => { sheet.hidden = false; };
    click('#btnMore', openSheet);
    click('#btnMenu', openSheet);
    click('#pillMenu', openSheet);
    document.addEventListener('pointerdown', e => {
      if (!sheet.hidden && !sheet.contains(e.target) && !e.target.closest?.('#btnMenu, #btnMore, #pillMenu')) sheet.hidden = true;
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !sheet.hidden) { sheet.hidden = true; e.stopPropagation(); } }, true);
  }

  _wireKeysBar() {
    const pressable = (el, { onPress, onLongPress, repeat }) => {
      let timer = 0, rep = 0, long = false;
      el.addEventListener('pointerdown', e => {
        e.preventDefault();                       // keep focus in #kbd: the soft keyboard stays open
        try { el.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
        el.classList.add('pressed'); long = false;
        if (repeat) { onPress(); timer = setTimeout(() => { rep = setInterval(onPress, 60); }, 400); }
        else if (onLongPress) timer = setTimeout(() => { long = true; onLongPress(); }, 500);
      });
      const end = fire => () => {
        el.classList.remove('pressed');
        clearTimeout(timer); clearInterval(rep); timer = rep = 0;
        if (fire && !repeat && !long) onPress();
      };
      el.addEventListener('pointerup', end(true));
      el.addEventListener('pointercancel', end(false));
      el.addEventListener('mousedown', e => e.preventDefault());
      el.addEventListener('touchstart', e => { if (e.cancelable) e.preventDefault(); }, { passive: false });
      el.addEventListener('click', e => e.preventDefault());
    };
    const tapKey = entry => {
      this.sendInput(keyMsg(entry, true)); this.sendInput(keyMsg(entry, false));
      this.mods.consume();
    };
    for (const b of $$('#keysbar [data-key]')) pressable(b, { onPress: () => tapKey(NAMED[b.dataset.key]), repeat: b.hasAttribute('data-repeat') });
    for (const b of $$('#keysbar [data-mod]')) pressable(b, { onPress: () => this.mods.tap(b.dataset.mod), onLongPress: () => this.mods.lock(b.dataset.mod) });
    for (const b of $$('#keysbar [data-combo]')) pressable(b, { onPress: () => sendCombo(m => this.sendInput(m), b.dataset.combo) });
    for (const b of $$('#keysbar [data-nextpage]')) {
      pressable(b, { onPress: () => {
        const pages = $$('#keysbar .kpage');
        const i = pages.findIndex(p => !p.hidden);
        pages[i].hidden = true; pages[(i + 1) % pages.length].hidden = false;
      } });
    }
    this.mods.onChange(st => {
      for (const b of $$('#keysbar [data-mod]')) {
        const s = st[b.dataset.mod];
        b.classList.toggle('once', s === 'once'); b.classList.toggle('locked', s === 'locked');
      }
    });
    for (const el of [$('#keysbar'), $('#pill')]) {
      el.addEventListener('touchstart', e => { if (this.kbd.isOpen && e.cancelable && e.target.closest('button')) e.preventDefault(); }, { passive: false });
    }
  }

  _wireSheet() {
    const sheet = $('#sheet');
    const close = () => { sheet.hidden = true; };
    for (const b of $$('#segMode button')) b.addEventListener('click', () => this.setMode(b.dataset.v));
    for (const b of $$('#segQuality button')) b.addEventListener('click', () => this.setQuality(b.dataset.v));
    for (const b of $$('#segScale button')) b.addEventListener('click', () => this.setScale(b.dataset.v));
    for (const b of $$('#segFps button')) b.addEventListener('click', () => this.setFps(b.dataset.v));
    // desktop: closing the sheet gives the keyboard back to the remote screen
    new MutationObserver(() => { if (sheet.hidden) this._afterToolbar(); }).observe(sheet, { attributes: true, attributeFilter: ['hidden'] });
    $('#chkRemoteCursor').addEventListener('change', e => this._setCursorOptions(e.target.checked, this.prefs.localCursor));
    $('#chkKeys').addEventListener('change', e => { this._setPref('keysPinned', e.target.checked); this._syncKeysBar(); requestAnimationFrame(() => this.layout()); });
    $('#btnSendText').addEventListener('click', () => { close(); this.sendTextDialog().then(() => this._afterToolbar()); });
    $('#btnRefreshImg').addEventListener('click', () => { close(); this.send({ t: 'refresh' }); this._afterToolbar(); });
    $('#btnHelp').addEventListener('click', () => { close(); this.helpDialog().then(() => this._afterToolbar()); });
    $('#btnFull').addEventListener('click', () => { close(); this.toggleFullscreen(); });
    $('#btnDisconnect').addEventListener('click', () => { close(); this.disconnect(); });
  }

  // ---------------------------------------------------------------- landscape pill
  _pillShown() { return getComputedStyle(this.pill).display !== 'none'; }

  /** Horizontal place along the top edge: prefs.pillX = 0 (left) .. 1 (right). */
  _placePill() {
    if (!this._pillShown()) { this._pillWasShown = false; return; }
    const room = Math.max(0, this.stageWrap.clientWidth - this.pill.offsetWidth - 12);
    this.pill.style.left = `${Math.round(6 + clamp(this.prefs.pillX, 0, 1) * room)}px`;
    if (!this._pillWasShown) { this._pillWasShown = true; this._pillWake(); }
  }

  /** Full opacity now, back to 30 % after PILL_IDLE_MS without touching it. */
  _pillWake() {
    this.pill.classList.remove('idle');
    clearTimeout(this._pillTimer);
    this._pillTimer = setTimeout(() => {
      if (!this._pillDrag && this.state === 'live') this.pill.classList.add('idle');
    }, PILL_IDLE_MS);
  }

  /**
   * The pill can be dragged along the top edge (anywhere on it, also starting on a button: a
   * move beyond the slop turns the press into a drag and the button's click is swallowed).
   */
  _wirePill() {
    const pill = this.pill;
    pill.addEventListener('pointerdown', e => {
      this._pillWake();
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      this._pillDrag = { id: e.pointerId, x0: e.clientX, left0: pill.offsetLeft, moved: false };
    });
    pill.addEventListener('pointermove', e => {
      const d = this._pillDrag;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x0;
      if (!d.moved && Math.abs(dx) < 10) return;
      if (!d.moved) { d.moved = true; try { pill.setPointerCapture(e.pointerId); } catch { /* gone */ } }
      e.preventDefault();
      const room = Math.max(1, this.stageWrap.clientWidth - pill.offsetWidth - 12);
      this.prefs.pillX = clamp((d.left0 + dx - 6) / room, 0, 1);
      this._placePill();
    });
    const end = e => {
      const d = this._pillDrag;
      if (!d || d.id !== e.pointerId) return;
      this._pillDrag = null;
      if (d.moved) { this._pillDraggedAt = performance.now(); this._setPref('pillX', Math.round(this.prefs.pillX * 1000) / 1000); }
      this._pillWake();
    };
    pill.addEventListener('pointerup', end);
    pill.addEventListener('pointercancel', end);
    // a drag that started on a button is not a tap on it
    pill.addEventListener('click', e => {
      if (performance.now() - (this._pillDraggedAt || -1e9) < 400) { e.stopPropagation(); e.preventDefault(); }
    }, true);
  }

  sendTextDialog() {
    const name = this.machine?.name || 'el equipo';
    return modal(done => {
      const ta = h('textarea', { class: 'sendtext', attrs: { rows: 5, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Texto' } });
      const note = h('p', { class: 'small muted', text: '' });
      const canPaste = !!navigator.clipboard?.readText;
      return [
        h('h2', { text: 'Enviar texto' }),
        h('p', { class: 'small muted', text: `Escríbelo o pégalo aquí y elige qué hacer con él en ${name}.` }),
        ta, note,
        canPaste ? h('button', { class: 'btn wide', attrs: { type: 'button' }, text: 'Pegar del portapapeles', on: { click: async () => {
          try { ta.value = await navigator.clipboard.readText(); } catch { note.textContent = 'El navegador no ha dejado leer el portapapeles: mantén pulsado el cuadro y elige Pegar.'; }
        } } }) : null,
        h('div', { class: 'dlg-actions' },
          h('button', { class: 'btn', attrs: { type: 'button' }, text: 'Cerrar', on: { click: () => done(null) } }),
          h('button', { class: 'btn', attrs: { type: 'button' }, text: 'Copiar al portapapeles del equipo', on: { click: () => {
            if (ta.value) {
              const text = cutCodePoints(ta.value, MAX_CLIPBOARD);
              this.send({ t: 'clipboard', text });
              toast(text.length < ta.value.length ? `Copiado en el portapapeles de ${name} (recortado a ${MAX_CLIPBOARD.toLocaleString('es-ES')} caracteres).` : `Copiado en el portapapeles de ${name}.`);
            }
            done(null);
          } } }),
          h('button', { class: 'btn primary', attrs: { type: 'button' }, text: 'Escribir en el equipo', on: { click: () => {
            if (ta.value) this.typeText(ta.value);
            done(null);
          } } })),
      ].filter(Boolean);
    });
  }

  helpDialog() {
    const tp = this.prefs.mode === 'trackpad';
    const rows = tp ? [
      ['Mover el ratón', 'desliza un dedo'], ['Clic', 'toca'], ['Doble clic', 'toca dos veces'],
      ['Clic derecho', 'mantén pulsado o toca con dos dedos'], ['Arrastrar', 'mantén pulsado y mueve'],
      ['Desplazar', 'dos dedos'], ['Zoom', 'pellizca'], ['Teclado', 'toca con tres dedos'],
    ] : [
      ['Clic', 'toca donde quieras'], ['Clic derecho', 'mantén pulsado o toca con dos dedos'],
      ['Arrastrar', 'mantén pulsado y mueve'], ['Desplazar', 'desliza un dedo'],
      ['Mover la vista y zoom', 'dos dedos'], ['Teclado', 'toca con tres dedos'],
    ];
    return modal(done => [
      h('h2', { text: tp ? 'Gestos (modo ratón)' : 'Gestos (modo táctil)' }),
      h('dl', { class: 'gestures' }, rows.flatMap(([a, b]) => [h('dt', { text: a }), h('dd', { text: b })])),
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn primary', attrs: { type: 'button' }, text: 'Entendido', on: { click: () => done(null) } })),
    ]);
  }

  /** Back gesture while connected: ask before leaving. Returns true if it handled it. */
  async onPopState() {
    if (this.ignorePop) { this.ignorePop = false; return true; }
    if (!this.machine) return false;
    if (this.state !== 'live' && this.state !== 'reconnecting' && this.state !== 'connecting') { await this.disconnect(true); return true; }
    const machine = this.machine;
    const yes = await confirmDialog({ title: `¿Desconectar de ${machine.name}?`, ok: 'Desconectar', cancel: 'Seguir', danger: true, className: 'dlg-leave' });
    if (this.machine !== machine) return true;   // la sesión terminó o se cambió de cuenta mientras tanto
    if (yes) await this.disconnect(true);
    else { try { history.pushState({ rd: 'session' }, ''); } catch { /* ignore */ } }
    return true;
  }
}

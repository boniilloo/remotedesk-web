// input.js -- mouse wheel, mouse buttons and clipboard for the RemoteDesk
// web client. Protocol: remotedesk/protocol.py (viewer -> host):
//   wheel {dx, dy}  steps (dy > 0 = up, dx > 0 = right; host clamps to +-20)
//   mouse_btn {b: left|right|middle, down, x, y}   mouse_move {x, y} (0..1)
//   key {down, sc, k}   clipboard {text}   text {s}
import { isPasteShortcut } from "./keymap.js?v=7a6ac4ad45";
import { MAX_CLIPBOARD, codePoints } from "./session.js?v=7a6ac4ad45";

// ---------------------------------------------------------------------------
// Wheel
// ---------------------------------------------------------------------------

/**
 * Converts WheelEvents to protocol steps (120 units = 1 notch, like Qt angleDelta).
 *  - Chrome/Edge/Safari (and Firefox >= 90 when it knows native ticks) expose
 *    wheelDeltaX/Y = -ticks * 120: exact for notched wheels, fractional for touchpads.
 *  - deltaMode is read FIRST: Firefox then keeps native LINE units for mouse wheels
 *    (3 lines per notch -> 40 units/line) instead of converted pixels.
 *  - Pixel fallback: 100 px ~ 1 notch (Chrome on Windows reports 100 px/notch).
 *  - Remainders are dropped after `idleMs` without events so a half-step from a
 *    trackpad does not fire much later.
 *  - Shift+wheel: Chrome/Firefox turn it into horizontal scroll locally, but the
 *    remote app also sees Shift held and will do that itself, so it is undone.
 */
export class WheelAccumulator {
  constructor({ idleMs = 250, maxSteps = 20, undoShiftHorizontal = true } = {}) {
    Object.assign(this, { idleMs, maxSteps, undoShiftHorizontal });
    this.ax = 0; this.ay = 0; this.last = -Infinity;
  }

  /** @returns {{t:"wheel",dx:number,dy:number}|null} */
  push(e) {
    const mode = e.deltaMode;                       // must be read before deltaX/Y
    let ux, uy;                                     // Qt convention: y>0 up, x>0 left
    if (mode === 0 && (e.wheelDeltaX || e.wheelDeltaY)) {
      ux = e.wheelDeltaX || 0; uy = e.wheelDeltaY || 0;
    } else {
      const k = mode === 1 ? 40 : mode === 2 ? 120 : 1.2;
      ux = -e.deltaX * k; uy = -e.deltaY * k;
    }
    if (this.undoShiftHorizontal && e.shiftKey && !uy && ux) { uy = ux; ux = 0; }
    if (e.timeStamp - this.last > this.idleMs) { this.ax = 0; this.ay = 0; }
    this.last = e.timeStamp;
    this.ax += ux; this.ay += uy;
    const sx = Math.trunc(this.ax / 120), sy = Math.trunc(this.ay / 120);
    if (!sx && !sy) return null;
    this.ax -= sx * 120; this.ay -= sy * 120;
    const clamp = (v) => Math.max(-this.maxSteps, Math.min(this.maxSteps, v));
    return { t: "wheel", dx: clamp(-sx) || 0, dy: clamp(sy) || 0 };
  }
}

// ---------------------------------------------------------------------------
// Mouse buttons
// ---------------------------------------------------------------------------

export const BUTTON_NAMES = Object.freeze({ 0: "left", 1: "middle", 2: "right" });

/**
 * Wires mouse input on `el` (the remote screen element).
 *  - Buttons come from mousedown/mouseup: Pointer Events fire pointerdown only for
 *    the FIRST button of a chord (a second button arrives as pointermove), while
 *    mousedown/mouseup fire for every button.
 *  - contextmenu is suppressed; middle-button mouseup is prevented because on Linux
 *    it would otherwise fire a 'paste' (primary selection) in the page; auxclick
 *    and back/forward buttons (3/4) are prevented too.
 *  - pointer capture keeps moves/releases coming when the pointer leaves `el`.
 * `toNorm(clientX, clientY)` returns [x, y] in 0..1 of the remote screen, CLAMPED
 * like the desktop viewer (a release outside the image must still be sent, or the
 * button stays pressed on the host); null only if there is no image yet.
 * Hooks: onPos([x, y], event) after every position update (local cursor, edge pan),
 * onDown() before a button goes down (focus the keyboard sink), canControl().
 * Returns {detach, releaseHeld}.
 */
export function attachMouse(el, send, toNorm, { canControl = () => true, onPos = () => {}, onDown = () => {} } = {}) {
  let last = null;
  const held = new Set();                     // buttons pressed on `el`, not yet released
  const pos = (e) => {
    const p = toNorm(e.clientX, e.clientY);
    if (p) { last = p; onPos(p, e); }
    return p || last;
  };
  const onMove = (e) => {
    if (e.pointerType !== "mouse") return;
    const p = pos(e);
    if (p && canControl()) send({ t: "mouse_move", x: p[0], y: p[1] });
  };
  const onMouseDown = (e) => {
    const b = BUTTON_NAMES[e.button];
    if (e.button !== 0) e.preventDefault();
    onDown(e);
    if (!b || !canControl()) return;
    const p = pos(e);
    if (!p) return;
    held.add(b);
    send({ t: "mouse_btn", b, down: true, x: p[0], y: p[1] });
  };
  // On window: the release must be sent even if it happens outside `el` and pointer
  // capture did not engage.
  const onUp = (e) => {
    const b = BUTTON_NAMES[e.button];
    if (!held.has(b) && !el.contains(e.target)) return;
    if (e.button !== 0) e.preventDefault();  // middle: no Linux primary-selection paste
    if (!held.delete(b)) return;
    const p = pos(e);
    send({ t: "mouse_btn", b, down: false, x: p[0], y: p[1] });
  };
  const releaseHeld = () => {                 // window blur / tab hidden / disconnect
    for (const b of held) send({ t: "mouse_btn", b, down: false, x: last[0], y: last[1] });
    held.clear();
  };
  const onElem = {
    pointermove: onMove,
    pointerdown: (e) => { if (e.pointerType === "mouse") { try { el.setPointerCapture(e.pointerId); } catch { /* gone */ } } },
    mousedown: onMouseDown,
    contextmenu: (e) => e.preventDefault(),
    auxclick: (e) => e.preventDefault(),
  };
  for (const [t, h] of Object.entries(onElem)) el.addEventListener(t, h);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("blur", releaseHeld);
  return {
    releaseHeld,
    detach() {
      for (const [t, h] of Object.entries(onElem)) el.removeEventListener(t, h);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("blur", releaseHeld);
    },
  };
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/**
 * Text clipboard in both directions without any permission prompt.
 *
 * Local -> remote: on Ctrl/Cmd+V or Shift+Insert the keydown is NOT prevented and
 *   NOT forwarded yet; the browser then fires 'paste' (needs focus on the page; a
 *   focused hidden <textarea> works everywhere) with the local text, which is sent
 *   as {t:"clipboard"} BEFORE the V key goes out, so the host pastes the new text.
 *   'paste' events without a pending shortcut (Linux middle click, context menu)
 *   are ignored.
 * Remote -> local: on Ctrl/Cmd+C or Ctrl+X the keydown handler (a user gesture)
 *   calls clipboard.write() with a ClipboardItem whose data is a Promise resolved
 *   by the host's next {t:"clipboard"} message -- the pattern Safari needs; Chrome
 *   accepts it too. Other updates use writeText(), which only works with recent
 *   user activation (Chrome/Firefox ~5 s, Safari: inside the gesture); if it fails
 *   the text stays in `pendingRemote` and `onPending(text)` lets the UI offer a
 *   "copy" button (a tap is a gesture) -- important on iOS.
 * Size: the host ignores clipboards over MAX_CLIPBOARD characters (code points), so a bigger
 *   local text is not sent at all (`onTooBig(chars)` lets the UI say so); the V key still goes.
 */
export class ClipboardBridge {
  constructor(sendJson, forwardKeydown, { onPending = () => {}, onTooBig = () => {}, copyWaitMs = 3000 } = {}) {
    this.sendJson = sendJson;
    this.forwardKeydown = forwardKeydown;   // (event) => void, the normal key path
    this.onPending = onPending;
    this.onTooBig = onTooBig;
    this.copyWaitMs = copyWaitMs;
    this.pasteKey = null;                   // {e, timer}
    this.copyWaiter = null;                 // {resolve, reject, timer}
    this.lastSent = null;
    this.pendingRemote = null;
  }

  /** Call first in keydown. Returns true if the bridge took over the event. */
  keydown(e) {
    if (isPasteShortcut(e) && !e.repeat) {
      if (this.pasteKey) this._flushPasteKey();
      this.pasteKey = { e, timer: setTimeout(() => this._flushPasteKey(), 300) };
      return true;                          // caller must NOT preventDefault
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === "KeyC" || e.code === "KeyX") && !e.repeat) {
      this._armCopy();
    }
    return false;
  }

  /** Call first in keyup: a V released before 'paste' arrived flushes the held keydown. */
  keyup(e) {
    if (this.pasteKey && this.pasteKey.e.code === e.code) this._flushPasteKey();
  }

  /** window 'paste' listener. */
  paste(e) {
    e.preventDefault();
    if (!this.pasteKey) return;             // not ours: middle click, menu...
    const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    if (text) {
      const chars = codePoints(text, MAX_CLIPBOARD);
      if (chars > MAX_CLIPBOARD) this.onTooBig(chars);
      else { this.lastSent = text; this.sendJson({ t: "clipboard", text }); }
    }
    this._flushPasteKey();
  }

  _flushPasteKey() {
    const p = this.pasteKey;
    if (!p) return;
    clearTimeout(p.timer);
    this.pasteKey = null;
    this.forwardKeydown(p.e);
  }

  _armCopy() {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined" || !navigator.clipboard.write) return;
    if (this.copyWaiter) this.copyWaiter.reject(new Error("superseded"));
    let resolve, reject;
    const data = new Promise((res, rej) => { resolve = res; reject = rej; });
    const timer = setTimeout(() => { if (this.copyWaiter && this.copyWaiter.reject === reject) this.copyWaiter = null; reject(new Error("no clipboard update")); }, this.copyWaitMs);
    this.copyWaiter = { resolve, reject, timer };
    navigator.clipboard.write([new ClipboardItem({ "text/plain": data })]).catch(() => {});
  }

  /** Host sent {t:"clipboard", text}. */
  remote(text) {
    if (this.copyWaiter) {
      const w = this.copyWaiter;
      this.copyWaiter = null;
      clearTimeout(w.timer);
      w.resolve(new Blob([text], { type: "text/plain" }));
      this.pendingRemote = null;
      return;
    }
    if (text === this.lastSent) return;     // echo of our own paste
    this.pendingRemote = text;
    if (!navigator.clipboard || !navigator.clipboard.writeText) { this.onPending(text); return; }
    navigator.clipboard.writeText(text).then(
      () => { if (this.pendingRemote === text) this.pendingRemote = null; },
      () => this.onPending(text));
  }

  /** Call from a click/tap/keydown handler (user gesture) to flush pendingRemote. */
  flushPending() {
    const text = this.pendingRemote;
    if (text == null) return Promise.resolve(false);
    return navigator.clipboard.writeText(text).then(() => { this.pendingRemote = null; return true; }, () => false);
  }
}

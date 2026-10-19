// Touch gesture recognizer for the session surface (Pointer Events, multi-touch).
//
// Modes:
//  'trackpad' (default on phones): one finger is the mouse. The cursor moves relatively,
//             taps click where the CURSOR is, two fingers scroll, pinch zooms the local view.
//  'direct'   (default on tablets): taps click where the FINGER is, one finger drag scrolls the
//             remote, two fingers pan/zoom the local view.
// Shared: long press = right click (hold+move = left drag), double-tap+hold+move = left drag,
//         two-finger tap = right click, three-finger tap = toggle soft keyboard.
// Mouse / pen pointers bypass the recognizer: absolute position, real buttons, wheel.
// With {mouse:false} mouse pointers are ignored here (the page wires them with mouse.js, which
// handles button chords through mousedown/mouseup) and so is the wheel ({wheel:false}).

export const T = {
  SLOP: 10,                 // CSS px a finger may wander and still be a tap / long press
  LONG_PRESS_MS: 500,
  DOUBLE_TAP_MS: 300,       // max gap between a tap's release and the next touch (tap-and-drag)
  DOUBLE_TAP_DIST: 40,      // direct mode: 2nd touch must be this close to the 1st
  MULTI_TAP_MS: 300,        // two/three-finger tap: all fingers up within this time
  PINCH_SPAN: 16,           // span change (px) that makes a 2-finger gesture a pinch
  SCROLL_MOVE: 12,          // centroid move (px) that makes a 2-finger gesture a scroll
  EDGE_MARGIN: 0.15,        // trackpad: keep the cursor this far from the viewport edges
  MOMENTUM_MIN_V: 0.25,     // px/ms to start inertial scrolling
  MOMENTUM_DECAY: 0.95,     // per 16 ms frame
  VELOCITY_MIN_DT: 12,      // ms: scroll velocity is measured over at least this (one frame), never per event
  MOMENTUM_STILL_MS: 100,   // fingers held still this long before lifting: no fling
  MOVE_HZ_MS: 16,           // coalesce mouse_move to one per frame
};

/** CSS px of finger travel per wheel notch, as a function of zoom (z = CSS px per remote px). */
export function wheelStepPx(z) { return Math.max(12, Math.min(60, 60 * z)); }

/** Pointer acceleration for trackpad mode. v in CSS px/ms. */
export function trackpadGain(v) {
  if (v <= 0.15) return 1;
  if (v >= 1.5) return 2.6;
  return 1 + (v - 0.15) / (1.5 - 0.15) * 1.6;
}

export class Gestures {
  /**
   * @param {HTMLElement} surface element receiving pointer events (touch-action:none)
   * @param {{view, send, pointer:{x,y}, mode, modifiers, onKeyboardToggle, feedback, onCursor}} o
   */
  constructor(surface, o) {
    this.surface = surface;
    this.view = o.view;
    this.send = o.send;
    this.mods = o.modifiers;
    this.mode = o.mode || 'trackpad';
    this.pointer = o.pointer;                 // remote px, shared with the cursor renderer
    this.onKeyboardToggle = o.onKeyboardToggle || (() => {});
    this.feedback = o.feedback || (() => {});  // (kind, cssX, cssY)
    this.onCursor = o.onCursor || (() => {});  // local cursor moved
    this.canControl = true;
    this.touches = new Map();                 // pointerId -> {x,y,x0,y0,t0}
    this.g = null;                            // current gesture
    this.lastTap = { t: -1e9, x: 0, y: 0 };
    this.lastLocalMove = -1e9;
    this._pendingMove = null; this._moveTimer = 0;
    this._momentum = null;
    this.buttonsDown = new Set();
    this.handleMouse = o.mouse !== false;

    const opts = { passive: false };
    surface.addEventListener('pointerdown', e => this._down(e), opts);
    surface.addEventListener('pointermove', e => this._move(e), opts);
    surface.addEventListener('pointerup', e => this._up(e, false), opts);
    surface.addEventListener('pointercancel', e => this._up(e, true), opts);
    if (o.wheel !== false) surface.addEventListener('wheel', e => this._wheel(e), opts);
    surface.addEventListener('contextmenu', e => e.preventDefault());
    // iOS: belt and braces against page zoom / selection / callouts (touch-action:none does most of it)
    surface.addEventListener('touchstart', e => { if (e.cancelable) e.preventDefault(); }, opts);
    surface.addEventListener('touchmove', e => { if (e.cancelable) e.preventDefault(); }, opts);
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) surface.addEventListener(t, e => e.preventDefault(), opts);
  }

  setMode(mode) { this._cancelAll(); this.mode = mode; }

  /** Release held buttons and forget touches (blur, hidden page, disconnect). */
  releaseAll() { this._cancelAll(); }

  _ignore(e) { return e.pointerType === 'mouse' && !this.handleMouse; }

  // ---------------------------------------------------------------- helpers
  _local(e) {
    const r = this.surface.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  _norm(rx, ry) {
    const v = this.view;
    const x = Math.min(1, Math.max(0, rx / v.W)), y = Math.min(1, Math.max(0, ry / v.H));
    return { x: Math.round(x * 1e5) / 1e5, y: Math.round(y * 1e5) / 1e5 };
  }
  _setPointer(rx, ry) {
    const v = this.view;
    this.pointer.x = Math.min(v.W - 1, Math.max(0, rx));
    this.pointer.y = Math.min(v.H - 1, Math.max(0, ry));
    this.lastLocalMove = performance.now();
    this.onCursor();
  }
  _queueMove() {
    if (!this.canControl) return;
    this._pendingMove = this._norm(this.pointer.x, this.pointer.y);
    if (!this._moveTimer) this._moveTimer = setTimeout(() => this._flushMove(), T.MOVE_HZ_MS);
  }
  _flushMove() {
    clearTimeout(this._moveTimer); this._moveTimer = 0;
    if (this._pendingMove) { this.send({ t: 'mouse_move', ...this._pendingMove }); this._pendingMove = null; }
  }
  _btn(b, down) {
    if (!this.canControl) return;
    this._flushMove();
    const p = this._norm(this.pointer.x, this.pointer.y);
    this.send({ t: 'mouse_btn', b, down, x: p.x, y: p.y });
    if (down) this.buttonsDown.add(b); else this.buttonsDown.delete(b);
    if (!down) this.mods?.consume();          // one-shot Ctrl/Alt/Shift apply to one click
  }
  _click(b, count = 1) {
    for (let i = 0; i < count; i++) { this._btn(b, true); this._btn(b, false); }
  }
  _wheelSteps(acc, fingerDx, fingerDy) {
    // natural scrolling: content follows the finger. Protocol: dy>0 = up, dx>0 = right (pynput)
    const step = wheelStepPx(this.view.z);
    acc.x += fingerDx; acc.y += fingerDy;
    const sx = Math.trunc(acc.x / step), sy = Math.trunc(acc.y / step);
    if (sx || sy) {
      acc.x -= sx * step; acc.y -= sy * step;
      if (this.canControl) {
        this._flushMove();
        this.send({ t: 'wheel', dx: Math.max(-20, Math.min(20, -sx)), dy: Math.max(-20, Math.min(20, sy)) });
      }
    }
  }
  _moveToFinger(p) {           // direct mode: put the remote cursor under the finger
    const r = this.view.toRemote(p.x, p.y);
    this._setPointer(r.x, r.y);
    this._queueMove();
  }
  _centroid() {
    let x = 0, y = 0;
    for (const t of this.touches.values()) { x += t.x; y += t.y; }
    const n = this.touches.size || 1;
    return { x: x / n, y: y / n };
  }
  _span() {
    const a = [...this.touches.values()];
    if (a.length < 2) return 0;
    return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
  }

  // ---------------------------------------------------------------- mouse / pen (absolute)
  _isTouch(e) { return e.pointerType === 'touch'; }

  _mouseDown(e) {
    const p = this._local(e);
    const r = this.view.toRemote(p.x, p.y);
    this._setPointer(r.x, r.y);
    const b = e.pointerType === 'pen' ? 'left' : ({ 0: 'left', 1: 'middle', 2: 'right' })[e.button];
    if (b) this._btn(b, true);
    this.surface.setPointerCapture?.(e.pointerId);
  }
  _mouseMove(e) {
    const p = this._local(e);
    const r = this.view.toRemote(p.x, p.y);
    this._setPointer(r.x, r.y);
    this._queueMove();
  }
  _mouseUp(e) {
    const b = e.pointerType === 'pen' ? 'left' : ({ 0: 'left', 1: 'middle', 2: 'right' })[e.button];
    if (b && this.buttonsDown.has(b)) this._btn(b, false);
  }
  _wheel(e) {
    e.preventDefault();
    if (e.ctrlKey) {               // trackpad pinch on desktop browsers -> local zoom
      const p = this._local(e);
      this.view.zoomAt(Math.exp(-e.deltaY / 100), p.x, p.y);
      return;
    }
    this._wheelAcc ||= { x: 0, y: 0 };
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    // browser wheel: deltaY>0 = scroll down. Express as an inverted "finger" movement.
    const step = wheelStepPx(this.view.z);
    this._wheelAcc.x -= e.deltaX * k * step / 100;
    this._wheelAcc.y -= e.deltaY * k * step / 100;
    this._wheelSteps(this._wheelAcc, 0, 0);
  }

  // ---------------------------------------------------------------- touch
  _down(e) {
    if (this._ignore(e)) return;
    e.preventDefault();
    this._stopMomentum();
    if (!this._isTouch(e)) return this._mouseDown(e);
    this.surface.setPointerCapture?.(e.pointerId);
    const p = this._local(e);
    const now = performance.now();
    this.touches.set(e.pointerId, { x: p.x, y: p.y, x0: p.x, y0: p.y, t0: now });
    const n = this.touches.size;
    if (n === 1) {
      const nearLast = this.mode === 'trackpad' ||
        Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < T.DOUBLE_TAP_DIST;
      this.g = {
        kind: 'pending1', t0: now, x0: p.x, y0: p.y, lx: p.x, ly: p.y, lt: now,
        afterTap: now - this.lastTap.t < T.DOUBLE_TAP_MS && nearLast,
        maxFingers: 1, acc: { x: 0, y: 0 }, vx: 0, vy: 0, vdx: 0, vdy: 0, moved: now,
      };
      this.g.timer = setTimeout(() => this._longPress(), T.LONG_PRESS_MS);
    } else {
      this._toMulti(now);
    }
  }

  _toMulti(now) {
    const g = this.g;
    if (g?.timer) clearTimeout(g.timer);
    if (g && g.kind === 'drag') this._btn('left', false);   // a 2nd finger ends a drag
    const c = this._centroid();
    const maxFingers = Math.max(g?.maxFingers || 1, this.touches.size);
    const wasSingleAction = g && ['move', 'drag', 'scroll1'].includes(g.kind);
    this.g = {
      kind: 'pending2', t0: g && g.kind.startsWith('pending') ? g.t0 : now,
      maxFingers, cx: c.x, cy: c.y, c0x: c.x, c0y: c.y, span0: this._span(), span: this._span(),
      acc: { x: 0, y: 0 }, vx: 0, vy: 0, vdx: 0, vdy: 0, moved: now, lt: now, noTap: wasSingleAction,
    };
    for (const t of this.touches.values()) { t.x0 = t.x; t.y0 = t.y; }
  }

  _longPress() {
    const g = this.g;
    if (!g || g.kind !== 'pending1') return;
    g.kind = 'hold';
    if (this.mode === 'direct') this._moveToFinger({ x: g.x0, y: g.y0 });
    const s = this.view.toScreen(this.pointer.x, this.pointer.y);
    this.feedback('hold', s.x, s.y);
    try { navigator.vibrate?.(10); } catch { /* iOS: no vibration API */ }
  }

  _move(e) {
    if (this._ignore(e)) return;
    if (!this._isTouch(e)) { e.preventDefault(); return this._mouseMove(e); }
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    e.preventDefault();
    const p = this._local(e);
    const dxF = p.x - t.x, dyF = p.y - t.y;
    t.x = p.x; t.y = p.y;
    const g = this.g;
    if (!g) return;
    const now = performance.now();

    if (this.touches.size === 1 && g.kind !== 'pending2' && g.kind !== 'pinch' && g.kind !== 'scroll2') {
      const moved = Math.hypot(p.x - g.x0, p.y - g.y0);
      let ddx = dxF, ddy = dyF;                // movement to apply this event
      if (g.kind === 'pending1' && moved > T.SLOP) {
        clearTimeout(g.timer);
        ddx = p.x - g.x0; ddy = p.y - g.y0;    // give back the slop: no lost motion at start
        if (g.afterTap) this._startDrag(g);
        else if (this.mode === 'trackpad') g.kind = 'move';
        else { g.kind = 'scroll1'; this._moveToFinger({ x: g.x0, y: g.y0 }); }
      } else if (g.kind === 'hold' && moved > T.SLOP) {
        ddx = p.x - g.x0; ddy = p.y - g.y0;
        this._startDrag(g);
      }
      const dt = Math.max(1, now - (g.lastEv ?? g.t0));   // pointer acceleration (one finger: one event per frame)
      g.lastEv = now;
      if (g.kind === 'move' || (g.kind === 'drag' && this.mode === 'trackpad')) {
        const gain = trackpadGain(Math.hypot(dxF, dyF) / dt);
        this._setPointer(this.pointer.x + ddx * gain / this.view.z, this.pointer.y + ddy * gain / this.view.z);
        this.view.ensureVisible(this.pointer.x, this.pointer.y, T.EDGE_MARGIN);
        this._queueMove();
      } else if (g.kind === 'drag') {          // direct drag follows the finger
        this._moveToFinger(p);
      } else if (g.kind === 'scroll1') {
        this._trackVelocity(g, ddx, ddy, now);
        this._wheelSteps(g.acc, ddx, ddy);
      }
      return;
    }

    // two or more fingers
    if (g.kind === 'pending1' || g.kind === 'hold') return;   // will switch on next pointerdown
    const c = this._centroid();
    const span = this._span();
    const dcx = c.x - g.cx, dcy = c.y - g.cy;
    let dx2 = dcx, dy2 = dcy;
    if (g.kind === 'pending2') {
      const spanDelta = Math.abs(span - g.span0);
      const moved = Math.hypot(c.x - g.c0x, c.y - g.c0y);
      if (this.touches.size === 2 && spanDelta > T.PINCH_SPAN) g.kind = 'pinch';
      else if (moved > T.SCROLL_MOVE) g.kind = (this.mode === 'trackpad' && this.touches.size === 2) ? 'scroll2' : 'pinch';
      if (g.kind !== 'pending2') {           // decided: apply everything since the 2nd finger landed
        g.span = g.span0; g.cx = g.c0x; g.cy = g.c0y;
        dx2 = c.x - g.c0x; dy2 = c.y - g.c0y;
      }
    }
    if (g.kind === 'pinch') {
      const factor = g.span > 0 && span > 0 ? span / g.span : 1;
      this.view.zoomAt(factor, g.cx, g.cy, dx2, dy2);
      if (this.mode === 'trackpad') this.onCursor();
    } else if (g.kind === 'scroll2') {
      this._trackVelocity(g, dx2, dy2, now);
      this._wheelSteps(g.acc, dx2, dy2);
    }
    g.cx = c.x; g.cy = c.y; g.span = span;
  }

  /**
   * Scroll velocity for the fling. A two-finger move arrives as two pointermove events back to
   * back (one per finger, ~0 ms apart), each moving the centroid half the step: so the movement
   * is accumulated and the velocity updated only once VELOCITY_MIN_DT ms have really passed.
   */
  _trackVelocity(g, dx, dy, now) {
    g.vdx += dx; g.vdy += dy;
    if (dx || dy) g.moved = now;
    const dt = now - g.lt;
    if (dt < T.VELOCITY_MIN_DT) return;
    g.vx = 0.6 * g.vx + 0.4 * g.vdx / dt; g.vy = 0.6 * g.vy + 0.4 * g.vdy / dt;
    g.vdx = 0; g.vdy = 0; g.lt = now;
  }

  _startDrag(g) {
    clearTimeout(g.timer);
    g.kind = 'drag';
    if (this.mode === 'direct') this._moveToFinger({ x: g.x0, y: g.y0 });
    this._btn('left', true);
    const s = this.view.toScreen(this.pointer.x, this.pointer.y);
    this.feedback('drag', s.x, s.y);
  }

  _up(e, cancelled) {
    if (this._ignore(e)) return;
    if (!this._isTouch(e)) { e.preventDefault(); return this._mouseUp(e); }
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    e.preventDefault();
    const p = this._local(e);
    t.x = p.x; t.y = p.y;
    const g = this.g;
    const now = performance.now();
    const allMovedLittle = [...this.touches.values()].every(q => Math.hypot(q.x - q.x0, q.y - q.y0) < T.SLOP * 1.5);
    this.touches.delete(e.pointerId);
    if (!g) return;

    if (cancelled) { if (this.touches.size === 0) this._cancelAll(); return; }

    if (g.kind === 'pending2') g.allLittle = (g.allLittle ?? true) && allMovedLittle;

    if (this.touches.size > 0) {            // still fingers on screen
      if (g.kind === 'pending2' || g.kind === 'pinch' || g.kind === 'scroll2') {
        g.cx = this._centroid().x; g.cy = this._centroid().y; g.span = this._span(); g.span0 = g.span;
      }
      return;
    }

    clearTimeout(g.timer);
    switch (g.kind) {
      case 'pending1': {                     // tap
        if (this.mode === 'direct') this._moveToFinger({ x: g.x0, y: g.y0 });
        this._click('left');
        const s = this.view.toScreen(this.pointer.x, this.pointer.y);
        this.feedback('tap', s.x, s.y);
        this.lastTap = { t: now, x: g.x0, y: g.y0 };
        break;
      }
      case 'hold': {                         // long press without moving -> right click
        this._click('right');
        const s = this.view.toScreen(this.pointer.x, this.pointer.y);
        this.feedback('right', s.x, s.y);
        break;
      }
      case 'drag':
        this._btn('left', false);
        break;
      case 'scroll1':
      case 'scroll2':
        this._startMomentum(g);
        break;
      case 'pending2': {
        const quick = now - g.t0 < T.MULTI_TAP_MS + (g.maxFingers >= 3 ? 100 : 0);
        if (quick && g.allLittle !== false && !g.noTap) {
          if (g.maxFingers === 2) {
            if (this.mode === 'direct') this._moveToFinger({ x: g.c0x, y: g.c0y });
            this._click('right');
            const s = this.view.toScreen(this.pointer.x, this.pointer.y);
            this.feedback('right', s.x, s.y);
          } else if (g.maxFingers >= 3) {
            this.onKeyboardToggle();        // synchronous: still inside the pointerup user gesture
          }
        }
        break;
      }
    }
    this.g = null;
  }

  _startMomentum(g) {
    let vx = g.vx, vy = g.vy;
    if (performance.now() - (g.moved ?? 0) > T.MOMENTUM_STILL_MS) return;   // stopped, then lifted
    if (Math.hypot(vx, vy) < T.MOMENTUM_MIN_V) return;
    const acc = g.acc;
    let last = performance.now();
    const tick = () => {
      if (!this._momentum) return;
      const now = performance.now();
      const dt = Math.min(50, now - last); last = now;
      this._wheelSteps(acc, vx * dt, vy * dt);
      const decay = Math.pow(T.MOMENTUM_DECAY, dt / 16);
      vx *= decay; vy *= decay;
      if (Math.hypot(vx, vy) < 0.03) { this._momentum = null; return; }
      this._momentum = requestAnimationFrame(tick);
    };
    this._momentum = requestAnimationFrame(tick);
  }
  _stopMomentum() { if (this._momentum) cancelAnimationFrame(this._momentum); this._momentum = null; }

  /** Lift everything (pointercancel, blur, hidden page, mode switch). */
  _cancelAll() {
    if (this.g?.timer) clearTimeout(this.g.timer);
    for (const b of [...this.buttonsDown]) this._btn(b, false);
    this.touches.clear();
    this.g = null;
    this._stopMomentum();
  }
}

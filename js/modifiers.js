// Sticky modifiers for the extra-keys bar (Ctrl, Alt, Shift, Win, AltGr).
//   tap            : off -> once (key down sent now) ; once/locked -> off (key up)
//   double tap /
//   long press     : -> locked (stays down until tapped again)
//   "once" mods are released right after the next key, typed character or mouse click.
// The modifier key-down is sent immediately so remote Ctrl+click / Alt+drag work too.
import { MODIFIER_KEYS, keyMsg } from './keys.js?v=7a6ac4ad45';

export const DOUBLE_TAP_MS = 300;

export class Modifiers {
  constructor(send) {
    this.send = send;
    this.state = { ctrl: 'off', alt: 'off', shift: 'off', meta: 'off', altgr: 'off' };
    this.lastTap = { name: null, t: 0 };
    this.listeners = new Set();
  }
  onChange(fn) { this.listeners.add(fn); }
  _emit() { for (const fn of this.listeners) fn(this.state); }

  get anyActive() { return Object.values(this.state).some(s => s !== 'off'); }
  /** Modifiers that change the meaning of a typed character (so it must go as a key, not as text). */
  get shortcutActive() { return ['ctrl', 'alt', 'meta'].some(m => this.state[m] !== 'off'); }
  isActive(name) { return this.state[name] !== 'off'; }

  _down(name) { this.send(keyMsg(MODIFIER_KEYS[name], true)); }
  _up(name) { this.send(keyMsg(MODIFIER_KEYS[name], false)); }

  tap(name, now = performance.now()) {
    const s = this.state[name];
    const dbl = this.lastTap.name === name && now - this.lastTap.t < DOUBLE_TAP_MS;
    this.lastTap = { name, t: now };
    if (dbl && s === 'off') {           // 2nd tap of a double tap (1st tap turned it on then off... see below)
      this._down(name); this.state[name] = 'locked';
    } else if (dbl && s === 'once') {   // double tap while armed -> lock (key already down)
      this.state[name] = 'locked';
    } else if (s === 'off') {
      this._down(name); this.state[name] = 'once';
    } else {
      this._up(name); this.state[name] = 'off';
    }
    this._emit();
  }

  lock(name) {
    if (this.state[name] === 'off') this._down(name);
    this.state[name] = 'locked';
    this._emit();
  }

  /** Call after a non-modifier key / character / click has been sent. */
  consume() {
    let changed = false;
    for (const [name, s] of Object.entries(this.state)) {
      if (s === 'once') { this._up(name); this.state[name] = 'off'; changed = true; }
    }
    if (changed) this._emit();
  }

  /** Release everything (blur, page hidden, disconnect). Sends key ups for held modifiers. */
  releaseAll() {
    let changed = false;
    for (const [name, s] of Object.entries(this.state)) {
      if (s !== 'off') { this._up(name); this.state[name] = 'off'; changed = true; }
    }
    if (changed) this._emit();
  }
}

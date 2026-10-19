// Named keys for the extra-keys bar, the soft keyboard bridge and the toolbar shortcuts.
// Wire format (remotedesk/protocol.py): {"t":"key","down":bool,"sc":evdev,"k":pynput-name-or-char}
// sc = Linux evdev code (physical key, interpreted with the HOST layout); 0 = unknown.
// k  = pynput Key name ("enter", "ctrl"...) or a single character (fallback used when sc=0).
import { CODE_TO_EVDEV } from './keymap.js?v=7a6ac4ad45';

// evdev values from linux/input-event-codes.h; names match remotedesk/gui/qtkeys.py.
export const NAMED = {
  Escape:     { sc: 1,   k: 'esc' },
  Backspace:  { sc: 14,  k: 'backspace' },
  Tab:        { sc: 15,  k: 'tab' },
  Enter:      { sc: 28,  k: 'enter' },
  Control:    { sc: 29,  k: 'ctrl' },
  Shift:      { sc: 42,  k: 'shift' },
  Alt:        { sc: 56,  k: 'alt' },
  ' ':        { sc: 57,  k: 'space' },
  CapsLock:   { sc: 58,  k: 'caps_lock' },
  F1: { sc: 59, k: 'f1' }, F2: { sc: 60, k: 'f2' }, F3: { sc: 61, k: 'f3' }, F4: { sc: 62, k: 'f4' },
  F5: { sc: 63, k: 'f5' }, F6: { sc: 64, k: 'f6' }, F7: { sc: 65, k: 'f7' }, F8: { sc: 66, k: 'f8' },
  F9: { sc: 67, k: 'f9' }, F10: { sc: 68, k: 'f10' }, F11: { sc: 87, k: 'f11' }, F12: { sc: 88, k: 'f12' },
  PrintScreen:{ sc: 99,  k: 'print_screen' },
  AltGraph:   { sc: 100, k: 'alt_gr' },
  Home:       { sc: 102, k: 'home' },
  ArrowUp:    { sc: 103, k: 'up' },
  PageUp:     { sc: 104, k: 'page_up' },
  ArrowLeft:  { sc: 105, k: 'left' },
  ArrowRight: { sc: 106, k: 'right' },
  End:        { sc: 107, k: 'end' },
  ArrowDown:  { sc: 108, k: 'down' },
  PageDown:   { sc: 109, k: 'page_down' },
  Insert:     { sc: 110, k: 'insert' },
  Delete:     { sc: 111, k: 'delete' },
  Meta:       { sc: 125, k: 'cmd' },
  ContextMenu:{ sc: 127, k: 'menu' },
};

/** KeyboardEvent.code -> evdev (0 if unknown). Table generated from Chromium (keymap.js). */
export function evdevFromCode(code) {
  return CODE_TO_EVDEV[code] || 0;
}

export const MODIFIER_KEYS = {
  ctrl:  NAMED.Control,
  alt:   NAMED.Alt,
  shift: NAMED.Shift,
  meta:  NAMED.Meta,
  altgr: NAMED.AltGraph,
};

export function keyMsg(entry, down) {
  return { t: 'key', down, sc: entry.sc || 0, k: entry.k || null };
}

/**
 * Press a shortcut like "ctrl+alt+Delete" or "ctrl+c": modifiers down, key down/up,
 * modifiers up in reverse order. Letters go by character name (sc 0) so the host
 * resolves them with ITS layout (Ctrl+Z stays Ctrl+Z on AZERTY).
 */
export function sendCombo(send, spec) {
  const parts = spec.split('+');
  const keyName = parts.pop();
  const held = parts.map(p => MODIFIER_KEYS[p]).filter(Boolean);
  for (const m of held) send(keyMsg(m, true));
  const entry = NAMED[keyName] || { sc: 0, k: keyName.toLowerCase() };
  send(keyMsg(entry, true));
  send(keyMsg(entry, false));
  for (const m of held.reverse()) send(keyMsg(m, false));
}

// Soft-keyboard bridge: a hidden <input> receives what the phone keyboard produces
// (characters, autocorrect, predictive words, swipe typing, dictation, IME composition)
// and we mirror its edits onto the remote machine.
//
// Strategy (same family as noVNC's keyInput and Guacamole's guacTextInput, see SPEC §6):
//  * never trust keydown on soft keyboards (Android: key "Unidentified"/keyCode 229),
//  * on every `input` event diff the field value against the previous value
//    (common prefix + common suffix) and send  <arrows to edit point> + "\b"*removed + inserted
//    as ONE {"t":"text","s":...} message (host: injector.type_text, "\b" = Backspace),
//  * keep invisible padding (U+200B) before the caret so Backspace always has something to delete,
//  * reset the field only when NOT composing,
//  * named keys that never produce text (Enter, Tab, Esc, arrows, Delete, F-keys) are taken from
//    keydown and sent as {"t":"key"} with evdev codes,
//  * when a sticky Ctrl/Alt/Win is active, characters are sent as key events (shortcuts).
import { NAMED, evdevFromCode, keyMsg } from './keys.js?v=7a6ac4ad45';

const PAD = '\u200b';

const isHigh = c => c >= 0xD800 && c <= 0xDBFF;
const isLow = c => c >= 0xDC00 && c <= 0xDFFF;
/** Characters (code points) in str[a, b): the remote counts Backspaces and arrow presses in
 *  characters, the field in UTF-16 units (an emoji is 2 units, 1 Backspace). */
export function cps(str, a, b) {
  if (a > b) [a, b] = [b, a];
  let n = 0;
  for (let i = a; i < b; i++) if (!(i > a && isLow(str.charCodeAt(i)) && isHigh(str.charCodeAt(i - 1)))) n++;
  return n;
}
/** Splits text in chunks of at most `size` characters without breaking surrogate pairs. */
export function chunks(text, size) {
  const chars = [...text], out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}
const PAD_LEN = 16;
const MAX_LEN = 200;       // reset the field (when not composing) beyond this length...
const MIN_CARET = 8;       // ...or when fewer than this many chars remain before the caret
const MAX_TEXT_CHUNK = 500; // host accepts <= 2000 chars per "text" message (host.MAX_TEXT)

// Keys taken from keydown (they never produce an `input` event in a single-line <input>).
const KEYDOWN_KEYS = new Set(['Enter', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown', 'Delete', 'Insert',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']);

export class SoftKeyboard {
  /**
   * @param {HTMLInputElement} el hidden input
   * @param {{send:Function, modifiers:Modifiers, onOpenChange?:Function, liveComposition?:boolean, mirrorCaret?:boolean}} opts
   */
  constructor(el, opts) {
    this.el = el;
    this.send = opts.send;
    this.mods = opts.modifiers;
    this.onOpenChange = opts.onOpenChange || (() => {});
    this.liveComposition = opts.liveComposition !== false; // false = send words only when committed (CJK users)
    this.mirrorCaret = opts.mirrorCaret !== false;         // Gboard/iOS space-bar cursor -> remote arrows
    this.composing = false;
    this.prev = '';
    this.caret = 0;
    this.pendingComposition = null;
    el.setAttribute('autocomplete', 'off');
    el.setAttribute('autocorrect', 'off');
    el.setAttribute('autocapitalize', 'off');
    el.setAttribute('spellcheck', 'false');
    el.setAttribute('enterkeyhint', 'enter');
    el.addEventListener('input', e => this._onInput(e));
    el.addEventListener('keydown', e => this._onKeyDown(e));
    el.addEventListener('compositionstart', () => { this.composing = true; });
    el.addEventListener('compositionend', () => {
      this.composing = false;
      if (!this.liveComposition) this._onInput(null, true);
      setTimeout(() => this._maybeReset(), 0);
    });
    el.addEventListener('focus', () => { this._reset(); this.onOpenChange(true); });
    el.addEventListener('blur', () => { this.composing = false; this.onOpenChange(false); });
    document.addEventListener('selectionchange', () => this._onSelectionChange());
    this._reset();
  }

  get isOpen() { return document.activeElement === this.el; }

  /** MUST run synchronously inside a user-gesture handler (click/touchend/pointerup), or iOS won't show the keyboard. */
  open() { this.el.focus({ preventScroll: true }); }
  close() { this.el.blur(); }
  toggle() { if (this.isOpen) this.close(); else this.open(); }

  _reset() {
    this.el.value = PAD.repeat(PAD_LEN);
    try { this.el.setSelectionRange(PAD_LEN, PAD_LEN); } catch { /* not focused */ }
    this.prev = this.el.value;
    this.caret = PAD_LEN;
  }

  _maybeReset() {
    if (this.composing) return;
    const v = this.el.value;
    if (v.length > MAX_LEN || (this.el.selectionStart ?? v.length) < MIN_CARET) this._reset();
  }

  _onInput(e, force = false) {
    if (this.composing && !this.liveComposition && !force) return;
    const cur = this.el.value, prev = this.prev;
    if (cur === prev) return;
    // common prefix / suffix
    const max = Math.min(cur.length, prev.length);
    let p = 0;
    while (p < max && cur.charCodeAt(p) === prev.charCodeAt(p)) p++;
    let s = 0;
    while (s < max - p && cur.charCodeAt(cur.length - 1 - s) === prev.charCodeAt(prev.length - 1 - s)) s++;
    // never split a surrogate pair between the unchanged and the edited part
    if (p > 0 && isHigh(cur.charCodeAt(p - 1))) p--;
    if (s > 0 && isLow(cur.charCodeAt(cur.length - s))) s--;
    const removed = cps(prev, p, prev.length - s);
    const inserted = cur.slice(p, cur.length - s).replaceAll(PAD, '');
    // move the remote caret to the end of the edited region
    const editEnd = prev.length - s;
    this._arrows(Math.sign(editEnd - this.caret) * cps(prev, this.caret, editEnd));
    this._emitEdit(removed, inserted);
    // after the edit the remote caret is at the end of the inserted text; mirror the local caret
    const remoteCaret = cur.length - s;
    const localCaret = this.el.selectionStart ?? cur.length;
    this.prev = cur;
    this.caret = remoteCaret;
    if (localCaret !== remoteCaret) {
      this._arrows(Math.sign(localCaret - remoteCaret) * cps(cur, remoteCaret, localCaret));
      this.caret = localCaret;
    }
    if (!this.composing) this._maybeReset();
  }

  _emitEdit(removed, inserted) {
    if (!removed && !inserted) return;
    if (this.mods.shortcutActive) {
      // Ctrl/Alt/Win held: characters are shortcuts -> key events by character name (host layout resolves it)
      for (let i = 0; i < removed; i++) this._tapKey(NAMED.Backspace);
      for (const ch of inserted) {
        const lower = ch.toLowerCase();
        const needShift = ch !== lower && !this.mods.isActive('shift');
        if (needShift) this.send(keyMsg(NAMED.Shift, true));
        this._tapKey({ sc: 0, k: lower });
        if (needShift) this.send(keyMsg(NAMED.Shift, false));
      }
      this.mods.consume();
      return;
    }
    const s = '\b'.repeat(removed) + inserted.replace(/\r\n?/g, '\n');
    // chunk: the host types synchronously, keep messages small (and never split a character)
    for (const part of chunks(s, MAX_TEXT_CHUNK)) this.send({ t: 'text', s: part });
    if (this.mods.anyActive) this.mods.consume();  // e.g. Shift once
  }

  _arrows(n) {
    if (!n) return;
    const key = n < 0 ? NAMED.ArrowLeft : NAMED.ArrowRight;
    for (let i = 0; i < Math.abs(n); i++) this._tapKey(key);
  }

  _tapKey(entry) {
    this.send(keyMsg(entry, true));
    this.send(keyMsg(entry, false));
  }

  _onSelectionChange() {
    if (!this.mirrorCaret || !this.isOpen || this.composing) return;
    const el = this.el;
    if (el.value !== this.prev || el.selectionStart !== el.selectionEnd) return;
    const delta = el.selectionStart - this.caret;
    if (!delta) return;
    this._arrows(Math.sign(delta) * cps(el.value, this.caret, el.selectionStart));
    this.caret = el.selectionStart;
    this._maybeReset();
  }

  _onKeyDown(e) {
    if (e.isComposing || e.keyCode === 229) return;          // IME owns it: wait for `input`
    const hasShortcutMod = e.ctrlKey || e.altKey || e.metaKey;
    if (KEYDOWN_KEYS.has(e.key) || (hasShortcutMod && e.key.length === 1)) {
      e.preventDefault();
      const entry = NAMED[e.key] || { sc: evdevFromCode(e.code), k: e.key.length === 1 ? e.key.toLowerCase() : null };
      // hardware keyboard modifiers held in the same event
      const held = [];
      if (e.ctrlKey && !this.mods.isActive('ctrl')) held.push(NAMED.Control);
      if (e.altKey && !this.mods.isActive('alt')) held.push(NAMED.Alt);
      if (e.metaKey && !this.mods.isActive('meta')) held.push(NAMED.Meta);
      if (e.shiftKey && !this.mods.isActive('shift') && e.key.length !== 1) held.push(NAMED.Shift);
      for (const m of held) this.send(keyMsg(m, true));
      this._tapKey(entry);
      for (const m of held.reverse()) this.send(keyMsg(m, false));
      this.mods.consume();
      if (e.key === 'Enter') this._reset();
    }
    // everything else (letters, Backspace, space...) arrives through `input`
  }

  /** "Paste as keystrokes" / dictated text from the clipboard sheet. */
  typeText(text) { this._emitEdit(0, text); }
}

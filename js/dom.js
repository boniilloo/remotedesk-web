// DOM helpers. Text from hosts, storage or errors only ever goes through textContent /
// createTextNode / value: no innerHTML anywhere in the app.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * h('button', {class: 'x', text: 'Hola', attrs: {type: 'button'}, on: {click}}, child, …)
 * Children: nodes or strings (as text nodes). Never parses HTML.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'attrs') for (const [a, av] of Object.entries(v)) { if (av != null && av !== false) el.setAttribute(a, av === true ? '' : String(av)); }
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'hidden') el.hidden = !!v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'disabled') el.disabled = !!v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

let currentScreen = null;
/** Shows one of the top-level screens (#import, #login, #machines, #session). */
export function showScreen(id) {
  for (const s of $$('.screen')) s.hidden = s.id !== id;
  currentScreen = id;
  document.body.dataset.screen = id;
}
export const activeScreen = () => currentScreen;

let toastTimer = 0;
/** Bottom toast; `action` adds a button (a tap there is a user gesture: clipboard writes). */
export function toast(text, { action = null, onAction = null, ms = 4000 } = {}) {
  const t = $('#toast');
  if (!t) return;
  t.replaceChildren(h('span', { class: 'toast-text', text }));
  if (action) {
    t.appendChild(h('button', { class: 'toast-action', attrs: { type: 'button' }, text: action, on: {
      click: async () => { hideToast(); await onAction?.(); },
    } }));
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
export function hideToast() {
  const t = $('#toast');
  if (t) t.hidden = true;
  clearTimeout(toastTimer);
}

export const anyDialogOpen = () => !!document.querySelector('dialog[open]');

/** Modal <dialog> built from nodes. Resolves with the value passed to close(). */
export function modal(build, { className = '' } = {}) {
  return new Promise(resolve => {
    const dlg = h('dialog', { class: 'dlg ' + className });
    let result = null, settled = false;
    // Settle as soon as a button closes it: the 'close' event comes in a later task.
    const finish = () => { if (settled) return; settled = true; dlg.remove(); resolve(result); };
    const close = (v) => { result = v; if (dlg.open) dlg.close(); finish(); };
    dlg.append(...[].concat(build(close)));
    dlg.addEventListener('close', finish);         // Esc / dialog.close() from elsewhere
    dlg.addEventListener('cancel', () => { result = null; });
    document.body.appendChild(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    const first = dlg.querySelector('[autofocus]') || dlg.querySelector('input, textarea');
    if (first && matchMedia('(pointer: fine)').matches) first.focus();
  });
}

export function confirmDialog({ title, text = '', ok = 'Aceptar', cancel = 'Cancelar', danger = false, className = '' }) {
  return modal(close => [
    h('h2', { text: title }),
    text ? h('p', { text }) : null,
    h('div', { class: 'dlg-actions' },
      h('button', { class: 'btn', attrs: { type: 'button' }, text: cancel, on: { click: () => close(false) } }),
      h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), attrs: { type: 'button', 'data-ok': '' }, text: ok, on: { click: () => close(true) } })),
  ].filter(Boolean), { className }).then(v => v === true);
}

/** Small menu: items = [{label, onClick, danger}] */
export function menuDialog(title, items) {
  return modal(close => [
    h('h2', { text: title }),
    h('div', { class: 'menu-items' }, items.map(it => h('button', {
      class: 'btn wide' + (it.danger ? ' danger' : ''), attrs: { type: 'button' }, text: it.label,
      on: { click: () => { close(null); setTimeout(() => it.onClick(), 0); } },
    }))),
    h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', attrs: { type: 'button' }, text: 'Cerrar', on: { click: () => close(null) } })),
  ], { className: 'menu' });
}

/** Resolves after the browser had a chance to paint (also in background tabs). */
export function nextPaint() {
  return new Promise(resolve => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => requestAnimationFrame(fin));
    setTimeout(fin, 150);
  });
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

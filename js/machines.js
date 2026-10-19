// "Mis equipos": probes the 16 slots of the account in parallel and lists the machines as
// the answers arrive (presence.py Directory.scan semantics), plus the machines seen before
// (cache in localStorage): "Comprobando…" while their slot has not answered yet, greyed out
// with "visto hace…" once it has (or the scan ended) without them.
import { $, h, showScreen, activeScreen } from './dom.js?v=7a6ac4ad45';
import { KEYS, getJSON, setJSON } from './storage.js?v=7a6ac4ad45';

export const NUM_SLOTS = 16;
export const PROBE_TIMEOUT_MS = 6000;
const REFRESH_MS = 30000;              // desktop app: REFRESH_INTERVAL_MS
const MAX_KNOWN = 64;

const str = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Spanish "visto hace…" like remotedesk/gui/main_window.py _ago(). */
export function ago(ts, now = Date.now()) {
  if (!ts) return 'nunca visto';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 90) return 'visto hace un momento';
  if (s < 3600) return `visto hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `visto hace ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  return `visto hace ${d} día${d !== 1 ? 's' : ''}`;
}

/** Validates a probe answer from the core: plain values only. */
export function cleanProbe(slot, info) {
  if (!info || typeof info !== 'object') return null;
  const machine_id = str(info.machine_id, 128) || `slot-${slot}`;
  return {
    slot, machine_id,
    name: str(info.name) || `Equipo ${slot}`,
    os: str(info.os, 40) || '?',
    busy: info.busy === true,
    version: str(info.version, 40),
    path: str(info.path, 60) || null,
  };
}

export class MachinesScreen {
  /** app: { getNet(), probe(slot, ms), accountCode, onConnect(machine) } */
  constructor(app) {
    this.app = app;
    this.gen = 0;
    this.scanning = false;
    this.online = new Map();           // machine_id -> probe info (this scan / last scan)
    this.known = {};                   // machine_id -> {name, os, slot, lastSeen}
    this.done = 0;
    this.pending = new Set();          // slots of the running scan that have not answered yet
    this.order = [];                   // display order of this visit to the screen (see entries())
    this.netError = null;
    $('#mRefresh').addEventListener('click', () => this.scan());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.isShown() && !this.scanning && Date.now() - (this.lastScan || 0) > 10000) this.scan();
    });
  }

  isShown() { return activeScreen() === 'machines'; }

  show() {
    this._loadKnown();
    this.order = [];                     // sorted afresh on every visit, then kept
    $('#accountCode').textContent = this.app.accountCode ? `Cuenta ${this.app.accountCode}` : '';
    showScreen('machines');
    this.render();
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.isShown() && !document.hidden && !this.scanning) this.scan();
    }, REFRESH_MS);
    if (!this.scanning) this.scan();
  }

  hide() { clearInterval(this.timer); }

  forget() {
    this.online.clear(); this.known = {}; this.gen += 1; this.scanning = false; this.pending.clear(); this.order = [];
    this.lastScan = 0; clearInterval(this.timer);
  }

  // ------------------------------------------------------------------ cache
  _cacheOwner() { return this.app.accountCode || ''; }

  _loadKnown() {
    const c = getJSON(KEYS.machines, null);
    this.known = {};
    if (!c || typeof c !== 'object' || c.owner !== this._cacheOwner() || !c.list || typeof c.list !== 'object') return;
    for (const [id, m] of Object.entries(c.list).slice(0, MAX_KNOWN)) {
      if (!m || typeof m !== 'object') continue;
      const slot = Number.isInteger(m.slot) && m.slot >= 0 && m.slot < NUM_SLOTS ? m.slot : null;
      this.known[str(id, 128)] = { name: str(m.name) || 'Equipo', os: str(m.os, 40) || '?', slot,
        lastSeen: Number.isFinite(m.lastSeen) ? m.lastSeen : 0 };
    }
  }

  _saveKnown() {
    const entries = Object.entries(this.known).sort((a, b) => b[1].lastSeen - a[1].lastSeen).slice(0, MAX_KNOWN);
    setJSON(KEYS.machines, { owner: this._cacheOwner(), list: Object.fromEntries(entries) });
  }

  // ------------------------------------------------------------------ scan
  async scan() {
    const gen = ++this.gen;
    this.scanning = true;
    this.done = 0;
    this.netError = null;
    this.found = new Map();
    this.pending = new Set(Array.from({ length: NUM_SLOTS }, (_, s) => s));
    $('#mRefresh').disabled = true;
    this.render();                       // "Comprobando…" for the known machines, no empty text
    this._status('Conectando a la red…', true);
    let net;
    try {
      net = await this.app.getNet();
      if (gen !== this.gen) return;
      if (!this.onlineChecked) {
        const ok = await net.online(15000);
        if (gen !== this.gen) return;
        if (!ok) throw new Error('offline');
        this.onlineChecked = true;
      }
    } catch {
      if (gen !== this.gen) return;
      this.scanning = false;
      this.pending.clear();
      $('#mRefresh').disabled = false;
      this.netError = 'Sin conexión con la red de RemoteDesk. Comprueba tu conexión a Internet y pulsa ⟳.';
      this.render();
      return;
    }
    this._status(`Buscando equipos… 0/${NUM_SLOTS}`, true);
    const one = async slot => {
      let info = null;
      try { info = cleanProbe(slot, await this.app.probe(slot, PROBE_TIMEOUT_MS)); } catch { info = null; }
      if (gen !== this.gen) return;
      this.done += 1;
      this.pending.delete(slot);
      if (info) this._onResult(info);
      else if (this._knownIn(slot)) this.render();   // a known machine there: now it is "apagado"
      this._status(`Buscando equipos… ${this.done}/${NUM_SLOTS}`, true);
    };
    await Promise.all(Array.from({ length: NUM_SLOTS }, (_, s) => one(s)));
    if (gen !== this.gen) return;
    this.scanning = false;
    this.lastScan = Date.now();
    $('#mRefresh').disabled = false;
    // whoever did not answer this time is offline now
    for (const id of [...this.online.keys()]) if (!this.found.has(id)) this.online.delete(id);
    this._saveKnown();
    this.render();
  }

  _knownIn(slot) { return Object.values(this.known).some(k => k.slot === slot); }

  _onResult(info) {
    // another machine that used to be in this slot is not there any more
    for (const [id, other] of this.online) if (id !== info.machine_id && other.slot === info.slot) this.online.delete(id);
    this.found.set(info.machine_id, info);
    this.online.set(info.machine_id, info);
    this.known[info.machine_id] = { name: info.name, os: info.os, slot: info.slot, lastSeen: Date.now() };
    this.render();
  }

  _status(text, busy) {
    $('#mStatusText').textContent = text;
    const p = $('#mProgress');
    p.hidden = !busy;
    $('#mProgressBar').style.width = `${Math.round(100 * this.done / NUM_SLOTS)}%`;
  }

  // ------------------------------------------------------------------ render
  entries() {
    const list = [];
    for (const info of this.online.values()) list.push({ ...info, online: true, lastSeen: Date.now() });
    for (const [id, k] of Object.entries(this.known)) {
      if (this.online.has(id)) continue;
      // Not known to be off yet: its slot (or, without one, the whole scan) is still running.
      const checking = this.scanning && !this.netError && (k.slot == null ? true : this.pending.has(k.slot));
      list.push({ machine_id: id, name: k.name, os: k.os, slot: k.slot, online: false, checking, lastSeen: k.lastSeen });
    }
    const rank = e => (e.online ? (e.busy ? 1 : 0) : e.checking ? 2 : 3);
    list.sort((a, b) => rank(a) - rank(b) || (a.online ? a.name.localeCompare(b.name, 'es') : b.lastSeen - a.lastSeen));
    // Cards never move under a finger: those already shown keep their place while answers
    // arrive (or a machine goes off), new ones are added at the end.
    const pos = new Map(this.order.map((id, i) => [id, i]));
    const shown = list.filter(e => pos.has(e.machine_id)).sort((a, b) => pos.get(a.machine_id) - pos.get(b.machine_id));
    const stable = [...shown, ...list.filter(e => !pos.has(e.machine_id))];
    this.order = stable.map(e => e.machine_id);
    return stable;
  }

  render() {
    const list = this.entries();
    const box = $('#mList');
    box.replaceChildren(...list.map(e => this._card(e)));
    const nOnline = list.filter(e => e.online).length;
    if (this.netError) this._status(this.netError, false);
    else if (!this.scanning) {
      this._status(nOnline === 0 ? 'Ningún equipo en línea.' : nOnline === 1 ? '1 equipo en línea.' : `${nOnline} equipos en línea.`, false);
    }
    // "No hay equipos encendidos" only once a scan has really finished without any.
    $('#mEmpty').hidden = this.scanning || !this.lastScan || !!this.netError || nOnline > 0;
  }

  _card(e) {
    const cls = 'machine ' + (e.online ? (e.busy ? 'busy' : 'online') : e.checking ? 'checking' : 'offline');
    const detail = [e.os];
    if (e.online) {
      detail.push(e.busy ? 'ocupado: alguien lo está controlando' : 'en línea');
      if (e.path) detail.push(e.path);
    } else if (e.checking) {
      detail.push('comprobando…', ago(e.lastSeen));
    } else {
      detail.push('apagado o sin conexión', ago(e.lastSeen));
    }
    const canTry = e.slot != null;
    const btn = h('button', {
      class: cls, attrs: { type: 'button', 'aria-disabled': canTry ? null : 'true' },
      dataset: { slot: String(e.slot ?? ''), id: e.machine_id },
      on: { click: () => { if (canTry) this.app.onConnect({ slot: e.slot, name: e.name, os: e.os, machine_id: e.machine_id }); } },
    },
    h('span', { class: 'mdot', attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'mtext' },
      h('span', { class: 'mname', text: e.name }),
      h('span', { class: 'mdetail', text: detail.filter(Boolean).join(' · ') })),
    h('span', { class: 'mgo', text: e.online ? (e.busy ? 'Ocupado' : 'Conectar') : e.checking ? 'Comprobando…' : 'Intentar' }));
    return btn;
  }
}

// Automatic quality for mobile links. Pure logic (no DOM) so it can be unit-tested.
// Host knobs (remotedesk/host.py _on_settings): quality 10..95 (JPEG), scale in {1, 0.75, 0.5}
// (full frame on change: expensive), fps 1..60.
//
// Congestion signal: the RTT of our ping/pong. Frames and pongs share ONE ordered QUIC stream,
// so when the link is saturated the pong queues behind frame data and RTT inflates
// (bufferbloat) long before anything is lost. Step down fast, step up slowly.

export const SCALES = [0.5, 0.75, 1.0];

/** JPEG quality presets of the desktop viewer (remotedesk/protocol.py QUALITY_PRESETS). */
export const QUALITY = { low: 45, medium: 65, high: 85 };
export const FPS_CHOICES = [5, 10, 15, 25, 30];

export const LADDER = [
  { scale: 0.5,  quality: 35, fps: 8 },
  { scale: 0.5,  quality: 45, fps: 12 },
  { scale: 0.75, quality: 55, fps: 15 },
  { scale: 0.75, quality: 65, fps: 20 },
  { scale: 1.0,  quality: 65, fps: 25 },
  { scale: 1.0,  quality: 80, fps: 30 },
];

/** Smallest transmitted scale that still gives >= ~0.9 frame px per device px at this zoom. */
export function neededScale(z, dpr) {
  const need = z * dpr * 0.9;
  return SCALES.find(s => s >= need) ?? 1.0;
}

/** Starting rung from the hints the browser gives (Chrome Android only; iOS has none). */
export function initialRung({ connection, touch, relay } = {}) {
  let r = touch ? 3 : 4;
  if (connection) {
    if (connection.saveData) r = 1;
    else if (/^(slow-2g|2g)$/.test(connection.effectiveType)) r = 0;
    else if (connection.effectiveType === '3g') r = 1;
    else if (connection.type === 'cellular') r = Math.min(r, 2);
  }
  if (relay) r = Math.min(r, 3);
  return r;
}

export class AutoQuality {
  constructor({ rung = 3, now = 0, maxRung = LADDER.length - 1 } = {}) {
    this.rung = rung;
    this.maxRung = maxRung;
    this.minRtt = Infinity;
    this.bad = 0;                 // consecutive inflated RTT samples
    this.lastChange = now;
    this.lastNotGood = now;
    this.upCooldown = 20000;      // ms of good RTT before stepping up; doubles after each step down
    this.zoomScale = null;        // unknown until setZoom(): use the ladder's scale
    this.sent = null;
    this.bytes = 0; this.frames = 0; this.t0 = now;
  }

  onFrame(bytes) { this.bytes += bytes; this.frames += 1; }

  onRtt(ms, now) {
    // windowed minimum: forget the old minimum slowly (route changes, relay -> direct)
    this.minRtt = Math.min(ms, this.minRtt === Infinity ? ms : this.minRtt * 1.01 + 1);
    const inflated = ms > Math.max(this.minRtt * 2.5, this.minRtt + 150);
    const good = ms < this.minRtt * 1.5 + 40;
    if (inflated) this.bad += 1; else this.bad = 0;
    if (!good) this.lastNotGood = now;
    if (this.bad >= 2 && now - this.lastChange > 4000 && this.rung > 0) {
      this.rung -= 1; this.bad = 0; this.lastChange = now; this.lastNotGood = now;
      if (now - (this.lastDown ?? -1e12) > 30000) this.upCooldown = Math.min(120000, this.upCooldown * 2);  // once per episode
      this.lastDown = now;
    } else if (now - this.lastNotGood > this.upCooldown && now - this.lastChange > this.upCooldown
               && this.rung < this.maxRung) {
      this.rung += 1; this.lastChange = now; this.lastNotGood = now;
    } else if (now - this.lastChange > 300000) {
      this.upCooldown = Math.max(20000, this.upCooldown / 2);   // forgive old congestion
    }
  }

  setZoom(z, dpr) { this.zoomScale = neededScale(z, dpr); }

  /** What the controller wants now: {quality, fps, scale}. */
  target() {
    const r = LADDER[this.rung];
    const zs = this.zoomScale ?? r.scale;
    const s = { quality: r.quality, fps: r.fps, scale: Math.min(r.scale, zs) };
    if (zs > r.scale && this.rung >= 2) {
      // zoomed in to read small text: sharpness matters more than smoothness
      s.scale = zs; s.fps = Math.max(8, Math.round(r.fps * 0.6));
    }
    return s;
  }

  /** Settings to send, or null if unchanged. Call every ~1 s and after pinch end (debounced). */
  settings() {
    const s = this.target();
    if (this.sent && s.quality === this.sent.quality && s.fps === this.sent.fps && s.scale === this.sent.scale) return null;
    this.sent = s;
    return s;
  }

  /** Bytes/s and fps since the last call (for the info panel and the data counter). */
  sample(now) {
    const dt = Math.max(1, now - this.t0) / 1000;
    const out = { bps: this.bytes / dt, fps: this.frames / dt };
    this.bytes = 0; this.frames = 0; this.t0 = now;
    return out;
  }
}

// Local zoom/pan of the remote desktop. Nothing here is sent to the host.
//
// Units: "remote px" = pixels of the remote SCREEN (msg "screen": width/height),
// not of the transmitted frame (fw/fh change with the scale setting).
// z = CSS px per remote px. (tx, ty) = CSS offset of the remote origin inside the viewport.

export const MAX_ZOOM = 3;          // 1 remote px = 3 CSS px (= 9 device px on a DPR-3 phone)

export class View {
  constructor() {
    this.W = 1920; this.H = 1080;   // remote screen size
    this.vw = 390; this.vh = 600;   // visible area (CSS px), excludes toolbars + keyboard
    this.z = 1; this.tx = 0; this.ty = 0;
    this.alignTop = false;          // portrait phones: desktop under the top bar, free space below
    this.unitZ = Infinity;          // zoom of the "1:1" button: may be BELOW the fit zoom when the
                                    // remote screen is smaller than the window
    this.listeners = new Set();
    this.fit();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { for (const fn of this.listeners) fn(this); }

  get minZ() { return Math.min(this.vw / this.W, this.vh / this.H); }  // "contain"
  get maxZ() { return Math.max(MAX_ZOOM, this.minZ); }
  get lowZ() { return Math.min(this.minZ, this.unitZ); }               // smallest zoom allowed
  get isFit() { return Math.abs(this.z - this.minZ) < 1e-3; }

  setRemoteSize(W, H) {
    const wasFit = this.isFit;
    const c = this.centerRemote();
    const fx = c.x / this.W, fy = c.y / this.H;      // keep the same relative center
    this.W = W; this.H = H;
    if (wasFit) { this.fit(); return; }
    this.z = Math.min(this.maxZ, Math.max(this.lowZ, this.z));
    this.centerOn(fx * W, fy * H);
  }

  /** Visible area changed (rotation, keyboard, toolbars). keepPoint: remote point to keep visible. */
  setViewport(vw, vh, keepPoint = null) {
    const wasFit = this.isFit;
    const center = this.centerRemote();
    this.vw = Math.max(1, vw); this.vh = Math.max(1, vh);
    if (wasFit && !keepPoint) { this.fit(); return; }
    this.z = Math.min(this.maxZ, Math.max(this.lowZ, this.z));
    if (keepPoint) { this.centerOn(center.x, center.y, false); this.ensureVisible(keepPoint.x, keepPoint.y, 0.2, false); }
    else this.centerOn(center.x, center.y, false);
    this._clamp(); this._emit();
  }

  fit() { this.z = this.minZ; this._clamp(); this._emit(); }

  /**
   * Toolbar zoom button: fit <-> `oneToOne` CSS px per remote px (phones: 1; desktop browsers:
   * 1/devicePixelRatio = one remote pixel per device pixel), keeping `around` in place.
   */
  toggleZoom(around, oneToOne = 1) {
    if (this.isFit) {
      const p = around || this.centerRemote();
      this.unitZ = oneToOne;
      this.z = Math.min(this.maxZ, Math.max(this.lowZ, oneToOne));
      this.centerOn(p.x, p.y, false);
    } else {
      this.z = this.minZ;
    }
    this._clamp(); this._emit();
  }

  centerRemote() { return this.toRemote(this.vw / 2, this.vh / 2); }

  centerOn(rx, ry, emit = true) {
    this.tx = this.vw / 2 - rx * this.z;
    this.ty = this.vh / 2 - ry * this.z;
    this._clamp(); if (emit) this._emit();
  }

  /** Pinch: scale by `factor` keeping the remote point under (cx, cy) fixed, then pan by (dx, dy). */
  zoomAt(factor, cx, cy, dx = 0, dy = 0) {
    const rx = (cx - this.tx) / this.z, ry = (cy - this.ty) / this.z;
    this.z = Math.min(this.maxZ, Math.max(this.lowZ, this.z * factor));
    this.tx = cx - rx * this.z + dx;
    this.ty = cy - ry * this.z + dy;
    this._clamp(); this._emit();
  }

  panBy(dx, dy) { this.tx += dx; this.ty += dy; this._clamp(); this._emit(); }

  toRemote(cx, cy) { return { x: (cx - this.tx) / this.z, y: (cy - this.ty) / this.z }; }
  toScreen(rx, ry) { return { x: this.tx + rx * this.z, y: this.ty + ry * this.z }; }

  /** Pan (never zoom) so remote point (rx, ry) lies inside the viewport minus `margin` (fraction). */
  ensureVisible(rx, ry, margin = 0.15, emit = true) {
    const p = this.toScreen(rx, ry);
    const mx = Math.min(this.vw * margin, 60), my = Math.min(this.vh * margin, 60);
    let dx = 0, dy = 0;
    if (p.x < mx) dx = mx - p.x; else if (p.x > this.vw - mx) dx = this.vw - mx - p.x;
    if (p.y < my) dy = my - p.y; else if (p.y > this.vh - my) dy = this.vh - my - p.y;
    if (dx || dy) { this.tx += dx; this.ty += dy; this._clamp(); if (emit) this._emit(); }
  }

  _clamp() {
    const cw = this.W * this.z, ch = this.H * this.z;
    this.tx = cw <= this.vw ? (this.vw - cw) / 2 : Math.min(0, Math.max(this.vw - cw, this.tx));
    this.ty = ch <= this.vh ? (this.alignTop ? 0 : (this.vh - ch) / 2) : Math.min(0, Math.max(this.vh - ch, this.ty));
  }
}

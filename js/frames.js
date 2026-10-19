// Screen updates (MSG_FRAME, remotedesk/protocol.py pack_frame):
//   >IHHH  frame_id, width, height, count      (width/height = transmitted frame size fw/fh)
//   count x (>HHHHI x, y, w, h, size, then `size` bytes of JPEG)

/** Returns {id, width, height, rects:[{x,y,w,h,data:Uint8Array}]}; throws on truncated data. */
export function unpackFrame(u8) {
  if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
  if (u8.byteLength < 10) throw new Error('frame demasiado corto');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const id = dv.getUint32(0), width = dv.getUint16(4), height = dv.getUint16(6), count = dv.getUint16(8);
  let off = 10;
  const rects = [];
  for (let i = 0; i < count; i++) {
    if (off + 12 > u8.byteLength) throw new Error('frame truncado');
    const x = dv.getUint16(off), y = dv.getUint16(off + 2), w = dv.getUint16(off + 4), h = dv.getUint16(off + 6);
    const size = dv.getUint32(off + 8);
    off += 12;
    if (off + size > u8.byteLength) throw new Error('frame truncado');
    rects.push({ x, y, w, h, data: u8.subarray(off, off + size) });
    off += size;
  }
  return { id, width, height, rects };
}

/** Frame id of a (possibly corrupt) frame, so it can still be acknowledged. */
export function frameId(u8) {
  if (!u8 || u8.byteLength < 4) return null;
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(0);
}

// iOS Safari refuses canvases above 16,777,216 px (and has a total canvas memory budget).
export const MAX_CANVAS_AREA = 16_777_216;
// What one frame may make the page decode. The host (remotedesk/capture.py) sends at most
// MAX_RECTS = 40 grid-aligned rects that do not overlap (a full frame is one rect), so these
// only stop a hostile host: every tile is decoded to its full size, and a JPEG compresses a
// plain image about 1000:1 (a 32 MiB message could otherwise ask for tens of GiB).
export const MAX_TILES = 256;            // tiles per frame
export const MAX_TILE_AREA_RATIO = 2;    // sum of the tile areas <= 2 x the canvas area
export const DECODE_BATCH = 6;           // tiles decoded at the same time

/** Width and height declared in a base64 PNG's IHDR (bytes 16..23), or null if it is not a PNG. */
export function pngSize(b64) {
  let bin;
  try { bin = atob(String(b64).slice(0, 32)); } catch { return null; }
  if (bin.length < 24 || bin.slice(1, 4) !== 'PNG' || bin.slice(12, 16) !== 'IHDR') return null;
  const u32 = o => ((bin.charCodeAt(o) << 24) | (bin.charCodeAt(o + 1) << 16) | (bin.charCodeAt(o + 2) << 8) | bin.charCodeAt(o + 3)) >>> 0;
  return { w: u32(16), h: u32(20) };
}

const SOF_MARKERS = new Set([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF]);

/**
 * Width and height a JPEG declares in its SOFn header, read without decoding it (the host
 * crops every tile to exactly its rect). null if there is no SOF before the scan data.
 */
export function jpegSize(u8) {
  if (!u8 || u8.length < 4 || u8[0] !== 0xFF || u8[1] !== 0xD8) return null;
  let i = 2;
  while (i + 3 < u8.length) {
    if (u8[i] !== 0xFF) return null;
    let m = u8[i + 1];
    while (m === 0xFF && i + 2 < u8.length) { i++; m = u8[i + 1]; }   // fill bytes
    i += 2;
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) continue;   // no length
    if (m === 0xD9 || m === 0xDA) return null;                         // end / scan before any SOF
    if (i + 1 >= u8.length) return null;
    const len = (u8[i] << 8) | u8[i + 1];
    if (len < 2) return null;
    if (SOF_MARKERS.has(m)) {
      if (i + 6 >= u8.length) return null;
      return { h: (u8[i + 3] << 8) | u8[i + 4], w: (u8[i + 5] << 8) | u8[i + 6] };
    }
    i += len;
  }
  return null;
}

/**
 * Framebuffer canvas. The canvas has the transmitted frame size (fw x fh); zoom/pan is a CSS
 * transform done elsewhere. The JPEG tiles of one frame are decoded with createImageBitmap,
 * DECODE_BATCH at a time, and painted together in order; the caller acks the frame once draw()
 * resolves (also when it returns false: a dropped frame is acked too).
 *
 * Safety (a host is not trusted with this browser's memory):
 * - Rects are checked against the canvas actually in use, not the size the frame declares: a
 *   frame whose size the canvas refused (resize() above MAX_CANVAS_AREA) is dropped whole.
 * - A frame with more than MAX_TILES tiles, or whose tiles add up to more than
 *   MAX_TILE_AREA_RATIO x the canvas area, is dropped before decoding anything.
 * - A tile whose JPEG declares a size larger than its rect, or a rect outside the canvas, is
 *   skipped before decoding (a few MB of JPEG can declare gigabytes of pixels).
 * Frames paint in arrival order: if a newer frame was painted while an older one was still
 * decoding (the caller gives up waiting on a slow draw), the older one is dropped instead of
 * painting stale tiles over newer ones.
 */
export class FrameRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.w = canvas.width; this.h = canvas.height;
    this.drawn = 0;
    this.seq = 0;            // draws started
    this.painted = 0;        // seq of the newest frame painted
    this.dropped = 0;        // frames dropped because a newer one was painted first
    this.refused = 0;        // frames dropped by the size checks (canvas refused, too many tiles)
    this.skippedTiles = 0;   // tiles refused by the size checks
  }

  /** The tile may be decoded: a real JPEG no larger than its rect, the rect inside the canvas. */
  tileOk(r, fw, fh) {
    if (!r.w || !r.h || r.x + r.w > fw || r.y + r.h > fh) return false;
    const size = jpegSize(r.data);
    return !!size && size.w >= 1 && size.h >= 1 && size.w <= r.w && size.h <= r.h;
  }

  /** Resizing clears the canvas: only when the frame size really changes. */
  resize(w, h) {
    if (w === this.w && h === this.h) return false;
    if (w * h > MAX_CANVAS_AREA) return false;
    this.canvas.width = w; this.canvas.height = h;
    this.w = w; this.h = h;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, w, h);
    return true;
  }

  /** Whether the tiles of `frame` may be decoded at all on a fw x fh canvas (see the class). */
  frameOk(frame, fw, fh) {
    const rects = frame.rects;
    if (rects.length > MAX_TILES) return false;
    let area = 0;
    for (const r of rects) area += r.w * r.h;
    return area <= MAX_TILE_AREA_RATIO * fw * fh;
  }

  /** Paints `frame`. Resolves to true if it was painted, false if it was dropped. */
  async draw(frame) {
    const seq = ++this.seq;
    if (frame.width && frame.height && (frame.width !== this.w || frame.height !== this.h)
        && !this.resize(frame.width, frame.height)) {
      this.refused += 1;                     // the canvas kept its size: these rects do not fit
      return false;
    }
    const fw = this.w, fh = this.h;          // the canvas in use, not what the frame declares
    if (!this.frameOk(frame, fw, fh)) { this.refused += 1; return false; }
    const rects = frame.rects;
    const bitmaps = new Array(rects.length).fill(null);
    const closeAll = () => { for (const b of bitmaps) b?.close?.(); };
    for (let i = 0; i < rects.length; i += DECODE_BATCH) {
      if (seq < this.painted) break;         // a newer frame got there first: stop decoding
      const part = rects.slice(i, i + DECODE_BATCH);
      const out = await Promise.all(part.map(r => {
        if (!this.tileOk(r, fw, fh)) { this.skippedTiles += 1; return null; }
        return createImageBitmap(new Blob([r.data], { type: 'image/jpeg' })).catch(() => null);
      }));
      out.forEach((b, j) => { bitmaps[i + j] = b; });
    }
    if (seq < this.painted) {                // a newer frame is already on the canvas
      closeAll();
      this.dropped += 1;
      return false;
    }
    if (this.w !== fw || this.h !== fh) {    // resized while decoding (a new "screen")
      closeAll();
      this.refused += 1;
      return false;
    }
    this.painted = seq;
    const ctx = this.ctx;
    rects.forEach((r, i) => {
      const b = bitmaps[i];
      if (!b) return;
      if (b.width === r.w && b.height === r.h) ctx.drawImage(b, r.x, r.y);
      else ctx.drawImage(b, r.x, r.y, r.w, r.h);
      b.close?.();
    });
    this.drawn += 1;
    return true;
  }

  /** Give the memory back (iOS keeps released canvas memory for a while). */
  release() {
    this.canvas.width = 1; this.canvas.height = 1;
    this.w = 1; this.h = 1;
  }
}

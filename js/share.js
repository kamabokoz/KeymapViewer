// Share a keyboard record as a looping sequence of QR codes, and receive it with the camera.
// Frame text (QR alphanumeric mode): KV1/<session>/<index>/<total>/<crc32>/<base45 chunk>
import qrcode from '../vendor/qrcode.mjs';

const PREFIX = 'KV1';
const CHUNK = 440;          // base45 chars per frame (~290 bytes) -> QR version ~14 (EC M)
const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

// ---------------- encoding helpers ----------------
function b45encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) {
    if (i + 1 < bytes.length) {
      let n = bytes[i] * 256 + bytes[i + 1];
      const c = n % 45; n = (n - c) / 45;
      const d = n % 45; const e = (n - d) / 45;
      out += B45[c] + B45[d] + B45[e];
    } else {
      const n = bytes[i];
      out += B45[n % 45] + B45[Math.floor(n / 45)];
    }
  }
  return out;
}
function b45decode(str) {
  const out = [];
  for (let i = 0; i < str.length; i += 3) {
    const c = B45.indexOf(str[i]), d = B45.indexOf(str[i + 1]);
    if (c < 0 || d < 0) throw new Error('base45: invalid character');
    if (i + 2 < str.length) {
      const e = B45.indexOf(str[i + 2]);
      if (e < 0) throw new Error('base45: invalid character');
      const n = c + d * 45 + e * 2025;
      if (n > 0xFFFF) throw new Error('base45: out of range');
      out.push(n >> 8, n & 0xFF);
    } else {
      const n = c + d * 45;
      if (n > 0xFF) throw new Error('base45: out of range');
      out.push(n);
    }
  }
  return new Uint8Array(out);
}
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}
async function pipe(bytes, stream) {
  const s = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export const shareSupported = () => typeof CompressionStream !== 'undefined';
export const scanSupported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && typeof DecompressionStream !== 'undefined';

// Only what the viewer needs, to keep the number of QR frames small
function trim(rec) {
  const out = { id: rec.id, type: rec.type, name: rec.name, deviceName: rec.deviceName, readAt: rec.readAt };
  if (rec.customName) out.customName = rec.customName;
  if (rec.type === 'vial') {
    const v = rec.vial, d = v.definition;
    const def = { name: d.name, matrix: d.matrix, layouts: d.layouts };
    if (d.customKeycodes) def.customKeycodes = d.customKeycodes;
    out.vial = { ...v, definition: def };
  } else {
    const z = rec.zmk;
    const used = new Set();
    for (const l of z.keymap.layers) for (const b of l.bindings) used.add(b.behavior_id);
    const behaviors = {};
    for (const id of Object.keys(z.behaviors)) if (used.has(+id)) behaviors[id] = z.behaviors[id];
    out.zmk = { ...z, behaviors };
  }
  return out;
}

export async function buildFrames(rec) {
  const json = new TextEncoder().encode(JSON.stringify({ v: 1, keyboard: trim(rec) }));
  const packed = await pipe(json, new CompressionStream('deflate-raw'));
  const text = b45encode(packed);
  const sid = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, '0');
  const crc = crc32(packed);
  const n = Math.max(1, Math.ceil(text.length / CHUNK));
  const frames = [];
  for (let i = 0; i < n; i++) frames.push(`${PREFIX}/${sid}/${i + 1}/${n}/${crc}/${text.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  return { frames, bytes: packed.length, rawBytes: json.length };
}

export function drawQr(canvas, text, cssSize) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Alphanumeric');
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const total = count + quiet * 2;
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.max(1, Math.floor((cssSize * dpr) / total));
  const px = total * scale;
  canvas.width = px; canvas.height = px;
  canvas.style.width = canvas.style.height = `${px / dpr}px`;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000';
  for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) {
    if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
  }
  return count;
}

// ---------------- receiving ----------------
export class FrameCollector {
  constructor() { this.reset(); }
  reset() { this.sid = null; this.total = 0; this.crc = null; this.parts = []; }
  get received() { return this.parts.filter((p) => p != null).length; }
  // returns 'new' | 'dup' | 'ignored'
  add(text) {
    const m = /^KV1\/([0-9A-Z]{4})\/(\d+)\/(\d+)\/([0-9A-F]{8})\/(.*)$/s.exec(text || '');
    if (!m) return 'ignored';
    const [, sid, is, ns, crc, chunk] = m;
    const i = +is, n = +ns;
    if (!n || i < 1 || i > n) return 'ignored';
    if (sid !== this.sid || crc !== this.crc || n !== this.total) { this.sid = sid; this.crc = crc; this.total = n; this.parts = new Array(n).fill(null); }
    if (this.parts[i - 1] != null) return 'dup';
    this.parts[i - 1] = chunk;
    return 'new';
  }
  get complete() { return this.total > 0 && this.received === this.total; }
  async decode() {
    const packed = b45decode(this.parts.join(''));
    if (crc32(packed) !== this.crc) throw new Error('データが壊れています（CRC 不一致）。もう一度読み取ってください。');
    const json = await pipe(packed, new DecompressionStream('deflate-raw'));
    const obj = JSON.parse(new TextDecoder().decode(json));
    const rec = obj && obj.keyboard;
    if (!rec || !rec.id || !(rec.type === 'vial' ? rec.vial : rec.zmk)) throw new Error('キーボードのデータではありません');
    return rec;
  }
}

// Camera scanner: decodes frames in a worker (jsQR) and feeds the collector
export class QrScanner {
  constructor(video, onText) {
    this.video = video;
    this.onText = onText;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.busy = false;
    this.running = false;
    // Single-file (file://) build injects a factory that makes the worker from a Blob.
    // If no worker can be created, decode on the main thread with window.jsQR.
    try {
      this.worker = globalThis.__KV_QR_WORKER ? globalThis.__KV_QR_WORKER() : new Worker(new URL('./qr-worker.js', import.meta.url));
      this.worker.onmessage = (e) => { this.busy = false; if (e.data) this.onText(e.data); };
    } catch (e) {
      this.worker = null;
    }
  }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.grab();
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }
  grab() {
    const v = this.video;
    if (this.busy || v.readyState < 2 || !v.videoWidth) return;
    // centre square crop, downscaled for speed
    const side = Math.min(v.videoWidth, v.videoHeight);
    const sx = (v.videoWidth - side) / 2, sy = (v.videoHeight - side) / 2;
    const size = Math.min(side, 720);
    this.canvas.width = this.canvas.height = size;
    this.ctx.drawImage(v, sx, sy, side, side, 0, 0, size, size);
    const img = this.ctx.getImageData(0, 0, size, size);
    this.busy = true;
    if (this.worker) {
      this.worker.postMessage({ data: img.data.buffer, width: size, height: size }, [img.data.buffer]);
    } else if (globalThis.jsQR) {
      const r = globalThis.jsQR(img.data, size, size, { inversionAttempts: 'dontInvert' });
      this.busy = false;
      if (r && r.data) this.onText(r.data);
    } else this.busy = false;
  }
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
    if (this.worker) this.worker.terminate();
  }
}

export const _internal = { b45encode, b45decode, crc32 };

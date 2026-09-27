// Vial (QMK) keymap reader over WebHID (raw HID, usage page 0xFF60 / usage 0x61, 32-byte reports)
import { lzmaDecompress } from './lzma.js';

const MSG_LEN = 32;
const CMD_VIA_GET_PROTOCOL_VERSION = 0x01;
const CMD_VIA_GET_KEYBOARD_VALUE = 0x02;
const VIA_LAYOUT_OPTIONS = 0x02;
const CMD_VIA_GET_LAYER_COUNT = 0x11;
const CMD_VIA_KEYMAP_GET_BUFFER = 0x12;
const CMD_VIA_VIAL_PREFIX = 0xFE;
const CMD_VIAL_GET_KEYBOARD_ID = 0x00;
const CMD_VIAL_GET_SIZE = 0x01;
const CMD_VIAL_GET_DEFINITION = 0x02;
const CMD_VIAL_GET_ENCODER = 0x03;
const BUFFER_FETCH_CHUNK = 28;

class HidChannel {
  constructor(dev) {
    this.dev = dev;
    this.waiter = null;
    this.onReport = (ev) => {
      const data = new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength).slice();
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(data); }
    };
    dev.addEventListener('inputreport', this.onReport);
    this.chain = Promise.resolve();
  }
  close() { this.dev.removeEventListener('inputreport', this.onReport); }
  // Send a command and wait for the 32-byte reply. Serialised; retries on timeout.
  send(bytes, retries = 10, timeout = 600) {
    const run = async () => {
      const buf = new Uint8Array(MSG_LEN);
      buf.set(bytes);
      for (let attempt = 0; attempt <= retries; attempt++) {
        const reply = new Promise((resolve) => {
          this.waiter = resolve;
          setTimeout(() => { if (this.waiter === resolve) { this.waiter = null; resolve(null); } }, timeout);
        });
        await this.dev.sendReport(0, buf);
        const r = await reply;
        if (r) return r;
      }
      throw new Error('キーボードから応答がありません（タイムアウト）');
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
}

const u32le = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const hex = (arr) => Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');

export function vialSupported() { return 'hid' in navigator; }

export async function readVial(progress = () => {}) {
  const devices = await navigator.hid.requestDevice({ filters: [{ usagePage: 0xFF60, usage: 0x61 }] });
  const dev = devices[0];
  if (!dev) throw Object.assign(new Error('キャンセルされました'), { cancelled: true });
  if (!dev.opened) {
    try { await dev.open(); }
    catch (e) { throw new Error('デバイスを開けませんでした。Vial / VIA など他のアプリやタブが使用中でないか確認してください。(' + e.message + ')'); }
  }
  const ch = new HidChannel(dev);
  try {
    progress('プロトコルを確認中…');
    let d = await ch.send([CMD_VIA_GET_PROTOCOL_VERSION]);
    const viaProtocol = (d[1] << 8) | d[2];

    d = await ch.send([CMD_VIA_VIAL_PREFIX, CMD_VIAL_GET_KEYBOARD_ID]);
    const vialProtocol = u32le(d, 0);
    if (d[0] === 0xFF || vialProtocol > 0xFFFF) {
      throw new Error('このキーボードは Vial に対応していません（VIA のみのファームウェアの可能性があります）');
    }
    const uid = hex(d.slice(4, 12));

    progress('キーボード定義を読み込み中…');
    d = await ch.send([CMD_VIA_VIAL_PREFIX, CMD_VIAL_GET_SIZE]);
    let size = u32le(d, 0);
    if (size === 0 || size > 1 << 20) throw new Error('キーボード定義のサイズが不正です: ' + size);
    const payload = new Uint8Array(size);
    for (let block = 0, off = 0; off < size; block++, off += MSG_LEN) {
      const r = await ch.send([CMD_VIA_VIAL_PREFIX, CMD_VIAL_GET_DEFINITION, block & 0xFF, (block >> 8) & 0xFF, (block >> 16) & 0xFF, (block >> 24) & 0xFF]);
      payload.set(r.subarray(0, Math.min(MSG_LEN, size - off)), off);
    }
    const definition = JSON.parse(new TextDecoder().decode(lzmaDecompress(payload)));
    const rows = definition.matrix.rows, cols = definition.matrix.cols;

    d = await ch.send([CMD_VIA_GET_LAYER_COUNT]);
    const layers = d[1];

    progress('キーマップを読み込み中…');
    const total = layers * rows * cols * 2;
    const buf = new Uint8Array(total);
    for (let off = 0; off < total; off += BUFFER_FETCH_CHUNK) {
      const sz = Math.min(total - off, BUFFER_FETCH_CHUNK);
      const r = await ch.send([CMD_VIA_KEYMAP_GET_BUFFER, (off >> 8) & 0xFF, off & 0xFF, sz]);
      buf.set(r.subarray(4, 4 + sz), off);
    }
    const keymap = [];
    for (let l = 0; l < layers; l++) {
      const layer = [];
      for (let r = 0; r < rows; r++) {
        const row = [];
        for (let c = 0; c < cols; c++) {
          const o = ((l * rows + r) * cols + c) * 2;
          row.push((buf[o] << 8) | buf[o + 1]);
        }
        layer.push(row);
      }
      keymap.push(layer);
    }

    // encoders: indices referenced in the KLE layout ("idx,dir" with center label "e")
    const encIdx = new Set();
    for (const row of definition.layouts.keymap) {
      if (!Array.isArray(row)) continue;
      for (const item of row) {
        if (typeof item !== 'string') continue;
        const parts = item.split('\n');
        if (parts.includes('e')) {
          const m = /^(\d+),(\d+)$/.exec(parts[0]);
          if (m) encIdx.add(+m[1]);
        }
      }
    }
    const encoders = [];
    if (encIdx.size) {
      progress('エンコーダを読み込み中…');
      for (let l = 0; l < layers; l++) {
        const arr = [];
        for (const idx of encIdx) {
          const r = await ch.send([CMD_VIA_VIAL_PREFIX, CMD_VIAL_GET_ENCODER, l, idx]);
          arr[idx] = [(r[0] << 8) | r[1], (r[2] << 8) | r[3]];
        }
        encoders.push(arr);
      }
    }

    let layoutOptions = 0;
    if (definition.layouts.labels && definition.layouts.labels.length) {
      const r = await ch.send([CMD_VIA_GET_KEYBOARD_VALUE, VIA_LAYOUT_OPTIONS]);
      layoutOptions = ((r[2] << 24) | (r[3] << 16) | (r[4] << 8) | r[5]) >>> 0;
    }

    const name = definition.name || dev.productName || 'Vial keyboard';
    return {
      id: 'vial:' + uid,
      type: 'vial',
      name,
      deviceName: dev.productName || '',
      readAt: Date.now(),
      vial: { viaProtocol, vialProtocol, uid, vendorId: dev.vendorId, productId: dev.productId, definition, layers, rows, cols, keymap, encoders, layoutOptions },
    };
  } finally {
    ch.close();
    try { await dev.close(); } catch (e) { /* ignore */ }
  }
}

// ZMK Studio RPC reader (USB serial via Web Serial, or BLE via Web Bluetooth)
// Protocol: protobuf messages from zmk-studio-messages, framed with SOF/ESC/EOF bytes.

const SOF = 0xAB, ESC = 0xAC, EOF = 0xAD;
const BLE_SERVICE = '00000000-0196-6107-c967-c5cfb1c2482a';
const BLE_RPC_CHRC = '00000001-0196-6107-c967-c5cfb1c2482a';

export function zmkSerialSupported() { return 'serial' in navigator; }
export function zmkBleSupported() { return 'bluetooth' in navigator; }

// ---------- framing ----------
function frame(payload) {
  const out = [SOF];
  for (const b of payload) {
    if (b === SOF || b === ESC || b === EOF) out.push(ESC);
    out.push(b);
  }
  out.push(EOF);
  return new Uint8Array(out);
}

class Deframer {
  constructor(onFrame) { this.onFrame = onFrame; this.state = 0; this.data = []; }
  push(chunk) {
    for (const b of chunk) {
      if (this.state === 0) {
        if (b === SOF) { this.state = 1; this.data = []; }
      } else if (this.state === 1) {
        if (b === SOF) { this.data = []; }
        else if (b === ESC) this.state = 2;
        else if (b === EOF) { this.state = 0; this.onFrame(new Uint8Array(this.data)); }
        else this.data.push(b);
      } else { this.data.push(b); this.state = 1; }
    }
  }
}

// ---------- protobuf ----------
function writeVarint(out, v) {
  v = v >>> 0;
  while (v > 0x7F) { out.push((v & 0x7F) | 0x80); v >>>= 7; }
  out.push(v);
}
// fields: [[fieldNo, value]] where value is number (varint) or array/Uint8Array (length-delimited)
function pbEncode(fields) {
  const out = [];
  for (const [f, v] of fields) {
    if (typeof v === 'number' || typeof v === 'boolean') {
      writeVarint(out, (f << 3) | 0);
      writeVarint(out, Number(v));
    } else {
      writeVarint(out, (f << 3) | 2);
      writeVarint(out, v.length);
      for (const b of v) out.push(b);
    }
  }
  return out;
}

function readVarint(buf, pos) {
  let v = 0, mul = 1, b;
  do {
    b = buf[pos++];
    if (b === undefined) throw new Error('protobuf: truncated varint');
    if (mul < 4294967296) v += (b & 0x7F) * mul;
    mul *= 128;
  } while (b & 0x80);
  return [v % 4294967296, pos];
}

// Schema: { fieldNo: [name, type, subSchemaName?, repeated?] }
// types: u=uint32, i=int32, s=sint32, b=bool, e=enum, str, bytes, m=message
const S = {
  Response: { 1: ['request_response', 'm', 'RequestResponse'], 2: ['notification', 'm', 'Notification'] },
  RequestResponse: { 1: ['request_id', 'u'], 2: ['meta', 'm', 'MetaResponse'], 3: ['core', 'm', 'CoreResponse'], 4: ['behaviors', 'm', 'BehaviorsResponse'], 5: ['keymap', 'm', 'KeymapResponse'] },
  Notification: { 2: ['core', 'm', 'CoreNotification'], 5: ['keymap', 'm', 'KeymapNotification'] },
  MetaResponse: { 1: ['no_response', 'b'], 2: ['simple_error', 'e'] },
  CoreResponse: { 1: ['get_device_info', 'm', 'DeviceInfo'], 2: ['get_lock_state', 'e'], 4: ['reset_settings', 'b'] },
  DeviceInfo: { 1: ['name', 'str'], 2: ['serial_number', 'bytes'] },
  CoreNotification: { 1: ['lock_state_changed', 'e'] },
  KeymapNotification: { 1: ['unsaved_changes_status_changed', 'b'] },
  KeymapResponse: { 1: ['get_keymap', 'm', 'Keymap'], 6: ['get_physical_layouts', 'm', 'PhysicalLayouts'] },
  Keymap: { 1: ['layers', 'm', 'Layer', true], 2: ['available_layers', 'u'], 3: ['max_layer_name_length', 'u'] },
  Layer: { 1: ['id', 'u'], 2: ['name', 'str'], 3: ['bindings', 'm', 'BehaviorBinding', true] },
  BehaviorBinding: { 1: ['behavior_id', 's'], 2: ['param1', 'u'], 3: ['param2', 'u'] },
  PhysicalLayouts: { 1: ['active_layout_index', 'u'], 2: ['layouts', 'm', 'PhysicalLayout', true] },
  PhysicalLayout: { 1: ['name', 'str'], 2: ['keys', 'm', 'KeyPhysicalAttrs', true] },
  KeyPhysicalAttrs: { 1: ['width', 's'], 2: ['height', 's'], 3: ['x', 's'], 4: ['y', 's'], 5: ['r', 's'], 6: ['rx', 's'], 7: ['ry', 's'] },
  BehaviorsResponse: { 1: ['list_all_behaviors', 'm', 'ListAllBehaviors'], 2: ['get_behavior_details', 'm', 'BehaviorDetails'] },
  ListAllBehaviors: { 1: ['behaviors', 'u', null, true] },
  BehaviorDetails: { 1: ['id', 'u'], 2: ['display_name', 'str'], 3: ['metadata', 'm', 'ParamSet', true] },
  ParamSet: { 1: ['param1', 'm', 'ParamDesc', true], 2: ['param2', 'm', 'ParamDesc', true] },
  ParamDesc: { 1: ['name', 'str'], 2: ['nil', 'm', 'Empty'], 3: ['constant', 'u'], 4: ['range', 'm', 'Range'], 5: ['hid_usage', 'm', 'HidUsage'], 6: ['layer_id', 'm', 'Empty'] },
  Range: { 1: ['min', 'i'], 2: ['max', 'i'] },
  HidUsage: { 1: ['keyboard_max', 'u'], 2: ['consumer_max', 'u'] },
  Empty: {},
};

const conv = (type, v) => {
  switch (type) {
    case 'u': case 'e': return v >>> 0;
    case 'i': return v | 0;
    case 's': { const u = v >>> 0; return (u >>> 1) ^ -(u & 1); }
    case 'b': return v !== 0;
    default: return v;
  }
};

function pbDecode(buf, schemaName) {
  const schema = S[schemaName];
  const obj = {};
  for (const f of Object.values(schema)) if (f[3]) obj[f[0]] = [];
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const fno = Math.floor(key / 8), wt = key & 7;
    const f = schema[fno];
    let val;
    if (wt === 0) { [val, pos] = readVarint(buf, pos); }
    else if (wt === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      val = buf.subarray(pos, pos + len);
      pos += len;
    } else if (wt === 5) { pos += 4; continue; }
    else if (wt === 1) { pos += 8; continue; }
    else throw new Error('protobuf: unsupported wire type ' + wt);
    if (!f) continue;
    const [name, type, sub, rep] = f;
    if (type === 'm') {
      const m = pbDecode(val, sub);
      if (rep) obj[name].push(m); else obj[name] = m;
    } else if (type === 'str') obj[name] = new TextDecoder().decode(val);
    else if (type === 'bytes') obj[name] = Array.from(val);
    else if (wt === 2) { // packed repeated scalars
      let p = 0;
      while (p < val.length) { let x; [x, p] = readVarint(val, p); obj[name].push(conv(type, x)); }
    } else if (rep) obj[name].push(conv(type, val));
    else obj[name] = conv(type, val);
  }
  return obj;
}

// ---------- transports ----------
async function openSerial() {
  const port = await navigator.serial.requestPort({});
  try { await port.open({ baudRate: 12500 }); }
  catch (e) { throw new Error('シリアルポートを開けませんでした。他のアプリ（ZMK Studio など）が使用中でないか確認してください。(' + e.message + ')'); }
  const reader = port.readable.getReader();
  const writer = port.writable.getWriter();
  let onData = () => {};
  let closed = false;
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) onData(value);
      }
    } catch (e) { /* port closed */ }
  })();
  return {
    label: 'USB',
    set onData(fn) { onData = fn; },
    write: (bytes) => writer.write(bytes),
    async close() {
      if (closed) return; closed = true;
      try { await reader.cancel(); } catch (e) {}
      try { reader.releaseLock(); } catch (e) {}
      try { writer.releaseLock(); } catch (e) {}
      try { await port.close(); } catch (e) {}
    },
  };
}

async function openBle() {
  // Stock ZMK advertises only the HID + Battery services, so also match on battery_service
  // (same approach as DYA Studio). Bluefy (iOS) needs upper-case UUIDs and cannot filter on 128-bit ones.
  const bluefy = /Bluefy/.test(navigator.userAgent);
  const svcId = bluefy ? BLE_SERVICE.toUpperCase() : BLE_SERVICE;
  const chrId = bluefy ? BLE_RPC_CHRC.toUpperCase() : BLE_RPC_CHRC;
  const filters = bluefy ? [{ services: ['battery_service'] }] : [{ services: [svcId] }, { services: ['battery_service'] }];
  const dev = await navigator.bluetooth.requestDevice({ filters, optionalServices: [svcId] });
  const server = dev.gatt.connected ? dev.gatt : await dev.gatt.connect();
  let svc;
  try { svc = await server.getPrimaryService(svcId); }
  catch (e) {
    try { dev.gatt.disconnect(); } catch (_) {}
    throw new Error(`「${dev.name || 'このデバイス'}」には ZMK Studio のサービスがありません。ZMK Studio を有効にしたファームウェアか、分割キーボードならセントラル側を選んでください。`);
  }
  const chr = await svc.getCharacteristic(chrId);
  let onData = () => {};
  const handler = (ev) => {
    const v = ev.target.value;
    if (v) onData(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  };
  try { await chr.stopNotifications(); } catch (e) {}
  await chr.startNotifications();
  chr.addEventListener('characteristicvaluechanged', handler);
  return {
    label: 'BLE',
    set onData(fn) { onData = fn; },
    write: (bytes) => chr.writeValueWithoutResponse(bytes),
    async close() {
      chr.removeEventListener('characteristicvaluechanged', handler);
      try { await chr.stopNotifications(); } catch (e) {}
      try { dev.gatt.disconnect(); } catch (e) {}
    },
  };
}

// ---------- RPC client ----------
const SUBSYS = { core: 3, behaviors: 4, keymap: 5 };
const META_ERRORS = ['GENERIC', 'UNLOCK_REQUIRED', 'RPC_NOT_FOUND', 'MSG_DECODE_FAILED', 'MSG_ENCODE_FAILED'];

class RpcClient {
  constructor(transport) {
    this.t = transport;
    this.nextId = 1;
    this.pending = new Map();
    this.notifyHandlers = new Set();
    this.deframer = new Deframer((f) => this.onFrame(f));
    transport.onData = (d) => this.deframer.push(d);
  }
  onFrame(f) {
    let msg;
    try { msg = pbDecode(f, 'Response'); } catch (e) { console.warn('decode failed', e); return; }
    if (msg.request_response) {
      const rr = msg.request_response;
      const p = this.pending.get(rr.request_id);
      if (!p) return;
      this.pending.delete(rr.request_id);
      clearTimeout(p.timer);
      if (rr.meta && rr.meta.simple_error !== undefined) {
        const code = META_ERRORS[rr.meta.simple_error] || String(rr.meta.simple_error);
        p.reject(Object.assign(new Error('ZMK RPC エラー: ' + code), { code }));
      } else p.resolve(rr);
    } else if (msg.notification) {
      for (const h of this.notifyHandlers) h(msg.notification);
    }
  }
  call(subsystem, fields, timeout = 5000) {
    const id = this.nextId++;
    const body = pbEncode([[1, id], [SUBSYS[subsystem], pbEncode(fields)]]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('キーボードから応答がありません（タイムアウト）'));
      }, timeout);
      this.pending.set(id, { resolve: (rr) => resolve(rr[subsystem] || {}), reject, timer });
      Promise.resolve(this.t.write(frame(body))).catch((e) => { clearTimeout(timer); this.pending.delete(id); reject(e); });
    });
  }
  waitNotification(pred, signal) {
    return new Promise((resolve, reject) => {
      const h = (n) => { if (pred(n)) { this.notifyHandlers.delete(h); resolve(n); } };
      this.notifyHandlers.add(h);
      if (signal) signal.addEventListener('abort', () => { this.notifyHandlers.delete(h); reject(Object.assign(new Error('キャンセルされました'), { cancelled: true })); });
    });
  }
}

const LOCKED = 0, UNLOCKED = 1;

/**
 * Read the full keymap from a ZMK Studio device.
 * @param {'serial'|'ble'} kind
 * @param {(msg:string, opts?:{locked?:boolean})=>void} progress
 * @param {AbortSignal} signal  aborts the unlock wait
 */
export async function readZmk(kind, progress = () => {}, signal) {
  let t;
  try {
    t = kind === 'ble' ? await openBle() : await openSerial();
  } catch (e) {
    if (e && (e.name === 'NotFoundError' || e.name === 'AbortError')) throw Object.assign(new Error('キャンセルされました'), { cancelled: true });
    throw e;
  }
  const rpc = new RpcClient(t);
  try {
    progress('デバイス情報を取得中…');
    const core = await rpc.call('core', [[1, true]]);
    const info = core.get_device_info || {};

    const lock = await rpc.call('core', [[2, true]]);
    if ((lock.get_lock_state ?? LOCKED) !== UNLOCKED) {
      progress('キーボードがロックされています。キーボードの Studio Unlock キー（&studio_unlock）を押してください。', { locked: true });
      await rpc.waitNotification((n) => n.core && n.core.lock_state_changed === UNLOCKED, signal);
    }

    progress('キーマップを取得中…');
    const km = (await rpc.call('keymap', [[1, true]])).get_keymap;
    if (!km) throw new Error('キーマップを取得できませんでした');
    progress('物理レイアウトを取得中…');
    const pl = (await rpc.call('keymap', [[6, true]])).get_physical_layouts || { active_layout_index: 0, layouts: [] };

    progress('ビヘイビア一覧を取得中…');
    const ids = ((await rpc.call('behaviors', [[1, true]])).list_all_behaviors || {}).behaviors || [];
    const behaviors = {};
    let i = 0;
    for (const id of ids) {
      progress(`ビヘイビア情報を取得中… (${++i}/${ids.length})`);
      const d = (await rpc.call('behaviors', [[2, pbEncode([[1, id]])]])).get_behavior_details;
      if (d) behaviors[id] = { display_name: d.display_name || '', metadata: d.metadata || [] };
    }

    const serial = (info.serial_number || []).map((b) => b.toString(16).padStart(2, '0')).join('');
    const name = info.name || 'ZMK keyboard';
    return {
      id: 'zmk:' + (serial || name),
      type: 'zmk',
      name,
      deviceName: name,
      readAt: Date.now(),
      zmk: {
        transport: t.label,
        serial,
        keymap: { layers: km.layers.map((l) => ({ id: l.id ?? 0, name: l.name || '', bindings: l.bindings.map((b) => ({ behavior_id: b.behavior_id ?? 0, param1: b.param1 ?? 0, param2: b.param2 ?? 0 })) })) },
        physicalLayouts: {
          active: pl.active_layout_index ?? 0,
          layouts: pl.layouts.map((L) => ({ name: L.name || '', keys: L.keys.map((k) => ({ w: k.width ?? 0, h: k.height ?? 0, x: k.x ?? 0, y: k.y ?? 0, r: k.r ?? 0, rx: k.rx ?? 0, ry: k.ry ?? 0 })) })),
        },
        behaviors,
      },
    };
  } finally {
    await t.close();
  }
}

// exported for tests
export const _internal = { frame, Deframer, pbEncode, pbDecode };

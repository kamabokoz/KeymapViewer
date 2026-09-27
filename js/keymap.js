// Turns a stored record (raw Vial / ZMK data) into a renderable view model:
// { keys: [{x,y,w,h,x2,y2,w2,h2,r,rx,ry,encoder?}], layers: [{name, legends:[{tap:[..], hold, title, kind}]}], options }
import VKC from './vial-keycodes.js';

// ---------------- KLE ----------------
const LABEL_MAP = [
  [0, 6, 2, 8, 9, 11, 3, 5, 1, 4, 7, 10],
  [1, 7, -1, -1, 9, 11, 4, -1, -1, -1, -1, 10],
  [3, -1, 5, -1, 9, 11, -1, -1, 4, -1, -1, 10],
  [4, -1, -1, -1, 9, 11, -1, -1, -1, -1, -1, 10],
  [0, 6, 2, 8, 10, -1, 3, 5, 1, 4, 7, -1],
  [1, 7, -1, -1, 10, -1, 4, -1, -1, -1, -1, -1],
  [3, -1, 5, -1, 10, -1, -1, -1, 4, -1, -1, -1],
  [4, -1, -1, -1, 10, -1, -1, -1, -1, -1, -1, -1],
];
function reorder(labels, align) {
  const ret = new Array(12).fill(null);
  labels.forEach((l, i) => { if (l !== '' && l != null && LABEL_MAP[align] && LABEL_MAP[align][i] >= 0) ret[LABEL_MAP[align][i]] = l; });
  return ret;
}
export function parseKle(rows) {
  const cur = { x: 0, y: 0, w: 1, h: 1, x2: 0, y2: 0, w2: 0, h2: 0, r: 0, rx: 0, ry: 0, decal: false };
  const cluster = { x: 0, y: 0 };
  let align = 4;
  const keys = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const item of row) {
      if (typeof item === 'string') {
        keys.push({
          x: cur.x, y: cur.y, w: cur.w, h: cur.h, x2: cur.x2, y2: cur.y2,
          w2: cur.w2 || cur.w, h2: cur.h2 || cur.h, r: cur.r, rx: cur.rx, ry: cur.ry, decal: cur.decal,
          labels: reorder(item.split('\n'), align),
        });
        cur.x += cur.w;
        cur.w = cur.h = 1;
        cur.x2 = cur.y2 = cur.w2 = cur.h2 = 0;
        cur.decal = false;
      } else if (item && typeof item === 'object') {
        if ('r' in item) cur.r = item.r;
        if ('rx' in item) { cur.rx = cluster.x = item.rx; cur.x = cluster.x; cur.y = cluster.y; }
        if ('ry' in item) { cur.ry = cluster.y = item.ry; cur.x = cluster.x; cur.y = cluster.y; }
        if ('a' in item) align = item.a;
        if ('x' in item) cur.x += item.x;
        if ('y' in item) cur.y += item.y;
        if ('w' in item) cur.w = cur.w2 = item.w;
        if ('h' in item) cur.h = cur.h2 = item.h;
        if ('x2' in item) cur.x2 = item.x2;
        if ('y2' in item) cur.y2 = item.y2;
        if ('w2' in item) cur.w2 = item.w2;
        if ('h2' in item) cur.h2 = item.h2;
        if ('d' in item) cur.decal = item.d;
      }
    }
    cur.y += 1;
    cur.x = cur.rx;
  }
  return keys;
}

// rotated bounding box of a key (in key units)
function corners(k) {
  const pts = [[k.x, k.y], [k.x + k.w, k.y], [k.x, k.y + k.h], [k.x + k.w, k.y + k.h]];
  if (!k.r) return pts;
  const a = (k.r * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return pts.map(([x, y]) => [k.rx + (x - k.rx) * c - (y - k.ry) * s, k.ry + (x - k.rx) * s + (y - k.ry) * c]);
}
export function bounds(keys) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const k of keys) for (const [x, y] of corners(k)) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}
function shiftKeys(keys, dx, dy) {
  for (const k of keys) { k.x += dx; k.y += dy; k.rx += dx; k.ry += dy; }
}

// ---------------- labels ----------------
// JIS host layout (key label = "shifted\nbase") for HID keyboard usages
const JIS = {
  0x1E: '!\n1', 0x1F: '"\n2', 0x20: '#\n3', 0x21: '$\n4', 0x22: '%\n5', 0x23: '&\n6', 0x24: "'\n7", 0x25: '(\n8', 0x26: ')\n9', 0x27: '0',
  0x2D: '=\n-', 0x2E: '~\n^', 0x2F: '`\n@', 0x30: '{\n[', 0x31: '}\n]', 0x32: '}\n]', 0x33: '+\n;', 0x34: '*\n:', 0x35: '半角/\n全角',
  0x36: '<\n,', 0x37: '>\n.', 0x38: '?\n/', 0x39: '英数\nCaps', 0x87: '_\n\\ ろ', 0x88: 'かな', 0x89: '|\n¥', 0x8A: '変換', 0x8B: '無変換',
  0x90: 'かな', 0x91: '英数',
};
const US_OVERRIDE = { 0x90: 'かな\nLang1', 0x91: '英数\nLang2', 0x88: 'かな\nKana', 0x87: '_\n\\ Ro', 0x89: '|\n¥' };

function basicLabel(code, jis) {
  if (jis && JIS[code]) return JIS[code];
  if (US_OVERRIDE[code]) return US_OVERRIDE[code];
  const e = VKC.v6.codes[code];
  return e ? e[1] : '0x' + code.toString(16).toUpperCase();
}
// label of a basic key when shifted ("!" for "1")
function shiftedLabel(code, jis) {
  const l = basicLabel(code, jis);
  const parts = l.split('\n');
  return parts.length === 2 && parts[0].length <= 2 ? parts[0] : null;
}
const lines = (s) => String(s).split('\n').filter((x) => x !== '');

// ---------------- Vial ----------------
const MOD_NAMES = ['Ctl', 'Sft', 'Alt', 'Gui'];
function qmkModStr(m5) { // 5-bit QMK mod (bit4 = right)
  const side = m5 & 0x10 ? 'R' : 'L';
  const names = MOD_NAMES.filter((_, i) => m5 & (1 << i));
  return names.length ? side + names.join('+' + side) : '';
}

export function vialLegend(code, proto, custom, jis) {
  const tbl = proto === 6 ? VKC.v6 : VKC.v5;
  const hex = '0x' + code.toString(16).toUpperCase().padStart(4, '0');
  const lo = code & 0xFF, hi = code & 0xFF00;
  if (code === 0) return { tap: [], title: 'KC_NO', kind: 'none' };
  if (code === 1) return { tap: ['▽'], title: 'KC_TRNS', kind: 'trans' };
  if (code < 0x100 && lo >= 0x04 && lo <= 0x9F) {
    const e = tbl.codes[code];
    return { tap: lines(basicLabel(code, jis)), title: e ? e[0] : hex, kind: 'key' };
  }
  // shift + basic key -> show the shifted character
  if ((hi === 0x0200 || hi === 0x1200) && lo >= 0x04 && lo <= 0x38) {
    const s = shiftedLabel(lo, jis);
    const e = tbl.codes[code] || tbl.codes[hi];
    const id = e ? e[0].replace('kc', (tbl.codes[lo] || ['?'])[0]) : hex;
    if (s) return { tap: [s], title: id, kind: 'key' };
  }
  if (tbl.masked.includes(hi)) {
    const outer = tbl.codes[hi];
    if (outer) {
      const inner = tbl.codes[lo];
      const innerId = inner ? inner[0] : '0x' + lo.toString(16);
      const hold = outer[1].replace(/\n?\(kc\)/, '').replace(/\n/g, ' ');
      const isLayer = /^LT\d+/.test(outer[0]);
      return { tap: lines(lo ? basicLabel(lo, jis) : ''), hold, title: outer[0].replace('kc', innerId), kind: isLayer ? 'layer-tap' : 'mod-tap' };
    }
  }
  const e = tbl.codes[code];
  if (e) {
    let label = e[1];
    const um = /^USER(\d+)$/.exec(e[0]);
    if (um && custom && custom[+um[1]]) {
      const c = custom[+um[1]];
      return { tap: lines(c.shortName || c.name || e[1]), title: `${e[0]}: ${c.title || c.name || ''}`, kind: 'custom' };
    }
    let kind = 'func';
    if (/^(MO|TG|TO|TT|OSL|DF|PDF)\(/.test(e[0]) || /^FN_MO/.test(e[0]) || e[0] === 'QK_LAYER_LOCK') kind = 'layer';
    if (/^(KC_LCTRL|KC_LSHIFT|KC_LALT|KC_LGUI|KC_RCTRL|KC_RSHIFT|KC_RALT|KC_RGUI)$/.test(e[0])) kind = 'mod';
    return { tap: lines(label), title: e[0], kind };
  }
  // Layer-mod (v6): 0x5000-0x51FF
  if (proto === 6 && code >= 0x5000 && code <= 0x51FF) {
    const layer = (code >> 5) & 0xF, mod = code & 0x1F;
    return { tap: [`LM ${layer}`], hold: qmkModStr(mod), title: `LM(${layer}, ${qmkModStr(mod)})`, kind: 'layer' };
  }
  // mods + basic combos not in the table
  if (code < 0x2000 && hi) {
    const m = qmkModStr(hi >> 8);
    return { tap: lines(basicLabel(lo, jis)), hold: m, title: `${m}(${(tbl.codes[lo] || [hex])[0]})`, kind: 'key' };
  }
  return { tap: [hex], title: hex, kind: 'func' };
}

function vialChoices(labels) {
  return (labels || []).map((it) => (typeof it === 'string' ? { title: it, options: ['オフ', 'オン'], bool: true } : { title: it[0], options: it.slice(1), bool: false }));
}
export function decodeLayoutOptions(labels, value) {
  const choices = vialChoices(labels);
  const vals = new Array(choices.length).fill(0);
  let v = value >>> 0;
  for (let i = choices.length - 1; i >= 0; i--) {
    const c = choices[i];
    const n = c.options.length - 1;
    const bits = c.bool ? 1 : n > 0 ? n.toString(2).length : 0;
    if (!bits) continue;
    vals[i] = v & ((1 << bits) - 1);
    v = Math.floor(v / (1 << bits));
  }
  return vals;
}

function vialView(rec, opts) {
  const v = rec.vial;
  const def = v.definition;
  const all = parseKle(def.layouts.keymap).filter((k) => !k.decal);
  const choices = vialChoices(def.layouts.labels);
  const selected = opts.layoutChoices && opts.layoutChoices.length === choices.length ? opts.layoutChoices : decodeLayoutOptions(def.layouts.labels, v.layoutOptions || 0);

  for (const k of all) {
    k.layoutIndex = -1; k.layoutOption = -1;
    if (k.labels[8] && /^\d+,\d+$/.test(k.labels[8])) [k.layoutIndex, k.layoutOption] = k.labels[8].split(',').map(Number);
    if (k.labels[4] === 'e' && /^\d+,\d+$/.test(k.labels[0] || '')) {
      const [idx, dir] = k.labels[0].split(',').map(Number);
      k.encoder = { idx, dir };
    } else if (k.labels[0] && /^\d+,\d+$/.test(k.labels[0])) {
      [k.row, k.col] = k.labels[0].split(',').map(Number);
    } else k.skip = true;
  }
  const usable = all.filter((k) => !k.skip);
  // shift layout-option keys so that each option aligns with option 0 (as Vial does)
  const tl = {};
  for (const k of usable) {
    if (k.layoutIndex < 0) continue;
    const b = bounds([k]);
    const key = k.layoutIndex + ',' + k.layoutOption;
    tl[key] = tl[key] || { x: Infinity, y: Infinity };
    tl[key].x = Math.min(tl[key].x, b.minX); tl[key].y = Math.min(tl[key].y, b.minY);
  }
  const keys = [];
  for (const k of usable) {
    if (k.layoutIndex >= 0) {
      if ((selected[k.layoutIndex] ?? 0) !== k.layoutOption) continue;
      const a = tl[k.layoutIndex + ',' + k.layoutOption], z = tl[k.layoutIndex + ',0'] || a;
      shiftKeys([k], z.x - a.x, z.y - a.y);
    }
    keys.push(k);
  }
  const b = bounds(keys);
  shiftKeys(keys, -b.minX, -b.minY);

  const custom = def.customKeycodes || null;
  const proto = v.vialProtocol;
  const layers = [];
  for (let l = 0; l < v.layers; l++) {
    const legends = keys.map((k) => {
      let code;
      if (k.encoder) code = ((v.encoders[l] || [])[k.encoder.idx] || [0, 0])[k.encoder.dir];
      else code = ((v.keymap[l] || [])[k.row] || [])[k.col] ?? 0;
      const lg = vialLegend(code, proto, custom, opts.jis);
      if (k.encoder) lg.title = `エンコーダ${k.encoder.idx} ${k.encoder.dir ? '時計回り' : '反時計回り'}: ${lg.title}`;
      else lg.title = `[${k.row},${k.col}] ${lg.title}`;
      if (lg.kind === 'layer' || lg.kind === 'layer-tap') lg.targetLayer = layerTarget(lg.title);
      return lg;
    });
    layers.push({ name: `Layer ${l}`, legends });
  }
  return {
    keys: keys.map((k) => ({ x: k.x, y: k.y, w: k.w, h: k.h, x2: k.x2, y2: k.y2, w2: k.w2, h2: k.h2, r: k.r, rx: k.rx, ry: k.ry, encoder: !!k.encoder })),
    layers,
    layoutChoices: choices.length ? { choices, selected } : null,
    meta: [`Vial プロトコル v${proto}`, `VIA v${v.viaProtocol}`, `マトリクス ${v.rows}×${v.cols}`, `${v.layers} レイヤー`],
  };
}
function layerTarget(title) {
  const m = /(?:MO|TG|TO|TT|OSL|DF|PDF|LM)\((\d+)/.exec(title) || /LT(\d+)\(/.exec(title);
  return m ? +m[1] : null;
}

// ---------------- ZMK ----------------
const CONSUMER = {
  0x30: 'Power', 0x32: 'Sleep', 0x40: 'Menu', 0x6F: 'Bright\nUp', 0x70: 'Bright\nDown', 0xB0: 'Play', 0xB1: 'Pause', 0xB2: 'Rec',
  0xB3: 'FF', 0xB4: 'Rew', 0xB5: 'Next', 0xB6: 'Prev', 0xB7: 'Stop', 0xB8: 'Eject', 0xCD: 'Play/\nPause', 0xE2: 'Mute',
  0xE9: 'Vol +', 0xEA: 'Vol -', 0x183: 'Media\nSel', 0x18A: 'Mail', 0x192: 'Calc', 0x194: 'My\nPC', 0x1A7: 'Docs',
  0x221: 'Search', 0x223: 'Browser\nHome', 0x224: 'Back', 0x225: 'Fwd', 0x226: 'Stop', 0x227: 'Refresh', 0x22A: 'Fav',
  0x29F: 'Mission\nCtrl', 0x2A0: 'Launch\npad', 0x2A2: 'Desktop',
};
const ZMK_MODS = ['LCtl', 'LSft', 'LAlt', 'LGui', 'RCtl', 'RSft', 'RAlt', 'RGui'];
const MOD_USAGES = { 0xE0: 'LCtl', 0xE1: 'LSft', 0xE2: 'LAlt', 0xE3: 'LGui', 0xE4: 'RCtl', 0xE5: 'RSft', 0xE6: 'RAlt', 0xE7: 'RGui' };

export function hidLabel(value, jis) {
  const mods = (value >>> 24) & 0xFF;
  let page = (value >>> 16) & 0xFF;
  const id = value & 0xFFFF;
  if (page === 0) page = 7;
  let base;
  if (page === 7) {
    if (mods && (mods & ~0x22) === 0 && id >= 0x04 && id <= 0x38) {
      const s = shiftedLabel(id, jis);
      if (s) return { lines: [s], mods: '' };
    }
    base = MOD_USAGES[id] || basicLabel(id, jis);
  } else if (page === 0x0C) base = CONSUMER[id] || 'C:0x' + id.toString(16).toUpperCase();
  else base = `0x${page.toString(16)}:${id.toString(16)}`;
  const m = ZMK_MODS.filter((_, i) => mods & (1 << i)).join('+');
  return { lines: lines(base), mods: m };
}
const hidText = (v, jis) => { const h = hidLabel(v, jis); return (h.mods ? h.mods + '+' : '') + h.lines.join(' ').replace(/\s+/g, ' '); };

function matchDesc(descs, value) {
  if (!descs || !descs.length) return value === 0 ? { nil: {} } : null;
  for (const d of descs) {
    if (d.constant !== undefined) { if (d.constant === value) return d; }
    else if (d.range) { if (value >= d.range.min && value <= d.range.max) return d; }
    else if (d.hid_usage || d.layer_id) return d;
    else if (d.nil && value === 0) return d;
  }
  return null;
}
function pickSet(meta, p1, p2) {
  for (const set of meta || []) {
    const a = matchDesc(set.param1, p1), b = matchDesc(set.param2, p2);
    if (a && b) return [a, b];
  }
  const s = (meta || [])[0];
  return s ? [s.param1 && s.param1[0], s.param2 && s.param2[0]] : [null, null];
}

function zmkLegend(b, behaviors, layerName, jis) {
  const beh = behaviors[b.behavior_id];
  if (!beh) return { tap: ['?'], title: `不明なビヘイビア #${b.behavior_id} (${b.param1}, ${b.param2})`, kind: 'func' };
  const name = beh.display_name || `#${b.behavior_id}`;
  const lname = name.toLowerCase();
  const [d1, d2] = pickSet(beh.metadata, b.param1, b.param2);
  const fmt = (d, v) => {
    if (!d || d.nil) return null;
    if (d.hid_usage) return { kind: 'hid', text: hidText(v, jis), label: hidLabel(v, jis) };
    if (d.layer_id) return { kind: 'layer', text: layerName(v), layer: v };
    if (d.constant !== undefined) return { kind: 'const', text: d.name || String(v) };
    if (d.range) return { kind: 'range', text: (d.name ? d.name + ' ' : '') + v };
    return { kind: 'raw', text: String(v) };
  };
  const a = fmt(d1, b.param1), c = fmt(d2, b.param2);
  const title = [name, a && a.text, c && c.text].filter(Boolean).join(' · ');
  const hidTap = (x) => (x.label.mods ? { tap: x.label.lines, hold: x.label.mods } : { tap: x.label.lines });

  if (lname === 'transparent') return { tap: ['▽'], title, kind: 'trans' };
  if (lname === 'none') return { tap: [], title, kind: 'none' };
  if (a && a.kind === 'hid' && !c) {
    const r = hidTap(a);
    const isKp = lname === 'key press';
    if (!isKp) r.hold = [name, r.hold].filter(Boolean).join(' ');
    const isMod = MOD_USAGES[b.param1 & 0xFFFF] && ((b.param1 >>> 16) & 0xFF) === 7;
    return { ...r, title, kind: isKp ? (isMod ? 'mod' : 'key') : 'func' };
  }
  if (a && a.kind === 'layer' && c && c.kind === 'hid') {
    return { tap: c.label.lines, hold: (lname === 'layer-tap' ? 'LT ' : name + ' ') + a.text, title, kind: 'layer-tap', targetLayer: a.layer };
  }
  if (a && a.kind === 'hid' && c && c.kind === 'hid') { // mod-tap / hold-tap
    return { tap: c.label.lines, hold: a.label.lines.join(' ') + (lname === 'mod-tap' ? '' : ''), title, kind: 'mod-tap' };
  }
  if (a && a.kind === 'layer' && !c) {
    const short = { 'momentary layer': 'MO', 'toggle layer': 'TG', 'to layer': 'TO', 'sticky layer': 'SL' }[lname];
    return { tap: [a.text], hold: short || name, title, kind: 'layer', targetLayer: a.layer };
  }
  if (a && a.kind === 'const' && c && c.kind === 'range') return { tap: [a.text, String(b.param2)], hold: name, title, kind: 'func' };
  const parts = [a && a.text, c && c.text].filter(Boolean);
  if (parts.length) return { tap: parts.flatMap(lines), hold: name, title, kind: 'func' };
  return { tap: lines(name.replace(/ /, '\n')), title, kind: 'func' };
}

function zmkView(rec, opts) {
  const z = rec.zmk;
  const layouts = z.physicalLayouts.layouts;
  const li = opts.zmkLayout != null && layouts[opts.zmkLayout] ? opts.zmkLayout : z.physicalLayouts.active || 0;
  const L = layouts[li];
  const nkeys = Math.max(...z.keymap.layers.map((l) => l.bindings.length), 0);
  let keys;
  if (L && L.keys.length) {
    keys = L.keys.map((k) => ({ x: k.x / 100, y: k.y / 100, w: k.w / 100 || 1, h: k.h / 100 || 1, r: k.r / 100, rx: k.rx / 100, ry: k.ry / 100 }));
  } else { // no physical layout: grid fallback
    keys = Array.from({ length: nkeys }, (_, i) => ({ x: i % 12, y: Math.floor(i / 12), w: 1, h: 1, r: 0, rx: 0, ry: 0 }));
  }
  for (const k of keys) { k.x2 = 0; k.y2 = 0; k.w2 = k.w; k.h2 = k.h; }
  const b = bounds(keys);
  shiftKeys(keys, -b.minX, -b.minY);

  const byId = new Map(z.keymap.layers.map((l, i) => [l.id, { l, i }]));
  const layerName = (v) => {
    const e = byId.get(v) || (z.keymap.layers[v] ? { l: z.keymap.layers[v], i: v } : null);
    return e ? (e.l.name || `L${e.i}`) : `L${v}`;
  };
  const layers = z.keymap.layers.map((l, i) => ({
    name: l.name || `Layer ${i}`,
    legends: keys.map((_, ki) => {
      const bd = l.bindings[ki];
      if (!bd) return { tap: [], title: '', kind: 'none' };
      const lg = zmkLegend(bd, z.behaviors, layerName, opts.jis);
      lg.title = `#${ki} ${lg.title}`;
      if (lg.targetLayer != null) { const e = byId.get(lg.targetLayer); lg.targetLayer = e ? e.i : lg.targetLayer; }
      return lg;
    }),
  }));
  return {
    keys, layers,
    zmkLayouts: layouts.length > 1 ? { names: layouts.map((x, i) => x.name || `Layout ${i}`), selected: li } : null,
    meta: [`ZMK Studio (${z.transport})`, `${z.keymap.layers.length} レイヤー`, `${keys.length} キー`, `${Object.keys(z.behaviors).length} ビヘイビア`],
  };
}

export function buildView(rec, opts = {}) {
  return rec.type === 'vial' ? vialView(rec, opts) : zmkView(rec, opts);
}

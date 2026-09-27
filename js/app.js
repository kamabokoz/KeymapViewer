import { readVial, vialSupported } from './vial.js';
import { readZmk, zmkSerialSupported, zmkBleSupported } from './zmk.js';
import { listKeyboards, getKeyboard, putKeyboard, deleteKeyboard, requestPersistence } from './db.js';
import { buildView } from './keymap.js';
import { renderKeyboard } from './render.js';
import { buildFrames, drawQr, FrameCollector, QrScanner, shareSupported, scanSupported } from './share.js';

const $ = (s, r = document) => r.querySelector(s);
const BLE_NOTE = 'キーボードが一覧に出ない場合は、キーボードの Studio Unlock キーを押してから、もう一度「ZMK Studio（Bluetooth）」を押してください（Windows・macOS では、アンロック時に接続待ちになるファームウェア〔DYA Studio 対応の cormoran 版 ZMK など〕が必要です）。一覧にはマウスなど他の Bluetooth 機器も表示されることがあります。';
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const prefs = (() => {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('kv-prefs') || '{}'); } catch (e) {}
  return {
    get: (k, d) => (k in p ? p[k] : d),
    set: (k, v) => { p[k] = v; try { localStorage.setItem('kv-prefs', JSON.stringify(p)); } catch (e) {} },
  };
})();

const state = {
  list: [],
  current: null,   // record
  view: null,
  layer: 0,
  allLayers: prefs.get('allLayers', false),
  jis: prefs.get('jis', false),
  layoutChoices: null,
  zmkLayout: null,
  selectedKey: -1,
  busy: false,
  abort: null,
};

// ---------------- status ----------------
function setStatus(msg, kind = 'info', { cancellable = false } = {}) {
  const el = $('#status');
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'status ' + kind;
  $('#status-text').textContent = msg;
  $('#status-cancel').hidden = !cancellable;
  $('#status-close').hidden = kind === 'busy';
}

// ---------------- list ----------------
async function refreshList() {
  state.list = await listKeyboards();
  const ul = $('#kb-list');
  ul.innerHTML = state.list.map((r) => `
    <li><button class="kb-item${state.current && state.current.id === r.id ? ' active' : ''}" data-id="${esc(r.id)}">
      <span class="badge ${r.type}">${r.type === 'vial' ? 'Vial' : 'ZMK'}</span>
      <span class="kb-name">${esc(r.customName || r.name)}</span>
      <span class="kb-date">${new Date(r.readAt).toLocaleDateString('ja-JP')}</span>
    </button></li>`).join('');
  $('#list-empty').hidden = state.list.length > 0;
  $('#export-all').disabled = state.list.length === 0;
  const sel = $('#kb-select');
  sel.innerHTML = state.list.map((r) => `<option value="${esc(r.id)}">${esc(r.customName || r.name)}（${r.type === 'vial' ? 'Vial' : 'ZMK'}）</option>`).join('');
  if (state.current) sel.value = state.current.id;
}

async function openKeyboard(id, { keepLayer = false } = {}) {
  const rec = await getKeyboard(id);
  if (!rec) return;
  state.current = rec;
  if (!keepLayer) { state.layer = 0; state.layoutChoices = null; state.zmkLayout = null; state.selectedKey = -1; }
  prefs.set('last', id);
  rebuild();
  await refreshList();
}

// ---------------- viewer ----------------
function rebuild() {
  const rec = state.current;
  const viewer = $('#viewer');
  if (!rec) { viewer.hidden = true; $('#welcome').hidden = false; return; }
  $('#welcome').hidden = true;
  viewer.hidden = false;
  try {
    state.view = buildView(rec, { jis: state.jis, layoutChoices: state.layoutChoices, zmkLayout: state.zmkLayout });
  } catch (e) {
    console.error(e);
    $('#kb-area').innerHTML = `<p class="error">表示できませんでした: ${esc(e.message)}</p>`;
    return;
  }
  if (state.layer >= state.view.layers.length) state.layer = 0;
  $('#kb-title').textContent = rec.customName || rec.name;
  $('#kb-sub').textContent = [rec.customName && rec.customName !== rec.name ? rec.name : null, '読み取り: ' + new Date(rec.readAt).toLocaleString('ja-JP')].filter(Boolean).join(' · ');
  $('#kb-meta').innerHTML = state.view.meta.map((m) => `<span class="chip">${esc(m)}</span>`).join('');

  // layout options
  const opt = $('#layout-opts');
  const parts = [];
  if (state.view.layoutChoices) {
    const { choices, selected } = state.view.layoutChoices;
    choices.forEach((c, i) => {
      parts.push(`<label class="lo"><span>${esc(c.title)}</span><select data-lo="${i}">${c.options.map((o, j) => `<option value="${j}"${selected[i] === j ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`);
    });
  }
  if (state.view.zmkLayouts) {
    const { names, selected } = state.view.zmkLayouts;
    parts.push(`<label class="lo"><span>物理レイアウト</span><select data-zl="1">${names.map((n, j) => `<option value="${j}"${selected === j ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>`);
  }
  opt.innerHTML = parts.join('');
  opt.hidden = parts.length === 0;

  $('#toggle-all').setAttribute('aria-pressed', String(state.allLayers));
  $('#toggle-jis').setAttribute('aria-pressed', String(state.jis));
  $('#toggle-jis').textContent = state.jis ? 'JIS 表記' : 'US 表記';
  renderLayers();
}

function renderLayers() {
  const v = state.view;
  const tabs = $('#layer-tabs');
  tabs.hidden = state.allLayers;
  tabs.innerHTML = v.layers.map((l, i) => `<button role="tab" class="tab" aria-selected="${i === state.layer}" data-layer="${i}"><span class="tab-n">${i}</span>${esc(l.name)}</button>`).join('');
  const area = $('#kb-area');
  if (state.allLayers) {
    area.innerHTML = v.layers.map((l, i) => `<section class="layer-block"><h3><span class="tab-n">${i}</span>${esc(l.name)}</h3>${renderKeyboard(v, i, { idPrefix: `l${i}k` })}</section>`).join('');
  } else {
    area.innerHTML = renderKeyboard(v, state.layer, { selectedKey: state.selectedKey });
  }
  showDetail();
}

function showDetail() {
  const el = $('#key-detail');
  const v = state.view;
  if (state.allLayers || state.selectedKey < 0 || !v) { el.innerHTML = '<span class="hint">キーをタップすると詳細を表示します。数字キーでレイヤーを切り替えられます。</span>'; return; }
  const lg = v.layers[state.layer].legends[state.selectedKey];
  if (!lg) { el.innerHTML = ''; return; }
  const jump = lg.targetLayer != null && lg.targetLayer !== state.layer && v.layers[lg.targetLayer]
    ? ` <button class="link" data-goto="${lg.targetLayer}">→ ${esc(v.layers[lg.targetLayer].name)} を表示</button>` : '';
  el.innerHTML = `<code>${esc(lg.title)}</code>${jump}`;
}

// ---------------- reading ----------------
async function doRead(kind) {
  if (state.busy) return;
  state.busy = true;
  state.abort = new AbortController();
  document.body.classList.add('busy');
  try {
    setStatus('デバイスを選択してください…', 'busy');
    let rec;
    const progress = (m, o = {}) => setStatus(m, o.locked ? 'warn' : 'busy', { cancellable: !!o.locked });
    if (kind === 'vial') rec = await readVial(progress);
    else rec = await readZmk(kind === 'zmk-ble' ? 'ble' : 'serial', progress, state.abort.signal);
    const prev = await getKeyboard(rec.id);
    if (prev && prev.customName) rec.customName = prev.customName;
    await putKeyboard(rec);
    requestPersistence();
    setStatus(`「${rec.customName || rec.name}」を読み取り、保存しました。オフラインでも表示できます。`, 'ok');
    await openKeyboard(rec.id);
  } catch (e) {
    console.error(e);
    if (kind === 'zmk-ble' && e.cancelled) setStatus(BLE_NOTE, 'warn');
    else if (e.cancelled || e.name === 'NotFoundError' || e.name === 'AbortError') setStatus(null);
    else setStatus('読み取りに失敗しました: ' + e.message, 'error');
  } finally {
    state.busy = false;
    state.abort = null;
    document.body.classList.remove('busy');
  }
}

// ---------------- import / export ----------------
function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const fileSafe = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '_');
const exportObj = (recs) => ({ format: 'keymap-viewer', version: 1, exportedAt: new Date().toISOString(), keyboards: recs });

async function importFile(file) {
  try {
    const data = JSON.parse(await file.text());
    const recs = Array.isArray(data) ? data : data.keyboards || (data.id ? [data] : []);
    let n = 0;
    for (const r of recs) {
      if (!r || !r.id || !(r.type === 'vial' ? r.vial : r.zmk)) continue;
      await putKeyboard(r);
      n++;
    }
    if (!n) throw new Error('キーボードのデータが見つかりません');
    setStatus(`${n} 件のキーボードをインポートしました。`, 'ok');
    await refreshList();
    if (!state.current) openKeyboard(recs[0].id);
    else if (recs.some((r) => r.id === state.current.id)) openKeyboard(state.current.id, { keepLayer: true });
  } catch (e) {
    setStatus('インポートに失敗しました: ' + e.message, 'error');
  }
}

// ---------------- QR share / receive ----------------
const share = { timer: null, frames: [], i: 0, paused: false };
const dots = (el, n, on = () => false, cur = -1) => {
  el.innerHTML = n > 1 ? Array.from({ length: n }, (_, i) => `<i class="${on(i) ? 'on' : ''}${i === cur ? ' cur' : ''}"></i>`).join('') : '';
};
function shareShow() {
  const n = share.frames.length;
  const size = Math.min(460, window.innerWidth - 80, window.innerHeight - 330);
  drawQr($('#share-canvas'), share.frames[share.i], Math.max(220, size));
  $('#share-count').textContent = n > 1 ? `${share.i + 1} / ${n} 枚目` : '1 枚';
  dots($('#share-dots'), n, () => false, share.i);
}
function shareTick() {
  clearTimeout(share.timer);
  if (share.frames.length < 2 || share.paused) return;
  share.timer = setTimeout(() => { share.i = (share.i + 1) % share.frames.length; shareShow(); shareTick(); }, +$('#share-speed').value);
}
async function openShare() {
  const r = state.current; if (!r) return;
  if (!shareSupported()) { setStatus('このブラウザは圧縮機能（CompressionStream）に対応していないため、QR を作れません。', 'error'); return; }
  const { frames, bytes } = await buildFrames(r);
  Object.assign(share, { frames, i: 0, paused: false });
  $('#share-desc').textContent = `「${r.customName || r.name}」のキーマップ（圧縮後 ${(bytes / 1024).toFixed(1)} KB）` +
    (frames.length > 1 ? `を ${frames.length} 枚の QR に分けて順番に表示しています。` : 'を QR にしました。');
  $('#share-pause').hidden = frames.length < 2;
  $('#share-pause').textContent = '一時停止';
  $('#share-speed').closest('label').hidden = frames.length < 2;
  $('#share-dlg').showModal();
  shareShow();
  shareTick();
}

let scanner = null;
async function openScan() {
  const dlg = $('#scan-dlg'), msg = $('#scan-msg');
  const setMsg = (t, k = '') => { msg.textContent = t; msg.className = 'small ' + k; };
  if (!scanSupported()) {
    setStatus(location.protocol === 'https:' || location.hostname === 'localhost'
      ? 'このブラウザはカメラ（または展開機能）に対応していません。'
      : 'カメラを使うには HTTPS で開く必要があります。', 'error');
    return;
  }
  const col = new FrameCollector();
  let done = false;
  dots($('#scan-dots'), 0);
  setMsg('パソコンに表示した QR コードにカメラを向けてください。');
  dlg.showModal();
  scanner = new QrScanner($('#scan-video'), async (text) => {
    if (done) return;
    const res = col.add(text);
    if (res === 'ignored') { setMsg('Keymap Viewer の QR コードではありません。', 'error'); return; }
    if (res === 'new') {
      dots($('#scan-dots'), col.total, (i) => col.parts[i] != null);
      setMsg(col.total > 1 ? `受信中… ${col.received} / ${col.total}` : '受信しました');
      if (navigator.vibrate) navigator.vibrate(15);
    }
    if (!col.complete) return;
    done = true;
    try {
      const rec = await col.decode();
      const prev = await getKeyboard(rec.id);
      if (!rec.customName && prev && prev.customName) rec.customName = prev.customName;
      await putKeyboard(rec);
      requestPersistence();
      setMsg('保存しました', 'ok');
      closeScan();
      dlg.close();
      setStatus(`「${rec.customName || rec.name}」を QR から受け取り、保存しました。`, 'ok');
      await openKeyboard(rec.id);
    } catch (e) {
      console.error(e);
      setMsg(e.message, 'error');
      col.reset(); done = false;
    }
  });
  try { await scanner.start(); }
  catch (e) {
    closeScan();
    setMsg(e.name === 'NotAllowedError' ? 'カメラの使用が許可されませんでした。ブラウザの設定でカメラを許可してください。' : 'カメラを起動できませんでした: ' + e.message, 'error');
  }
}
function closeScan() { if (scanner) { scanner.stop(); scanner = null; } }

// ---------------- events ----------------
function bind() {
  $('#read-vial').addEventListener('click', () => doRead('vial'));
  $('#read-zmk-usb').addEventListener('click', () => doRead('zmk-usb'));
  $('#read-zmk-ble').addEventListener('click', () => doRead('zmk-ble'));
  $('#status-cancel').addEventListener('click', () => state.abort && state.abort.abort());
  $('#status-close').addEventListener('click', () => setStatus(null));

  $('#kb-list').addEventListener('click', (e) => {
    const b = e.target.closest('.kb-item');
    if (b) openKeyboard(b.dataset.id);
  });
  $('#kb-select').addEventListener('change', (e) => openKeyboard(e.target.value));

  $('#layer-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-layer]');
    if (b) { state.layer = +b.dataset.layer; renderLayers(); }
  });
  $('#kb-area').addEventListener('click', (e) => {
    const g = e.target.closest('.key');
    if (!g || state.allLayers) return;
    const i = +g.dataset.i;
    state.selectedKey = state.selectedKey === i ? -1 : i;
    renderLayers();
  });
  $('#key-detail').addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]');
    if (b) { state.layer = +b.dataset.goto; renderLayers(); }
  });
  $('#layout-opts').addEventListener('change', (e) => {
    const s = e.target;
    if (s.dataset.lo != null) {
      state.layoutChoices = [...state.view.layoutChoices.selected];
      state.layoutChoices[+s.dataset.lo] = +s.value;
    } else if (s.dataset.zl) state.zmkLayout = +s.value;
    state.selectedKey = -1;
    rebuild();
  });
  $('#toggle-all').addEventListener('click', () => { state.allLayers = !state.allLayers; prefs.set('allLayers', state.allLayers); rebuild(); });
  $('#toggle-jis').addEventListener('click', () => { state.jis = !state.jis; prefs.set('jis', state.jis); rebuild(); });

  $('#rename').addEventListener('click', async () => {
    const r = state.current; if (!r) return;
    const n = prompt('表示名（空欄で元の名前に戻します）', r.customName || r.name);
    if (n === null) return;
    r.customName = n.trim() || undefined;
    await putKeyboard(r);
    rebuild(); refreshList();
  });
  $('#delete').addEventListener('click', async () => {
    const r = state.current; if (!r) return;
    if (!confirm(`「${r.customName || r.name}」を削除しますか？`)) return;
    await deleteKeyboard(r.id);
    state.current = null;
    await refreshList();
    if (state.list[0]) openKeyboard(state.list[0].id); else rebuild();
  });
  $('#export-one').addEventListener('click', () => {
    const r = state.current; if (r) download(`keymap-${fileSafe(r.customName || r.name)}.json`, exportObj([r]));
  });
  $('#export-all').addEventListener('click', async () => download(`keymaps-${new Date().toISOString().slice(0, 10)}.json`, exportObj(await listKeyboards())));
  $('#import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ''; });
  $('#print').addEventListener('click', () => window.print());

  $('#share-qr').addEventListener('click', openShare);
  $('#scan-qr').addEventListener('click', openScan);
  $('#share-pause').addEventListener('click', () => {
    share.paused = !share.paused;
    $('#share-pause').textContent = share.paused ? '再開' : '一時停止';
    shareTick();
  });
  $('#share-speed').addEventListener('change', shareTick);
  $('#share-dlg').addEventListener('close', () => clearTimeout(share.timer));
  $('#scan-dlg').addEventListener('close', closeScan);
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());

  document.addEventListener('keydown', (e) => {
    if (!state.view || state.allLayers || e.target.closest('input,select,textarea') || document.querySelector('dialog[open]')) return;
    if (/^[0-9]$/.test(e.key) && state.view.layers[+e.key]) { state.layer = +e.key; renderLayers(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const n = state.view.layers.length;
      state.layer = (state.layer + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
      renderLayers();
    } else if (e.key === 'Escape') { state.selectedKey = -1; renderLayers(); }
  });

  // print always shows every layer
  addEventListener('beforeprint', () => {
    if (!state.view || state.allLayers) return;
    state._printRestore = true; state.allLayers = true; renderLayers();
  });
  addEventListener('afterprint', () => {
    if (state._printRestore) { state._printRestore = false; state.allLayers = false; renderLayers(); }
  });

  // drag & drop import
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) importFile(f); });

  // capability hints
  const caps = [
    ['#read-vial', vialSupported(), 'WebHID'],
    ['#read-zmk-usb', zmkSerialSupported(), 'Web Serial'],
    ['#read-zmk-ble', zmkBleSupported(), 'Web Bluetooth'],
  ];
  const missing = [];
  for (const [sel, ok, api] of caps) { $(sel).disabled = !ok; if (!ok) missing.push(api); }
  const notes = [];
  if (missing.length) notes.push(`このブラウザは ${missing.join(' / ')} に対応していないため、一部の読み取りは使えません（デスクトップ版 Chrome / Edge 推奨）。保存済みキーマップの表示とインポートは利用できます。`);
  if (notes.length) {
    $('#cap-note').hidden = false;
    $('#cap-note').textContent = notes.join(' ');
  }

  // online indicator
  const net = () => { $('#net').textContent = navigator.onLine ? 'オンライン' : 'オフライン'; $('#net').className = 'net ' + (navigator.onLine ? 'on' : 'off'); };
  addEventListener('online', net); addEventListener('offline', net); net();

  // install prompt
  let deferred = null;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#install').hidden = false; });
  $('#install').addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#install').hidden = true; });
  addEventListener('appinstalled', () => { $('#install').hidden = true; });

  // iOS has no install prompt: show a button that explains "Add to Home Screen"
  if (IS_IOS && !IS_STANDALONE) {
    const safari = !/CriOS|FxiOS|EdgiOS|OPiOS|Bluefy/.test(navigator.userAgent);
    $('#ios-browser-note').textContent = safari ? '' : 'Safari 以外のブラウザでは、共有ボタンの位置が異なる場合があります。うまくいかない場合は Safari で開いてください。';
    $('#ios-install').hidden = false;
    $('#ios-install').addEventListener('click', () => $('#ios-dlg').showModal());
    let seen = false;
    try { seen = localStorage.getItem('kv-ios-hint') === '1'; } catch (e) {}
    if (!seen) $('#ios-banner').hidden = false;
    $('#ios-banner-open').addEventListener('click', () => $('#ios-dlg').showModal());
    $('#ios-banner-close').addEventListener('click', () => {
      $('#ios-banner').hidden = true;
      try { localStorage.setItem('kv-ios-hint', '1'); } catch (e) {}
    });
  }
}

async function init() {
  bind();
  await refreshList();
  const last = prefs.get('last', null);
  const pick = state.list.find((r) => r.id === last) || state.list[0];
  if (pick) await openKeyboard(pick.id);
  else rebuild();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e));
  }
}
init();

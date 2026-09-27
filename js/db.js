// IndexedDB storage for keyboard records
const DB_NAME = 'keymap-viewer';
const STORE = 'keyboards';

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const r = fn(s);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
export const listKeyboards = () => tx('readonly', (s) => s.getAll()).then((a) => a.sort((x, y) => (y.readAt || 0) - (x.readAt || 0)));
export const getKeyboard = (id) => tx('readonly', (s) => s.get(id));
export const putKeyboard = (rec) => tx('readwrite', (s) => s.put(rec));
export const deleteKeyboard = (id) => tx('readwrite', (s) => s.delete(id));

export async function requestPersistence() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
}

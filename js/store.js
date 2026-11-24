/* 로컬 캐시 (IndexedDB) — 오프라인에서도 타임라인·검색이 동작하도록 */
const DB_NAME = "hemory";
const DB_VER = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("records")) db.createObjectStore("records", { keyPath: "id" });
      if (!db.objectStoreNames.contains("pending")) db.createObjectStore("pending", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "k" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let _db = null;
async function db() { if (!_db) _db = await openDB(); return _db; }

function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out?.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const store = {
  async allRecords() { return (await tx("records", "readonly", (s) => s.getAll())) || []; },

  async putRecords(recs) {
    if (!recs?.length) return;
    await tx("records", "readwrite", (s) => { recs.forEach((r) => s.put(r)); });
  },

  async deleteRecords(ids) {
    if (!ids?.length) return;
    await tx("records", "readwrite", (s) => { ids.forEach((id) => s.delete(id)); });
  },

  async replaceAll(recs) {
    await tx("records", "readwrite", (s) => { s.clear(); recs.forEach((r) => s.put(r)); });
  },

  async clearAll() {
    await tx("records", "readwrite", (s) => { s.clear(); });
    await tx("pending", "readwrite", (s) => { s.clear(); });
  },

  async getKV(k, d = null) {
    const row = await tx("kv", "readonly", (s) => s.get(k));
    return row ? row.v : d;
  },
  async setKV(k, v) { await tx("kv", "readwrite", (s) => s.put({ k, v })); },

  /* 업로드 대기 (오프라인) */
  async pendingAll() { return (await tx("pending", "readonly", (s) => s.getAll())) || []; },
  async pendingPut(item) { await tx("pending", "readwrite", (s) => s.put(item)); },
  async pendingDel(id) { await tx("pending", "readwrite", (s) => s.delete(id)); },
};

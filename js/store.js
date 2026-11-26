/* 로컬 캐시 (IndexedDB) — 오프라인에서도 타임라인·검색이 동작하도록
   v2: 녹음 중 청크를 적립하는 parts 저장소 추가(앱이 꺼져도 녹음을 살릴 수 있게) */
const DB_NAME = "hemory";
const DB_VER = 2;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("records")) db.createObjectStore("records", { keyPath: "id" });
      if (!db.objectStoreNames.contains("pending")) db.createObjectStore("pending", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "k" });
      if (!db.objectStoreNames.contains("parts")) db.createObjectStore("parts", { keyPath: "id" });
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
    await tx("parts", "readwrite", (s) => { s.clear(); });
  },

  async getKV(k, d = null) {
    const row = await tx("kv", "readonly", (s) => s.get(k));
    return row ? row.v : d;
  },
  async setKV(k, v) { await tx("kv", "readwrite", (s) => s.put({ k, v })); },
  async delKV(k) { await tx("kv", "readwrite", (s) => s.delete(k)); },

  /* 업로드 대기 (오프라인) */
  async pendingAll() { return (await tx("pending", "readonly", (s) => s.getAll())) || []; },
  async pendingCount() { return Number(await tx("pending", "readonly", (s) => s.count())) || 0; },
  async pendingPut(item) { await tx("pending", "readwrite", (s) => s.put(item)); },
  async pendingDel(id) { await tx("pending", "readwrite", (s) => s.delete(id)); },
  async pendingDelBase(base) {
    if (!base) return;
    const all = await this.pendingAll();
    for (const it of all) if (String(it.id || "").startsWith(base)) await this.pendingDel(it.id);
  },

  /* 녹음 중 청크 적립 — 한 덩어리씩 append 만 한다(전체 재기록 없음) */
  async partPut(id, blob, extra = {}) {
    if (!blob || !blob.size) return;
    await tx("parts", "readwrite", (s) => s.put({ id, blob, at: Date.now(), ...extra }));
  },
  async partAll(session = "current") {
    const rows = (await tx("parts", "readonly", (s) => s.getAll())) || [];
    return rows.filter((r) => String(r.id).startsWith(session + ":")).sort((a, b) => (a.at || 0) - (b.at || 0));
  },
  async partClear(session = "current") {
    const rows = await this.partAll(session);
    if (!rows.length) return;
    await tx("parts", "readwrite", (s) => { rows.forEach((r) => s.delete(r.id)); });
  },
  async partCount(session = "current") {
    return (await this.partAll(session)).length;
  },
  /* 모든 적립 그룹(세션) — 앱이 끊겨도 어느 녹음인지 구분하기 위해 */
  async partGroups() {
    const rows = (await tx("parts", "readonly", (s) => s.getAll())) || [];
    const map = new Map();
    for (const r of rows) {
      const key = String(r.id).split(":")[0];
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    }
    const out = [];
    for (const [key, list] of map) {
      list.sort((a, b) => (a.at || 0) - (b.at || 0));
      out.push({ key, parts: list, bytes: list.reduce((a, p) => a + (p.blob?.size || 0), 0), at: list[0]?.at || 0 });
    }
    return out.sort((a, b) => b.at - a.at);
  },
  async partClearGroup(key) {
    const rows = (await this.partGroups()).find((g) => g.key === key);
    if (!rows) return;
    await tx("parts", "readwrite", (s) => { rows.parts.forEach((r) => s.delete(r.id)); });
  },

  /* 진행 중이던 녹음 세션 메타 */
  async sessionGet() { return await this.getKV("recsession", null); },
  async sessionSet(v) { await this.setKV("recsession", v); },
  async sessionDel() { await this.delKV("recsession"); },
};

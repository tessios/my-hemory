/* Google Drive 연동 — OAuth 토큰, 폴더 탐색, 업로드, 오디오 스트리밍 */
import { CONFIG } from "./config.js";
import { localSettings, saveSettings, sleep } from "./util.js";

const TOKEN_KEY = "hemory.token";
const FOLDER_KEY = "hemory.folders";

export class AuthError extends Error {
  constructor(msg, code) { super(msg); this.code = code || "auth"; }
}

export const drive = {
  token: null,
  expiresAt: 0,
  clientId: "",
  _inflight: null,

  init() {
    const s = localSettings();
    this.clientId = (s.clientId || CONFIG.clientId || "").trim();
    try {
      const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
      if (t && t.access_token && t.expiresAt > Date.now() + 60000) {
        this.token = t.access_token;
        this.expiresAt = t.expiresAt;
      }
    } catch {}
    return this;
  },

  get configured() { return !!this.clientId; },
  get signedIn() { return !!this.token; },

  setClientId(id) {
    this.clientId = (id || "").trim();
    saveSettings({ clientId: this.clientId });
  },

  _store(resp) {
    if (!resp?.access_token) return;
    this.token = resp.access_token;
    const ttl = (Number(resp.expires_in) || 3500) * 1000;
    this.expiresAt = Date.now() + ttl - 60000;
    try {
      localStorage.setItem(TOKEN_KEY, JSON.stringify({ access_token: this.token, expiresAt: this.expiresAt }));
    } catch {}
  },

  signOut() {
    const t = this.token;
    this.token = null; this.expiresAt = 0;
    localStorage.removeItem(TOKEN_KEY);
    try { if (t && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t, () => {}); } catch {}
  },

  async _waitGoogle(ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (window.google?.accounts?.oauth2) return true;
      await sleep(120);
    }
    return false;
  },

  /* 토큰 요청: 팝업 → 실패 시 리다이렉트 */
  async signIn({ interactive = true } = {}) {
    if (!this.clientId) throw new AuthError("Client ID가 설정되지 않았습니다.", "no_client");
    const ok = await this._waitGoogle(interactive ? 10000 : 2000);
    if (!ok) {
      if (interactive) return this.redirectSignIn();
      throw new AuthError("Google 인증 스크립트를 불러오지 못했습니다.", "no_gis");
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      let client;
      try {
        client = google.accounts.oauth2.initTokenClient({
          client_id: this.clientId,
          scope: CONFIG.scopes,
          prompt: interactive ? "" : "none",
          callback: (resp) => {
            if (resp.error) return finish(reject, new AuthError(resp.error_description || resp.error, resp.error));
            this._store(resp);
            finish(resolve, resp);
          },
          error_callback: (err) => {
            if (interactive) { finish(resolve, this.redirectSignIn()); }
            else finish(reject, new AuthError(err?.message || "silent_failed", err?.type));
          },
        });
      } catch (e) {
        return interactive ? finish(resolve, this.redirectSignIn()) : finish(reject, e);
      }
      try {
        client.requestAccessToken({ prompt: interactive ? "" : "none" });
      } catch (e) {
        if (interactive) finish(resolve, this.redirectSignIn());
        else finish(reject, e);
      }
    });
  },

  redirectSignIn() {
    const state = Math.random().toString(36).slice(2);
    sessionStorage.setItem("hemory.oauth_state", state);
    const redirect = location.origin + location.pathname;
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", this.clientId);
    u.searchParams.set("redirect_uri", redirect);
    u.searchParams.set("response_type", "token");
    u.searchParams.set("scope", CONFIG.scopes);
    u.searchParams.set("include_granted_scopes", "true");
    u.searchParams.set("state", state);
    u.searchParams.set("prompt", "select_account");
    location.assign(u.toString());
    return new Promise(() => {});
  },

  /* 리다이렉트 복귀 처리 */
  consumeRedirect() {
    const h = location.hash || "";
    if (!h.includes("access_token") && !h.includes("error")) return false;
    const p = new URLSearchParams(h.slice(1));
    const state = p.get("state");
    const expect = sessionStorage.getItem("hemory.oauth_state");
    sessionStorage.removeItem("hemory.oauth_state");
    history.replaceState(null, "", location.pathname + location.search);
    if (p.get("error")) return false;
    if (state && expect && state !== expect) return false;
    const ttl = (Number(p.get("expires_in")) || 3500) * 1000;
    this.token = p.get("access_token");
    this.expiresAt = Date.now() + ttl - 60000;
    try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ access_token: this.token, expiresAt: this.expiresAt })); } catch {}
    return true;
  },

  async ensureToken() {
    if (this.token && this.expiresAt > Date.now()) return this.token;
    if (!this.clientId) throw new AuthError("Client ID가 설정되지 않았습니다.", "no_client");
    if (!this._inflight) {
      this._inflight = this.signIn({ interactive: false }).finally(() => { this._inflight = null; });
    }
    await this._inflight;
    if (!this.token) throw new AuthError("세션이 만료되었습니다. 다시 연결해 주세요.", "expired");
    return this.token;
  },

  async req(path, { method = "GET", body, headers = {}, retry = true } = {}) {
    const token = await this.ensureToken();
    const res = await fetch(CONFIG.driveApi + path, {
      method,
      headers: { Authorization: "Bearer " + token, ...headers },
      body,
    });
    if (res.status === 401 && retry) {
      this.token = null;
      return this.req(path, { method, body, headers, retry: false });
    }
    if (!res.ok) {
      let msg = `Drive ${res.status}`;
      try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
      throw new Error(msg);
    }
    return res.json();
  },

  /* ── 폴더 ─────────────────────────────── */
  async _findFolder(name, parentId = "root") {
    const q = `name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`;
    const j = await this.req(`/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=5`);
    return j.files?.[0] || null;
  },

  async _mkdir(name, parentId = "root") {
    return this.req(`/files?fields=id,name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
    });
  },

  async ensureRoot() {
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem(FOLDER_KEY) || "{}"); } catch {}
    if (cache.root) {
      try { await this.req(`/files/${cache.root}?fields=id,trashed`); return cache.root; } catch {}
    }
    let f = await this._findFolder(CONFIG.rootFolder);
    if (!f) f = await this._mkdir(CONFIG.rootFolder);
    cache.root = f.id;
    localStorage.setItem(FOLDER_KEY, JSON.stringify(cache));
    return f.id;
  },

  async ensureFolder(name, parentId) {
    const key = parentId + ":" + name;
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem(FOLDER_KEY) || "{}"); } catch {}
    if (cache[key]) return cache[key];
    let f = await this._findFolder(name, parentId);
    if (!f) f = await this._mkdir(name, parentId);
    cache[key] = f.id;
    localStorage.setItem(FOLDER_KEY, JSON.stringify(cache));
    return f.id;
  },

  async monthFolder(date = new Date()) {
    const root = await this.ensureRoot();
    const name = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    return this.ensureFolder(name, root);
  },

  async inbox() {
    const root = await this.ensureRoot();
    return this.ensureFolder(CONFIG.inboxFolder, root);
  },

  async children(folderId, { pageToken, orderBy = "name" } = {}) {
    const q = `'${folderId}' in parents and trashed = false`;
    const fields = "nextPageToken,files(id,name,mimeType,size,modifiedTime,createdTime,parents)";
    let url = `/files?q=${encodeURIComponent(q)}&fields=${fields}&pageSize=1000&orderBy=${encodeURIComponent(orderBy)}`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    return this.req(url);
  },

  /* 루트 아래 전체 파일 목록 (월 폴더 + _inbox) */
  async listTree() {
    const root = await this.ensureRoot();
    const top = await this.children(root);
    const folders = (top.files || []).filter((f) => f.mimeType === "application/vnd.google-apps.folder");
    const files = [];
    for (const f of folders) {
      if (f.name === CONFIG.trashFolder) continue;
      let pageToken = null;
      do {
        const j = await this.children(f.id, { pageToken });
        for (const c of j.files || []) {
          if (c.mimeType === "application/vnd.google-apps.folder") continue;
          files.push({ ...c, folderId: f.id, folderName: f.name });
        }
        pageToken = j.nextPageToken;
      } while (pageToken);
    }
    return { root, files, folders };
  },

  async getText(fileId) {
    const token = await this.ensureToken();
    const res = await fetch(`${CONFIG.driveApi}/files/${fileId}?alt=media`, {
      headers: { Authorization: "Bearer " + token },
    });
    if (!res.ok) throw new Error("파일을 읽지 못했습니다 (" + res.status + ")");
    return res.text();
  },

  audioUrl(fileId) {
    return `${CONFIG.driveApi}/files/${fileId}?alt=media&access_token=${encodeURIComponent(this.token || "")}`;
  },

  /* ── 업로드(재개형, 진행률) ─────────────────── */
  async upload(blob, name, parentId, { mimeType, onProgress } = {}) {
    const token = await this.ensureToken();
    const meta = { name, parents: [parentId] };
    const init = await fetch(`${CONFIG.uploadApi}/files?uploadType=resumable&fields=id,name,size`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType || blob.type || "application/octet-stream",
        "X-Upload-Content-Length": String(blob.size),
      },
      body: JSON.stringify(meta),
    });
    if (!init.ok) throw new Error("업로드 시작 실패 (" + init.status + ")");
    const loc = init.headers.get("Location");
    if (!loc) throw new Error("업로드 주소를 받지 못했습니다.");
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", loc);
      xhr.setRequestHeader("Content-Type", mimeType || blob.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); }
        } else reject(new Error("업로드 실패 (" + xhr.status + ")"));
      };
      xhr.onerror = () => reject(new Error("네트워크 오류로 업로드하지 못했습니다."));
      xhr.send(blob);
    });
  },

  async trash(fileId) {
    return this.req(`/files/${fileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
  },
};

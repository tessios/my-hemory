/* Google Drive 연동 — OAuth 토큰, 폴더 탐색, 업로드, 오디오 스트리밍

   로그인 유지 방식 (v1.3.2)
   ──────────────────────────────────────────────────────────────
   · Google 액세스 토큰은 수명이 1시간이다. 예전에는 이 토큰만 믿어서
     1시간이 지나거나 앱을 다시 열면 곧바로 로그인 화면으로 돌아갔다.
   · 이제는 "로그인한 사람"을 토큰과 따로 저장한다(hemory.session).
     토큰이 만료돼도 첫 화면으로 돌아가지 않고 바로 타임라인으로 들어간다.
   · 토큰이 필요할 때는 조용히 다시 받는다.
     ① 데스크톱: 팝업 무음 갱신(prompt=none)
     ② 아이폰 홈 화면 앱: 팝업이 돌아오지 못하므로 앱을 Google로 잠깐
        넘겼다가(prompt=none) 토큰을 받아 곧바로 돌아온다. 구글에 로그인된
        상태면 계정 선택 화면 없이 자동으로 끝난다.
     ③ 그래도 안 되면(구글 세션 자체가 끊긴 경우 등) 화면 맨 아래에
        '다시 연결' 막대를 띄우고, 앱은 캐시된 기록으로 계속 쓸 수 있게 둔다.
   · 자동 리다이렉트는 앱을 연 직후 20초 안, 녹음 중이 아닐 때만 한다.
     (녹음 중에 화면을 넘기면 녹음이 끊기기 때문) */
import { CONFIG } from "./config.js";
import { localSettings, saveSettings, sleep } from "./util.js";

const TOKEN_KEY = "hemory.token";      // { access_token, expiresAt } — 1시간짜리 액세스 토큰
const SESSION_KEY = "hemory.session";  // { email, name, since } — 로그인한 사람 (토큰 만료와 무관)
const AUTH_KEY = "hemory.auth";        // { needsReconnect, lastError, lastSilentAt, blockUntil }
const FOLDER_KEY = "hemory.folders";

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1);

const SILENT_COOLDOWN = 5 * 60 * 1000;    // 자동 리다이렉트 최소 간격
const BLOCK_AFTER_FAIL = 30 * 60 * 1000;  // 실패 후 자동 시도 중단 시간
const NAV_WINDOW = 20 * 1000;             // 앱을 연 직후에만 자동 리다이렉트

function readJSON(key, fallback = null) {
  try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v ?? fallback; }
  catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function removeKey(key) { try { localStorage.removeItem(key); } catch {} }

export class AuthError extends Error {
  constructor(msg, code) { super(msg); this.code = code || "auth"; }
}

export const drive = {
  token: null,
  expiresAt: 0,
  clientId: "",
  email: "",
  name: "",
  since: 0,
  needsReconnect: false,

  _inflight: null,
  _navDeadline: 0,   // 이 시각까지만 자동 리다이렉트 허용
  _lastFailAt: 0,

  /* 앱이 지정: 지금 화면을 Google로 넘겨도 안전한가 (녹음 중·시트 열림이면 false) */
  canNavigate: () => false,

  init() {
    const s = localSettings();
    this.clientId = (s.clientId || CONFIG.clientId || "").trim();
    this._inflight = null;
    this._lastFailAt = 0;
    this.token = null;
    this.expiresAt = 0;
    this.email = "";
    this.name = "";
    this.since = 0;

    const t = readJSON(TOKEN_KEY);
    if (t && t.access_token) {
      this.token = t.access_token;
      this.expiresAt = Number(t.expiresAt) || 0;
    }

    const sess = readJSON(SESSION_KEY);
    if (sess) {
      this.email = sess.email || "";
      this.name = sess.name || "";
      this.since = Number(sess.since) || 0;
    } else if (t && t.access_token) {
      // v1.3.1 이하에서 로그인해 둔 사용자: 토큰 기록은 남아 있으니 세션으로 승격한다.
      // (앱에서 '연결 해제'를 한 경우에는 토큰 기록도 지워지므로 여기 걸리지 않는다)
      let legacy = "";
      try { legacy = localStorage.getItem("hemory.email") || ""; } catch {}
      if (legacy) {
        this.email = legacy;
        this.since = Date.now();
        this._remember();
      }
    }

    const auth = readJSON(AUTH_KEY, {});
    this.needsReconnect = !!auth.needsReconnect;
    this._navDeadline = Date.now() + NAV_WINDOW;
    return this;
  },

  get configured() { return !!this.clientId; },
  get signedIn() { return !!this.token; },
  /* 로그인한 적이 있는가 — 토큰이 만료돼도 true */
  get hasSession() { return !!(this.token || this.email || this.since); },
  get tokenValid() { return !!this.token && this.expiresAt > Date.now() + 60000; },
  get tokenLeftMs() { return this.token ? Math.max(0, this.expiresAt - Date.now()) : 0; },
  get standalone() {
    try { return navigator.standalone === true || matchMedia("(display-mode: standalone)").matches; }
    catch { return false; }
  },

  setClientId(id) {
    this.clientId = (id || "").trim();
    saveSettings({ clientId: this.clientId });
  },

  /* ── 저장 ─────────────────────────────── */
  _store(resp) {
    if (!resp || !resp.access_token) return;
    this.token = resp.access_token;
    const ttl = (Number(resp.expires_in) || 3500) * 1000;
    this.expiresAt = Date.now() + ttl - 60000;
    writeJSON(TOKEN_KEY, { access_token: this.token, expiresAt: this.expiresAt });
    this._remember();
    this._mark({ needsReconnect: false, lastError: "", blockUntil: 0 });
    this._lastFailAt = 0;
  },

  /* 로그인한 사람을 토큰과 별도로 남긴다 (첫 화면으로 돌아가지 않게) */
  _remember() {
    if (!this.since) this.since = Date.now();
    writeJSON(SESSION_KEY, { email: this.email || "", name: this.name || "", since: this.since });
    if (this.email) { try { localStorage.setItem("hemory.email", this.email); } catch {} }
  },

  _mark(patch = {}) {
    const cur = readJSON(AUTH_KEY, {});
    const next = { ...cur, ...patch };
    if (patch.needsReconnect !== undefined) this.needsReconnect = !!patch.needsReconnect;
    writeJSON(AUTH_KEY, next);
  },

  _markSilentAttempt() {
    this._mark({ lastSilentAt: Date.now() });
  },

  /* 이메일·이름은 토큰이 살아 있을 때 한 번 확인 */
  async _identify() {
    try {
      const u = await this.about();
      if (!u.emailAddress) return;
      const prev = (this.email || "").toLowerCase();
      const now = u.emailAddress.toLowerCase();
      // 원래 쓰던 계정과 다른 계정으로 연결되면 엉뚱한 드라이브에 쌓이므로 즉시 해제한다
      if (prev && prev !== now) {
        try { localStorage.setItem("hemory.authNotice", `다른 Google 계정(${u.emailAddress})으로 연결되어 해제했습니다. 원래 계정으로 다시 연결해 주세요.`); } catch {}
        this.signOut();
        setTimeout(() => { try { location.reload(); } catch {} }, 60);
        return;
      }
      this.email = u.emailAddress;
      if (u.displayName) this.name = u.displayName;
      this._remember();
    } catch {}
  },

  signOut() {
    const t = this.token;
    this.token = null; this.expiresAt = 0;
    this.email = ""; this.name = ""; this.since = 0;
    removeKey(TOKEN_KEY); removeKey(SESSION_KEY);
    removeKey("hemory.email");
    this._mark({ needsReconnect: false, lastError: "", blockUntil: 0, lastSilentAt: 0 });
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

  /* GIS 팝업으로 토큰 받기 (데스크톱·안드로이드) */
  _popupToken({ prompt = "", timeout = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(v);
      };
      timer = setTimeout(() => done(reject, new AuthError("Google 응답이 없습니다.", "popup_timeout")), timeout);
      let client;
      try {
        client = google.accounts.oauth2.initTokenClient({
          client_id: this.clientId,
          scope: CONFIG.scopes,
          prompt,
          hint: this.email || undefined,
          callback: (resp) => {
            if (resp && resp.error) return done(reject, new AuthError(resp.error_description || resp.error, resp.error));
            this._store(resp);
            done(resolve, resp);
          },
          error_callback: (err) => done(reject, new AuthError(err && err.message || "silent_failed", (err && err.type) || "silent_failed")),
        });
      } catch (e) { done(reject, e); return; }
      try { client.requestAccessToken({ prompt }); }
      catch (e) { done(reject, e); }
    });
  },

  /* 사용자가 직접 누르는 로그인 · 다시 연결 */
  async signIn({ interactive = true } = {}) {
    if (!this.clientId) throw new AuthError("Client ID가 설정되지 않았습니다.", "no_client");
    const prompt = interactive ? (this.email ? "" : "select_account") : "none";

    // 아이폰 홈 화면 앱: 팝업은 돌아오지 못한다 → 처음부터 리다이렉트
    if (IS_IOS && this.standalone) return this.redirectSignIn({ prompt, silent: !interactive });

    if (!interactive) return this._refreshOnce();

    const ok = await this._waitGoogle(8000);
    if (!ok) return this.redirectSignIn({ prompt });

    try {
      await this._popupToken({ prompt, timeout: 180000 });
      this._identify().catch(() => {});
      return;
    } catch (e) {
      // 팝업이 막혔거나 열리지 않았을 때만 리다이렉트로 넘어간다
      const type = e && e.code;
      if (type === "popup_closed" || type === "access_denied") {
        throw new AuthError("로그인을 취소했습니다.", "cancelled");
      }
      return this.redirectSignIn({ prompt });
    }
  },

  /* 페이지 전체를 Google로 넘겼다가 토큰을 받아 돌아온다 (아이폰 홈 화면 앱의 기본 경로) */
  redirectSignIn({ prompt = null, silent = false } = {}) {
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem("hemory.oauth_state", state); } catch {}
    if (silent) this._markSilentAttempt();

    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", this.clientId);
    u.searchParams.set("redirect_uri", location.origin + location.pathname);
    u.searchParams.set("response_type", "token");
    u.searchParams.set("scope", CONFIG.scopes);
    u.searchParams.set("include_granted_scopes", "true");
    u.searchParams.set("state", state);
    u.searchParams.set("prompt", prompt == null ? (this.email ? "" : "select_account") : prompt);
    if (this.email) u.searchParams.set("login_hint", this.email);
    location.assign(u.toString());
    return new Promise(() => {});
  },

  /* 넘어갔다 돌아온 결과 처리 → { ok, error, silent } */
  consumeRedirect() {
    const h = location.hash || "";
    if (!h || (!h.includes("access_token") && !h.includes("error"))) return { ok: false };

    let p;
    try { p = new URLSearchParams(h.slice(1)); } catch { return { ok: false }; }

    let expect = "";
    try { expect = sessionStorage.getItem("hemory.oauth_state") || ""; sessionStorage.removeItem("hemory.oauth_state"); } catch {}
    try { history.replaceState(null, "", location.pathname + location.search); } catch {}

    const auth = readJSON(AUTH_KEY, {});
    const silent = !!(auth.lastSilentAt && Date.now() - Number(auth.lastSilentAt) < 10 * 60 * 1000);

    if (p.get("error")) {
      this._mark({
        needsReconnect: true,
        lastError: p.get("error"),
        blockUntil: Date.now() + BLOCK_AFTER_FAIL,
      });
      return { ok: false, error: p.get("error"), silent };
    }

    if (expect && p.get("state") && p.get("state") !== expect) {
      this._mark({ needsReconnect: true, lastError: "state_mismatch" });
      return { ok: false, error: "state_mismatch", silent };
    }

    const ttl = (Number(p.get("expires_in")) || 3500) * 1000;
    this.token = p.get("access_token");
    this.expiresAt = Date.now() + ttl - 60000;
    writeJSON(TOKEN_KEY, { access_token: this.token, expiresAt: this.expiresAt });
    this._remember();
    this._mark({ needsReconnect: false, lastError: "", blockUntil: 0 });
    this._lastFailAt = 0;
    this._identify().catch(() => {});
    return { ok: true, silent };
  },

  _canAutoNavigate() {
    if (!this.canNavigate()) return false;
    if (Date.now() > this._navDeadline) return false;
    const auth = readJSON(AUTH_KEY, {});
    if (auth.blockUntil && Date.now() < Number(auth.blockUntil)) return false;
    if (auth.lastSilentAt && Date.now() - Number(auth.lastSilentAt) < SILENT_COOLDOWN) return false;
    return true;
  },

  /* 조용한 갱신 한 번 */
  async _refreshOnce() {
    if (this.tokenValid) return this.token;
    if (!this.clientId) throw new AuthError("Client ID가 설정되지 않았습니다.", "no_client");
    if (this._lastFailAt && Date.now() - this._lastFailAt < 30000) {
      throw new AuthError("Google 연결을 다시 확인해야 합니다.", "needs_reconnect");
    }

    // ① 팝업 무음 갱신 (아이폰 홈 화면 앱에서는 팝업이 돌아오지 못하므로 건너뛴다)
    if (!(IS_IOS && this.standalone)) {
      const ready = await this._waitGoogle(4000);
      if (ready) {
        try {
          await this._popupToken({ prompt: "none", timeout: 9000 });
          this._identify().catch(() => {});
          return this.token;
        } catch (e) { /* 다음 단계로 */ }
      }
    }

    // ② 앱을 연 직후라면 잠깐 Google로 넘겼다가 토큰을 받아 돌아온다
    if (this._canAutoNavigate()) return this.redirectSignIn({ prompt: "none", silent: true });

    this._lastFailAt = Date.now();
    this._mark({ needsReconnect: true, lastError: "silent_failed" });
    throw new AuthError("Google 연결을 다시 확인해야 합니다.", "needs_reconnect");
  },

  async ensureToken() {
    if (this.tokenValid) return this.token;
    if (!this.clientId) throw new AuthError("Client ID가 설정되지 않았습니다.", "no_client");
    if (this._inflight) {
      try { await this._inflight; } catch {}
      if (this.tokenValid) return this.token;
      throw new AuthError("Google 연결을 다시 확인해야 합니다.", "needs_reconnect");
    }
    this._inflight = this._refreshOnce().finally(() => { this._inflight = null; });
    await this._inflight;
    if (!this.tokenValid) throw new AuthError("Google 연결을 다시 확인해야 합니다.", "needs_reconnect");
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
      // 토큰만 만료된 경우: 세션은 그대로 두고 한 번만 다시 받아 재시도
      this.expiresAt = 0;
      writeJSON(TOKEN_KEY, { access_token: this.token, expiresAt: 0 });
      return this.req(path, { method, body, headers, retry: false });
    }
    if (!res.ok) {
      let msg = `Drive ${res.status}`;
      try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
      throw new Error(msg);
    }
    return res.json();
  },

  async about() {
    const j = await this.req("/about?fields=user(displayName,emailAddress)");
    return j.user || {};
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

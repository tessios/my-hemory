/* v1.5.1 — 모듈 연결 회귀 테스트
   ─────────────────────────────────────────────────────────────
   ES 모듈은 import 이름이 하나만 틀려도 **파일 전체가 조용히 실행되지 않는다**.
   (v1.5.1 배포본에서 js/app.js 가 존재하지 않는 `leaseReady` 를 import 해
    화면이 첫 화면에서 멈춘 사고의 재발 방지선)

   ① js/*.js 의 모든 정적 import 이름이 대상 파일에 실제로 export 되어 있는가
   ② index.html 이 부르는 스크립트·스타일 파일이 저장소에 있는가
   ③ 서비스워커 SHELL 에 적힌 파일이 모두 존재하는가(없으면 install 캐시가 통째로 실패)
   실행: node --test tests/imports.test.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jsDir = join(root, "js");
const jsFiles = readdirSync(jsDir).filter((f) => f.endsWith(".js"));

/* 파일이 밖으로 내보내는 이름 */
function exportNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).replace(/^default\s+as\s+/, "").trim());
    }
  }
  if (/export\s+default/.test(src)) names.add("default");
  return names;
}

/* 파일이 정적으로 가져오는 이름들 */
function importSpecs(src) {
  const specs = [];
  for (const m of src.matchAll(/import\s+([^;]*?)\s+from\s+["'](\.[^"']+)["']/g)) {
    const clause = m[1].trim();
    const from = m[2];
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const part of named[1].split(",")) {
        const t = part.trim();
        if (!t) continue;
        specs.push({ name: t.split(/\s+as\s+/)[0].trim(), from });
      }
    }
    const def = clause.match(/^([A-Za-z0-9_$]+)\s*(?:,|$)/);
    if (def) specs.push({ name: "default", from });
    const ns = clause.match(/\*\s+as\s+([A-Za-z0-9_$]+)/);
    if (ns) specs.push({ name: "*", from });
  }
  return specs;
}

test("js/*.js 의 import 이름이 대상 파일의 export 와 일치한다", () => {
  const problems = [];
  const cache = new Map();
  const exp = (file) => {
    if (!cache.has(file)) cache.set(file, existsSync(file) ? exportNames(readFileSync(file, "utf8")) : null);
    return cache.get(file);
  };
  for (const f of jsFiles) {
    const src = readFileSync(join(jsDir, f), "utf8");
    for (const { name, from } of importSpecs(src)) {
      const target = resolve(jsDir, from);
      const names = exp(target);
      if (!names) { problems.push(`js/${f}: ${from} 파일이 없습니다`); continue; }
      if (name === "*") continue;
      if (!names.has(name)) {
        problems.push(`js/${f}: ${from} 에 \`${name}\` export 가 없습니다 (모듈 전체가 로드 실패한다)`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("index.html 이 부르는 스크립트·스타일 파일이 저장소에 있다", () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const missing = [];
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const p = m[1].split("?")[0];
    if (!p || /^(https?:)?\/\//.test(p) || p.startsWith("#") || p.startsWith("data:")) continue;
    if (!existsSync(join(root, p.replace(/^\.?\//, "")))) missing.push(p);
  }
  assert.deepEqual(missing, [], `index.html 참조 파일 없음: ${missing.join(", ")}`);
});

test("서비스워커 SHELL 의 파일이 모두 존재하고 캐시 키가 버전과 맞는다", () => {
  const sw = readFileSync(join(root, "sw.js"), "utf8");
  const version = readFileSync(join(root, "js/config.js"), "utf8").match(/version:\s*"([^"]+)"/)?.[1];
  const cacheKey = sw.match(/const VERSION\s*=\s*"([^"]+)"/)?.[1];
  assert.ok(version, "config.js 에 version 이 없습니다");
  assert.equal(cacheKey, `hemory-v${version}`, "서비스워커 캐시 키가 config.js 버전과 다릅니다");

  const list = sw.match(/const SHELL\s*=\s*\[([\s\S]*?)\]/)?.[1] || "";
  const entries = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(entries.includes("./"), "SHELL 에 ./ 가 없습니다");
  const missing = entries
    .filter((e) => e !== "./")
    .filter((e) => !existsSync(join(root, e.replace(/^\.\//, ""))));
  assert.deepEqual(missing, [], `SHELL 에 없는 파일: ${missing.join(", ")}`);

  // 새로 만든 js 모듈은 SHELL 에도 들어 있어야 오프라인에서 앱이 뜬다
  const inShell = new Set(entries.map((e) => e.replace(/^\.\//, "")));
  const notListed = jsFiles.map((f) => `js/${f}`).filter((f) => !inShell.has(f));
  assert.deepEqual(notListed, [], `서비스워커 SHELL 에 빠진 모듈: ${notListed.join(", ")}`);
});

test("version.json 이 config.js 버전과 같다", () => {
  const version = readFileSync(join(jsDir, "config.js"), "utf8").match(/version:\s*"([^"]+)"/)?.[1];
  const vj = JSON.parse(readFileSync(join(root, "version.json"), "utf8"));
  assert.equal(vj.version, version, "version.json 과 앱 버전이 어긋나면 업데이트 판정이 틀어진다");
});

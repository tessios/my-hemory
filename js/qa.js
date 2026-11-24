/* Gemini 연동 — (1) 근거 기반 Q&A  (2) 짧은 녹음의 즉시 전사 (선택) */
import { CONFIG } from "./config.js";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

function key() {
  try { return (JSON.parse(localStorage.getItem("hemory.settings") || "{}").geminiKey || "").trim(); } catch { return ""; }
}
export const hasGemini = () => !!key();

// 앞 모델이 단종(404)·과부하(503)이면 차례로 시도
const FALLBACK_MODELS = ["gemini-3.6-flash", "gemini-flash-latest"];

async function once(model, { parts, json, temperature, k }) {
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: { temperature, maxOutputTokens: 4096 },
    safetySettings: [],
  };
  if (json) body.generationConfig.responseMimeType = "application/json";
  const res = await fetch(`${ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(k)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let m = `Gemini ${res.status}`;
    try { const j = await res.json(); m = j.error?.message || m; } catch {}
    const err = new Error(m);
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  if (!text) throw new Error("응답이 비어 있습니다.");
  return text;
}

async function generate({ parts, model = CONFIG.geminiModel, json = false, temperature = 0.2, apiKey }) {
  const k = apiKey || key();
  if (!k) throw new Error("Gemini API 키가 설정되지 않았습니다.");
  const models = [model, ...FALLBACK_MODELS.filter((m) => m !== model)];
  let last = null;
  for (const mdl of models) {
    try {
      return await once(mdl, { parts, json, temperature, k });
    } catch (e) {
      const retryable = [404, 429, 500, 502, 503, 504].includes(e.status);
      if (!retryable) throw e;
      last = e;
    }
  }
  throw last;
}

/* ── Q&A ─────────────────────────────────────────── */
export async function ask(question, hits) {
  const ctx = hits.map((h, i) => {
    const d = new Date(h.rec.started_at);
    const when = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const t = h.t != null ? ` @${Math.floor(h.t / 60)}분` : "";
    return `[${i + 1}] (${when} · ${h.rec.title || "제목 없음"}${t}) ${h.text}`;
  }).join("\n");

  const prompt = `너는 사용자 본인의 개인 녹음 기록을 대신 기억해 주는 비서다. 아래 '기록 발췌'만 근거로 한국어로 간결하게 답한다.

규칙:
- 발췌에 없는 내용은 추측하지 말고 "기록에서 확인되지 않습니다"라고 말한다.
- 답에 쓴 근거의 번호를 문장 끝에 [1], [2]처럼 붙인다.
- 3~6문장, 존댓말, 불필요한 서론 없이 바로 답한다.
- 날짜·사람·숫자는 발췌에 나온 그대로 쓴다.

기록 발췌:
${ctx}

질문: ${question}`;

  const answer = await generate({ parts: [{ text: prompt }] });
  return { answer, sources: hits };
}

/* ── 즉시 전사 (짧은 녹음) ─────────────────────────── */
export async function transcribe(blob, { hint = "" } = {}) {
  if (blob.size > 18 * 1024 * 1024) {
    throw new Error("파일이 커서 브라우저 전사를 할 수 없습니다(18MB 이하). 맥 전사로 넘깁니다.");
  }
  const b64 = await blobToBase64(blob);
  const mime = blob.type || "audio/mp4";
  const prompt = `다음 한국어(또는 한국어+영어) 녹음을 전사하고 정리해 JSON 하나로만 답하라.${hint ? `\n참고: ${hint}` : ""}

형식:
{
  "title": "내용을 12자 내외로 요약한 제목",
  "type": "meeting|work|meal|daily|study|etc",
  "one_line": "한 문장 요약",
  "bullets": ["핵심 3~5개"],
  "agenda": ["회의일 때 안건"],
  "decisions": ["회의일 때 결정 사항"],
  "actions": [{"owner":"","task":"","due":""}],
  "keywords": ["키워드 5개"],
  "speakers": ["화자 이름 또는 화자 1, 화자 2"],
  "segments": [{"start": 0.0, "end": 3.4, "speaker": "화자 1", "text": "문장"}]
}

규칙:
- 실제로 들린 말만. 추측 금지. 시간은 초 단위 숫자.
- 문장은 호흡 단위로 3~12초 안팎. 말이 없는 구간은 넣지 않는다.
- 두 사람 이상이면 목소리로 구분해 화자 1/화자 2로 표시. 확실치 않으면 "화자".
- 회의가 아니면 agenda/decisions/actions는 빈 배열.`;

  const text = await generate({
    json: true,
    temperature: 0.1,
    parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }],
  });
  let data;
  try { data = JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("전사 결과를 해석하지 못했습니다.");
    data = JSON.parse(m[0]);
  }
  data.segments = (data.segments || []).map((s, i) => ({
    i, start: Number(s.start) || 0, end: Number(s.end) || null,
    speaker: s.speaker || "화자", text: String(s.text || "").trim(),
  })).filter((s) => s.text);
  return data;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1]);
    fr.onerror = () => reject(new Error("파일을 읽지 못했습니다."));
    fr.readAsDataURL(blob);
  });
}

"""실제 OAuth 없이 Drive API 응답을 가로채 앱의 동기화 경로를 통합 검증."""
import asyncio, json, os
from playwright.async_api import async_playwright

OUT = "/workspace/downloads/my-hemory/_shots"
URL = "https://tessios.github.io/my-hemory/"

ROOT, M11, INBOX = "ROOT", "M11", "INBOX"
transcript = {
    "schema": "hemory.transcript.v1",
    "id": "20261124-0930_meeting_abc123",
    "title": "현장 품질 점검 회의",
    "type": "meeting",
    "started_at": "2026-11-24T09:30:00+09:00",
    "duration_sec": 1240,
    "source": "iphone",
    "status": "done",
    "summary": {
        "one_line": "배관 두 구간 점검을 마치고 잔여 구간은 내일 오전으로 옮겼다.",
        "bullets": ["5번 라인 육안검사 완료"],
        "agenda": ["점검 범위", "잔여 일정"],
        "decisions": ["잔여 구간은 내일 09시 시작"],
        "actions": [{"owner": "김 과장", "task": "잔여 구간 도면 준비", "due": "내일 08:30"}],
        "keywords": ["점검", "배관", "일정"],
    },
    "speakers": ["팀장", "김 과장"],
    "segments": [
        {"i": 0, "start": 1.2, "end": 6.8, "speaker": "팀장", "text": "오늘 점검 범위부터 확인하겠습니다."},
        {"i": 1, "start": 7.4, "end": 14.2, "speaker": "김 과장", "text": "5번 라인은 육안검사까지 끝났고 잔여 구간이 남았습니다."},
        {"i": 2, "start": 15.0, "end": 21.5, "speaker": "팀장", "text": "잔여 구간은 내일 아홉 시에 시작하죠."},
    ],
    "audio": {"file_name": "20261124-0930_meeting_abc123.m4a", "size": 88000},
    "engine": {"asr": "faster-whisper/medium", "diarization": "pyannote", "summary": "gemini-2.5-flash"},
}

F = lambda i, n, m, s=1000: {"id": i, "name": n, "mimeType": m, "size": str(s),
                             "modifiedTime": "2026-11-24T09:40:00.000Z",
                             "createdTime": "2026-11-24T09:30:00.000Z", "parents": []}
FOLDER = "application/vnd.google-apps.folder"


def files_for(q: str):
    if "Hemory-개인녹음" in q:
        return [F(ROOT, "Hemory-개인녹음", FOLDER)]
    if f"'{ROOT}' in parents" in q:
        return [F(M11, "2026-11", FOLDER), F(INBOX, "_inbox", FOLDER), F("TR", "_trash", FOLDER)]
    if f"'{M11}' in parents" in q:
        return [F("A1", "20261124-0930_meeting_abc123.m4a", "audio/mp4"),
                F("J1", "20261124-0930_meeting_abc123.json", "application/json"),
                F("A2", "20261123-1200_meal_def456.m4a", "audio/mp4")]
    if f"'{INBOX}' in parents" in q:
        return [F("A3", "20261124-1500_work_ghi789.m4a", "audio/mp4")]
    return []


async def handler(route):
    req = route.request
    url = req.url
    if "/about" in url:
        return await route.fulfill(json={"user": {"displayName": "Yoonchan", "emailAddress": "korea.yoonchan.kim@gmail.com"}})
    if "/upload/" in url or req.method in ("POST", "PUT", "PATCH"):
        return await route.fulfill(json={"id": "NEW", "name": "x"})
    if "/files/J1" in url and "alt=media" in url:
        return await route.fulfill(status=200, content_type="application/json",
                                   body=json.dumps(transcript, ensure_ascii=False))
    if "/files/" in url and "alt=media" in url:
        return await route.fulfill(status=200, content_type="audio/mp4", body=b"\x00" * 100)
    if "/files?" in url or url.endswith("/files"):
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(url).query).get("q", [""])[0]
        return await route.fulfill(json={"files": files_for(q)})
    return await route.fulfill(json={})


async def main():
    errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                                  is_mobile=True, has_touch=True)
        page = await ctx.new_page()
        page.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
        page.on("console", lambda m: errs.append("console: " + m.text) if m.type == "error" else None)
        await page.add_init_script("""
            localStorage.setItem('hemory.token', JSON.stringify({access_token:'FAKE', expiresAt: Date.now()+3600e3}));
            localStorage.setItem('hemory.settings', JSON.stringify({clientId:'fake.apps.googleusercontent.com'}));
        """)
        await page.route("https://www.googleapis.com/**", handler)
        await page.goto(URL, wait_until="networkidle")
        await page.wait_for_timeout(1800)
        await page.screenshot(path=f"{OUT}/drive-01-timeline.png")

        cards = await page.locator(".card").count()
        titles = await page.locator(".card-title").all_inner_texts()
        times = await page.locator(".card-time").all_inner_texts()
        pending = await page.locator(".card.pending").count()
        sub = await page.locator("#tl-sub").inner_text()
        account = await page.evaluate("localStorage.getItem('hemory.email')")
        print("cards:", cards, "pending:", pending)
        print("titles:", titles)
        print("times:", times)
        print("sub:", sub, "| account:", account)

        # 완료 기록 상세
        await page.locator('.card:has-text("현장 품질 점검 회의")').first.click()
        await page.wait_for_timeout(900)
        await page.screenshot(path=f"{OUT}/drive-02-detail.png")
        seg = await page.locator("#transcript .tr").count()
        print("segments:", seg, "| player:", await page.locator("#player").count())

        # 오디오 URL 확인
        src = await page.evaluate("(() => { const a = document.querySelector('audio'); return a ? a.src : null })()")
        print("audio src:", (src or "none")[:80])

        # 문장 탭 → 재생 시도 (가짜 오디오라 실패할 수 있음)
        await page.locator("#transcript .tr").nth(2).click()
        await page.wait_for_timeout(700)
        await page.locator(".sheet-close").click()
        await page.wait_for_timeout(400)

        # 검색
        await page.click("#tabbar button[data-tab='search']")
        await page.wait_for_timeout(300)
        await page.fill("#q", "잔여 구간")
        await page.wait_for_timeout(700)
        hits = await page.locator(".hit").count()
        print("search hits:", hits)
        await page.screenshot(path=f"{OUT}/drive-03-search.png")

        # 설정 (연결 상태)
        await page.click("#tabbar button[data-tab='settings']")
        await page.wait_for_timeout(600)
        await page.screenshot(path=f"{OUT}/drive-04-settings.png")

        await b.close()
    print("ERRORS:", errs[:10] if errs else "none")

asyncio.run(main())

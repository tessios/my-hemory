import asyncio, os
from playwright.async_api import async_playwright

OUT = "/workspace/downloads/my-hemory/_shots"
os.makedirs(OUT, exist_ok=True)
URL = "https://tessios.github.io/my-hemory/"

async def main():
    errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                                  is_mobile=True, has_touch=True,
                                  user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
        page = await ctx.new_page()
        page.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
        await page.goto(URL, wait_until="networkidle")
        await page.wait_for_timeout(800)
        await page.screenshot(path=f"{OUT}/live-01-gate.png")

        await page.click("#btn-demo")
        await page.wait_for_timeout(1200)
        await page.screenshot(path=f"{OUT}/live-02-timeline.png")

        await page.click(".card")
        await page.wait_for_timeout(900)
        await page.screenshot(path=f"{OUT}/live-03-detail.png")

        await page.evaluate("document.querySelector('#sheet-root .sheet-body').scrollTop = 620")
        await page.wait_for_timeout(500)
        await page.click("#transcript .tr:nth-child(3)")
        await page.wait_for_timeout(400)
        await page.screenshot(path=f"{OUT}/live-04-transcript.png")
        await page.click(".sheet-close")
        await page.wait_for_timeout(500)

        await page.click("#tabbar button[data-tab='search']")
        await page.wait_for_timeout(400)
        await page.fill("#q", "출시")
        await page.wait_for_timeout(800)
        await page.screenshot(path=f"{OUT}/live-05-search.png")

        await page.click("#search-mode button[data-mode='ask']")
        await page.wait_for_timeout(400)
        await page.screenshot(path=f"{OUT}/live-06-ask.png")
        await page.fill("#q", "")
        await page.click("#search-mode button[data-mode='search']")

        await page.click("#tabbar button[data-tab='timeline']")
        await page.wait_for_timeout(400)
        await page.click("#fab")
        await page.wait_for_timeout(700)
        await page.screenshot(path=f"{OUT}/live-07-recorder.png")
        await page.click(".sheet-close")
        await page.wait_for_timeout(400)

        await page.click("#tabbar button[data-tab='settings']")
        await page.wait_for_timeout(700)
        await page.screenshot(path=f"{OUT}/live-08-settings.png")
        await page.evaluate("window.scrollTo(0, 900)")
        await page.wait_for_timeout(400)
        await page.screenshot(path=f"{OUT}/live-09-settings2.png")

        # 서비스 워커 등록 확인
        sw = await page.evaluate("navigator.serviceWorker.controller ? 'controlled' : (navigator.serviceWorker.getRegistrations().then(r=>r.length))")
        caches = await page.evaluate("caches.keys()")
        print("SW:", sw, "caches:", caches)
        print("manifest:", await page.evaluate("document.querySelector('link[rel=manifest]').href"))
        print("standalone meta:", await page.evaluate("document.querySelector('meta[name=apple-mobile-web-app-capable]').content"))
        await b.close()
    print("ERRORS:", errs[:20] if errs else "none")

asyncio.run(main())

import asyncio, subprocess, time, os, sys
from playwright.async_api import async_playwright

OUT = "/workspace/downloads/my-hemory/_shots"
os.makedirs(OUT, exist_ok=True)

async def main():
    srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", "/workspace/downloads/my-hemory"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.2)
    errors = []
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            ctx = await b.new_context(viewport={"width":390,"height":844}, device_scale_factor=2,
                                      is_mobile=True, has_touch=True, user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
            page = await ctx.new_page()
            page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type in ("error","warning") else None)
            page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
            await page.goto("http://localhost:8765/", wait_until="networkidle")
            await page.wait_for_timeout(600)
            await page.screenshot(path=f"{OUT}/01-gate.png")

            await page.click("#btn-demo")
            await page.wait_for_timeout(900)
            await page.screenshot(path=f"{OUT}/02-timeline.png")

            # detail
            await page.click(".card")
            await page.wait_for_timeout(700)
            await page.screenshot(path=f"{OUT}/03-detail.png")
            await page.evaluate("document.querySelector('#sheet-root .sheet-body').scrollTop = 700")
            await page.wait_for_timeout(400)
            await page.screenshot(path=f"{OUT}/04-transcript.png")
            await page.click(".sheet-close")
            await page.wait_for_timeout(400)

            # search
            await page.click("#tabbar button[data-tab='search']")
            await page.wait_for_timeout(400)
            await page.fill("#q", "검색 지연")
            await page.wait_for_timeout(700)
            await page.screenshot(path=f"{OUT}/05-search.png")

            # ask
            await page.click("#search-mode button[data-mode='ask']")
            await page.wait_for_timeout(300)
            await page.click("#search-mode button[data-mode='search']")
            await page.fill("#q", "")
            await page.wait_for_timeout(300)

            # recorder
            await page.click("#tabbar button[data-tab='timeline']")
            await page.wait_for_timeout(300)
            await page.click("#fab")
            await page.wait_for_timeout(600)
            await page.screenshot(path=f"{OUT}/06-recorder.png")
            await page.click(".sheet-close")
            await page.wait_for_timeout(300)

            # settings
            await page.click("#tabbar button[data-tab='settings']")
            await page.wait_for_timeout(500)
            await page.screenshot(path=f"{OUT}/07-settings.png")
            await page.evaluate("window.scrollTo(0,600)")
            await page.wait_for_timeout(300)
            await page.screenshot(path=f"{OUT}/08-settings2.png")

            await b.close()
    finally:
        srv.terminate()
    print("ERRORS:")
    for e in errors[:30]:
        print(" -", e)
    print("done", sorted(os.listdir(OUT)))

asyncio.run(main())

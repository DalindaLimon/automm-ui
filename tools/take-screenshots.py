"""Retake the README screenshots from a live printer.

    pip install playwright && python -m playwright install chromium-headless-shell
    python tools/take-screenshots.py PRINTER_IP docs/images            # all of them
    python tools/take-screenshots.py PRINTER_IP docs/images overview   # only some: overview calibrate phone fluidd

Needs automm-ui installed on the printer and a few calibrations on the wall.
Filament names and colours are swapped for the example names below in the
page's memory only (nothing is written to the printer), so personal names
don't end up on GitHub; every number shown is the printer's real result.
"""
import asyncio
import sys
from pathlib import Path

from playwright.async_api import async_playwright

HOST = sys.argv[1]
OUT = Path(sys.argv[2])
ONLY = set(sys.argv[3:])
OUT.mkdir(parents=True, exist_ok=True)

DEMO = [
    ("Elegoo Rapid PETG Black", "PETG", "#060606"),
    ("Sunlu PETG Green", "PETG", "#5cf30e"),
    ("eSun PETG+ Coral", "PETG", "#ff7174"),
    ("Polymaker PETG White", "PETG", "#fafafa"),
    ("Overture PETG Blue", "PETG", "#3a6fd3"),
]

# runs inside the page: rename the wall in memory and pick a 0.4 mm run to show
DEMO_JS = """(demo) => {
  const lib = groupLibrary(runs, labels, meta), ren = {};
  lib.forEach((f, i) => { if (demo[i]) ren[f.name] = demo[i]; });
  const nl = {};
  for (const [k, n] of Object.entries(labels)) if (k !== "pending") nl[k] = ren[n] ? ren[n][0] : n;
  const nm = {};
  for (const [, [name, material, color]] of Object.entries(ren)) nm[name] = { material, color };
  labels = nl; meta = nm;
  const lib2 = groupLibrary(runs, labels, meta);
  // feature a stock 0.4 mm nozzle run, so the README doesn't open on the "other nozzle" warning
  const std = f => f.latest.payload.geometry && Math.abs(f.latest.payload.geometry.line_w - 0.42) < 0.01;
  const pick = lib2.find(f => std(f) && f.name.includes("Green")) || lib2.find(std) || lib2[0];
  sel = { kind: "fil", name: pick.name }; selRunKey = null;
  renderWall(); renderSelection();
  return pick.name;
}"""

READY = "document.querySelectorAll('.spool').length > 5 && document.querySelector('#coFlow b').textContent !== '–'"


async def open_page(browser, width, height, scale=1, mobile=False):
    ctx = await browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=scale,
                                    is_mobile=mobile, has_touch=mobile, color_scheme="dark")
    await ctx.add_init_script("try { localStorage.setItem('automm-ui.lite', '0') } catch (e) {}")
    page = await ctx.new_page()
    return ctx, page


async def demo(target):
    await target.wait_for_function(READY, timeout=20000)
    name = await target.evaluate(DEMO_JS, DEMO)
    await target.wait_for_timeout(1200)
    return name


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--disable-dev-shm-usage"])

        if not ONLY or "overview" in ONLY:
            ctx, page = await open_page(browser, 1600, 1000)
            await page.goto(f"http://{HOST}/automm/")
            print("overview:", await demo(page))
            await page.screenshot(path=OUT / "overview.png")
            await page.locator("#coGeo").screenshot(path=OUT / "geometry.png")
            await page.locator("#orcaBox").screenshot(path=OUT / "orca.png")
            await ctx.close()

        if not ONLY or "calibrate" in ONLY:
            ctx, page = await open_page(browser, 1600, 1000)
            await page.goto(f"http://{HOST}/automm/")
            await demo(page)
            await page.locator('.spool[data-sel*=\'"slot"\']').nth(1).click()   # Box slot 1B
            await page.wait_for_timeout(500)
            await page.click("#btnCal")
            await page.wait_for_timeout(600)
            await page.locator("#dlgCal").screenshot(path=OUT / "calibrate.png")
            await ctx.close()

        if not ONLY or "phone" in ONLY:
            ctx, page = await open_page(browser, 390, 844, scale=2, mobile=True)
            await page.goto(f"http://{HOST}/automm/")
            await demo(page)
            await page.screenshot(path=OUT / "phone.png")
            await ctx.close()

        if not ONLY or "fluidd" in ONLY:
            ctx, page = await open_page(browser, 1600, 1000)
            await page.goto(f"http://{HOST}/#/")
            await page.wait_for_selector("a[data-automm]", timeout=30000)
            await page.wait_for_timeout(1500)
            await page.click("a[data-automm]")
            frame = None
            for _ in range(40):
                frame = next((f for f in page.frames if "/automm/?embed=1" in f.url), None)
                if frame:
                    break
                await page.wait_for_timeout(250)
            await page.wait_for_timeout(3000)          # let the embedded page connect and draw
            print("fluidd:", await demo(frame))
            await page.wait_for_timeout(2000)
            # close any Fluidd pop-up (snackbar) sitting over the page
            await page.evaluate("document.querySelectorAll('.v-snack').forEach(e => e.remove())")
            print("frame spools:", await frame.evaluate("document.querySelectorAll('.spool').length"),
                  "frames:", [f.url for f in page.frames if 'automm' in f.url])
            await page.screenshot(path=OUT / "fluidd.png")
            await ctx.close()

        await browser.close()


asyncio.run(main())

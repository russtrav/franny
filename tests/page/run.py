"""Drive the Franny page in Chromium with the function mocked by real captured responses."""
import json, sys, pathlib, time
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
PAGE = (pathlib.Path(__file__).parent / "../../index.html").resolve().as_uri()
FX = json.loads((HERE / "fixtures.json").read_text())
OUT = HERE / "shots"; OUT.mkdir(exist_ok=True)
ENDPOINT = "https://seqvzektwxxypdcqgtve.supabase.co/functions/v1/league-ask"


FONTS = pathlib.Path(__file__).parent / "fonts/node_modules"
FONT_CSS = """
@font-face{font-family:'Archivo';font-style:normal;font-weight:100 900;font-stretch:62% 125%;src:url(https://fonts.gstatic.com/archivo.woff2) format('woff2');}
@font-face{font-family:'Marcellus SC';font-style:normal;font-weight:400;src:url(https://fonts.gstatic.com/marcellus.woff2) format('woff2');}
"""
def font_routes(page):
    if not FONTS.exists():  # fonts are optional; without them the page falls back to system fonts
        return
    page.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(status=200, content_type="text/css", body=FONT_CSS))
    page.route("https://fonts.gstatic.com/archivo.woff2", lambda r: r.fulfill(status=200, content_type="font/woff2", body=(FONTS/"@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2").read_bytes()))
    page.route("https://fonts.gstatic.com/marcellus.woff2", lambda r: r.fulfill(status=200, content_type="font/woff2", body=(FONTS/"@fontsource/marcellus-sc/files/marcellus-sc-latin-400-normal.woff2").read_bytes()))

problems = []
def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond: problems.append(msg)

def router(state):
    def handle(route):
        req = route.request
        body = json.loads(req.post_data or "{}")
        state["calls"].append(body)
        state["content_types"].append(req.headers.get("content-type"))
        if body.get("passcode") != "keeper-sleeper-flex-18":
            fx = FX["bad_passcode"]
        elif body["action"] == "hello":
            fx = FX["hello"]
        else:
            q = body.get("question", "").lower()
            if "testegg" in q: fx = FX["egg"]  # eggs are answered before the daily cap is checked
            elif state.get("cap_hit"): fx = FX["daily_cap"]
            elif body.get("deep"): fx = FX["deep"]
            elif "standings" in q: fx = FX["standings"]
            elif "against everyone" in q: fx = FX["record"] if body.get("asker") else FX["needs_asker"]
            elif "gibberish" in q: fx = FX["no_query"]
            else: fx = FX["streak"]
        status = fx.get("_status", 200)
        time.sleep(0.3)
        route.fulfill(status=status, content_type="application/json",
                      headers={"access-control-allow-origin": "*"}, body=json.dumps(fx))
    return handle

with sync_playwright() as p:
    browser = p.chromium.launch()
    for scheme in ["light", "dark"]:
        for name, vp in [("phone", {"width": 390, "height": 844}), ("desktop", {"width": 1280, "height": 900})]:
            ctx = browser.new_context(viewport=vp, color_scheme=scheme, device_scale_factor=2 if name == "phone" else 1)
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
            state = {"calls": [], "content_types": []}
            page.route(ENDPOINT, router(state)); font_routes(page)
            page.goto(PAGE)
            tag = f"{scheme}-{name}"

            # 1. gate
            check(page.is_visible("#gate") and not page.is_visible("#app"), f"[{tag}] first visit shows the passcode gate")
            page.screenshot(path=str(OUT / f"{tag}-1-gate.png"))
            page.fill("#code", "wrong")
            page.click("#gateBtn")
            page.wait_for_selector("#gateNotice:not([hidden])")
            check("isn't right" in page.inner_text("#gateNotice"), f"[{tag}] wrong passcode is refused with a clear message")
            page.fill("#code", "keeper-sleeper-flex-18")
            page.click("#gateBtn")
            page.wait_for_selector("#picker:not([hidden])")
            check(page.is_visible("#app"), f"[{tag}] right passcode opens the page")
            check(page.locator("#activeNames button").count() == 12, f"[{tag}] picker lists the 12 active managers")
            page.screenshot(path=str(OUT / f"{tag}-2-picker.png"))
            page.click("#skipPick")
            check(page.is_hidden("#picker"), f"[{tag}] Just browsing closes the picker")
            check(page.locator("#plaque .plate").count() == 16, f"[{tag}] plaque shows 15 champions plus the open 2026 plate")
            check(page.locator("#examples button").count() == 8, f"[{tag}] 8 example questions")
            check("100 questions left" in page.inner_text("#budget"), f"[{tag}] budget shows 100 left")
            page.wait_for_timeout(900)
            page.screenshot(path=str(OUT / f"{tag}-3-home.png"), full_page=True)

            # 2. ask via example
            page.click("#examples button >> text=Longest win streak of all time")
            page.wait_for_selector("#entry .answer")
            check("Tom holds the longest" in page.inner_text("#entry .answer"), f"[{tag}] example question shows the answer")
            check(page.locator("#entry tbody tr").count() == 10, f"[{tag}] answer table has 10 rows")
            check("99 questions left" in page.inner_text("#budget"), f"[{tag}] budget updates after asking")
            check(page.is_visible("#harderBtn"), f"[{tag}] Think harder offered")
            page.screenshot(path=str(OUT / f"{tag}-4-answer.png"), full_page=True)

            # 3. "my" question without an asker -> picker -> auto re-ask
            page.fill("#q", "What's my record against everyone?")
            page.click("#askBtn")
            page.wait_for_selector("#picker:not([hidden])")
            check("about you" in page.inner_text("#pickerWhy"), f"[{tag}] a 'my' question asks who you are")
            check("Tom holds the longest" in page.inner_text("#entry"), f"[{tag}] previous answer stays while picking")
            page.click("#activeNames button >> text=Tom")
            page.wait_for_selector("#entry .answer >> text=95 wins")
            check("Asking as Tom" in " ".join(page.inner_text("#who").split()), f"[{tag}] header shows the picked manager")
            check(state["calls"][-1].get("asker") == "Tom", f"[{tag}] re-asked automatically as Tom")

            # 4. think harder
            page.click("#examples button >> text=Who has the most championships?")
            page.wait_for_selector("#harderBtn")
            page.click("#harderBtn")
            page.wait_for_selector("#entry .deep-tag")
            check(state["calls"][-1].get("deep") is True, f"[{tag}] Think harder sends deep=true")
            check("Jesse and John" in page.inner_text("#entry .answer"), f"[{tag}] Think harder answer shows")

            # 5. plaque plate -> standings
            page.click("#plaque .plate >> text=Russ")
            page.wait_for_selector("#entry .answer >> text=Captain Lamarvellous")
            check(page.locator("#entry tbody tr").count() == 12, f"[{tag}] tapping a plate asks for that season's standings")
            check("Yes" in page.inner_text("#entry tbody"), f"[{tag}] booleans render as Yes/No")
            page.screenshot(path=str(OUT / f"{tag}-5-standings.png"), full_page=True)

            # 6. no_query -> Think harder offered in notice, previous answer kept
            page.fill("#q", "gibberish question")
            page.click("#askBtn")
            page.wait_for_selector("#notice:not([hidden])")
            check("Think harder" in page.inner_text("#notice"), f"[{tag}] failed query offers Think harder")
            check("Captain Lamarvellous" in page.inner_text("#entry"), f"[{tag}] previous answer restored after a failure")

            # 7. daily cap
            state["cap_hit"] = True
            page.fill("#q", "Highest-scoring week ever")
            page.click("#askBtn")
            page.wait_for_selector("#notice:not([hidden]) >> text=resets at midnight")
            check("0 questions left" in page.inner_text("#budget"), f"[{tag}] daily cap shows 0 left")
            state["cap_hit"] = False

            # 7b. easter egg: just the reply, no table, no Think harder, not saved as a recent question
            page.fill("#q", "a testegg question")
            page.click("#askBtn")
            page.wait_for_selector("#entry .answer >> text=Egg reply")
            check(page.locator("#entry table, #entry .empty-rows, #entry .meta, #harderBtn").count() == 0,
                  f"[{tag}] easter egg shows only the reply")
            check("testegg" not in page.inner_text("#recent"), f"[{tag}] easter egg isn't saved as a recent question")

            # 8. reload remembers passcode + asker, opens without the gate
            page.reload()
            page.wait_for_selector("#app:not([hidden])")
            check(page.is_hidden("#gate"), f"[{tag}] reload skips the gate")
            check("Asking as Tom" in " ".join(page.inner_text("#who").split()), f"[{tag}] reload remembers who you are")
            check(page.locator("#recent button").count() >= 1, f"[{tag}] recent questions remembered")

            # 9. forget device
            page.click("#forget")
            check(page.is_visible("#gate"), f"[{tag}] Forget this device returns to the gate")

            # layout: no horizontal page scroll
            sw = page.evaluate("document.documentElement.scrollWidth"); cw = page.evaluate("document.documentElement.clientWidth")
            check(sw <= cw, f"[{tag}] no horizontal page scroll ({sw} <= {cw})")
            check(all(ct and ct.startswith("text/plain") for ct in state["content_types"]), f"[{tag}] requests are simple text/plain (no CORS preflight)")
            check(not errors, f"[{tag}] no page errors {errors[:3]}")
            ctx.close()
    # Unlock link: #passcode opens straight in and is wiped from the address bar.
    for scheme in ["light"]:
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, color_scheme=scheme)
        page = ctx.new_page()
        state = {"calls": [], "content_types": []}
        page.route(ENDPOINT, router(state)); font_routes(page)
        page.goto(PAGE + "#keeper-sleeper-flex-18")
        page.wait_for_selector("#app:not([hidden])")
        check(page.is_hidden("#gate"), "[link] unlock link skips the passcode screen")
        check("#" not in page.url and "keeper" not in page.url, f"[link] passcode wiped from the address bar ({page.url})")
        check(page.evaluate("localStorage.getItem('franny.passcode')") == "keeper-sleeper-flex-18", "[link] passcode remembered on the device")
        page.click("#skipPick")
        page.goto(PAGE)  # plain link afterwards still works
        page.wait_for_selector("#app:not([hidden])")
        check(page.is_hidden("#gate"), "[link] plain link works after unlocking once")
        ctx.close()

        ctx = browser.new_context(viewport={"width": 390, "height": 844}, color_scheme=scheme)
        page = ctx.new_page()
        state = {"calls": [], "content_types": []}
        page.route(ENDPOINT, router(state)); font_routes(page)
        page.goto(PAGE + "#old-passcode")
        page.wait_for_selector("#gate:not([hidden])")
        page.wait_for_selector("#gateNotice:not([hidden])")
        check("old passcode" in page.inner_text("#gateNotice"), "[link] link with a wrong passcode explains itself")
        check(page.evaluate("localStorage.getItem('franny.passcode')") is None, "[link] wrong passcode not remembered")
        ctx.close()

    browser.close()

print("\n%d problem(s)" % len(problems))
sys.exit(1 if problems else 0)

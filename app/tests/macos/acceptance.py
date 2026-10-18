#!/usr/bin/env python3
"""WP-02 acceptance tests on macOS (SPEC 9.1 WP-02 tests 1 to 4, plus the macOS side of test 5).

Runs the real app binary on this Mac's real screen and checks it from outside with its own test tools
(zorder, warp, a window-server hit test inside a helper window, lsappinfo) plus the app's own test log.
Python standard library only. Usage: acceptance.py <output dir>   (run-acceptance.sh builds everything first)

Statuses: pass, fail, blocked (needs a permission or hardware this machine does not have; says which).
Synthetic clicks need the Accessibility / PostEvent permission; without it, click routing is checked with
the window server's own hit test (NSWindow.windowNumber(at:)), asked by the strip process and by a helper
window placed under the strip. That is the same oracle the earlier stack spike used.
"""
import json
import os
import pathlib
import subprocess
import sys
import time
import traceback

HERE = pathlib.Path(__file__).resolve().parent
APP_DIR = HERE.parents[1]
TOOLS = HERE / "tools" / "bin"
BIN = os.environ.get("BUSYHOLM_BIN") or str(APP_DIR / "src-tauri" / "target" / "debug" / "busyholm")
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else APP_DIR / "tests" / "out" / "macos").resolve()
OUT.mkdir(parents=True, exist_ok=True)
RESULTS = []
APP_RUNS = []


def record(test, name, status, detail):
    RESULTS.append({"test": test, "name": name, "status": status, "detail": detail})
    print(f"[{status.upper():7}] {test} {name}: {json.dumps(detail)[:400]}", flush=True)


def tool(name, *args, timeout=30):
    return subprocess.run([str(TOOLS / name), *map(str, args)], capture_output=True, text=True, timeout=timeout)


def frontmost():
    return subprocess.run(["bash", str(HERE / "tools" / "frontmost.sh")], capture_output=True, text=True).stdout.strip()


def warp(x, y):
    tool("warp", f"{x:.1f}", f"{y:.1f}")


def cursor():
    a = tool("warp", "--get").stdout.split()
    return float(a[0]), float(a[1])


def windows_of(pid):
    rows = json.loads(tool("zorder", "--pid", pid, "--json").stdout)["windows"]
    return [r for r in rows if r["pid"] == pid]


def screens():
    return json.loads(tool("screens").stdout)


def read_jsonl(path):
    out = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass  # a partial last line
    except FileNotFoundError:
        pass
    return out


class App:
    def __init__(self, tag, *extra, exit_after=60):
        self.tag = tag
        self.log = OUT / f"{tag}.log"
        self.data = OUT / f"data-{tag}"
        args = [BIN, "--data-dir", str(self.data), "--test-log", str(self.log), "--mock-collector", "--mock-static",
                "--strip-page", "placeholder/strip.html", "--test-freeze", "--test-fixed-rect",
                "--exit-after", str(exit_after), *extra]
        self.p = subprocess.Popen(args, stdout=open(OUT / f"{tag}.stdout", "w"), stderr=subprocess.STDOUT)
        self.pid = self.p.pid

    def events(self, name=None):
        ev = read_jsonl(self.log)
        return [e for e in ev if name is None or e.get("event") == name]

    def wait(self, pred, timeout):
        end = time.time() + timeout
        while time.time() < end:
            for e in self.events():
                if pred(e):
                    return e
            if self.p.poll() is not None:
                break
            time.sleep(0.1)
        for e in self.events():
            if pred(e):
                return e
        return None

    def alive(self):
        return self.p.poll() is None

    def stop(self):
        if self.p.poll() is None:
            self.p.terminate()
            try:
                self.p.wait(5)
            except subprocess.TimeoutExpired:
                self.p.kill()
                self.p.wait(5)
        APP_RUNS.append({"tag": self.tag, "returncode": self.p.returncode})
        time.sleep(1.0)  # let WebKit helper processes of this run go away before the next launch

    def diagnose(self):
        """The app did not come up: keep a stack sample of it for the report."""
        if self.p.poll() is None:
            subprocess.run(["sample", str(self.pid), "2", "-file", str(OUT / f"{self.tag}.sample.txt")],
                           capture_output=True, timeout=30)
        return {"alive": self.p.poll() is None, "returncode": self.p.returncode,
                "sample": str(OUT / f"{self.tag}.sample.txt") if self.p.poll() is None else None}


def ev_is(name, **kv):
    return lambda e: e.get("event") == name and all(e.get("data", {}).get(k) == v for k, v in kv.items())


def strip_window(app):
    return [w for w in windows_of(app.pid) if w["bounds"][3] > 0 and w["layer"] != 1000 and w["bounds"][2] > 400]


def wait_shown(app, timeout=25):
    e = app.wait(ev_is("strip_visibility", visible=True), timeout)
    if e is None:
        print(f"  app {app.tag} did not show the strip: {app.diagnose()}", flush=True)
    return e


def wait_rects(app, timeout=15):
    return app.wait(lambda e: e.get("event") == "hit_rects" and e["data"].get("count", 0) > 0, timeout)


# ------------------------------------------------------------------------------------------------
PROBE_CLICK = False


def probe_click_permission():
    # Preflight only: `clicker --check` never posts an event (an off-screen probe click would be
    # clamped to the screen edge and land a real click there).
    global PROBE_CLICK
    r = tool("clicker", "--check")
    PROBE_CLICK = r.returncode == 0
    return PROBE_CLICK


def test1_focus():
    before = frontmost()
    app = App("t1-focus")
    try:
        shown = wait_shown(app)
        if not shown:
            record("1", "frontmost app unchanged after the strip appears", "fail", {"reason": "strip never reported visible", "alive": app.alive()})
            return
        t0 = shown["t"]
        samples = {}
        for at in (2.0, 5.0):
            time.sleep(max(0.0, t0 + at - time.time()))
            samples[f"{at:.0f}s"] = frontmost()
        ok = all(v == before for v in samples.values()) and before != ""
        record("1", "frontmost app unchanged 2 s and 5 s after the strip appears", "pass" if ok else "fail",
               {"before": before, **samples})
        win = app.events("window")
        strip = [w["data"] for w in win if w["data"].get("label") == "strip"]
        detail = strip[-1] if strip else {}
        non_act = detail.get("nonactivating") is True and detail.get("can_become_key") is False
        record("1", "strip is a non-activating panel that cannot become key (structural)", "pass" if non_act else "fail",
               {k: detail.get(k) for k in ("ns_level", "collection_behavior", "panel", "nonactivating", "can_become_key", "activation_policy")})
        if not probe_click_permission():
            record("1", "frontmost app unchanged 2 s and 5 s after a real click on a resident", "blocked",
                   {"reason": "no Accessibility/PostEvent permission for synthetic clicks (CGPreflightPostEventAccess false); grant it to the terminal running this script to run this check"})
            return
        rects = wait_rects(app)
        place = app.events("placement")[-1]["data"]
        sx, sy = place["logical"][0], place["logical"][1]
        r = rects["data"]["rects"][0]
        cx, cy = sx + r[0] + r[2] / 2, sy + r[1] + r[3] / 2
        orig = cursor()
        warp(cx, cy)
        time.sleep(0.6)
        tool("clicker", f"{cx:.1f}", f"{cy:.1f}")
        tc = time.time()
        got = {}
        for at in (2.0, 5.0):
            time.sleep(max(0.0, tc + at - time.time()))
            got[f"{at:.0f}s"] = frontmost()
        warp(*orig)
        clicked = app.wait(ev_is("page_event", name="resident_click"), 2) is not None
        ok = clicked and all(v == before for v in got.values())
        record("1", "frontmost app unchanged 2 s and 5 s after a real click on a resident", "pass" if ok else "fail",
               {"before": before, **got, "strip_received_click": clicked})
    finally:
        app.stop()


def latest_after(events, t_min, key="t"):
    xs = [e for e in events if e.get(key, 0) >= t_min]
    return xs[-1] if xs else None


def test2_click_routing():
    app = App("t2-click", "--oracle")
    helper = None
    orig = cursor()
    try:
        if not wait_shown(app) or not wait_rects(app):
            record("2", "click routing: empty strip goes through, resident goes to the strip", "fail",
                   {"reason": "strip or hit rects never reported", "alive": app.alive()})
            return
        place = app.events("placement")[-1]["data"]
        sx, sy, sw, sh = place["logical"]
        rects = app.events("hit_rects")[-1]["data"]["rects"]
        # The fixed test sprite: the rect nearest the horizontal centre.
        r = min(rects, key=lambda q: abs(q[0] + q[2] / 2 - sw / 2))
        res = (sx + r[0] + r[2] / 2, sy + r[1] + r[3] / 2)
        empty = None
        for fx in (0.05, 0.15, 0.3, 0.7, 0.9):
            px, py = sw * fx, 10.0
            if not any(q[0] <= px < q[0] + q[2] and q[1] <= py < q[1] + q[3] for q in rects):
                empty = (sx + px, sy + py)
                break
        hlog = OUT / "t2-testwin.jsonl"
        helper = subprocess.Popen([str(TOOLS / "testwin"), f"{sx:.0f}", f"{sy:.0f}", f"{sw:.0f}", f"{sh:.0f}", "40"],
                                  stdout=open(hlog, "w"), stderr=subprocess.DEVNULL)
        time.sleep(1.5)

        def probe(label, pt, settle=1.4):
            tw = time.time()
            warp(*pt)
            time.sleep(settle)
            o = latest_after(app.events("oracle"), tw + 0.5)
            h = latest_after(read_jsonl(hlog), tw + 0.5)
            return {"where": label, "point": [round(pt[0], 1), round(pt[1], 1)],
                    "to_strip": None if o is None else o["data"]["click_goes_to_strip"],
                    "to_window_beneath": None if h is None else h.get("lands_on_me"),
                    "ignoring": None if o is None else o["data"]["ignoring"],
                    "faded": None if o is None else o["data"].get("faded")}

        steps = [probe("resident", res), probe("empty strip (dwell > 400 ms: hover-fade)", empty),
                 probe("resident while faded", res), probe("outside the strip", (sx + sw / 2, sy - 150)),
                 probe("resident again", res)]
        # (click goes to the strip, click goes to the window beneath). None: not checked. Outside the
        # strip the oracle does not sample (it runs only near the strip), so "not the strip" there is
        # None or False; everywhere else the oracle must have answered.
        want = [(True, False), (False, True), (False, True), (None, None), (True, False)]
        ok = True
        for s, (ws, wb) in zip(steps, want):
            if ws is None:
                if s["to_strip"]:
                    ok = False
            elif s["to_strip"] is not ws:
                ok = False
            if wb is not None and s["to_window_beneath"] is not wb:
                ok = False
        fade_on = app.wait(ev_is("fade", on=True), 0.5) is not None
        fade_off = app.wait(ev_is("fade", on=False), 0.5) is not None
        record("2", "click routing by the window server: resident to the strip, empty strip to the window beneath", "pass" if ok else "fail",
               {"steps": steps})
        record("2", "hover-fade turns on after 400 ms over empty strip and off on leave", "pass" if (fade_on and fade_off) else "fail",
               {"fade_on": fade_on, "fade_off": fade_off})
        if PROBE_CLICK:
            warp(*empty)
            time.sleep(0.6)
            tool("clicker", f"{empty[0]:.1f}", f"{empty[1]:.1f}")
            time.sleep(0.8)
            got_beneath = any(e.get("event") == "mouse_down" for e in read_jsonl(hlog))
            record("2", "real synthetic click on empty strip reaches the window beneath", "pass" if got_beneath else "fail", {})
        else:
            record("2", "real synthetic click (not just the window-server hit test)", "blocked",
                   {"reason": "no Accessibility/PostEvent permission for synthetic clicks"})
    finally:
        warp(*orig)
        if helper:
            helper.terminate()
        app.stop()


def test3_geometry():
    app = App("t3-geometry")
    try:
        if not wait_shown(app):
            record("3", "strip bottom equals the work-area bottom (live, this Mac)", "fail", {"reason": "strip never shown", "alive": app.alive()})
            return
        time.sleep(1.0)
        sc = screens()
        wins = strip_window(app)
        if not wins:
            record("3", "strip bottom equals the work-area bottom (live, this Mac)", "fail", {"reason": "no strip window on screen", "windows": windows_of(app.pid)})
            return
        b = wins[0]["bounds"]
        # The screen whose frame contains the strip window.
        scr = next((s for s in sc if s["frame"][0] <= b[0] < s["frame"][0] + s["frame"][2] and s["frame"][1] <= b[1] < s["frame"][1] + s["frame"][3]), sc[0])
        v = scr["visible"]
        win_bottom, work_bottom = b[1] + b[3], v[1] + v[3]
        settings_h = 112
        ok = abs(win_bottom - work_bottom) <= 1 and abs(b[0] - v[0]) <= 1 and abs(b[2] - v[2]) <= 1 and abs(b[3] - settings_h) <= 1
        record("3", "strip bottom equals the work-area bottom (live, this Mac)", "pass" if ok else "fail",
               {"window_bounds_pts": b, "work_area_pts": v, "screen": scr["name"], "scale": scr["scale"],
                "dock": "bottom" if v[1] + v[3] < scr["frame"][1] + scr["frame"][3] else "hidden or side"})
        record("3", "other matrix cells (Dock left, auto-hide, 150% scale, taskbar top)", "blocked",
               {"reason": "would change this Mac's Dock and display settings; covered by the pure geometry matrix test (cargo test --test geometry) and the Windows CI job"})
    finally:
        app.stop()


def test4_fullscreen():
    app = App("t4-fullscreen", exit_after=80)
    fs = None
    try:
        if not wait_shown(app):
            record("4", "the strip hides while another app is fullscreen", "fail", {"reason": "strip never shown", "alive": app.alive()})
            return
        time.sleep(1.0)
        on_before = len(strip_window(app)) > 0
        t_fs = time.time()
        fs = subprocess.Popen([str(TOOLS / "fsapp"), "8"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        hidden = app.wait(lambda e: e.get("event") == "strip_visibility" and e["data"].get("visible") is False
                          and e["data"].get("reason") == "fullscreen" and e["t"] >= t_fs, 7)
        time.sleep(0.5)
        on_during = len(strip_window(app)) > 0
        fs.wait(20)
        t_exit = time.time()
        back = app.wait(lambda e: e.get("event") == "strip_visibility" and e["data"].get("visible") is True and e["t"] >= t_exit - 1.0, 8)
        time.sleep(0.8)
        on_after = len(strip_window(app)) > 0
        ok = on_before and hidden is not None and not on_during and back is not None and on_after
        record("4", "the strip hides while another app is fullscreen, and returns after", "pass" if ok else "fail",
               {"on_screen_before": on_before, "hidden_event": hidden is not None,
                "hide_latency_s": None if hidden is None else round(hidden["t"] - t_fs, 2),
                "on_screen_during": on_during, "shown_again_event": back is not None, "on_screen_after": on_after})
    finally:
        if fs and fs.poll() is None:
            fs.terminate()
        app.stop()


def test5_mac_fallback():
    app = App("t5-reserve", "--layer", "reserve_space")
    try:
        lay = app.wait(lambda e: e.get("event") == "layer", 20)
        wait_shown(app)
        time.sleep(0.8)
        wins = strip_window(app)
        d = lay["data"] if lay else {}
        ok = d.get("requested") == "reserve_space" and d.get("effective") == "on_top" and d.get("reason") == "unsupported" and wins and wins[0]["layer"] == 3
        record("5", "macOS: reserve space is unavailable and falls back to on top (Windows and X11 parts run in CI)", "pass" if ok else "fail",
               {"layer_event": d, "window_layer": wins[0]["layer"] if wins else None})
    finally:
        app.stop()


def extra_layers():
    app = App("x-behind", "--layer", "behind_windows")
    try:
        wait_shown(app)
        time.sleep(0.8)
        wins = strip_window(app)
        ok = bool(wins) and wins[0]["layer"] < 0
        record("x", "behind-windows layer puts the strip below normal windows", "pass" if ok else "fail",
               {"window_layer": wins[0]["layer"] if wins else None})
        tray = app.wait(lambda e: e.get("event") == "tray_rect" and e["data"].get("rect") is not None, 5)
        auto = app.wait(lambda e: e.get("event") == "autostart", 5)
        record("x", "tray icon placed by the OS; autostart off by default", "pass" if (tray and auto and auto["data"].get("enabled") is False) else "fail",
               {"tray": tray["data"] if tray else None, "autostart": auto["data"] if auto else None})
        world = app.wait(lambda e: e.get("event") == "world_inputs", 5)
        record("x", "world inputs (seed, ledger, choices) reach the pages after the collector's ledger", "pass" if (world and world["data"].get("days", 0) > 0) else "fail",
               {"world_inputs": world["data"] if world else None})
        idle = app.wait(lambda e: e.get("event") == "idle_trigger", 5)
        record("x", "ambient is manual by default: the idle trigger reports itself off", "pass" if (idle and idle["data"].get("enabled") is False) else "fail",
               {"idle_trigger": idle["data"] if idle else None})
    finally:
        app.stop()


def extra_ambient():
    before = frontmost()
    app = App("x-ambient", "--open", "ambient", "--test-close-ambient-after", "4", exit_after=30)
    try:
        opened = app.wait(ev_is("ambient", open=True), 15)
        time.sleep(0.8)
        wins = windows_of(app.pid)
        amb = [w for w in wins if w["layer"] == 1000]
        hidden = app.wait(lambda e: e.get("event") == "strip_visibility" and e["data"].get("reason") == "ambient", 3)
        sc = screens()[0]["frame"]
        covers = bool(amb) and [round(v) for v in amb[0]["bounds"]] == [round(v) for v in sc]
        closed = app.wait(ev_is("ambient", open=False), 10)
        time.sleep(1.5)
        gone = not any(w["layer"] == 1000 for w in windows_of(app.pid))
        back = app.wait(lambda e: e.get("event") == "strip_visibility" and e["data"].get("visible") is True
                        and closed is not None and e["t"] >= closed["t"] - 0.1, 3)
        after = frontmost()
        ok = opened and covers and hidden and closed and gone and back
        record("x", "ambient window on demand: level 1000 over the whole display, strip hidden, destroyed on exit, strip back",
               "pass" if ok else "fail", {"ambient_bounds": amb[0]["bounds"] if amb else None, "screen": sc, "strip_hidden": hidden is not None,
                                          "destroyed": gone, "strip_back": back is not None})
        record("x", "after ambient closes, the previously frontmost app is frontmost again", "pass" if after == before else "fail",
               {"before": before, "after": after})
    finally:
        app.stop()


def extra_raise():
    app = App("x-raise", "--layer", "behind_windows", "--mock-fixture", "005-needs-you")
    try:
        wait_shown(app)
        raised = app.wait(lambda e: e.get("event") == "layer" and e["data"].get("reason") == "needs_you", 10)
        time.sleep(0.8)
        wins = strip_window(app)
        ok = raised is not None and bool(wins) and wins[0]["layer"] == 3
        record("x", "behind windows: the strip raises itself on top while an agent needs you", "pass" if ok else "fail",
               {"layer_event": raised["data"] if raised else None, "window_layer": wins[0]["layer"] if wins else None})
    finally:
        app.stop()


def extra_popover():
    app = App("x-popover", "--open", "popover", exit_after=20)
    try:
        wait_shown(app)
        ev = app.wait(lambda e: e.get("event") == "window" and e["data"].get("label") == "popover", 12)
        tray = app.wait(lambda e: e.get("event") == "tray_rect" and e["data"].get("rect") is not None, 6)
        time.sleep(0.5)
        pts = [w for w in windows_of(app.pid) if abs(w["bounds"][2] - 360) <= 1 and abs(w["bounds"][3] - 480) <= 1]
        ok = ev is not None and tray is not None and bool(pts)
        detail = {"popover_bounds": pts[0]["bounds"] if pts else None, "tray_rect_px": tray["data"]["rect"] if tray else None}
        if ok:
            b, r = pts[0]["bounds"], [v / 2.0 for v in tray["data"]["rect"]]  # tray rect is physical px at 2x
            under = b[1] >= r[1] + r[3] - 1 and b[1] - (r[1] + r[3]) < 20
            centred = abs((b[0] + b[2] / 2) - (r[0] + r[2] / 2)) <= 1 or b[0] + b[2] >= screens()[0]["frame"][2] - 9
            ok = under and centred
            detail.update({"under_tray": under, "centred_or_clamped": centred})
        record("x", "popover opens attached under the tray icon", "pass" if ok else "fail", detail)
    finally:
        app.stop()


def extra_single_instance():
    a = App("x-single-a", "--single-instance", exit_after=40)
    b = None
    try:
        if not wait_shown(a):
            record("x", "single instance: a second launch focuses the first and exits", "fail", {"reason": "first instance never showed the strip"})
            return
        b = App("x-single-b", "--single-instance", exit_after=40)
        try:
            b.p.wait(15)
        except subprocess.TimeoutExpired:
            pass
        b_code = b.p.returncode
        b_strip = any(e.get("event") == "strip_visibility" for e in b.events())
        second = a.wait(lambda e: e.get("event") == "second_instance", 8)
        details = a.wait(lambda e: e.get("event") == "window" and e["data"].get("label") == "details", 8)
        ok = b_code == 0 and not b_strip and second is not None and details is not None
        record("x", "single instance: a second launch focuses the first (details window) and exits", "pass" if ok else "fail",
               {"second_exit_code": b_code, "second_showed_a_strip": b_strip, "first_saw_second": second is not None,
                "details_opened": details is not None})
    finally:
        if b:
            b.stop()
        a.stop()


def main():
    if not pathlib.Path(BIN).exists():
        print(f"app binary missing: {BIN}", file=sys.stderr)
    tests = sys.argv[2].split(",") if len(sys.argv) > 2 else ["1", "2", "3", "4", "5", "x"]
    probe_click_permission()
    order = [("1", test1_focus), ("2", test2_click_routing), ("3", test3_geometry), ("5", test5_mac_fallback),
             ("x", extra_layers), ("x", extra_raise), ("x", extra_popover), ("x", extra_ambient), ("x", extra_single_instance),
             ("4", test4_fullscreen)]
    for k, fn in order:
        if k in tests:
            try:
                fn()
            except Exception as ex:  # a crash in the harness is a failure, never a pass
                record(k, f"harness error in {fn.__name__}", "fail", {"error": repr(ex), "trace": traceback.format_exc()[-1500:]})
    (OUT / "results.json").write_text(json.dumps({"results": RESULTS, "app_runs": APP_RUNS}, indent=2))
    n = {s: sum(1 for r in RESULTS if r["status"] == s) for s in ("pass", "fail", "blocked")}
    print(f"\nWP-02 macOS acceptance: {n['pass']} pass, {n['fail']} fail, {n['blocked']} blocked  ->  {OUT / 'results.json'}")
    sys.exit(1 if n["fail"] else 0)


if __name__ == "__main__":
    main()

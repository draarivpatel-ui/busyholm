#!/usr/bin/env python3
"""WP-12 acceptance tests on macOS (SPEC 9.1 WP-12 tests 1 to 4, end to end on this Mac).

Runs the real app. The idle clock is moved through a file (debug builds only, BUSYHOLM_FAKE_IDLE_FILE)
because nobody is at the keyboard; the cursor is moved with CGWarpMouseCursorPosition (no permission).
Real synthetic keys and clicks need the Accessibility/PostEvent permission this session does not have,
so that part is `blocked` and replaced by structural checks (see test 2b/2c). Python standard library only.
Usage: ambient.py <output dir> [tests, e.g. 1,2,3,4]     (run-ambient.sh builds everything first)
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import traceback

ARGV = list(sys.argv)
HERE = pathlib.Path(__file__).resolve().parent
OUTDIR = sys.argv[1] if len(sys.argv) > 1 else str(HERE.parents[1] / "tests" / "out" / "macos-ambient")
sys.argv = [sys.argv[0], OUTDIR]
sys.path.insert(0, str(HERE))
import acceptance as A  # noqa: E402  (helpers: App, record, tool, windows_of, screens, ev_is, ...)

OUT = A.OUT
REPO = A.APP_DIR.parent
DISPLAY_TYPES = ("PreventUserIdleDisplaySleep", "NoDisplaySleepAssertion", "PreventDisplaySleep")


class Amb(A.App):
    """The app with the debug test hooks and a real (unfrozen) ambient page."""

    def __init__(self, tag, *extra, env=None, idle_minutes=None, idle=None, exit_after=90):
        self.tag = tag
        self.log = OUT / f"{tag}.log"
        self.data = OUT / f"data-{tag}"
        self.idle_file = OUT / f"idle-{tag}.txt"
        base = [A.BIN, "--data-dir", str(self.data), "--test-log", str(self.log), "--mock-collector", "--mock-static",
                "--exit-after", str(exit_after)]
        if idle_minutes is not None:
            self.write_idle_minutes(idle_minutes)
        e = dict(os.environ)
        if idle is not None:
            self.idle_file.write_text(str(idle))
            e["BUSYHOLM_FAKE_IDLE_FILE"] = str(self.idle_file)
            e["BUSYHOLM_IDLE_TRIGGER"] = "on"
        e.update(env or {})
        self.before = set(webkit_pids())
        self.p = subprocess.Popen(base + list(extra), stdout=open(OUT / f"{tag}.stdout", "w"), stderr=subprocess.STDOUT, env=e)
        self.pid = self.p.pid

    def write_idle_minutes(self, minutes):
        self.data.mkdir(parents=True, exist_ok=True)
        f = self.data / "settings.json"
        if not f.exists():  # let the app write its defaults once, then edit them
            subprocess.run([A.BIN, "--data-dir", str(self.data), "--exit-after", "1", "--mock-collector", "--mock-static"],
                           capture_output=True, timeout=30)
            time.sleep(1.0)
        s = json.loads(f.read_text())
        s["ambient"]["idle_minutes"] = minutes
        f.write_text(json.dumps(s))

    def set_idle(self, seconds):
        self.idle_file.write_text(str(seconds))


def webkit_pids():
    out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
    return [int(l.split(None, 1)[0]) for l in out.splitlines() if "com.apple.WebKit" in l]


def open_events(app):
    return [e for e in app.events("ambient")]


def is_open(app):
    ev = open_events(app)
    return bool(ev) and ev[-1]["data"].get("open") is True


def wait_open(app, timeout, want=True):
    return app.wait(A.ev_is("ambient", open=want), timeout)


def settle_closed(app, secs):
    """True when no ambient scene opened during the next `secs` seconds."""
    t0 = time.time()
    time.sleep(secs)
    return not any(e["t"] >= t0 and e["data"].get("open") for e in open_events(app))


def state_of(app):
    return [e["data"].get("state") for e in app.events("idle_trigger")]


# ------------------------------------------------------------------------------------------------
# Test 1: the idle trigger, end to end with a fake idle clock
# ------------------------------------------------------------------------------------------------
def test1_trigger():
    app = Amb("t1-trigger", idle_minutes=5, idle=299.0, env={"BUSYHOLM_FAKE_MEDIA": "off", "BUSYHOLM_FAKE_FULLSCREEN": "off"}, exit_after=60)
    try:
        if not app.wait(A.ev_is("strip_visibility", visible=True), 25):
            A.record("1", "idle trigger end to end", "fail", {"reason": "app did not come up", **app.diagnose()})
            return
        quiet = settle_closed(app, 3.0)
        t_set = time.time()
        app.set_idle(300.0)
        opened = wait_open(app, 6)
        lat = None if opened is None else round(opened["t"] - t_set, 2)
        A.record("1", "fake idle source: no scene at 299 s, a scene starts when idle reaches the 5 min threshold",
                 "pass" if quiet and opened is not None and lat <= 2.5 else "fail", {"quiet_below_threshold": quiet, "opened": opened is not None, "latency_s": lat})
        if opened is None:
            return
        time.sleep(1.5)
        t_in = time.time()
        app.set_idle(0.0)  # "input": the idle clock resets while the cursor does not move
        closed = wait_open(app, 3, want=False)
        gexit = app.wait(A.ev_is("ambient_exit", by="guard"), 0.5)
        lat = None if closed is None else round(closed["t"] - t_in, 3)
        A.record("2", "idle-started scene ends when the idle clock resets (a key or click) within 100 ms of the guard's poll",
                 "pass" if closed is not None and lat <= 0.25 else "fail",
                 {"closed_latency_s": lat, "guard_event": gexit["data"] if gexit else None,
                  "note": "the fake idle file stands in for a real key press; real posting is blocked (see 2b)"})
        # No immediate bounce back in: idle is now small, then climbs back over the threshold = new scene.
        again = settle_closed(app, 2.5)
        A.record("1", "after the exit the trigger does not bounce straight back in", "pass" if again else "fail", {})
        app.set_idle(310.0)
        reopened = wait_open(app, 6)
        A.record("1", "once the user has been active (idle reset) and idles again, it starts again", "pass" if reopened else "fail", {})
    finally:
        app.stop()


def test1_skip_fullscreen():
    app = Amb("t1-fullscreen", idle_minutes=5, idle=299.0, env={"BUSYHOLM_FAKE_MEDIA": "off"}, exit_after=80)
    fs = None
    try:
        # The idle clock starts low so no scene opens at launch; a real fullscreen app is started first.
        if not A.wait_shown(app):
            A.record("1", "never starts over a fullscreen app", "fail", {"reason": "app did not come up"})
            return
        time.sleep(1.0)
        t_fs = time.time()
        fs = subprocess.Popen([str(A.TOOLS / "fsapp"), "14"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        hidden = app.wait(lambda e: e.get("event") == "strip_visibility" and e["data"].get("reason") == "fullscreen" and e["data"].get("visible") is False and e["t"] >= t_fs, 8)
        time.sleep(1.0)
        app.set_idle(301.0)
        during = settle_closed(app, 6.0)
        skip = [s for s in state_of(app) if s and s.startswith("skipped")]
        t_ex = time.time()
        fs.wait(30)
        reopened = wait_open(app, 25)
        lat = None if reopened is None else round(reopened["t"] - t_ex, 1)
        A.record("1", "REAL fullscreen app on the strip's display: no scene while it is fullscreen, one starts after it ends",
                 "pass" if hidden is not None and during and skip and reopened is not None else "fail",
                 {"fullscreen_seen": hidden is not None, "no_scene_during_fullscreen": during, "skip_state_logged": skip[:1],
                  "scene_after_fullscreen_ended": reopened is not None, "seconds_after_exit": lat})
    finally:
        if fs and fs.poll() is None:
            fs.terminate()
        app.stop()


def test1_skip_media():
    app = Amb("t1-media", idle_minutes=5, idle=301.0, env={"BUSYHOLM_FAKE_MEDIA": "on", "BUSYHOLM_FAKE_FULLSCREEN": "off"}, exit_after=40)
    try:
        if not A.wait_shown(app):
            A.record("1", "never starts during a call or video", "fail", {"reason": "app did not come up"})
            return
        quiet = settle_closed(app, 7.0)
        skip = [s for s in state_of(app) if s and s.startswith("skipped")]
        A.record("1", "call or video active (fake probe): idle past the threshold still starts nothing, and the log says why",
                 "pass" if quiet and skip else "fail", {"quiet": quiet, "state": skip[:1]})
    finally:
        app.stop()


def test1_gate_and_optout():
    for tag, kw, env, name in [
        ("t1-gate", dict(idle_minutes=5, idle=999.0), {"BUSYHOLM_IDLE_TRIGGER": "off"}, "per-OS verification gate closed (the shipped state): no scene however idle"),
        ("t1-optout", dict(idle_minutes=None, idle=999.0), {}, "user opt-out (idle_minutes null, the default): no scene however idle"),
    ]:
        app = Amb(tag, env=env, exit_after=30, **kw)
        try:
            if not A.wait_shown(app):
                A.record("1", name, "fail", {"reason": "app did not come up"})
                continue
            quiet = settle_closed(app, 5.0)
            st = app.events("idle_trigger")
            A.record("1", name, "pass" if quiet and st and st[0]["data"]["enabled"] is False else "fail", {"quiet": quiet, "state": st[0]["data"] if st else None})
        finally:
            app.stop()


# ------------------------------------------------------------------------------------------------
# Test 2: exit on input
# ------------------------------------------------------------------------------------------------
def display_frame():
    return A.screens()[0]["frame"]


def test2_exit():
    app = Amb("t2-exit", "--open", "ambient", exit_after=60)
    orig = A.cursor()
    try:
        opened = wait_open(app, 20)
        if not opened:
            A.record("2", "exit on a mouse move over 8 px", "fail", {"reason": "ambient never opened", **app.diagnose()})
            return
        time.sleep(2.2)  # opening gesture grace (0.6 s + 0.9 s for a hand-started scene) plus the baseline sample
        cx, cy = A.cursor()  # the guard's baseline is wherever the cursor has been resting
        still_open = is_open(app)
        # a 5 px nudge from the baseline stays open
        r = A.tool("warpt", cx + 5, cy)
        time.sleep(0.8)
        small_ok = is_open(app)
        # a move over 8 px from the baseline exits; time it
        r = A.tool("warpt", cx + 20, cy + 3)
        t_warp = float(r.stdout.strip())
        closed = wait_open(app, 3, want=False)
        gexit = app.wait(A.ev_is("ambient_exit", by="guard"), 0.3)
        lat_close = None if closed is None else round(closed["t"] - t_warp, 3)
        lat_guard = None if gexit is None else round(gexit["t"] - t_warp, 3)
        ok = still_open and small_ok and closed is not None and lat_close <= 0.1
        A.record("2", "mouse move: 5 px keeps the scene, a move over 8 px closes it within 100 ms of the move",
                 "pass" if ok else "fail", {"stayed_open_after_centering": still_open, "stayed_open_at_5px": small_ok, "guard_detect_s": lat_guard,
                                            "window_closed_s": lat_close, "reason": gexit["data"] if gexit else None})
        time.sleep(1.0)
        after = [w for w in A.windows_of(app.pid) if w["layer"] == 1000]
        A.record("2", "after the exit no level-1000 window is left", "pass" if not after else "fail", {"left": len(after)})
    finally:
        A.warp(*orig)
        app.stop()


def test2_structural():
    """Real clicks/keys cannot be posted here; show instead that nothing underneath can receive them."""
    perm = A.probe_click_permission()
    A.record("2", "real synthetic click/key into the scene (CGEventPost)", "pass" if perm else "blocked",
             {"reason": None if perm else "Accessibility/PostEvent permission missing for this session; run again after granting it to the terminal"})
    app = Amb("t2-struct", "--open", "ambient", exit_after=40)
    try:
        if not wait_open(app, 20):
            A.record("2", "structural: nothing underneath can receive input", "fail", {"reason": "ambient never opened"})
            return
        time.sleep(1.5)
        f = display_frame()
        amb = [w for w in A.windows_of(app.pid) if w["layer"] == 1000]
        covers = bool(amb) and [round(v) for v in amb[0]["bounds"]] == [round(v) for v in f]
        front = A.frontmost()
        rows = json.loads(A.tool("zorder", "--json").stdout)["windows"]
        mine = [r for r in rows if r["pid"] == app.pid and r["layer"] == 1000]
        z = mine[0]["zIndexFromFront"] if mine else 10**9
        # Every ordinary window (levels 0 to 5: normal, floating, docks) of any other app is behind the scene.
        above_ordinary = [(r["owner"], r["layer"]) for r in rows if r["pid"] != app.pid and 0 <= r["layer"] <= 5
                          and r["zIndexFromFront"] < z and r["bounds"][2] > 100 and r["bounds"][3] > 100]
        system_above = sorted({(r["owner"], r["layer"]) for r in rows if r["pid"] != app.pid and r["zIndexFromFront"] < z})
        ok = covers and bool(mine) and not above_ordinary and "usyholm" in front
        A.record("2", "structural: the scene (level 1000, the whole display) is above every ordinary window and is the frontmost app, so clicks and keys land on it and not on the app beneath",
                 "pass" if ok else "fail", {"covers_display": covers, "ordinary_windows_above_it": above_ordinary, "system_ui_above_it": system_above, "frontmost": front})
    finally:
        app.stop()


# ------------------------------------------------------------------------------------------------
# Test 3: no power assertion
# ------------------------------------------------------------------------------------------------
def assertions():
    txt = subprocess.run(["pmset", "-g", "assertions"], capture_output=True, text=True).stdout
    rows = re.findall(r"pid (\d+)\(([^)]*)\): \[[^\]]*\]\s+\S+\s+(\w+) named: \"([^\"]*)\"", txt)
    return [{"pid": int(p), "name": n, "type": t, "label": l} for p, n, t, l in rows], txt


def test3_pmset():
    app = Amb("t3-pmset", "--open", "ambient", exit_after=70)
    try:
        if not wait_open(app, 20):
            A.record("3", "no power assertion while ambient runs", "fail", {"reason": "ambient never opened"})
            return
        mine_total = set()
        before_rows, _ = assertions()
        samples = 0
        t_end = time.time() + 30
        while time.time() < t_end:
            rows, _ = assertions()
            new_wk = set(webkit_pids()) - app.before
            mine = {app.pid} | new_wk
            for r in rows:
                if r["pid"] in mine:
                    mine_total.add((r["pid"], r["name"], r["type"], r["label"]))
            samples += 1
            time.sleep(3)
        others = sorted({(r["name"], r["type"]) for r in before_rows})
        A.record("3", "no power assertion held by Busyholm or its WebKit helpers while ambient runs (10 samples of pmset -g assertions over 30 s)",
                 "pass" if not mine_total and samples >= 9 else "fail",
                 {"samples": samples, "assertions_owned_by_busyholm_or_new_webkit_processes": sorted(mine_total), "busyholm_pid": app.pid,
                  "other_apps_assertions_present_for_comparison": others})
        # and after it closed
        A.tool("warpt", 1, 1)
    finally:
        app.stop()


# ------------------------------------------------------------------------------------------------
# Test 4: CPU at 30 fps over 2 minutes
# ------------------------------------------------------------------------------------------------
def test4_cpu(duration=120):
    app = Amb("t4-cpu", "--open", "ambient", exit_after=duration + 60)
    try:
        if not wait_open(app, 20):
            A.record("4", "ambient CPU", "fail", {"reason": "ambient never opened"})
            return
        time.sleep(8)  # scene fade-in and first frames
        new_wk = sorted(set(webkit_pids()) - app.before)
        out = OUT / "t4-cpu-measure.json"
        cmd = [sys.executable, "-I", str(REPO / "tools" / "measure.py"), "--pid", str(app.pid), "--duration", str(duration), "--label", "wp12-ambient", "--json", str(out)]
        if new_wk:
            cmd += ["--extra-pids", ",".join(map(str, new_wk))]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=duration + 90)
        data = json.loads(out.read_text()) if out.exists() else {}
        cpu = data.get("total", {}).get("cpu_pct")
        A.record("4", f"ambient at 30 fps, {duration} s, summed over Busyholm and its WebKit helpers (budget 8% of one core)", "pass" if cpu is not None and cpu <= 8.0 else "fail",
                 {"measure": data if data else r.stdout[-600:], "still_open": is_open(app)})
    finally:
        app.stop()


ALL = [("1", test1_trigger), ("1", test1_skip_fullscreen), ("1", test1_skip_media), ("1", test1_gate_and_optout), ("2", test2_exit),
       ("2", test2_structural), ("3", test3_pmset), ("4", test4_cpu)]


def main():
    sel = ARGV[2].split(",") if len(ARGV) > 2 else ["1", "2", "3", "4"]
    A.probe_click_permission()
    for k, fn in ALL:
        if k in sel:
            try:
                fn()
            except Exception as ex:
                A.record(k, f"harness error in {fn.__name__}", "fail", {"error": repr(ex), "trace": traceback.format_exc()[-1500:]})
    (OUT / "results.json").write_text(json.dumps({"results": A.RESULTS, "app_runs": A.APP_RUNS}, indent=2))
    n = {s: sum(1 for r in A.RESULTS if r["status"] == s) for s in ("pass", "fail", "blocked")}
    print(f"\nWP-12 macOS ambient: {n['pass']} pass, {n['fail']} fail, {n['blocked']} blocked  ->  {OUT / 'results.json'}")
    sys.exit(1 if n["fail"] else 0)


if __name__ == "__main__":
    main()

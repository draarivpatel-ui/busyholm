#!/usr/bin/env python3
"""Idle CPU / memory / wakeup measurement for desktop apps (macOS only).

Method (identical for Tauri and Electron):
  * Process set = the app's main PID + every process whose macOS "responsible process" is that PID
    (covers WKWebView XPC helpers, which are launchd children, not children of the app) + every
    descendant by parent PID (covers Electron helpers). Each process is labelled by how it was found.
  * CPU %  = (user+system CPU time delta) / wall time over the window, from proc_pid_rusage
    (exact, not ps's decaying %cpu). 100% = one full core.
  * Memory = ri_phys_footprint at the end of the window (what Activity Monitor shows as "Memory"),
    plus resident size for reference.
  * Wakeups/s = (package idle wakeups + interrupt wakeups) delta / wall time (Activity Monitor's
    "Idle Wake Ups"; a good proxy for battery cost of an "idle" app).

  * Fallback for binaries exec'd from a terminal (their WebKit helpers are attributed to the terminal app,
    not to the binary): --extra-pids passes the com.apple.WebKit.* PIDs that appeared after launch
    (computed by the runner as a before/after PID-set diff); they are labelled "webkit-new".

Usage: measure.py --pid <app main pid> [--extra-pids a,b] [--duration 60] [--label text] [--json out.json]
"""
import argparse, ctypes, ctypes.util, json, subprocess, sys, time

libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)

class RUsageV2(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(n, ctypes.c_uint64) for n in (
        "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups", "pageins", "wired_size",
        "resident_size", "phys_footprint", "proc_start_abstime", "proc_exit_abstime",
        "child_user_time", "child_system_time", "child_pkg_idle_wkups", "child_interrupt_wkups",
        "child_pageins", "child_elapsed_abstime", "diskio_bytesread", "diskio_byteswritten")]

class Timebase(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]

tb = Timebase(); libc.mach_timebase_info(ctypes.byref(tb))
TICK_NS = tb.numer / tb.denom   # rusage CPU times are in mach absolute-time units on Apple Silicon

try:
    _resp = libc.responsibility_get_pid_responsible_for_pid
    _resp.restype = ctypes.c_int; _resp.argtypes = [ctypes.c_int]
except AttributeError:
    _resp = None

def rusage(pid):
    ru = RUsageV2()
    if libc.proc_pid_rusage(ctypes.c_int(pid), 2, ctypes.byref(ru)) != 0:
        return None
    return ru

def all_procs():
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,comm="], capture_output=True, text=True).stdout
    procs = {}
    for line in out.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            procs[int(parts[0])] = (int(parts[1]), parts[2])
    return procs

def process_set(main_pid, extra=()):
    procs = all_procs()
    found = {main_pid: "main"}
    # descendants by ppid (Electron helpers)
    frontier = [main_pid]
    while frontier:
        p = frontier.pop()
        for pid, (ppid, _) in procs.items():
            if ppid == p and pid not in found:
                found[pid] = "child"; frontier.append(pid)
    # responsibility (WKWebView XPC helpers spawned by launchd on behalf of the app)
    if _resp:
        for pid in procs:
            if pid not in found and pid > 1:
                try:
                    if _resp(pid) == main_pid:
                        found[pid] = "responsible"
                except Exception:
                    pass
    for pid in extra:
        if pid in procs and pid not in found:
            found[pid] = "webkit-new"
    return {pid: (how, procs.get(pid, (0, "?"))[1]) for pid, how in found.items()}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int, required=True)
    ap.add_argument("--duration", type=float, default=60)
    ap.add_argument("--label", default="")
    ap.add_argument("--json")
    ap.add_argument("--extra-pids", default="")
    a = ap.parse_args()

    extra = [int(x) for x in a.extra_pids.split(",") if x.strip()]
    pset = process_set(a.pid, extra)
    r0 = {pid: rusage(pid) for pid in pset}
    t0 = time.monotonic()
    time.sleep(a.duration)
    wall = time.monotonic() - t0
    rows = []
    for pid, (how, name) in sorted(pset.items()):
        s, e = r0[pid], rusage(pid)
        if s is None or e is None:
            rows.append(dict(pid=pid, how=how, name=name, error="gone or not readable")); continue
        cpu_ns = ((e.user_time + e.system_time) - (s.user_time + s.system_time)) * TICK_NS
        wk = (e.pkg_idle_wkups + e.interrupt_wkups) - (s.pkg_idle_wkups + s.interrupt_wkups)
        rows.append(dict(pid=pid, how=how, name=name.split("/")[-1],
                         cpu_pct=round(cpu_ns / 1e9 / wall * 100, 3),
                         footprint_mb=round(e.phys_footprint / 2**20, 1),
                         rss_mb=round(e.resident_size / 2**20, 1),
                         wakeups_per_s=round(wk / wall, 1)))
    ok = [r for r in rows if "error" not in r]
    total = dict(cpu_pct=round(sum(r["cpu_pct"] for r in ok), 3),
                 footprint_mb=round(sum(r["footprint_mb"] for r in ok), 1),
                 rss_mb=round(sum(r["rss_mb"] for r in ok), 1),
                 wakeups_per_s=round(sum(r["wakeups_per_s"] for r in ok), 1),
                 processes=len(ok))
    result = dict(label=a.label, main_pid=a.pid, duration_s=round(wall, 1),
                  measured_at=time.strftime("%Y-%m-%d %H:%M:%S %Z"), processes=rows, total=total)
    print(f"== {a.label}  ({wall:.0f}s window, {len(ok)} processes)")
    for r in rows:
        if "error" in r:
            print(f"  {r['pid']:>6} {r['how']:<11} {r['name'][:46]:<46} {r['error']}")
        else:
            print(f"  {r['pid']:>6} {r['how']:<11} {r['name'][:46]:<46} cpu {r['cpu_pct']:6.2f}%  "
                  f"footprint {r['footprint_mb']:7.1f} MB  rss {r['rss_mb']:7.1f} MB  wakeups {r['wakeups_per_s']:6.1f}/s")
    print(f"  TOTAL cpu {total['cpu_pct']:.2f}%  footprint {total['footprint_mb']:.1f} MB  "
          f"rss {total['rss_mb']:.1f} MB  wakeups {total['wakeups_per_s']:.1f}/s")
    if a.json:
        with open(a.json, "w") as f:
            json.dump(result, f, indent=2)

if __name__ == "__main__":
    main()

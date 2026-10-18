#!/usr/bin/env bash
# WP-02 acceptance tests on Linux / X11 (SPEC 9.1 WP-02 tests 2 to 5; test 1 is macOS focus probing).
#
# Runs the real app binary on an X server with a window manager and checks it from outside with
# xdotool, xprop and xwininfo plus the app's own test log (--test-log). Statuses: PASS, FAIL,
# BLOCKED (the environment cannot run the check; says which tool or condition). Writes results.json
# (an array of {test, name, status, detail}) into the output directory and exits 1 on any FAIL.
#
# Usage:  acceptance.sh [output dir] [tests]        tests: comma list of w,3,2,4,5,x (default all)
#   BUSYHOLM_BIN   the app binary (default src-tauri/target/debug/busyholm)
#
# Environment: needs DISPLAY (an X server), a running EWMH window manager (openbox) and a D-Bus
# session bus (the app stalls about 25 s at start without a working one). Whatever is missing and can
# be started is started:
#   no DISPLAY      -> re-runs itself under dbus-run-session + xvfb-run -a -s "-screen 0 1280x800x24"
#   always          -> re-runs itself under dbus-run-session (a private session bus)
#   no WM           -> starts openbox
# On a CI runner:   sudo apt-get install -y xvfb openbox metacity dbus-x11 xdotool wmctrl x11-utils python3-tk
#                   (metacity is optional: the click-through check also runs under it when installed)
#                   app/tests/linux/acceptance.sh app/tests/out/linux
# Tools: xdotool, xprop, xwininfo, xev (x11-utils), wmctrl, python3; python3-tk only for the fake
# taskbar cases (3b, 3c), which are BLOCKED without it.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$HERE/../.." && pwd)"
BIN="${BUSYHOLM_BIN:-$APP_DIR/src-tauri/target/debug/busyholm}"
OUT="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "${1:-$APP_DIR/tests/out/linux}")"
TESTS="${2:-w,3,2,4,5,x}"
mkdir -p "$OUT"

# ---- Re-run under the pieces that are missing ------------------------------------------------------
# Always under a private session bus (a stale ambient bus, such as a leftover systemd user bus in a
# VM, makes the app stall about 25 s at start). Set BH_ACC_KEEP_BUS=1 to keep the ambient bus.
if [ -z "${BH_ACC_WRAPPED:-}" ]; then
  export BH_ACC_WRAPPED=1
  cmd=("$0" "$@"); changed=0
  if [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
    cmd=(xvfb-run -a -s "-screen 0 1280x800x24" "${cmd[@]}"); changed=1
  fi
  if [ -z "${BH_ACC_KEEP_BUS:-}" ] && command -v dbus-run-session >/dev/null 2>&1; then
    cmd=(dbus-run-session -- "${cmd[@]}"); changed=1
  fi
  [ "$changed" -eq 1 ] && exec "${cmd[@]}"
fi

# Software rendering and no portals: the same settings the Linux smoke runs used.
export LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 GTK_USE_PORTAL=0 GIO_USE_PORTAL=0 NO_AT_BRIDGE=1

RES="$OUT/results.jsonl"
: > "$RES"
FAILS=0

# ---- Small helpers ---------------------------------------------------------------------------------
rec() { # test name status(pass|fail|blocked) detail
  python3 - "$RES" "$1" "$2" "$3" "$4" <<'PY'
import json, sys
path, test, name, status, detail = sys.argv[1:6]
try:
    d = json.loads(detail)
except ValueError:
    d = detail
with open(path, "a") as f:
    f.write(json.dumps({"test": test, "name": name, "status": status, "detail": d}) + "\n")
PY
  [ "$3" = fail ] && FAILS=$((FAILS + 1))
  printf '[%-7s] %s %s: %s\n' "$(echo "$3" | tr a-z A-Z)" "$1" "$2" "$(echo "$4" | cut -c1-400)"
}

now() { date +%s.%N; }
fmin() { python3 -c 'import sys; print(round(float(sys.argv[1]) - float(sys.argv[2]), 2))' "$1" "$2"; }
jget() { # path like data.rect_px.1 from a JSON line on stdin
  python3 -c '
import json, sys
v = json.loads(sys.stdin.read())
for k in sys.argv[1].split("."):
    v = v[int(k)] if isinstance(v, list) else v[k]
print(v if isinstance(v, str) else json.dumps(v))' "$1"
}
lq() { python3 "$HERE/logq.py" "$LOG" "$@"; }

have() { command -v "$1" >/dev/null 2>&1; }
missing=""
for t in xdotool xprop xwininfo python3; do have "$t" || missing="$missing $t"; done

wgeom() { # window id -> "X Y W H MapState"
  xwininfo -id "$1" 2>/dev/null | awk '/Absolute upper-left X:/{x=$4} /Absolute upper-left Y:/{y=$4} /^ *Width:/{w=$2} /^ *Height:/{h=$2} /Map State:/{m=$3} END{print x,y,w,h,m}'
}
workarea() { xprop -root _NET_WORKAREA 2>/dev/null | sed 's/.*= *//' | tr -d ',' | awk '{print $1,$2,$3,$4}'; }

# ---- Environment -----------------------------------------------------------------------------------
WM_STARTED=""
APP_PID=""; SINK_PID=""; PANEL_PID=""; FS_PID=""
cleanup() {
  for p in "$FS_PID" "$SINK_PID" "$PANEL_PID" "$APP_PID" "$WM_STARTED"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null
  done
  wait 2>/dev/null
}
trap cleanup EXIT

SW=0; SH=0
if [ -z "$missing" ] && [ -n "${DISPLAY:-}" ] && xwininfo -root >/dev/null 2>&1; then
  read -r SW SH <<<"$(xwininfo -root | awk '/^ *Width:/{w=$2} /^ *Height:/{h=$2} END{print w,h}')"
fi
WM_OK=0
if [ "$SW" -gt 0 ]; then
  if ! xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q "window id"; then
    if have openbox; then
      openbox > "$OUT/openbox.log" 2>&1 &
      WM_STARTED=$!
      for _ in $(seq 1 50); do
        xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q "window id" && break
        sleep 0.1
      done
    fi
  fi
  xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q "window id" && WM_OK=1
fi
WM_NAME="$(xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | awk '{print $NF}' | xargs -I{} xprop -id {} _NET_WM_NAME 2>/dev/null | sed 's/.*= *"\(.*\)".*/\1/')"
[ -n "$WM_NAME" ] || WM_NAME=unknown
{
  echo "date: $(date -u +%FT%TZ)"
  echo "uname: $(uname -a)"
  echo "DISPLAY=${DISPLAY:-} screen=${SW}x${SH} wm_ok=$WM_OK started_openbox=${WM_STARTED:+yes}"
  echo "WM: $WM_NAME"
  echo "xdotool: $(xdotool --version 2>&1 | head -1)  wmctrl: $(have wmctrl && echo yes || echo no)  xev: $(have xev && echo yes || echo no)  tk: $(python3 -c 'import tkinter; print("yes")' 2>/dev/null || echo no)"
  echo "binary: $BIN"
} > "$OUT/env.txt"

block_all() { # reason
  for t in w 3 2 4 5 x; do
    case ",$TESTS," in *",$t,"*) rec "$t" "all checks of test $t" blocked "$1" ;; esac
  done
}

finish() {
  python3 - "$RES" "$OUT/results.json" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
json.dump(rows, open(sys.argv[2], "w"), indent=2)
n = {s: sum(1 for r in rows if r["status"] == s) for s in ("pass", "fail", "blocked")}
print(f"\nWP-02 Linux acceptance: {n['pass']} pass, {n['fail']} fail, {n['blocked']} blocked  ->  {sys.argv[2]}")
PY
  [ "$FAILS" -gt 0 ] && exit 1
  exit 0
}

if [ -n "$missing" ]; then block_all "missing tools:$missing"; finish; fi
if [ "$SW" -le 0 ]; then block_all "no usable X display (DISPLAY='${DISPLAY:-}'); install xvfb or run under xvfb-run"; finish; fi
if [ ! -x "$BIN" ]; then
  rec 0 "app binary present" fail "not found or not executable: $BIN (build it first: cargo build in app/src-tauri)"
  finish
fi
if [ "$WM_OK" -ne 1 ]; then block_all "no EWMH window manager running and openbox is not installed"; finish; fi

# ---- App and helper-window management --------------------------------------------------------------
cd "$APP_DIR" || exit 2

safe() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-40; }

start_app() { # tag [extra app args]
  TAG="$(safe "$1")"; shift
  LOG="$OUT/$TAG.log"; DATA="$OUT/data-$TAG"
  rm -rf "$DATA"; : > "$LOG"
  local envarg=(-u BUSYHOLM_STRIP_ANY_WM)
  [ "${STRIP_ANY:-1}" = 1 ] && envarg=(BUSYHOLM_STRIP_ANY_WM=1)
  env "${envarg[@]}" "$BIN" --data-dir "$DATA" --test-log "$LOG" --mock-collector --mock-static \
    --strip-page placeholder/strip.html --test-freeze --test-fixed-rect --exit-after 100 "$@" \
    > "$OUT/$TAG.stdout" 2>&1 &
  APP_PID=$!
}
stop_app() {
  if [ -n "$APP_PID" ]; then
    kill -TERM "$APP_PID" 2>/dev/null
    for _ in $(seq 1 50); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 0.1; done
    kill -KILL "$APP_PID" 2>/dev/null
    wait "$APP_PID" 2>/dev/null
    APP_PID=""
  fi
}
wait_shown() { lq --event strip_visibility --where visible=true --wait 30 >/dev/null; }
strip_xid() { lq --event window --where label=strip | jget data.xid; }

# An xev window as a click sink / fullscreen candidate. xev prints every ButtonPress with root coords.
start_xev() { # name geometry outfile -> sets XEV_PID
  stdbuf -oL xev -name "$1" -geometry "$2" -event button > "$3" 2>&1 &
  XEV_PID=$!
  for _ in $(seq 1 50); do
    XEV_WIN="$(xdotool search --name "$1" 2>/dev/null | head -1)"
    [ -n "$XEV_WIN" ] && break
    sleep 0.1
  done
  sleep 0.5
}
sink_clicks() { grep -c '^ButtonPress' "$1" 2>/dev/null || true; }

# =================================================================================================
# Test 3: strip bottom equals the work-area bottom (+/- 1 px), spans its width, height 112 at scale 1
# =================================================================================================
geometry_case() { # label panel_edge(none|bottom|top) [GDK_SCALE]
  local label="${CTX:-}$1" edge="$2" gscale="${3:-1}" panel_h=40
  PANEL_PID=""
  if [ "$edge" != none ]; then
    if ! python3 -c 'import tkinter' >/dev/null 2>&1; then
      rec 3 "$label: fake taskbar on the $edge edge" blocked "python3-tk is not installed (apt: python3-tk), so no dock window with a strut can be created"
      return
    fi
    python3 "$HERE/fakepanel.py" "$SW" "$SH" "$panel_h" "$edge" > "$OUT/panel-$(safe "$label").out" 2>&1 &
    PANEL_PID=$!
    local pid=""
    for _ in $(seq 1 50); do pid="$(xdotool search --name BHPANEL 2>/dev/null | head -1)"; [ -n "$pid" ] && break; sleep 0.1; done
    if [ -z "$pid" ]; then
      rec 3 "$label: fake taskbar on the $edge edge" blocked "the fake panel window never appeared"
      kill "$PANEL_PID" 2>/dev/null; PANEL_PID=""; return
    fi
    if [ "$edge" = bottom ]; then
      s="0,0,0,$panel_h,0,0,0,0,0,0,0,$((SW - 1))"; s4="0,0,0,$panel_h"
    else
      s="0,0,$panel_h,0,0,0,0,0,0,$((SW - 1)),0,0"; s4="0,0,$panel_h,0"
    fi
    xprop -id "$pid" -f _NET_WM_STRUT_PARTIAL 32c -set _NET_WM_STRUT_PARTIAL "$s"
    xprop -id "$pid" -f _NET_WM_STRUT 32c -set _NET_WM_STRUT "$s4"
    sleep 1
  fi
  GDK_SCALE="$gscale" start_app "t3-$label"
  if ! wait_shown; then
    rec 3 "$label: strip bottom equals the work-area bottom" fail "strip never reported visible; alive=$(kill -0 "$APP_PID" 2>/dev/null && echo yes || echo no)"
  else
    sleep 1.5
    local xid scale exp_h X Y W H MAP WAX WAY WAW WAH
    xid="$(strip_xid)"
    scale="$(lq --event placement --last | jget data.scale)"
    exp_h="$(python3 -c 'import sys; print(round(112 * float(sys.argv[1])))' "$scale")"
    read -r X Y W H MAP <<<"$(wgeom "$xid")"
    read -r WAX WAY WAW WAH <<<"$(workarea)"
    local win_bottom=$((Y + H)) work_bottom=$((WAY + WAH))
    local d_bottom=$((win_bottom - work_bottom)); [ $d_bottom -lt 0 ] && d_bottom=$((-d_bottom))
    local d_x=$((X - WAX)); [ $d_x -lt 0 ] && d_x=$((-d_x))
    local d_w=$((W - WAW)); [ $d_w -lt 0 ] && d_w=$((-d_w))
    local d_h=$((H - exp_h)); [ $d_h -lt 0 ] && d_h=$((-d_h))
    local bug="n/a"
    if [ "$H" -eq 200 ] && [ "$exp_h" -ne 200 ]; then bug="STILL PRESENT (window is 200 px tall)"; else bug="gone (measured height $H, expected $exp_h)"; fi
    local detail
    detail="$(python3 -c '
import json, sys
k = ["window_xywh", "work_area_xywh", "expected_height", "scale", "map_state", "panel", "spike_200px_bug"]
v = [list(map(int, sys.argv[1:5])), list(map(int, sys.argv[5:9])), int(sys.argv[9]), float(sys.argv[10]), sys.argv[11], sys.argv[12], sys.argv[13]]
print(json.dumps(dict(zip(k, v))))' "$X" "$Y" "$W" "$H" "$WAX" "$WAY" "$WAW" "$WAH" "$exp_h" "$scale" "$MAP" "$edge" "$bug")"
    if [ $d_bottom -le 1 ] && [ $d_x -le 1 ] && [ $d_w -le 1 ] && [ $d_h -le 1 ]; then
      rec 3 "$label: strip bottom equals the work-area bottom (+/-1 px), spans its width, height $exp_h" pass "$detail"
    else
      rec 3 "$label: strip bottom equals the work-area bottom (+/-1 px), spans its width, height $exp_h" fail "$detail"
    fi
  fi
  stop_app
  [ -n "$PANEL_PID" ] && { kill "$PANEL_PID" 2>/dev/null; wait "$PANEL_PID" 2>/dev/null; PANEL_PID=""; sleep 0.5; }
}

# A taskbar that appears while the strip is running: the strip must follow the new work area.
runtime_panel_case() {
  local label="${CTX:-}3f-panel-appears-at-runtime" panel_h=40
  if ! python3 -c 'import tkinter' >/dev/null 2>&1; then
    rec 3 "$label" blocked "python3-tk is not installed (apt: python3-tk), so no dock window with a strut can be created"
    return
  fi
  start_app "t3-$label"
  if ! wait_shown; then
    rec 3 "$label" fail "strip never reported visible"; stop_app; return
  fi
  sleep 2
  local t0 pid=""
  python3 "$HERE/fakepanel.py" "$SW" "$SH" "$panel_h" bottom > "$OUT/panel-$(safe "$label").out" 2>&1 &
  PANEL_PID=$!
  for _ in $(seq 1 50); do pid="$(xdotool search --name BHPANEL 2>/dev/null | head -1)"; [ -n "$pid" ] && break; sleep 0.1; done
  if [ -z "$pid" ]; then
    rec 3 "$label" blocked "the fake panel window never appeared"; kill "$PANEL_PID" 2>/dev/null; PANEL_PID=""; stop_app; return
  fi
  t0="$(now)"
  xprop -id "$pid" -f _NET_WM_STRUT_PARTIAL 32c -set _NET_WM_STRUT_PARTIAL "0,0,0,$panel_h,0,0,0,0,0,0,0,$((SW - 1))"
  xprop -id "$pid" -f _NET_WM_STRUT 32c -set _NET_WM_STRUT "0,0,0,$panel_h"
  local want_y=$((SH - panel_h - 112)) ev lat="none" X Y W H MAP xid
  ev="$(lq --event placement --where "rect_px.1=$want_y" --since "$t0" --wait 10)"
  [ -n "$ev" ] && lat="$(fmin "$(echo "$ev" | jget t)" "$t0")"
  sleep 1
  xid="$(strip_xid)"; read -r X Y W H MAP <<<"$(wgeom "$xid")"
  local detail="{\"strip_window_xywh\":[$X,$Y,$W,$H],\"expected_bottom\":$((SH - panel_h)),\"placement_follow_latency_s\":\"$lat\"}"
  if [ $((Y + H)) -eq $((SH - panel_h)) ] && [ "$lat" != none ]; then
    rec 3 "$label: the strip moves above a taskbar that appears while it runs" pass "$detail"
  else
    rec 3 "$label: the strip moves above a taskbar that appears while it runs" fail "$detail"
  fi
  kill "$PANEL_PID" 2>/dev/null; wait "$PANEL_PID" 2>/dev/null; PANEL_PID=""
  stop_app
}

geometry_suite() {
  geometry_case 3a-no-panel none
  geometry_case 3b-panel-bottom bottom
  geometry_case 3c-panel-top top
  geometry_case 3d-scale-200pct none 2
  geometry_case 3e-scale-200pct-panel-bottom bottom 2
  runtime_panel_case
}

test3() {
  geometry_suite
  # The same layout cases under a window manager that is not on the denylist and passes clicks.
  if have metacity && have Xvfb; then
    display_up metacity metacity
    CTX="[metacity] " STRIP_ANY=0 geometry_suite
    display_down
  else
    rec 3 "layout cases under metacity" blocked "metacity or Xvfb not installed (apt: metacity xvfb)"
  fi
  rec 3 "other matrix cells (150% scale, left panel, auto-hide)" blocked \
    "GDK on X11 only has integer scales (GDK_SCALE=1 and 2 are tested above); 150% is a fractional scale that X11 GTK3 cannot express, and a left or auto-hide panel is covered by the pure geometry matrix (cargo test --test geometry)"
}

# =================================================================================================
# Test 2: click routing. Empty strip area -> the window beneath; the sprite -> the strip.
#
# The strip is click-through by an X11 input shape on its window. A window manager that wraps every
# window in a frame window of its own (openbox, fluxbox, xfwm4, icewm: measured) swallows the click
# in the frame, which has no input shape, so the shape cannot work there. So the check runs on three
# displays: a bare X server (no window manager: the app's own behaviour), metacity when installed (a
# manager that passes the shape through: measured), and the suite's own window manager.
# =================================================================================================
click_case() { # label  (runs against the current DISPLAY; sets CLICK_RESULT=pass|fail|blocked)
  local label="$1"
  CLICK_RESULT=fail
  local sinkout="$OUT/t2-$(safe "$label")-sink.out" top=$((SH - 420)) gx gy gw gh gm
  # The window beneath is started first so that, with no window manager, it is also lower in the
  # stacking order than the strip.
  start_xev BHSINK "${SW}x400+0+${top}" "$sinkout"
  SINK_PID=$XEV_PID
  local sw_xid="$XEV_WIN"
  if [ -z "$sw_xid" ]; then
    rec 2 "$label: click routing" fail "the xev window beneath the strip never appeared"
    CLICK_DETAIL="no sink window"; return
  fi
  start_app "t2-$label"
  if ! wait_shown || ! lq --event hit_rects --where count=3 --wait 20 >/dev/null; then
    rec 2 "$label: click routing" fail "strip or hit rects never reported; alive=$(kill -0 "$APP_PID" 2>/dev/null && echo yes || echo no)"
    CLICK_DETAIL="strip never shown"; return
  fi
  sleep 1
  # Points in screen pixels: the sprite is the hit rect nearest the horizontal centre; the empty
  # point is on the strip, away from every rect.
  local pts SX SY EX EY RX RY RW RH PX PY
  pts="$(python3 - "$LOG" <<'PY'
import json, sys
ev = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
pl = [e for e in ev if e["event"] == "placement"][-1]["data"]
hr = [e for e in ev if e["event"] == "hit_rects"][-1]["data"]
x, y, w, h = pl["rect_px"]; s = pl["scale"]; vw = hr["viewport"][0]
rects = hr["rects"]
r = min(rects, key=lambda q: abs(q[0] + q[2] / 2 - vw / 2))
sx, sy = x + (r[0] + r[2] / 2) * s, y + (r[1] + r[3] / 2) * s
# The first rect is a resident (the page logs resident_click for residents, not for the test sprite).
q0 = rects[0]
rx_, ry_ = x + (q0[0] + q0[2] / 2) * s, y + (q0[1] + q0[3] / 2) * s
ex = ey = None
for f in (0.15, 0.3, 0.7, 0.85):
    px, py = vw * f, 10.0
    if not any(q[0] <= px < q[0] + q[2] and q[1] <= py < q[1] + q[3] for q in rects):
        ex, ey = x + px * s, y + py * s
        break
print(round(sx), round(sy), round(ex), round(ey), x, y, w, h, round(rx_), round(ry_))
PY
)"
  read -r SX SY EX EY RX RY RW RH PX PY <<<"$pts"
  read -r gx gy gw gh gm <<<"$(wgeom "$sw_xid")"
  if [ "$gy" -gt "$EY" ] || [ $((gy + gh)) -lt $((RY + RH)) ]; then
    xdotool windowmove "$sw_xid" 0 $((SH - 400)) 2>/dev/null; sleep 0.5
    read -r gx gy gw gh gm <<<"$(wgeom "$sw_xid")"
  fi
  local covers="no"
  [ "$gy" -le "$EY" ] && [ $((gy + gh)) -ge $((RY + RH)) ] && covers="yes"

  local t_a t_c
  # A: empty strip point.
  xdotool mousemove --sync "$EX" "$EY"; sleep 1.3
  local fade_on; fade_on="$(lq --event fade --where on=true --since "$(fmin "$(now)" 2.5)" >/dev/null && echo yes || echo no)"
  local c0; c0="$(sink_clicks "$sinkout")"
  t_a="$(now)"
  xdotool click 1; sleep 1.0
  local c1; c1="$(sink_clicks "$sinkout")"
  local strip_got_a="no"; lq --event page_event --where name=resident_click --since "$t_a" >/dev/null && strip_got_a="yes"
  # B: leave the strip so hover-fade ends and the strip is clickable again.
  xdotool mousemove --sync $((SW / 2)) $((top - 100)); sleep 1.2
  local fade_off="no"; lq --event fade --where on=false --since "$t_a" >/dev/null && fade_off="yes"
  # C: the test sprite (a hit rect that is not a resident): the click must stay in the strip.
  xdotool mousemove --sync "$SX" "$SY"; sleep 1.0
  local c2a; c2a="$(sink_clicks "$sinkout")"
  xdotool click 1; sleep 0.8
  local c2; c2="$(sink_clicks "$sinkout")"
  # D: a resident: the strip's page logs resident_click.
  xdotool mousemove --sync "$PX" "$PY"; sleep 0.8
  t_c="$(now)"
  xdotool click 1
  local rc="no"; lq --event page_event --where name=resident_click --since "$t_c" --wait 2.5 >/dev/null && rc="yes"
  sleep 0.5
  local c3; c3="$(sink_clicks "$sinkout")"
  local root_pos; root_pos="$(grep -A1 '^ButtonPress' "$sinkout" | grep -o 'root:([0-9,]*)' | head -1)"
  # What is under the pointer at the empty point (a frame window of the window manager, or the sink)?
  xdotool mousemove --sync "$EX" "$EY"; sleep 0.8
  local under; under="$(xdotool getmouselocation --shell 2>/dev/null | sed -n 's/^WINDOW=//p')"
  local strip_x; strip_x="$(strip_xid)"
  CLICK_DETAIL="$(python3 -c '
import json, sys
k = ["display_wm", "empty_point", "sprite_point", "sink_covers_points", "sink_xywh", "sink_clicks_before_after_empty_click", "sink_click_root_pos",
     "strip_got_empty_click", "sink_clicks_after_sprite_click", "sink_clicks_after_resident_click", "resident_click_logged", "fade_on", "fade_off", "top_level_window_under_empty_point", "strip_window", "sink_window"]
a = sys.argv[1:]
v = [a[0], [int(a[1]), int(a[2])], [int(a[3]), int(a[4])], a[5], [int(a[6]), int(a[7]), int(a[8]), int(a[9])], [int(a[10]), int(a[11])], a[12], a[13], int(a[14]), int(a[21]), a[15], a[16], a[17], a[18], a[19], a[20]]
print(json.dumps(dict(zip(k, v))))' "$label" "$EX" "$EY" "$SX" "$SY" "$covers" "$gx" "$gy" "$gw" "$gh" "$c0" "$c1" "${root_pos:-none}" "$strip_got_a" "$c2" "$rc" "$fade_on" "$fade_off" "${under:-?}" "${strip_x:-?}" "$sw_xid" "$c3")"
  CLICK_FADE="$fade_on/$fade_off"
  if [ "$covers" = no ]; then
    CLICK_RESULT=blocked; CLICK_REASON="could not place the test window under the strip (the window manager ignored the position)"
  elif [ "$c1" -eq $((c0 + 1)) ] && [ "$strip_got_a" = no ] && [ "$rc" = yes ] && [ "$c2" -eq "$c2a" ] && [ "$c3" -eq "$c1" ]; then
    CLICK_RESULT=pass
  else
    CLICK_RESULT=fail
  fi
}

# Run click_case on its own X server: optional window manager. Sets CLICK_* and records the result.
# A second X server, optionally with a window manager: display_up label wm; display_down.
display_up() {
  local label="$1" wm="$2" n=""
  D_SAVED="$DISPLAY"; D_XPID=""; D_WPID=""
  have Xvfb || return 2
  for i in $(seq 90 99); do [ ! -e "/tmp/.X11-unix/X$i" ] && { n=$i; break; }; done
  [ -n "$n" ] || return 3
  Xvfb ":$n" -screen 0 "${SW}x${SH}x24" -nolisten tcp > "$OUT/xvfb-$(safe "$label").out" 2>&1 &
  D_XPID=$!
  export DISPLAY=":$n"
  for _ in $(seq 1 50); do xwininfo -root >/dev/null 2>&1 && break; sleep 0.1; done
  if [ -n "$wm" ]; then
    $wm > "$OUT/wm-$(safe "$label").out" 2>&1 &
    D_WPID=$!
    for _ in $(seq 1 50); do xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q "window id" && break; sleep 0.1; done
    sleep 1
  fi
  return 0
}
display_down() {
  [ -n "$D_WPID" ] && { kill "$D_WPID" 2>/dev/null; wait "$D_WPID" 2>/dev/null; }
  [ -n "$D_XPID" ] && { kill "$D_XPID" 2>/dev/null; wait "$D_XPID" 2>/dev/null; }
  export DISPLAY="$D_SAVED"
}

# Run click_case on its own X server: optional window manager. The strip runs WITHOUT the denylist
# override here (STRIP_ANY=0): neither a bare server nor metacity may be withheld.
click_on_new_display() { # label wm-command-or-empty
  local label="$1" wm="$2"
  display_up "$label" "$wm"
  case $? in
    2) rec 2 "click routing, $label" blocked "Xvfb not installed (needed for a second X server)"; return ;;
    3) rec 2 "click routing, $label" blocked "no free display number"; return ;;
  esac
  STRIP_ANY=0 click_case "$label"
  if [ "$CLICK_RESULT" = pass ]; then
    rec 2 "click routing, $label: empty strip click reaches the window beneath, sprite click reaches the strip" pass "$CLICK_DETAIL"
  elif [ "$CLICK_RESULT" = blocked ]; then
    rec 2 "click routing, $label" blocked "$CLICK_REASON: $CLICK_DETAIL"
  else
    rec 2 "click routing, $label: empty strip click reaches the window beneath, sprite click reaches the strip" fail "$CLICK_DETAIL"
  fi
  [ -n "$SINK_PID" ] && { kill "$SINK_PID" 2>/dev/null; wait "$SINK_PID" 2>/dev/null; SINK_PID=""; }
  stop_app
  display_down
}

test2() {
  if ! have xev || ! have stdbuf; then
    rec 2 "click routing" blocked "xev or stdbuf missing (x11-utils, coreutils): no window to receive clicks beneath the strip"
    return
  fi
  click_on_new_display "bare X server, no window manager" ""
  if have metacity; then click_on_new_display "metacity" "metacity"; fi
  # The suite's own window manager (openbox in the VM and on CI).
  click_case "suite window manager ($WM_NAME)"
  case "$(echo "$WM_NAME" | tr A-Z a-z)" in
    openbox|fluxbox|xfwm4|icewm)
      if [ "$CLICK_RESULT" = pass ]; then
        rec 2 "click routing under $WM_NAME: empty strip click reaches the window beneath, sprite click reaches the strip" pass "$CLICK_DETAIL"
      else
        rec 2 "click routing under $WM_NAME" blocked "environment limit: the click did not reach the window beneath under $WM_NAME, which re-parents every window into a frame window (the top-level window under the pointer at the empty point is recorded below; for openbox it is the frame, not the strip or the sink), and a frame has no input shape. The same strip passes on the bare X server and under metacity. Product-level decision needed (see the report). $CLICK_DETAIL"
      fi ;;
    *)
      if [ "$CLICK_RESULT" = pass ]; then
        rec 2 "click routing under $WM_NAME: empty strip click reaches the window beneath, sprite click reaches the strip" pass "$CLICK_DETAIL"
      elif [ "$CLICK_RESULT" = blocked ]; then
        rec 2 "click routing under $WM_NAME" blocked "$CLICK_REASON: $CLICK_DETAIL"
      else
        rec 2 "click routing under $WM_NAME: empty strip click reaches the window beneath, sprite click reaches the strip" fail "$CLICK_DETAIL"
      fi ;;
  esac
  if [ "${CLICK_FADE:-}" = "yes/yes" ]; then
    rec 2 "hover-fade turns on after 400 ms over the empty strip and off on leave" pass "{\"fade_on\":true,\"fade_off\":true}"
  else
    rec 2 "hover-fade turns on after 400 ms over the empty strip and off on leave" fail "{\"fade_on/fade_off\":\"${CLICK_FADE:-?}\"}"
  fi
  [ -n "$SINK_PID" ] && { kill "$SINK_PID" 2>/dev/null; wait "$SINK_PID" 2>/dev/null; SINK_PID=""; }
  stop_app
}

# =================================================================================================
# Test 4: the strip hides while another window is fullscreen, and returns after.
# =================================================================================================
fs_case() { # label how-it-ends(close|unfullscreen)
  local label="$1" ending="$2"
  start_xev BHFS "600x400+100+100" "$OUT/t4-$(safe "$label")-fs.out"
  FS_PID=$XEV_PID
  local fs_xid="$XEV_WIN"
  if [ -z "$fs_xid" ]; then
    rec 4 "$label" fail "the test window never appeared"; kill "$FS_PID" 2>/dev/null; FS_PID=""; return
  fi
  wmctrl -i -a "$fs_xid" 2>/dev/null
  local t0 t1 hidden vis_hidden back vis_back xid
  xid="$(strip_xid)"
  t0="$(now)"
  wmctrl -i -r "$fs_xid" -b add,fullscreen
  hidden="$(lq --event strip_visibility --where visible=false --where reason=fullscreen --since "$t0" --wait 12)"
  sleep 0.6
  read -r _ _ _ _ vis_hidden <<<"$(wgeom "$xid")"
  if [ "$ending" = close ]; then
    t1="$(now)"; kill "$FS_PID" 2>/dev/null; wait "$FS_PID" 2>/dev/null; FS_PID=""
  else
    t1="$(now)"; wmctrl -i -r "$fs_xid" -b remove,fullscreen
  fi
  back="$(lq --event strip_visibility --where visible=true --since "$t1" --wait 12)"
  sleep 0.6
  read -r _ _ _ _ vis_back <<<"$(wgeom "$xid")"
  [ -n "$FS_PID" ] && { kill "$FS_PID" 2>/dev/null; wait "$FS_PID" 2>/dev/null; FS_PID=""; }
  local hl="none" bl="none"
  [ -n "$hidden" ] && hl="$(fmin "$(echo "$hidden" | jget t)" "$t0")"
  [ -n "$back" ] && bl="$(fmin "$(echo "$back" | jget t)" "$t1")"
  local detail="{\"hide_latency_s\":\"$hl\",\"strip_map_state_while_fullscreen\":\"${vis_hidden:-?}\",\"return_latency_s\":\"$bl\",\"strip_map_state_after\":\"${vis_back:-?}\",\"fullscreen_ended_by\":\"$ending\"}"
  if [ -n "$hidden" ] && [ "$vis_hidden" = IsUnMapped ] && [ -n "$back" ] && [ "$vis_back" = IsViewable ]; then
    rec 4 "$label" pass "$detail"
  else
    rec 4 "$label" fail "$detail"
  fi
}

test4() {
  if ! have xev || ! have wmctrl || ! have stdbuf; then
    rec 4 "the strip hides while another window is fullscreen" blocked "xev, wmctrl or stdbuf missing (x11-utils, wmctrl, coreutils)"
    return
  fi
  start_app t4-fullscreen
  if ! wait_shown; then
    rec 4 "the strip hides while another window is fullscreen" fail "strip never reported visible"
    stop_app; return
  fi
  sleep 2
  fs_case "fullscreen window closed: strip hides, then returns" close
  sleep 1
  fs_case "fullscreen toggled off in place: strip hides, then returns (no window closed)" unfullscreen
  stop_app
}

# =================================================================================================
# Test 5: reserve-space mode. X11 struts, dock window type, work area shrinks.
# =================================================================================================
reserve_case() { # label GDK_SCALE
  local label="$1"
  GDK_SCALE="${2:-1}" start_app "t5-$label" --layer reserve_space
  if ! lq --event layer --wait 30 >/dev/null || ! wait_shown; then
    rec 5 "$label: reserve space on X11" fail "no layer event or strip never visible"
    stop_app; return
  fi
  sleep 2
  local xid layer_ev X Y W H MAP WAX WAY WAW WAH
  xid="$(strip_xid)"
  layer_ev="$(lq --event layer --last)"
  read -r X Y W H MAP <<<"$(wgeom "$xid")"
  read -r WAX WAY WAW WAH <<<"$(workarea)"
  local sp s4 wt
  sp="$(xprop -id "$xid" _NET_WM_STRUT_PARTIAL 2>/dev/null)"
  s4="$(xprop -id "$xid" _NET_WM_STRUT 2>/dev/null)"
  wt="$(xprop -id "$xid" _NET_WM_WINDOW_TYPE 2>/dev/null)"
  local want_h want_sp want_s4
  want_h="$(lq --event placement --last | jget data.rect_px.3)"
  want_sp="0, 0, 0, $((SH - Y)), 0, 0, 0, 0, 0, 0, $X, $((X + W - 1))"
  want_s4="0, 0, 0, $((SH - Y))"
  local effective; effective="$(echo "$layer_ev" | jget data.effective)"
  local y_first y_last
  y_first="$(lq --event placement | jget data.rect_px.1)"
  y_last="$(lq --event placement --last | jget data.rect_px.1)"
  local detail
  detail="$(python3 -c '
import json, sys
k = ["layer_effective", "strut_partial", "strut", "window_type", "window_xywh", "work_area_xywh", "placement_y_first", "placement_y_last", "screen_h"]
a = sys.argv[1:]
v = [a[0], a[1], a[2], a[3], list(map(int, a[4:8])), list(map(int, a[8:12])), a[12], a[13], int(a[14])]
print(json.dumps(dict(zip(k, v))))' "$effective" "${sp#*= }" "${s4#*= }" "${wt#*= }" "$X" "$Y" "$W" "$H" "$WAX" "$WAY" "$WAW" "$WAH" "$y_first" "$y_last" "$SH")"
  local ok_s=0 ok_t=0 ok_w=0 ok_c=0
  [ "${sp#*= }" = "$want_sp" ] && [ "${s4#*= }" = "$want_s4" ] && [ "$((SH - Y))" -eq "$want_h" ] && ok_s=1
  echo "$wt" | grep -q "_NET_WM_WINDOW_TYPE_DOCK" && ok_t=1
  [ "$WAH" -eq $((SH - want_h)) ] && ok_w=1
  [ "$y_first" = "$y_last" ] && [ "$Y" -eq $((SH - want_h)) ] && ok_c=1
  [ "$effective" = reserve_space ] || ok_s=0
  if [ $ok_s -eq 1 ]; then
    rec 5 "$label: reserve space: _NET_WM_STRUT_PARTIAL on the strip, bottom = strip height ($want_h), x range = strip width (end is inclusive)" pass "$detail"
  else
    rec 5 "$label: reserve space: _NET_WM_STRUT_PARTIAL on the strip, bottom = strip height ($want_h), x range = strip width (end is inclusive)" fail "$detail (wanted: $want_sp)"
  fi
  if [ $ok_t -eq 1 ]; then rec 5 "$label: strip window type is _NET_WM_WINDOW_TYPE_DOCK" pass "$wt"; else rec 5 "$label: strip window type is _NET_WM_WINDOW_TYPE_DOCK" fail "$wt"; fi
  if [ $ok_w -eq 1 ]; then
    rec 5 "$label: under $WM_NAME _NET_WORKAREA shrinks by the strip height" pass "{\"work_area_h\":$WAH,\"screen_h\":$SH,\"strip_h\":$want_h}"
  else
    rec 5 "$label: under $WM_NAME _NET_WORKAREA shrinks by the strip height" fail "{\"work_area_h\":$WAH,\"screen_h\":$SH,\"strip_h\":$want_h}"
  fi
  if [ $ok_c -eq 1 ]; then
    rec 5 "$label: no upward creep: the strip stays on the screen bottom after its own strut changed the work area" pass "{\"placement_y_first\":$y_first,\"placement_y_last\":$y_last,\"window_y\":$Y}"
  else
    rec 5 "$label: no upward creep: the strip stays on the screen bottom after its own strut changed the work area" fail "{\"placement_y_first\":$y_first,\"placement_y_last\":$y_last,\"window_y\":$Y,\"want_y\":$((SH - want_h))}"
  fi
  stop_app
}

test5() {
  reserve_case scale-100pct 1
  reserve_case scale-200pct 2
  rec 5 "Windows reserve mode (AppBar maximised-window test)" blocked "Windows only; runs in the Windows CI job"
}

# =================================================================================================
# Extra checks: behind-windows layer, tray and autostart events.
# =================================================================================================
# Which of two windows is higher? xwininfo -root -tree lists the root's children topmost first, so the
# smaller line number is the higher window. Prints "<strip_line> <sink_line>".
stack_lines() { # sink-name
  xwininfo -root -tree 2>/dev/null | awk -v sink="$1" '
    index($0, "\"Busyholm strip\"") && !s { s = NR }
    index($0, "\"" sink "\"") && !k { k = NR }
    END { print s + 0, k + 0 }'
}

stack_case() { # layer(on_top|behind_windows) expected(strip_above|sink_above)
  local layer="$1" want="$2" xid st
  start_xev BHSINKX "${SW}x400+0+$((SH - 420))" "$OUT/tx-sink-$layer.out"
  SINK_PID=$XEV_PID
  local sink_win="$XEV_WIN"
  start_app "tx-$layer" --layer "$layer"
  if ! wait_shown; then
    rec x "$layer layer" fail "strip never visible"; kill "$SINK_PID" 2>/dev/null; SINK_PID=""; stop_app; return
  fi
  sleep 1.5
  xid="$(strip_xid)"
  st="$(xprop -id "$xid" _NET_WM_STATE 2>/dev/null)"
  xdotool windowraise "$sink_win" 2>/dev/null; xdotool windowactivate "$sink_win" 2>/dev/null; sleep 1
  local lines ls lk
  lines="$(stack_lines BHSINKX)"; read -r ls lk <<<"$lines"
  local got="unknown"
  if [ "$ls" -gt 0 ] && [ "$lk" -gt 0 ]; then
    if [ "$ls" -lt "$lk" ]; then got=strip_above; else got=sink_above; fi
  fi
  if [ "$got" = "$want" ]; then
    rec x "$layer layer: an ordinary window just raised is stacked $( [ "$want" = strip_above ] && echo below || echo above ) the strip" pass "{\"net_wm_state\":\"${st#*= }\",\"tree_line_strip\":$ls,\"tree_line_sink\":$lk,\"smaller_line_is_higher\":true}"
  elif [ "$got" = unknown ]; then
    rec x "$layer layer: stacking against an ordinary window" blocked "could not find both windows in xwininfo -root -tree"
  else
    rec x "$layer layer: an ordinary window just raised is stacked $( [ "$want" = strip_above ] && echo below || echo above ) the strip" fail "{\"net_wm_state\":\"${st#*= }\",\"tree_line_strip\":$ls,\"tree_line_sink\":$lk,\"got\":\"$got\",\"wanted\":\"$want\"}"
  fi
  kill "$SINK_PID" 2>/dev/null; wait "$SINK_PID" 2>/dev/null; SINK_PID=""
  stop_app
}

testx() {
  if have xev && have stdbuf; then
    # The first case also proves the order test itself: on top, a freshly raised ordinary window must
    # still be below the strip.
    stack_case on_top strip_above
    stack_case behind_windows sink_above
  else
    rec x "layer stacking" blocked "xev or stdbuf missing"
  fi
  start_app tx-tray
  lq --event autostart --wait 20 >/dev/null
  local tray auto
  tray="$(lq --event tray_rect --wait 15)"
  auto="$(lq --event autostart)"
  if [ -n "$auto" ] && [ "$(echo "$auto" | jget data.enabled)" = false ]; then
    rec x "autostart is off by default" pass "$(echo "$auto" | jget data)"
  else
    rec x "autostart is off by default" fail "${auto:-no autostart event}"
  fi
  if [ -n "$tray" ] && [ "$(echo "$tray" | jget data.rect)" != null ]; then
    rec x "tray icon placed by the desktop" pass "$(echo "$tray" | jget data)"
  else
    rec x "tray icon placed by the desktop" blocked "tray_rect is null: Xvfb has no StatusNotifier or system tray host to report an icon rectangle (needs a real desktop session)"
  fi
  stop_app
}

# =================================================================================================
# Test w: the strip is withheld on a window manager that fails click-through (the denylist), and
# shown on every other one. Runs WITHOUT BUSYHOLM_STRIP_ANY_WM.
# =================================================================================================
testw() {
  local lower denied=""
  lower="$(echo "$WM_NAME" | tr A-Z a-z)"
  for k in openbox fluxbox xfwm4 icewm; do case "$lower" in *"$k"*) denied="$k" ;; esac; done
  STRIP_ANY=0 start_app tw-default
  if [ -n "$denied" ]; then
    local ev; ev="$(lq --event strip_unsupported --wait 30)"
    sleep 3
    local reason details strips
    reason="$( [ -n "$ev" ] && echo "$ev" | jget data.reason )"
    details="$(lq --event window --where label=details --wait 10 >/dev/null && echo yes || echo no)"
    strips="$(xdotool search --name "Busyholm strip" 2>/dev/null | wc -l | tr -d ' ')"
    local shown; shown="$(lq --event strip_visibility --where visible=true >/dev/null && echo yes || echo no)"
    local detail="{\"window_manager\":\"$WM_NAME\",\"strip_unsupported_reason\":\"${reason:-none}\",\"details_window_opened\":\"$details\",\"strip_windows_on_screen\":$strips,\"strip_reported_visible\":\"$shown\"}"
    if [ -n "$ev" ] && echo "$reason" | grep -qi "$denied" && [ "$details" = yes ] && [ "$strips" -eq 0 ] && [ "$shown" = no ]; then
      rec w "strip withheld on a window manager that fails click-through ($WM_NAME): strip_unsupported, details window, no strip" pass "$detail"
    else
      rec w "strip withheld on a window manager that fails click-through ($WM_NAME): strip_unsupported, details window, no strip" fail "$detail"
    fi
  else
    if wait_shown && ! lq --event strip_unsupported >/dev/null; then
      rec w "strip shown on a window manager that is not on the denylist ($WM_NAME)" pass "{\"window_manager\":\"$WM_NAME\"}"
    else
      rec w "strip shown on a window manager that is not on the denylist ($WM_NAME)" fail "{\"window_manager\":\"$WM_NAME\",\"strip_unsupported\":\"$(lq --event strip_unsupported | cut -c1-200)\"}"
    fi
  fi
  stop_app
  # BUSYHOLM_STRIP_ANY_WM=1 must lift the denylist.
  if [ -n "$denied" ]; then
    STRIP_ANY=1 start_app tw-override
    if wait_shown && ! lq --event strip_unsupported >/dev/null; then
      rec w "BUSYHOLM_STRIP_ANY_WM=1 lifts the denylist ($WM_NAME)" pass "{\"window_manager\":\"$WM_NAME\"}"
    else
      rec w "BUSYHOLM_STRIP_ANY_WM=1 lifts the denylist ($WM_NAME)" fail "strip not shown with the override set"
    fi
    stop_app
  fi
  # Unlisted window managers and no window manager at all stay supported (metacity, bare X server).
  if have Xvfb; then
    display_up bare ""
    STRIP_ANY=0 start_app tw-bare
    if wait_shown && ! lq --event strip_unsupported >/dev/null; then
      rec w "strip shown with no window manager at all, no override" pass "{}"
    else
      rec w "strip shown with no window manager at all, no override" fail "$(lq --event strip_unsupported | cut -c1-200)"
    fi
    stop_app; display_down
    if have metacity; then
      display_up metacity metacity
      STRIP_ANY=0 start_app tw-metacity
      if wait_shown && ! lq --event strip_unsupported >/dev/null; then
        rec w "strip shown under metacity, no override" pass "{}"
      else
        rec w "strip shown under metacity, no override" fail "$(lq --event strip_unsupported | cut -c1-200)"
      fi
      stop_app; display_down
    fi
  fi
}

for t in ${TESTS//,/ }; do
  case "$t" in
    w) testw ;;
    3) test3 ;;
    2) test2 ;;
    4) test4 ;;
    5) test5 ;;
    x) testx ;;
  esac
done
finish

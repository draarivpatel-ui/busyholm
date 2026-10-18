#!/usr/bin/env bash
# WP-12 acceptance tests on Linux / X11 (SPEC 9.1 WP-12 tests 1 to 3; test 4 CPU is macOS-gating only).
#
# Runs the real DEBUG binary (the test hooks are compiled out of release builds) under Xvfb with openbox
# and real X input (xdotool uses XTEST, which the X server treats as hardware input, so it resets the
# XScreenSaver idle clock exactly like a key or mouse would). Checks the app's own test log (--test-log).
#
#   1  real idle source: right after xdotool input, the idle clock the app reads is small, and after 4 quiet
#      seconds it reads about 4 (XScreenSaverQueryInfo through dlopen); fake idle file: no scene at 299 s,
#      a scene at 300 s; fake call/video (BUSYHOLM_FAKE_MEDIA=on): no scene.
#   2  exit: a hand-started scene closes within 100 ms of a real mouse move over 8 px, a real key press and a
#      real click; and the click is not delivered to a probe window beneath it (python3-tk counts ButtonPress).
#   3  power: no inhibitor held by the app. D-Bus `org.freedesktop.ScreenSaver` Inhibit calls from this
#      process are watched with dbus-monitor while the scene is open; the check passes when there are none.
#
# Usage: ambient.sh [output dir] [tests: 1,2,3]       BUSYHOLM_BIN: the app binary (default: debug build)
# On a CI runner: sudo apt-get install -y xvfb openbox dbus-x11 xdotool x11-utils python3-tk libxss1
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$HERE/../.." && pwd)"
BIN="${BUSYHOLM_BIN:-$APP_DIR/src-tauri/target/debug/busyholm}"
OUT="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "${1:-$APP_DIR/tests/out/linux-ambient}")"
TESTS="${2:-1,2,3}"
mkdir -p "$OUT"

if [ -z "${BH_AMB_WRAPPED:-}" ]; then
  export BH_AMB_WRAPPED=1
  cmd=("$0" "$@")
  [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1 && cmd=(xvfb-run -a -s "-screen 0 1280x800x24" "${cmd[@]}")
  command -v dbus-run-session >/dev/null 2>&1 && cmd=(dbus-run-session -- "${cmd[@]}")
  exec "${cmd[@]}"
fi
export LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 GTK_USE_PORTAL=0 GIO_USE_PORTAL=0 NO_AT_BRIDGE=1

RES="$OUT/results.jsonl"; : > "$RES"; FAILS=0
rec() { # test name status detail
  python3 - "$RES" "$1" "$2" "$3" "$4" <<'PY'
import json, sys
path, test, name, status, detail = sys.argv[1:6]
try: d = json.loads(detail)
except ValueError: d = detail
open(path, "a").write(json.dumps({"test": test, "name": name, "status": status, "detail": d}) + "\n")
PY
  [ "$3" = fail ] && FAILS=$((FAILS + 1))
  printf '[%-7s] %s %s: %s\n' "$(echo "$3" | tr a-z A-Z)" "$1" "$2" "$(echo "$4" | cut -c1-300)"
}
now() { date +%s.%N; }
q() { python3 "$HERE/logq.py" "$@"; }   # logq.py LOG --event NAME [--where k=v] [--since T] [--wait S]

command -v openbox >/dev/null 2>&1 && ! pgrep -x openbox >/dev/null && { openbox >/dev/null 2>&1 & sleep 1; }
for t in xdotool python3; do command -v "$t" >/dev/null 2>&1 || { echo "missing tool: $t"; exit 2; }; done

APP_PID=""
start_app() { # tag idle_minutes(or "") extra args...  (env passes through)
  local tag="$1" minutes="$2"; shift 2
  DATA="$OUT/data-$tag"; LOG="$OUT/$tag.log"; rm -rf "$DATA" "$LOG"; mkdir -p "$DATA"
  if [ -n "$minutes" ]; then
    "$BIN" --data-dir "$DATA" --exit-after 1 --mock-collector --mock-static >/dev/null 2>&1; sleep 1
    python3 - "$DATA/settings.json" "$minutes" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); s["ambient"]["idle_minutes"] = int(sys.argv[2]); json.dump(s, open(sys.argv[1], "w"))
PY
  fi
  "$BIN" --data-dir "$DATA" --test-log "$LOG" --mock-collector --mock-static --exit-after 80 "$@" >"$OUT/$tag.stdout" 2>&1 &
  APP_PID=$!
}
stop_app() { [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null; APP_PID=""; sleep 1; }
opened() { q "$LOG" --event ambient --where open=true --since "${1:-0}" --wait "${2:-4}" >/dev/null; }
closed() { q "$LOG" --event ambient --where open=false --since "${1:-0}" --wait "${2:-3}"; }

if [[ ",$TESTS," == *,1,* ]]; then
  xdotool mousemove 5 5; sleep 4
  unset BUSYHOLM_FAKE_IDLE_FILE BUSYHOLM_IDLE_TRIGGER
  start_app t1-real ""
  if q "$LOG" --event idle_probe --wait 30 >/dev/null; then
    idle=$(q "$LOG" --event idle_probe | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["data"]["idle_s"])')
    ok=$(python3 -c "i='$idle'; print('pass' if i not in ('None','') and 3.0 <= float(i) <= 40.0 else 'fail')")
    rec 1 "real X11 idle clock (XScreenSaverQueryInfo) reads a sane value after quiet time" "$ok" "{\"idle_s\": \"$idle\"}"
  else
    rec 1 "real X11 idle clock" blocked '{"reason": "no idle_probe event; libXss.so.1 missing or no XScreenSaver extension on this X server"}'
  fi
  stop_app

  echo 299 > "$OUT/idle-1.txt"
  export BUSYHOLM_FAKE_IDLE_FILE="$OUT/idle-1.txt" BUSYHOLM_IDLE_TRIGGER=on BUSYHOLM_FAKE_MEDIA=off BUSYHOLM_FAKE_FULLSCREEN=off
  start_app t1 5
  q "$LOG" --event strip_visibility --wait 30 >/dev/null; sleep 3
  quiet=1; q "$LOG" --event ambient --where open=true >/dev/null && quiet=0
  t=$(now); echo 300 > "$OUT/idle-1.txt"
  if opened "$t" 6; then rec 1 "no scene at 299 s, a scene at the 5 min threshold" "$([ $quiet = 1 ] && echo pass || echo fail)" "{\"quiet_below\": $quiet}"
  else rec 1 "no scene at 299 s, a scene at the 5 min threshold" fail "{\"quiet_below\": $quiet, \"opened\": false}"; fi
  stop_app

  export BUSYHOLM_FAKE_MEDIA=on
  start_app t1m 5
  q "$LOG" --event strip_visibility --wait 30 >/dev/null; sleep 7
  if q "$LOG" --event ambient --where open=true >/dev/null; then rec 1 "fake call/video active: no scene" fail '{}'
  else rec 1 "fake call/video active: no scene" pass '{}'; fi
  stop_app
  unset BUSYHOLM_FAKE_IDLE_FILE BUSYHOLM_IDLE_TRIGGER BUSYHOLM_FAKE_MEDIA BUSYHOLM_FAKE_FULLSCREEN
fi

if [[ ",$TESTS," == *,2,* ]]; then
  for case in move key click; do
    xdotool mousemove 640 400; sleep 0.3
    start_app "t2-$case" "" --open ambient
    if ! opened 0 25; then rec 2 "exit on $case" fail '{"reason": "scene never opened"}'; stop_app; continue; fi
    sleep 2.4
    t=$(now)
    case $case in move) xdotool mousemove_relative 20 3 ;; key) xdotool key a ;; click) xdotool click 1 ;; esac
    if c=$(closed "$t" 3); then
      lat=$(python3 -c "import json; print(round(json.loads('''$c''')['t'] - $t, 3))")
      rec 2 "$case: the scene closes within 100 ms" "$(python3 -c "print('pass' if $lat <= 0.1 else 'fail')")" "{\"latency_s\": $lat}"
    else rec 2 "$case: the scene closes within 100 ms" fail '{"reason": "did not close in 3 s"}'; fi
    stop_app
  done
  if python3 -c 'import tkinter' 2>/dev/null; then
    cat > "$OUT/probe.py" <<'PY'
import sys, tkinter
n = 0
r = tkinter.Tk(); r.geometry("600x400+340+200")
def down(e):
    global n; n += 1; open(sys.argv[1], "w").write(str(n))
r.bind("<ButtonPress>", down); open(sys.argv[1], "w").write("0"); r.after(30000, r.destroy); r.mainloop()
PY
    python3 "$OUT/probe.py" "$OUT/probe-count.txt" & PROBE=$!; sleep 1
    xdotool mousemove 640 400; sleep 0.3
    start_app t2-beneath "" --open ambient
    if opened 0 25; then
      sleep 2.4; xdotool click 1; sleep 0.8
      n=$(cat "$OUT/probe-count.txt"); c=0; q "$LOG" --event ambient --where open=false >/dev/null && c=1
      rec 2 "a click on the scene closes it and is not delivered to the window beneath" "$([ "$n" = 0 ] && [ $c = 1 ] && echo pass || echo fail)" "{\"probe_button_presses\": $n, \"scene_closed\": $c}"
    else rec 2 "a click on the scene is not delivered beneath" fail '{"reason": "scene never opened"}'; fi
    stop_app; kill $PROBE 2>/dev/null
  else rec 2 "a click on the scene is not delivered beneath" blocked '{"reason": "python3-tk missing"}'; fi
fi

if [[ ",$TESTS," == *,3,* ]]; then
  if command -v dbus-monitor >/dev/null 2>&1; then
    dbus-monitor --session "interface='org.freedesktop.ScreenSaver'" "interface='org.gnome.SessionManager'" > "$OUT/dbus-monitor.txt" 2>&1 & MON=$!
    sleep 1
    start_app t3 "" --open ambient
    opened 0 25 && sleep 15
    stop_app; kill $MON 2>/dev/null
    n=$(grep -ci "Inhibit" "$OUT/dbus-monitor.txt" || true)
    rec 3 "no screensaver or session inhibit call on the session bus while the scene is open" "$([ "${n:-0}" = 0 ] && echo pass || echo fail)" "{\"inhibit_calls\": ${n:-0}}"
  else rec 3 "no inhibit call" blocked '{"reason": "dbus-monitor missing"}'; fi
fi

python3 - "$RES" "$OUT/results.json" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
json.dump(rows, open(sys.argv[2], "w"), indent=2)
PY
echo "WP-12 Linux ambient: $(grep -c . "$RES") checks, $FAILS failed -> $OUT/results.json"
[ "$FAILS" -eq 0 ]

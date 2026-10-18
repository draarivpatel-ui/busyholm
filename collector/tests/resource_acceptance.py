"""Live sidecar acceptance. All artifacts stay under collector/test-output/."""
import argparse
import http.client
import json
import math
import os
from pathlib import Path
import subprocess
import time

REPO = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("--mode", choices=["idle", "latency"], required=True)
parser.add_argument("--binary", default=str(REPO / "target/release/collector"))
parser.add_argument("--seconds", type=float, default=600)
parser.add_argument("--arg", action="append", default=[], help="extra argument for the binary (repeatable)")
parser.add_argument("--requests", type=int, default=5000)
parser.add_argument("--rate", type=int, default=500)
parser.add_argument("--label", default="", help="suffix for the evidence file name")
args = parser.parse_args()
run = REPO / "collector/test-output" / f"resource-{args.mode}-{os.getpid()}"
data = run / "data"
output = run / "outputs"
data.mkdir(parents=True)
output.mkdir()
out = (output / "stdout.jsonl").open("wb")
err = (output / "stderr.log").open("wb")
child = subprocess.Popen([args.binary, "--data-dir", str(data), *args.arg], stdin=subprocess.PIPE, stdout=out, stderr=err)
try:
    deadline = time.monotonic() + 5
    while not (data / "runtime.json").exists() and time.monotonic() < deadline and child.poll() is None:
        time.sleep(0.01)
    assert (data / "runtime.json").exists(), "sidecar never created runtime file"
    runtime = json.loads((data / "runtime.json").read_text())
    begin = time.monotonic()
    if args.mode == "idle":
        deadline = begin + args.seconds
        while time.monotonic() < deadline:
            assert child.poll() is None, "sidecar exited during idle sample"
            time.sleep(min(1, max(0, deadline-time.monotonic())))
        result = {"duration_s": time.monotonic()-begin}
    else:
        payload = {"v":1,"agent":"claude","instance":"00000000000000000000000000000001","parent":None,
                   "root_id":"00000000000000000000000000000003","account_id":None,"session_id":None,"turn_id":None,"request_id":None,
                   "host":"cli","kind":"heartbeat","source":"hook","confidence":"exact","t":1791806400000,
                   "prompt":"BHCANARY_prompt","message":"BHCANARY_reply","creator_account_id":"bca1a700-0000-4000-8000-000000000001"}
        body = json.dumps(payload).encode()
        headers = {"Content-Type":"application/json", "X-Busyholm-Token":runtime["token"]}
        samples = []
        statuses = {}
        for i in range(args.requests):
            delay = begin + i/args.rate - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            connection = http.client.HTTPConnection("127.0.0.1",runtime["port"],timeout=2)
            start = time.perf_counter_ns()
            connection.request("POST",f'/e/{runtime["secret"]}',body=body,headers=headers)
            response = connection.getresponse()
            response.read()
            samples.append((time.perf_counter_ns()-start)/1_000_000)
            statuses[response.status] = statuses.get(response.status,0)+1
            connection.close()
        elapsed = time.monotonic()-begin
        samples.sort()
        p99 = samples[math.ceil(len(samples)*0.99)-1]
        result = {"requests":args.requests,"target_rps":args.rate,"actual_rps":args.requests/elapsed,
                  "p50_ms":samples[len(samples)//2],"p99_ms":p99,"max_ms":samples[-1],"statuses":statuses}
        assert statuses == {204:args.requests}, "receiver did not acknowledge every request"
        assert p99 <= 5, f"p99 {p99:.3f} ms exceeds 5 ms"
        assert result["actual_rps"] >= args.rate*0.98, "load generator did not sustain the target rate"
    child.stdin.close()
    if hasattr(os,"wait4"):
        _, status, usage = os.wait4(child.pid,0)
        child.returncode = os.waitstatus_to_exitcode(status)
        cpu = usage.ru_utime+usage.ru_stime
        if args.mode == "idle":
            import sys
            rss = usage.ru_maxrss / (1024*1024 if sys.platform == "darwin" else 1024)
            result.update(cpu_seconds=cpu,cpu_pct_of_one_core=100*cpu/result["duration_s"],peak_rss_mb=rss)
            assert rss <= 30, f"peak memory {rss:.1f} MB exceeds 30 MB"
            assert result["cpu_pct_of_one_core"] <= 0.3, "idle CPU exceeds 0.3%"
    else:
        child.wait(timeout=5)
        assert args.mode != "idle", "idle CPU measurement requires POSIX wait4"
    assert child.returncode == 0, "sidecar failed on graceful shutdown"
    out.close()
    err.close()
    for file in output.iterdir():
        content=file.read_bytes().lower()
        assert b"bhcanary" not in content and b"bca1a700" not in content, "canary appeared in sidecar output"
    assert not (data/"runtime.json").exists(), "runtime file survived clean exit"
    print(json.dumps(result,indent=2))
    evidence = REPO/"collector/evidence"
    evidence.mkdir(exist_ok=True)
    (evidence/f"{args.mode}{args.label}.json").write_text(json.dumps(result,indent=2)+"\n")
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    out.close()
    err.close()

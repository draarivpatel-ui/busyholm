#!/usr/bin/env python3
"""Query the app's JSON-lines test log (--test-log). Standard library only.

  logq.py LOG [--event NAME] [--where key=value ...] [--since EPOCH] [--wait SECONDS] [--last] [--count]

Prints the first matching event as one JSON line (the last one with --last, the number of matches
with --count). Exit 0 when something matched, 1 otherwise. --wait polls the file until a match or
the timeout. A --where key may be a dotted path (rect_px.1). A --where value is compared against
data[key] as JSON when it parses (true, false, 112, "x"), otherwise as a plain string.
"""
import argparse
import json
import sys
import time


def read(path):
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


def dig(d, path):
    """data[key] for "key", or a nested value for "key.0.sub" (list indexes allowed)."""
    for part in path.split("."):
        try:
            d = d[int(part)] if isinstance(d, list) else d[part]
        except (KeyError, IndexError, ValueError, TypeError):
            return None
    return d


def coerce(v):
    try:
        return json.loads(v)
    except ValueError:
        return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("log")
    ap.add_argument("--event")
    ap.add_argument("--where", action="append", default=[])
    ap.add_argument("--since", type=float, default=0.0)
    ap.add_argument("--wait", type=float, default=0.0)
    ap.add_argument("--last", action="store_true")
    ap.add_argument("--count", action="store_true")
    a = ap.parse_args()
    want = {}
    for kv in a.where:
        k, _, v = kv.partition("=")
        want[k] = coerce(v)

    def matches():
        m = []
        for e in read(a.log):
            if a.event and e.get("event") != a.event:
                continue
            if e.get("t", 0) < a.since:
                continue
            d = e.get("data", {})
            if all(dig(d, k) == v for k, v in want.items()):
                m.append(e)
        return m

    end = time.time() + a.wait
    while True:
        m = matches()
        if m or time.time() >= end:
            break
        time.sleep(0.1)
    if a.count:
        print(len(m))
        sys.exit(0 if m else 1)
    if not m:
        sys.exit(1)
    print(json.dumps(m[-1] if a.last else m[0]))


if __name__ == "__main__":
    main()

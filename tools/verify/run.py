#!/usr/bin/env python3
"""Busyholm offline verification CLI. Any failed or incomplete gate exits 1."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

from checks import REPO, EXCLUDED, dash_lint, files_under, product_roots, static_network
from licenses import cargo_environment, generate
from runtime import privacy_check, runtime_network


def fingerprint():
    paths = [REPO / 'Cargo.toml', REPO / 'Cargo.lock', REPO / 'package-lock.json']
    for root in product_roots(REPO): paths.extend(files_under(root, EXCLUDED))
    return {str(p.relative_to(REPO)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(set(paths)) if p.is_file() and not p.is_symlink()
            and not str(p.relative_to(REPO)).startswith('app/src-tauri/gen/schemas/')}


def prepare():
    commands = [['cargo', 'build', '--release', '--offline', '--locked', '-p', 'busyholm-shim', '-p', 'busyholm-sidecar'],
                ['node', 'world/renderer/tools/build.mjs'], ['node', 'ui/tools/build.mjs'],
                ['node', 'app/scripts/assemble-frontend.mjs'],
                ['cargo', 'build', '--manifest-path', 'app/src-tauri/Cargo.toml', '--release', '--features', 'collector', '--offline', '--locked']]
    base = Path(tempfile.mkdtemp(prefix='bh-wp14-prepare-')).resolve()
    log = base / 'build.txt'
    with log.open('w') as f:
        for command in commands:
            print(f'Preparing: {" ".join(command)}', flush=True)
            p = subprocess.run(command, cwd=REPO, env=cargo_environment(), stdout=f, stderr=subprocess.STDOUT)
            if p.returncode: return dict(check='prepare', passed=False, errors=[f'build failed; see {log}'], root=str(base))
    return dict(check='prepare', passed=True, root=str(base))


def simple(name, issues):
    return dict(check=name, passed=not issues, errors=issues)


def check(name, args):
    try:
        if name == 'static-network': return simple(name, static_network(REPO))
        if name == 'dash': return simple(name, dash_lint(REPO))
        if name == 'runtime-network': return runtime_network(args.seed_socket)
        if name == 'privacy': return privacy_check(not args.sidecar_only, args.seed_leak)
        if name == 'licenses': return generate(args.notices, args.target)
        if name == 'prepare': return prepare()
        if name == 'self-test':
            p = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', str(Path(__file__).parent),
                                '-p', 'test_*.py', '-v'], capture_output=True, text=True)
            print(p.stdout + p.stderr)
            return dict(check=name, passed=p.returncode == 0)
        raise ValueError(name)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as e:
        return dict(check=name, passed=False, errors=[str(e)])


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('check', choices=['all', 'prepare', 'self-test', 'static-network', 'runtime-network',
                                   'privacy', 'licenses', 'dash'])
    p.add_argument('--json', type=Path)
    p.add_argument('--seed-socket', action='store_true')
    p.add_argument('--seed-leak', action='store_true')
    p.add_argument('--sidecar-only', action='store_true', help='diagnostic subset; not a full app gate')
    p.add_argument('--notices', type=Path, default=REPO / 'packaging/out/notices')
    p.add_argument('--target', help='Rust target for offline licence metadata')
    args = p.parse_args()
    start = fingerprint()
    names = ['static-network', 'runtime-network', 'privacy', 'licenses', 'dash'] if args.check == 'all' else [args.check]
    results = []
    for name in names:
        print(f'Running {name}', flush=True)
        r = check(name, args)
        results.append(r)
        print(f'{name}: {"PASS" if r["passed"] else "FAIL"}', flush=True)
    end = fingerprint()
    changed = sorted(set(start) ^ set(end) | {p for p in start.keys() & end.keys() if start[p] != end[p]})
    if changed: results.append(simple('source-stability', [{'path': p, 'error': 'source changed during verification'} for p in changed]))
    report = dict(passed=all(r['passed'] for r in results), results=results, source_sha256=end,
                  platform={'darwin': 'macos', 'win32': 'windows'}.get(sys.platform, sys.platform),
                  git_head=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip())
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(report, indent=2) + '\n')
    # Keep raw samples, credentials-free logs and fingerprints in artifacts, not terminal output.
    summary = {**report, 'source_sha256': f'{len(end)} product files'}
    summary['results'] = [{k: v for k, v in r.items() if k not in {'evidence', 'plan', 'lock_sha256'}
                          and (k != 'samples' or not isinstance(v, list))} for r in results]
    print(json.dumps(summary, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__': raise SystemExit(main())

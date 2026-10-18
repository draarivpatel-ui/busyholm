"""Unsigned offline bundles and store-depot content staging. No account or upload commands."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'tools/verify'))
from checks import dash_lint, static_network
from licenses import cargo_environment, generate, host_target, release_rustflags

TARGETS = {'macos': 'aarch64-apple-darwin', 'macos-x64': 'x86_64-apple-darwin',
           'windows-x64': 'x86_64-pc-windows-msvc', 'windows-arm64': 'aarch64-pc-windows-msvc',
           'linux': 'aarch64-unknown-linux-gnu', 'linux-x64': 'x86_64-unknown-linux-gnu'}


def build_plan(repo, target, output):
    repo, output = Path(repo), Path(output)
    triple = TARGETS[target]
    os_name = 'macos' if target.startswith('macos') else ('windows' if target.startswith('windows') else 'linux')
    bundles = {'macos': ['app'], 'windows': ['nsis'], 'linux': ['appimage', 'deb']}[os_name]
    helper = output / 'support/busyholm-hook'
    overlay = dict(bundle=dict(targets=bundles, externalBin=[str(helper)], resources={
        str(output / 'notices/THIRD-PARTY-NOTICES.txt'): 'THIRD-PARTY-NOTICES.txt',
        str(output / 'notices/OFL.txt'): 'OFL.txt',
        str(output / 'notices/third-party-sources.tar.gz'): 'third-party-sources.tar.gz'}))
    if os_name == 'windows': overlay['bundle']['windows'] = {'webviewInstallMode': {'type': 'skip'}}
    core = ['cargo', 'build', '--manifest-path', str(repo / 'Cargo.toml'), '--release', '--target', triple,
            '--offline', '--locked', '-p', 'busyholm-shim', '-p', 'busyholm-sidecar']
    if os_name == 'windows': core[1:2] = ['xwin', 'build']
    app = ['node', str(repo / 'app/node_modules/.bin/tauri'), 'build', '--target', triple,
           '--features', 'collector', '--ci', '--no-sign', '--config', str(output / 'bundle-config.json')]
    if os_name == 'windows': app += ['--runner', 'cargo-xwin']
    app += ['--', '--offline', '--locked']
    return dict(target=target, triple=triple, os=os_name, output=str(output), overlay=overlay,
                rustflags=release_rustflags(repo),
                commands=[['node', str(repo / 'world/renderer/tools/build.mjs')],
                          ['node', str(repo / 'ui/tools/build.mjs')], core, app],
                dmg_command=['hdiutil', 'create', '-volname', 'Busyholm', '-srcfolder', str(output / 'dmg-root'),
                             '-format', 'UDZO', str(output / 'Busyholm-unsigned.dmg')] if os_name == 'macos' else None)


def validate_depot(folder, os_name):
    folder = Path(folder)
    if not folder.is_dir(): return ['missing depot folder']
    required = {'windows': ['busyholm.exe', 'busyholm-hook.exe', 'THIRD-PARTY-NOTICES.txt', 'OFL.txt'],
                'linux': ['busyholm', 'busyholm-hook', 'THIRD-PARTY-NOTICES.txt', 'OFL.txt'],
                'macos': ['Busyholm.app/Contents/MacOS/busyholm', 'Busyholm.app/Contents/MacOS/busyholm-hook',
                          'Busyholm.app/Contents/Resources/THIRD-PARTY-NOTICES.txt', 'Busyholm.app/Contents/Resources/OFL.txt']}[os_name]
    errors = [f'missing depot file: {name}' for name in required if not (folder / name).is_file()]
    for p in folder.rglob('*'):
        if p.is_file() and (p.suffix.lower() in {'.dmg', '.msi', '.deb', '.appimage'} or 'setup' in p.name.lower()):
            errors.append(f'installer is not raw depot content: {p.name}')
    return errors


def offline_command(cmd):
    """A hard OS network guard covers bundler SDK downloads as well as Cargo offline mode."""
    if sys.platform == 'darwin':
        guard = shutil.which('sandbox-exec')
        if not guard: raise RuntimeError('sandbox-exec unavailable; cannot guarantee an offline packaging run')
        return [guard, '-p', '(version 1)(allow default)(deny network-outbound)', *cmd]
    if sys.platform.startswith('linux'):
        # linux.sh enters a fresh network namespace first. No routed interface is permitted.
        routes = Path('/proc/net/route').read_text().splitlines()[1:]
        if any(line.split()[0] != 'lo' for line in routes if line.split()):
            raise RuntimeError('Linux packaging needs an isolated network namespace; use packaging/linux.sh')
        return cmd
    raise RuntimeError('This harness builds on macOS or Linux only')


def run(cmd, log, cwd=REPO):
    with log.open('ab') as f:
        p = subprocess.run(offline_command(cmd), cwd=cwd, env=cargo_environment(), stdout=f, stderr=subprocess.STDOUT)
    if p.returncode: raise RuntimeError(f'command failed ({p.returncode}); see {log}')


def verify_release_report(path, expected_platform=None):
    if not path: return ['a passing tools/verify/run.py all report is required; --draft makes a local review bundle']
    report = json.loads(Path(path).read_text())
    required = {'static-network', 'runtime-network', 'privacy', 'licenses', 'dash'}
    results = {r['check']: r for r in report.get('results', [])}
    errors = [f'missing or failing release check: {name}' for name in sorted(required)
              if name not in results or results[name].get('passed') is not True]
    if expected_platform and report.get('platform') != expected_platform:
        errors.append('verification report is for another OS or has no OS tag')
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
    if report.get('git_head') != head: errors.append('verification report does not match HEAD')
    for name, digest in report.get('source_sha256', {}).items():
        if Path(name).is_absolute() or '..' in Path(name).parts:
            errors.append('verification source path escapes the repository'); continue
        p = REPO / name
        if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != digest:
            errors.append(f'verified source changed: {name}')
    if not report.get('source_sha256'): errors.append('report has no source fingerprints')
    if results.get('privacy', {}).get('app_included') is not True: errors.append('app privacy was not exercised')
    return errors


def stage_depot(plan, output):
    os_name, triple = plan['os'], plan['triple']
    release = REPO / 'app/src-tauri/target' / triple / 'release'
    core = REPO / 'target' / triple / 'release'
    depot = output / 'steam/content' / os_name
    depot.mkdir(parents=True)
    if os_name == 'macos':
        source = release / 'bundle/macos/Busyholm.app'
        shutil.copytree(source, depot / source.name, symlinks=True)
    else:
        suffix = '.exe' if os_name == 'windows' else ''
        shutil.copy2(release / ('busyholm' + suffix), depot / ('busyholm' + suffix))
        shutil.copy2(core / ('busyholm-hook' + suffix), depot / ('busyholm-hook' + suffix))
        for name in ['THIRD-PARTY-NOTICES.txt', 'OFL.txt', 'third-party-sources.tar.gz']:
            shutil.copy2(output / 'notices' / name, depot / name)
        # Tauri's static frontend is embedded. These are the only adjacent native runtime files.
        for p in release.glob('*.dll') if os_name == 'windows' else release.glob('*.so*'):
            shutil.copy2(p, depot / p.name)
    errors = validate_depot(depot, os_name)
    if errors: raise RuntimeError('; '.join(errors))
    config = depot_config(plan, output, True)
    (output / 'steam/launch-dry-run.json').write_text(json.dumps(config, indent=2) + '\n')
    return depot


def depot_config(plan, output, ready):
    os_name, triple = plan['os'], plan['triple']
    depot = output / 'steam/content' / os_name
    return dict(os=os_name, target=triple, content_root=str(depot), content_ready=ready,
                  executable='Busyholm.app/Contents/MacOS/busyholm' if os_name == 'macos' else ('busyholm.exe' if os_name == 'windows' else 'busyholm'),
                  app_id=None, depot_id=None, upload=False,
                  supported_for_release=os_name != 'linux',
                  prerequisite='WebView2 must already be installed' if os_name == 'windows' else
                  ('Linux is not a supported release target yet; layout only' if os_name == 'linux' else 'Developer ID and notarisation still required'))


def build(args):
    output = args.out.resolve()
    if output.exists() and any(output.iterdir()): raise RuntimeError('output folder must be new or empty')
    output.mkdir(parents=True, exist_ok=True)
    plan = build_plan(REPO, args.target, output)
    if args.target == 'macos' and sys.platform == 'darwin':
        plan['triple'] = host_target()
        if plan['triple'] != TARGETS['macos']:
            plan = build_plan(REPO, 'macos-x64', output)
    (output / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n')
    if args.dry_run:
        (output / 'steam/content' / plan['os']).mkdir(parents=True)
        (output / 'steam/launch-dry-run.json').write_text(json.dumps(depot_config(plan, output, False), indent=2) + '\n')
        return dict(check='packaging-plan', passed=True, output=str(output), plan=plan)
    errors = verify_release_report(args.report, plan['os'])
    errors += static_network(REPO) + dash_lint(REPO)
    license_result = generate(output / 'notices', plan['triple'])
    errors += license_result['errors']
    if errors and not args.draft:
        return dict(check='packaging', passed=False, errors=errors, output=str(output))
    if not (output / 'notices/OFL.txt').is_file(): raise RuntimeError('no OFL text available even for a draft')
    (output / 'bundle-config.json').write_text(json.dumps(plan['overlay'], indent=2) + '\n')
    log = output / 'build.txt'
    for command in plan['commands'][:3]: run(command, log)
    support = output / 'support'
    support.mkdir()
    suffix = '.exe' if plan['os'] == 'windows' else ''
    helper = REPO / 'target' / plan['triple'] / 'release' / ('busyholm-hook' + suffix)
    shutil.copy2(helper, support / ('busyholm-hook-' + plan['triple'] + suffix))
    run(plan['commands'][3], log, REPO / 'app')
    depot = stage_depot(plan, output)
    if args.draft:
        (output / 'DRAFT.txt').write_text('Unsigned local review artifacts. Release gates failed or are incomplete.\n')
    if plan['dmg_command']:
        dmg_root = output / 'dmg-root'
        dmg_root.mkdir()
        shutil.copytree(depot / 'Busyholm.app', dmg_root / 'Busyholm.app', symlinks=True)
        (dmg_root / 'Applications').symlink_to('/Applications')
        if args.draft: shutil.copy2(output / 'DRAFT.txt', dmg_root / 'DRAFT.txt')
        run(plan['dmg_command'], log)
        run(['hdiutil', 'verify', str(output / 'Busyholm-unsigned.dmg')], log)
    release = REPO / 'app/src-tauri/target' / plan['triple'] / 'release/bundle'
    direct = output / 'direct'
    direct.mkdir()
    patterns = {'macos': ['macos/*.app'], 'windows': ['nsis/*.exe'], 'linux': ['appimage/*.AppImage', 'deb/*.deb']}[plan['os']]
    for pattern in patterns:
        artifacts = list(release.glob(pattern))
        if not artifacts: raise RuntimeError(f'expected bundle is missing: {pattern}')
        for artifact in artifacts:
            if artifact.is_dir(): shutil.copytree(artifact, direct / artifact.name, symlinks=True)
            else: shutil.copy2(artifact, direct / artifact.name)
    return dict(check='packaging', passed=not errors, draft=args.draft, errors=errors, output=str(output), depot=str(depot))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--target', choices=TARGETS, required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--report', type=Path)
    p.add_argument('--draft', action='store_true', help='local artifacts even with failed gates; never a release pass')
    p.add_argument('--dry-run', action='store_true', help='write plan only; no compiler or bundler')
    args = p.parse_args()
    try: result = build(args)
    except (OSError, RuntimeError, subprocess.SubprocessError) as e:
        result = dict(check='packaging', passed=False, errors=[str(e)], output=str(args.out.resolve()))
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    return 0 if result['passed'] else 1


if __name__ == '__main__': raise SystemExit(main())

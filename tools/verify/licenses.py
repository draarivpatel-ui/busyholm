"""Generate notices only from installed cargo metadata, npm locks and local licence files."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

from checks import REPO, license_allowed


def release_rustflags(repo=REPO, home=None):
    home_dir = Path(home) if home is not None else Path.home()
    repo_dir = Path(repo)
    flags = []
    for raw, mapped in [(home_dir, '~'), (repo_dir, 'busyholm')]:
        candidates = [raw]
        try:
            resolved = raw.resolve()
            if resolved not in candidates:
                candidates.append(resolved)
        except OSError:
            pass
        for candidate in candidates:
            flag = f'--remap-path-prefix={candidate}={mapped}'
            if flag not in flags:
                flags.append(flag)
    return flags


def cargo_environment(repo=REPO, home=None):
    env = os.environ.copy()
    # Put the usual Rust toolchain locations on PATH without sourcing shell startup files or changing caller variables.
    extra = ['/opt/homebrew/opt/rustup/bin', str(Path.home() / '.cargo/bin'),
             '/opt/homebrew/opt/llvm/bin', '/opt/homebrew/opt/lld/bin']
    env['PATH'] = os.pathsep.join(extra + [env.get('PATH', '')])
    env['CARGO_NET_OFFLINE'] = 'true'
    env['HOMEBREW_NO_AUTO_UPDATE'] = '1'
    existing = [f for f in env.get('CARGO_ENCODED_RUSTFLAGS', '').split('\x1f') if f]
    if not existing and env.get('RUSTFLAGS'):
        existing = env['RUSTFLAGS'].split()
    for flag in release_rustflags(repo, home):
        if flag not in existing:
            existing.append(flag)
    env['CARGO_ENCODED_RUSTFLAGS'] = '\x1f'.join(existing)
    env.pop('RUSTFLAGS', None)
    return env


def host_target():
    result = subprocess.run(['rustc', '-vV'], env=cargo_environment(), capture_output=True, text=True, check=True)
    return next(line.split(': ', 1)[1] for line in result.stdout.splitlines() if line.startswith('host:'))


def metadata(manifest, target):
    cmd = ['cargo', 'metadata', '--manifest-path', str(manifest), '--offline', '--locked',
           '--filter-platform', target, '--format-version', '1']
    p = subprocess.run(cmd, env=cargo_environment(), capture_output=True, text=True)
    if p.returncode: raise RuntimeError(p.stderr.strip())
    return json.loads(p.stdout)


def notice_files(folder, license_file=None):
    files = []
    if license_file:
        p = Path(license_file)
        if not p.is_absolute(): p = folder / p
        if p.is_file() and not p.is_symlink(): files.append(p)
    if folder.is_dir():
        for p in sorted(folder.iterdir()):
            if p.is_file() and not p.is_symlink() and re.match(r'(?i)^(licen[cs]e|copying|notice)([.\-_]|$)', p.name):
                files.append(p)
    return sorted(set(files))


# Phrases that identify each licence text. Whitespace is collapsed and case ignored before matching.
SIGNATURES = {
    'MIT': ['permission is hereby granted, free of charge, to any person obtaining a copy'],
    'Apache-2.0': ['apache license', 'version 2.0, january 2004', 'terms and conditions for use, reproduction, and distribution'],
    'Zlib': ["this software is provided 'as-is', without any express or implied warranty", 'altered source versions must be plainly marked'],
    'BSD-3-Clause': ['redistributions of source code must retain', 'redistributions in binary form must reproduce', 'neither the name'],
    'MPL-2.0': ['mozilla public license version 2.0'],
}


def text_satisfies(expression, texts):
    """True when the texts contain the licence text of enough identifiers to satisfy the SPDX expression (OR: one
    alternative, AND: all). Unknown identifiers never match, so the check fails closed."""
    haystack = re.sub(r'\s+', ' ', '\n'.join(texts)).lower()
    present = lambda ident: ident in SIGNATURES and all(sig in haystack for sig in SIGNATURES[ident])
    tokens = re.findall(r'[A-Za-z0-9.+-]+|[()]', (expression or '').replace('/', ' OR '))
    cursor = 0
    def atom():
        nonlocal cursor
        token = tokens[cursor]; cursor += 1
        if token == '(':
            ok = either(); cursor += 1
            return ok
        if token in {'AND', 'OR', 'WITH', ')'}: raise ValueError()
        return present(token)
    def both():
        nonlocal cursor
        ok = atom()
        while cursor < len(tokens) and tokens[cursor] == 'AND':
            cursor += 1; rhs = atom(); ok = ok and rhs
        return ok
    def either():
        nonlocal cursor
        ok = both()
        while cursor < len(tokens) and tokens[cursor] == 'OR':
            cursor += 1; rhs = both(); ok = ok or rhs
        return ok
    try: return either() and cursor == len(tokens)
    except (ValueError, IndexError): return False


def override_files(name, version):
    """Committed licence text for a package whose installed archive ships none: packaging/licence-overrides/<name>-<version>/
    (an npm scope slash becomes two underscores). The version is part of the folder name, so a new version needs a new,
    checked override."""
    return notice_files(REPO / 'packaging/licence-overrides' / f'{name.replace("/", "__")}-{version}')


def installed_or_override(name, version, expression, files, errors):
    """The package's notice files: the installed archive's, else a committed override that matches the declared licence."""
    if files: return files
    files = override_files(name, version)
    if not files:
        errors.append(dict(package=f'{name}@{version}', error='installed licence text is missing'))
    elif not text_satisfies(expression, [f.read_text(errors='replace') for f in files]):
        errors.append(dict(package=f'{name}@{version}', error=f'licence override does not match the declared licence: {expression}'))
    return files


def generate(output, target=None):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    target = target or host_target()
    errors, entries, sources, hashes, metadata_files = [], {}, {}, {}, []
    minimums = {}
    for manifest in [REPO / 'Cargo.toml', REPO / 'app/src-tauri/Cargo.toml']:
        try: data = metadata(manifest, target)
        except RuntimeError as e:
            errors.append(dict(manifest=str(manifest.relative_to(REPO)), error=str(e))); continue
        meta_file = output / ('app-metadata.json' if manifest.parent.name == 'src-tauri' else 'core-metadata.json')
        # Do not put machine-specific paths into distributable notices.
        meta_file.write_text(json.dumps(data, indent=2) + '\n'); metadata_files.append(meta_file.name)
        versions = [p['rust_version'] for p in data['packages'] if p.get('rust_version')]
        minimums[str(manifest.relative_to(REPO))] = max(versions, key=lambda s: tuple(map(int, s.split('.'))))
        for p in data['packages']:
            key = ('cargo', p['name'], p['version'])
            if key in entries: continue
            local = p.get('source') is None
            expression = p.get('license')
            if local and expression in ('UNLICENSED', 'MIT'):
                # Busyholm's own crates: covered by the repository LICENSE, not by third-party notices.
                entries[key] = dict(license=expression, texts=[], own=True); continue
            if not license_allowed(expression):
                errors.append(dict(package=f'{p["name"]}@{p["version"]}', error=f'missing or disallowed licence: {expression}'))
            folder = Path(p['manifest_path']).parent
            files = notice_files(folder, p.get('license_file'))
            if not local: files = installed_or_override(p['name'], p['version'], expression, files, errors)
            entries[key] = dict(license=expression, texts=[(f.name, f.read_text(errors='replace')) for f in files], own=local)
            if expression and 'MPL-2.0' in expression:
                sources[f'cargo/{p["name"]}-{p["version"]}'] = folder
    npm_os = 'darwin' if 'apple' in target else ('win32' if 'windows' in target else 'linux')
    npm_cpu = 'arm64' if target.startswith('aarch64') else 'x64'
    for lock in [REPO / 'package-lock.json', REPO / 'app/package-lock.json', REPO / 'world/art/package-lock.json']:
        hashes[str(lock.relative_to(REPO))] = hashlib.sha256(lock.read_bytes()).hexdigest()
        packages = json.loads(lock.read_text()).get('packages', {})
        for name, p in packages.items():
            if not name or 'node_modules/' not in name or p.get('link'): continue
            if p.get('os') and npm_os not in p['os']: continue
            if p.get('cpu') and npm_cpu not in p['cpu']: continue
            package_name = name.rsplit('node_modules/', 1)[1]
            key = ('npm', package_name, p.get('version', 'UNKNOWN'))
            if key in entries: continue
            expression = p.get('license')
            if not license_allowed(expression):
                errors.append(dict(package=f'{package_name}@{key[2]}', error=f'missing or disallowed licence: {expression}'))
            folder = lock.parent / name
            files = notice_files(folder)
            files = installed_or_override(package_name, key[2], expression, files, errors)
            entries[key] = dict(license=expression, texts=[(f.name, f.read_text(errors='replace')) for f in files], own=False)
    for lock in [REPO / 'Cargo.lock', REPO / 'app/src-tauri/Cargo.lock']:
        hashes[str(lock.relative_to(REPO))] = hashlib.sha256(lock.read_bytes()).hexdigest()
    ofl = REPO / 'ui/src/fonts/OFL.txt'
    fonts = list((REPO / 'ui/src/fonts').glob('*.woff*')) + list((REPO / 'ui/src/fonts').glob('*.ttf'))
    if fonts and (not ofl.is_file() or 'SIL OPEN FONT LICENSE' not in ofl.read_text()):
        errors.append(dict(error='bundled font OFL text is missing'))
    if ofl.is_file(): shutil.copy2(ofl, output / 'OFL.txt')
    with tarfile.open(output / 'third-party-sources.tar.gz', 'w:gz') as archive:
        for name, folder in sorted(sources.items()):
            archive.add(folder, arcname=name, filter=lambda item: None if '/target/' in item.name or '/.git/' in item.name else item)
    lines = ['Busyholm third-party notices', f'Target: {target}',
             'INCOMPLETE: release is blocked by licence-check.json.' if errors else 'Generated offline from the locked, locally installed dependencies.',
             'MPL-2.0 package sources accompany this file in third-party-sources.tar.gz.', '']
    for (ecosystem, name, version), entry in sorted(entries.items()):
        if entry['own']: continue
        lines.extend([f'{ecosystem}: {name} {version}', f'Licence expression: {entry["license"]}', ''])
        for filename, text in entry['texts']: lines.extend([f'--- {filename} ---', text.rstrip(), ''])
    if ofl.is_file(): lines.extend(['Bundled Fraunces font: OFL-1.1', ofl.read_text().rstrip(), ''])
    (output / 'THIRD-PARTY-NOTICES.txt').write_text('\n'.join(lines) + '\n')
    result = dict(check='licenses', passed=not errors, target=target, errors=errors,
                  packages=len(entries), npm_platform=dict(os=npm_os, cpu=npm_cpu),
                  lock_sha256=hashes, minimum_rust=minimums, metadata_files=metadata_files,
                  notice_sha256=hashlib.sha256((output / 'THIRD-PARTY-NOTICES.txt').read_bytes()).hexdigest(),
                  mpl_source_packages=sorted(sources), output=str(output.resolve()))
    (output / 'license-check.json').write_text(json.dumps(result, indent=2) + '\n')
    return result

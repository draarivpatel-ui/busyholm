"""Offline, fail-closed verification primitives for WP-14."""
import base64
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re

REPO = Path(__file__).resolve().parents[2]
EXCLUDED = {"node_modules", "target", "dist", "test", "tests", "fixtures", "captures",
            "evidence", "test-output", "tools", "build", "__pycache__", ".git"}
SOURCE_EXT = {".rs", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".html", ".css", ".json", ".toml", ".py", ".sh"}
TOKENS = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|`(?:\\.|[^`\\])*`|//[^\n]*|/\*[\s\S]*?\*/')
NETWORK = re.compile(
    r'\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon|importScripts)\b|'
    r'\b(?:TcpStream|TcpListener|UdpSocket|SocketAddr|reqwest|ureq|surf|hyper|axios)\b|'
    r'\b(?:std|tokio)::net::|'
    r'\b(?:connect_timeout|Server::http|curl|wget|NWConnection|URLSession|WinHttpOpen|InternetOpen|urllib|requests)\b'
)
URL = re.compile(r'\b(?:https?|wss?|ftp)://[^\s"\'<>`)]+')
# Loopback clients that may call fetch. Each is one named file; the rule for it is in loopback_client_issues.
LOOPBACK_PREFIX = "http://127.0.0.1:"
LOOPBACK_FETCH_CLIENTS = {
    "collector-wp06/plugin/busyholm.js": "OpenCode plugin: posts allowlisted events to the loopback receiver (see tools/verify/README.md)",
}


def strip_comments(text):
    return TOKENS.sub(lambda m: re.sub(r'[^\n]', ' ', m[0]) if m[0].startswith(('//', '/*')) else m[0], text)


def product_roots(root):
    return [p for p in sorted(Path(root).iterdir()) if p.is_dir() and
            (p.name in {"app", "shim", "installer", "world", "ui", "sidecar"} or p.name.startswith("collector"))]


def files_under(folder, excluded=()):
    """Never follow symlinks, never leave the explicitly supplied root."""
    for base, dirs, files in os.walk(folder, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in excluded and not (Path(base) / d).is_symlink())
        for name in sorted(files):
            yield Path(base) / name


def call_args(clean, masked, open_at):
    """Argument text of the call whose '(' is at open_at; strings and comments are masked in `masked`."""
    depth = 0
    for i in range(open_at, len(masked)):
        if masked[i] == '(':
            depth += 1
        elif masked[i] == ')':
            depth -= 1
            if depth == 0:
                return clean[open_at + 1:i].strip()
    return ''


def loopback_client_issues(rel, clean):
    """Rule for a file in LOOPBACK_FETCH_CLIENTS, on comment-stripped text. An empty list allows its fetch.

    Every URL literal must be built from the loopback address; every redirect option must be "error" (and there
    must be at least one); the only fetch forms are the default transport `fetch(url, init)` and a call whose URL
    is a loopback template literal; the word fetch appears nowhere else; and every transport(...) call takes a
    loopback template literal, which is what feeds the default transport. The URL at the default transport is a
    parameter, so its origin is checked by that transport(...) rule, not by this one.
    """
    issues = []

    def bad(error, match=None):
        issues.append(dict(path=rel, error=error, match=match))

    for m in URL.finditer(clean):
        if not m[0].startswith(LOOPBACK_PREFIX):
            bad("non-loopback URL in a loopback client", m[0])
    redirects = re.findall(r'\bredirect\s*:\s*([^,}\n]+)', clean)
    if not redirects or any(value.strip() != '"error"' for value in redirects):
        bad('loopback client must set redirect: "error" on every request', ", ".join(v.strip() for v in redirects) or None)
    masked = TOKENS.sub(lambda m: ' ' * len(m[0]), clean)
    calls = 0
    for m in re.finditer(r'\bfetch\s*\(', masked):
        calls += 1
        args = call_args(clean, masked, m.end() - 1)
        if args != 'url, init' and not args.startswith('`' + LOOPBACK_PREFIX):
            bad("fetch whose URL is not the default transport parameter or a loopback literal", args)
    if len(re.findall(r'\bfetch\b', clean)) != calls:
        bad("fetch referenced outside a direct call")
    for m in re.finditer(r'\btransport\s*\(', masked):
        args = call_args(clean, masked, m.end() - 1)
        if not args.startswith('`' + LOOPBACK_PREFIX):
            bad("transport(...) call not built from the loopback address", args)
    return issues


def static_network(root):
    root = Path(root)
    policy_path = Path(__file__).with_name("loopback-policy.json")
    policy = json.loads(policy_path.read_text()) if policy_path.exists() else {}
    issues = []
    for folder in product_roots(root):
        for p in files_under(folder, EXCLUDED):
            if p.suffix not in SOURCE_EXT or p.name.endswith(("lock.json", ".lock")):
                continue
            rel = p.relative_to(root).as_posix()
            if rel.startswith('app/src-tauri/gen/schemas/'):
                # Tauri CLI-generated schema documentation is not shipped executable code.
                continue
            if p.is_symlink():
                issues.append(dict(path=rel, error="source symlink is not audited")); continue
            text = p.read_text()
            audited = rel in policy and hashlib.sha256(p.read_bytes()).hexdigest() == policy[rel]["sha256"]
            if rel in policy and not audited:
                issues.append(dict(path=rel, error="audited loopback source changed; review and repin its digest"))
            clean = strip_comments(text) if p.suffix not in {".json", ".toml"} else text
            clean = mask_test_modules(clean) if p.suffix == ".rs" else clean
            loopback = rel in LOOPBACK_FETCH_CLIENTS
            loopback_issues = loopback_client_issues(rel, clean) if loopback else []
            issues.extend(loopback_issues)
            for lineno, line in enumerate(clean.splitlines(), 1):
                inert = ((rel == "app/src-tauri/tauri.conf.json" and
                          ('"$schema"' in line or '"connect-src"' in line)) or
                         (rel == "ui/src/ui/dom.js" and re.fullmatch(r'\s*const SVG_NS = "http://www.w3.org/2000/svg";\s*', line)))
                for m in ([] if loopback else URL.finditer(line)):  # a loopback client's URLs are checked by its rule
                    if inert and m[0] in {"https://schema.tauri.app/config/2", "http://ipc.localhost", "http://www.w3.org/2000/svg"}:
                        continue
                    issues.append(dict(path=rel, line=lineno, error="remote or socket URL", match=m[0]))
                if not audited:
                    api_line = re.sub(r'\[\s*["\'](fetch|WebSocket|XMLHttpRequest|sendBeacon|EventSource)["\']\s*\]', r'.\1', line)
                    api_line = TOKENS.sub(lambda m: ' ' * len(m[0]), api_line)
                    if loopback and not loopback_issues:
                        api_line = re.sub(r'\bfetch\b', ' ', api_line)  # approved by loopback_client_issues
                    patterns = [NETWORK]
                    if p.suffix != '.rs': patterns.append(re.compile(r'\bEventSource\b'))
                    for m in (m for pattern in patterns for m in pattern.finditer(api_line)):
                        issues.append(dict(path=rel, line=lineno, error="network API outside audited loopback transport", match=m[0]))
                    if re.search(r'(?:from\s*|require\s*\(|import\s*\()["\'](?:node:)?(?:net|tls|http|https|http2|dgram)["\']', line):
                        issues.append(dict(path=rel, line=lineno, error='Node network module import'))
    return issues


def mask_test_modules(text):
    """Mask only a balanced, compile-excluded #[cfg(test)] module."""
    chars = list(text)
    for m in re.finditer(r'#\[cfg\(test\)\]\s*mod\s+\w+\s*\{', text):
        depth = 1
        end = m.end()
        tail = TOKENS.sub(lambda s: ' ' * len(s[0]), text[end:])
        for i, c in enumerate(tail):
            depth += (c == '{') - (c == '}')
            if depth == 0:
                end += i + 1
                break
        else:
            continue
        for i in range(m.start(), end):
            if chars[i] != '\n': chars[i] = ' '
    return ''.join(chars)


def socket_violations(raw):
    """Parse lsof -nP -i -F pftPn; check local and peer endpoints, TCP and UDP."""
    issues, pid, fd = [], None, None
    for line in raw.splitlines():
        if not line: continue
        if line[0] == 'p': pid = line[1:]
        if line[0] == 'f': fd = line[1:]
        if line[0] != 'n': continue
        name = line[1:].split(' (', 1)[0]
        for endpoint in name.split('->'):
            host = endpoint[1:].split(']', 1)[0] if endpoint.startswith('[') else endpoint.rsplit(':', 1)[0]
            try: allowed = ipaddress.ip_address(host).is_loopback
            except ValueError: allowed = False
            if not allowed:
                issues.append(dict(pid=pid, fd=fd, endpoint=endpoint, error="non-loopback socket"))
    return issues


def canary_patterns(canaries):
    patterns = set()
    for needle in canaries:
        for text in {needle, needle.lower(), needle.upper()}:
            b = text.encode()
            patterns.update([b, text.encode('utf-16le'), text.encode('utf-16be'), b.hex().encode(), b.hex().upper().encode()])
            for shift in range(3):
                encoded = base64.b64encode(b'\0' * shift + b).rstrip(b'=')
                core = encoded[math.ceil(8 * shift / 6):math.floor(8 * (shift + len(b)) / 6)]
                if len(core) >= 6: patterns.update([core, core.replace(b'+', b'-').replace(b'/', b'_')])
    return sorted(patterns, key=len, reverse=True)


def scan_canaries(roots, canaries):
    patterns = canary_patterns(canaries)
    if not roots or not patterns: return [dict(error="missing output roots or canaries")]
    issues = []
    overlap = max(map(len, patterns))
    for root in map(Path, roots):
        if not root.exists() or root.is_symlink():
            issues.append(dict(path=str(root), error="output root absent or symlink")); continue
        for base, dirs, files in os.walk(root, followlinks=False):
            for name in dirs + files:
                p = Path(base) / name
                if p.is_symlink(): issues.append(dict(path=str(p), error="output symlink is not scanned"))
            dirs[:] = [d for d in dirs if not (Path(base) / d).is_symlink()]
            for name in files:
                p = Path(base) / name
                if p.is_symlink(): continue
                if any(pattern in str(p.relative_to(root)).encode() for pattern in patterns):
                    issues.append(dict(path=str(p), error="canary in output filename")); continue
                try:
                    with p.open('rb') as f:
                        tail = b''
                        while chunk := f.read(1024 * 1024):
                            block = tail + chunk
                            if any(pattern in block for pattern in patterns):
                                issues.append(dict(path=str(p), error="privacy canary in output")); break
                            tail = block[-overlap:]
                except OSError as e: issues.append(dict(path=str(p), error=f"cannot scan output: {e}"))
    return issues


def mask_non_strings(text):
    out = ['\n' if c == '\n' else ' ' for c in text]
    for m in TOKENS.finditer(text):
        if m[0].startswith(('"', "'", '`')): out[m.start():m.end()] = m[0]
    return ''.join(out)


def dash_lint(root):
    root = Path(root)
    issues = []
    folders = product_roots(root) + [root / 'copy', root / 'packaging', root / 'tools/verify']
    paths = {root / 'README.md'}
    for folder in folders:
        if folder.is_dir(): paths.update(files_under(folder, EXCLUDED | {'output', 'out'}))
    for p in sorted(paths):
        if not p.is_file() or p.is_symlink(): continue
        rel = p.relative_to(root).as_posix()
        is_doc = p.suffix == '.md' and (p.name == 'README.md' or rel.startswith(('copy/', 'packaging/')))
        is_copy = p.suffix in {'.rs', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.html'} and rel.startswith(tuple(f.name + '/' for f in product_roots(root)))
        if not is_doc and not is_copy: continue
        text = p.read_text()
        if is_copy:
            if p.suffix == '.html': text = re.sub(r'<!--[\s\S]*?-->', lambda m: re.sub(r'[^\n]', ' ', m[0]), text)
            else: text = mask_non_strings(strip_comments(text))
        for lineno, line in enumerate(text.splitlines(), 1):
            if '\u2013' in line or '\u2014' in line:
                issues.append(dict(path=rel, line=lineno, error="em or en dash in public docs or literal copy"))
    return issues


ALLOWED = {'MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'ISC',
           'CC0-1.0', 'Unlicense', 'Zlib', 'Unicode-3.0', 'Unicode-DFS-2016', 'OFL-1.1', 'MPL-2.0', 'BSL-1.0'}


def license_allowed(expression):
    """SPDX AND/OR precedence. OR selects an allowed alternative; AND requires all."""
    if not isinstance(expression, str) or not expression.strip(): return False
    expression = expression.replace('/', ' OR ')
    tokens = re.findall(r'[A-Za-z0-9.+-]+|[()]', expression)
    if ''.join(tokens) != re.sub(r'\s+', '', expression): return False
    cursor = 0
    def atom():
        nonlocal cursor
        if cursor >= len(tokens): raise ValueError()
        token = tokens[cursor]; cursor += 1
        if token == '(':
            ok = either()
            if cursor >= len(tokens) or tokens[cursor] != ')': raise ValueError()
            cursor += 1
            return ok
        if token in {'AND', 'OR', 'WITH', ')'}: raise ValueError()
        ok = token in ALLOWED
        if cursor < len(tokens) and tokens[cursor] == 'WITH':
            cursor += 1
            if cursor >= len(tokens): raise ValueError()
            ok = ok and token == 'Apache-2.0' and tokens[cursor] == 'LLVM-exception'
            cursor += 1
        return ok
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


def performance_violations(s):
    budgets = {'collector-idle': (.3, 30, 10, None), 'strip-idle': (1, 150, 60, 12),
               'strip-active': (3, 150, 150, 30), 'ambient': (8, 230, None, 30),
               'strip-hidden': (.3, None, None, 0)}
    name = s.get('scenario')
    if name not in budgets: return ['unknown performance scenario']
    cpu, mem, wake, fps = budgets[name]
    if s.get('platform') == 'windows' and name == 'strip-idle': cpu = 2
    errors = []
    for field, limit in [('cpu_pct', cpu), ('footprint_mb', mem), ('wakeups_per_s', wake), ('drawn_fps', fps)]:
        value = s.get(field)
        if limit is None: continue
        if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            errors.append(f'{field}: missing or invalid measurement')
        elif value > limit + (0.2 if field == 'drawn_fps' else 0):
            errors.append(f'{field}: {value:.3f} exceeds {limit}')
    duration = s.get('duration_s', 0)
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration < 600:
        errors.append('measurement shorter than SPEC 6.7 ten-minute window')
    for field in ['load_start', 'load_end']:
        v = s.get(field)
        if not isinstance(v, (int, float)) or not math.isfinite(v) or v > 1.0:
            errors.append(f'{field}: quiet-machine condition unverified (load must be <= 1.0)')
    if name != 'collector-idle' and s.get('helpers_verified') is not True:
        errors.append('webview and GPU helpers or page health unverified')
    if name == 'strip-active':
        peak = s.get('cpu_peak_pct')
        if not isinstance(peak, (int, float)) or not math.isfinite(peak) or peak > 10:
            errors.append('active CPU peak exceeds 10% or is unmeasured')
        burst = s.get('peak_over_3_s')
        if not isinstance(burst, (int, float)) or not math.isfinite(burst) or burst > 3:
            errors.append('active CPU bursts above 3% last longer than 3 s or are unmeasured')
    if name == 'ambient':
        v = s.get('drawn_fps')
        if not isinstance(v, (int, float)) or not math.isfinite(v) or v < 28:
            errors.append('ambient did not sustain approximately 30 fps')
    return errors


DATA_FILES = {'ledger.json', 'choices.json', 'settings.json', 'install-manifest.json', 'salt',
              'backups', 'demo-ledger.json', 'pending-alerts.json', 'coverage.json', 'onboarding.json',
              'runtime.json', 'receiver-keys.json'}


def inventory(data):
    data = Path(data)
    if not data.is_dir(): return dict(files=[], errors=['missing data folder'])
    entries, errors = [], []
    for p in files_under(data):
        rel = p.relative_to(data).as_posix()
        entries.append(dict(path=rel, bytes=p.lstat().st_size))
        top = rel.split('/')[0]
        if p.is_symlink() or not any(top == name or top.startswith(name + '.') or top.startswith(name + '-') for name in DATA_FILES):
            errors.append(f'uninventoried data output: {rel}')
    return dict(files=entries, errors=errors)

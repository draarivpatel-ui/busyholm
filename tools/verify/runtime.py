"""Real-process checks using synthetic agent roots, temp data, and rootless lsof."""
from contextlib import ExitStack
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time

from checks import REPO, inventory, scan_canaries, socket_violations

CONTENT_FIELDS = ['prompt', 'last_assistant_message', 'tool_input', 'tool_response', 'output',
                  'text', 'content', 'message', 'title', 'name', 'summary', 'error_details',
                  'permission_suggestions', 'user_email', 'input-messages', 'last-assistant-message',
                  'toolUseResult', 'cwd', 'transcript_path', 'file_path', 'path', 'creator_user_id',
                  'creator_account_id', 'command', 'gitBranch', 'description', 'last_agent_message']
CANARIES = ['BHWP14CANARY_', 'BHCANARY_', 'bca1a700-0000-4000-8000-', 'WP14-RAW-']


def isolated_environment(base):
    """Per-child documented agent-root overrides; the caller's environment is untouched."""
    env = os.environ.copy()
    env.update(CLAUDE_CONFIG_DIR=str(base / 'inputs/claude'), CODEX_HOME=str(base / 'inputs/codex'),
               OPENCODE_CONFIG_DIR=str(base / 'inputs/opencode'), XDG_CONFIG_HOME=str(base / 'inputs/config'),
               XDG_DATA_HOME=str(base / 'inputs/share'), BUSYHOLM_NO_ONBOARDING='1',
               BUSYHOLM_IDLE_TRIGGER='off', CARGO_NET_OFFLINE='true')
    for p in ['claude', 'codex/sessions', 'opencode', 'config', 'share']:
        (base / 'inputs' / p).mkdir(parents=True, exist_ok=True)
    return env


def workdir(label):
    return Path(tempfile.mkdtemp(prefix=f'bh-wp14-{label}-')).resolve()


def wait_for(predicate, seconds=10):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = predicate()
        if value: return value
        time.sleep(.025)
    raise RuntimeError('timed out waiting for real product evidence')


def stop(child, stdin_shutdown=False):
    if child.poll() is not None: return
    if stdin_shutdown and child.stdin: child.stdin.close()
    else: child.terminate()
    try: child.wait(timeout=8)
    except subprocess.TimeoutExpired:
        child.kill(); child.wait(timeout=5)


class Live:
    def __init__(self, base, mode, stack, seconds=35, binary=None, launcher=None):
        self.base, self.mode = base, mode
        self.data = base / 'outputs' / mode / 'data'
        self.logs = self.data.parent
        self.logs.mkdir(parents=True, exist_ok=True)
        env = isolated_environment(base)
        if mode == 'sidecar':
            cmd = [str(REPO / 'target/release/busyholm-sidecar'), '--data-dir', str(self.data),
                   '--claude-root', env['CLAUDE_CONFIG_DIR'], '--codex-sessions', env['CODEX_HOME'] + '/sessions']
        else:
            cmd = [str(binary or REPO / 'app/src-tauri/target/release/busyholm'), '--data-dir', str(self.data),
                   '--test-log', str(self.logs / 'app.jsonl'), '--exit-after', str(seconds)]
        if launcher is not None:
            cmd.insert(0, str(launcher))
        self.child = subprocess.Popen(cmd, stdin=subprocess.PIPE, cwd=base if launcher else None,
                                      stdout=stack.enter_context((self.logs / 'stdout.jsonl').open('wb')),
                                      stderr=stack.enter_context((self.logs / 'stderr.txt').open('wb')), env=env)
        stack.callback(stop, self.child, mode == 'sidecar')
        self.runtime = self.data / 'runtime.json'
        wait_for(lambda: self.runtime.is_file() or self.child.poll() is not None)
        if not self.runtime.is_file():
            raise RuntimeError(f'{mode}: real collector did not start; build app with --features collector')

    def shim(self, body, agent, stack):
        start = time.monotonic()
        cmd = [str(REPO / 'target/release/busyholm-hook'), 'hook', '--agent', agent, '--runtime', str(self.runtime)]
        child = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                 stdout=stack.enter_context((self.logs / f'shim-{time.monotonic_ns()}.stdout').open('wb')),
                                 stderr=stack.enter_context((self.logs / f'shim-{time.monotonic_ns()}.stderr').open('wb')))
        stack.callback(stop, child)
        child.communicate(json.dumps(body).encode(), timeout=2)
        if child.returncode != 0: raise RuntimeError('shim returned nonzero')
        return 1000 * (time.monotonic() - start)


def content_fields():
    return {field: f'BHWP14CANARY_{field.replace("-", "_")}' for field in CONTENT_FIELDS}


def fixtures(base):
    """Populate real adapter formats from the repo's synthetic, content-filled fixtures."""
    env = isolated_environment(base)
    now = datetime.now(timezone.utc)
    cases = [('claude/transcript/transcript-main.jsonl', Path(env['CLAUDE_CONFIG_DIR']) / 'projects/synthetic/session.jsonl'),
             ('codex/rollout/rollout-complete-turn.jsonl', Path(env['CODEX_HOME']) / 'sessions' / now.strftime('%Y/%m/%d') / 'rollout-synthetic.jsonl')]
    counts = {}
    def refresh(v):
        if isinstance(v, dict):
            for key in list(v):
                if key == 'timestamp': v[key] = now.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
                else: refresh(v[key])
            # All named content fields are tested even if a fixture omitted one.
            for key, marker in content_fields().items():
                if key not in v: v[key] = marker
        elif isinstance(v, list):
            for item in v: refresh(item)
    for src, dest in cases:
        dest.parent.mkdir(parents=True, exist_ok=True)
        rows = [json.loads(line) for line in (REPO / 'fixtures/agent-inputs' / src).read_text().splitlines() if line]
        for row in rows: refresh(row)
        dest.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        counts[src] = len(rows)
    return counts


def read_outputs(file):
    rows = []
    if not file.exists(): return rows
    for line in file.read_text().splitlines():
        try: rows.append(json.loads(line))
        except ValueError: pass
    return rows


def turns(data, tool):
    try: ledger = json.loads((data / 'ledger.json').read_text())
    except (OSError, ValueError): return 0
    return sum(day.get(tool, {}).get('turns', 0) for day in ledger.get('days', {}).values())


def append_live_log_probe(base):
    """Startup rebuild must not award historic work. A NEW log turn proves live ingestion."""
    path = next((base / 'inputs/codex/sessions').rglob('rollout-synthetic.jsonl'))
    turn_id = f'WP14-RAW-live-log-{time.monotonic_ns()}'
    with path.open('a') as f:
        for event in ['task_started', 'task_complete']:
            payload = content_fields()
            payload.update(type=event, turn_id=turn_id)
            f.write(json.dumps(dict(type='event_msg', timestamp=datetime.now(timezone.utc).isoformat(), payload=payload)) + '\n')
            f.flush()
            time.sleep(.15)


def privacy_check(include_app=True, seed_leak=False):
    base = workdir('privacy')
    fixture_counts = fixtures(base)
    evidence, problems = [], []
    with ExitStack() as stack:
        for mode in (['sidecar', 'app'] if include_app else ['sidecar']):
            live = Live(base, mode, stack)
            # Let log-only activity be observed first, proving log ingestion independently of hooks.
            if mode == 'sidecar':
                wait_for(lambda: any(v.get('type') == 'snapshot' and v['data'].get('agents') for v in read_outputs(live.logs / 'stdout.jsonl')))
            else:
                wait_for(lambda: any(v.get('event') == 'snapshot' and v.get('data', {}).get('agents', 0) >= 2
                                    for v in read_outputs(live.logs / 'app.jsonl')))
            append_live_log_probe(base)
            wait_for(lambda: turns(live.data, 'codex') >= 1, seconds=10)
            timing = []
            for agent in ['claude', 'codex']:
                for event in ['UserPromptSubmit', 'PermissionRequest', 'Stop']:
                    body = content_fields()
                    body.update(hook_event_name=event, session_id=f'WP14-RAW-{agent}-session',
                                turn_id=f'WP14-RAW-{agent}-turn', request_id=f'WP14-RAW-{agent}-request',
                                tool_name='Bash' if agent == 'claude' else 'shell', host='cli',
                                tool_input={'command': 'BHWP14CANARY_command', 'file_path': 'BHWP14CANARY_file_path'})
                    timing.append(live.shim(body, agent, stack))
                    time.sleep(.3)
            # Snapshot evidence and persisted counts prove that an always-silent shim did deliver.
            if mode == 'sidecar':
                wait_for(lambda: turns(live.data, 'claude') >= 1 and turns(live.data, 'codex') >= 2)
                # Preserve runtime output before the service removes it on clean shutdown.
                shutil.copy2(live.runtime, live.logs / 'runtime-observed.json')
                stop(live.child, True)
            else:
                wait_for(lambda: turns(live.data, 'claude') >= 1 and turns(live.data, 'codex') >= 2, seconds=10)
                live.child.wait(timeout=40)
            if live.child.returncode != 0: problems.append(f'{mode}: nonzero product exit')
            inv = inventory(live.data)
            problems.extend(inv['errors'])
            evidence.append(dict(mode=mode, log_records=len(read_outputs(live.logs / 'stdout.jsonl')),
                                 ledger_turns={tool: turns(live.data, tool) for tool in ['claude', 'codex']},
                                 shim_wall_ms=timing, inventory=inv))
    if seed_leak: (base / 'outputs/seeded-leak.txt').write_text('BHWP14CANARY_prompt')
    hits = scan_canaries([base / 'outputs'], CANARIES)
    problems.extend(hits)
    for file in (base / 'outputs').rglob('shim-*'):
        if file.stat().st_size: problems.append(f'shim produced output: {file.name}')
    return dict(check='privacy', passed=not problems, errors=problems, evidence=evidence,
                fixture_counts=fixture_counts, root=str(base), app_included=include_app)


class SocketSampler:
    def __init__(self, path):
        self.path, self.pids, self.lock = path, set(), threading.Lock()
        self.done = threading.Event()
        self.errors, self.violations, self.samples = [], [], 0
        self.observed = set()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def add(self, pid):
        with self.lock: self.pids.add(pid)

    def run(self):
        with self.path.open('w') as log:
            while not self.done.is_set():
                with self.lock: pids = sorted(self.pids)
                if not pids: self.done.wait(.02); continue
                try:
                    result = subprocess.run(['lsof', '-nP', '-a', '-p', ','.join(map(str, pids)), '-i', '-F', 'pftPn'],
                                            capture_output=True, text=True, timeout=3)
                    if result.returncode not in [0, 1] or result.stderr.strip():
                        self.errors.append(result.stderr or f'lsof exited {result.returncode}')
                    log.write(result.stdout); log.flush()
                    self.samples += 1
                    self.observed.update(line[1:] for line in result.stdout.splitlines() if line.startswith('p'))
                    self.violations.extend(socket_violations(result.stdout))
                except (OSError, subprocess.TimeoutExpired) as e: self.errors.append(str(e))
                self.done.wait(.02)

    def close(self):
        self.done.set(); self.thread.join(timeout=5)
        if self.thread.is_alive(): self.errors.append('socket sampler did not stop')


def runtime_network(seed_socket=False):
    if not shutil.which('lsof'): raise RuntimeError('lsof is not installed')
    base = workdir('network')
    isolated_environment(base)
    with ExitStack() as stack:
        live = Live(base, 'sidecar', stack)
        sampler = SocketSampler(base / 'outputs/lsof.txt')
        sampler.add(live.child.pid); sampler.thread.start(); stack.callback(sampler.close)
        probe = None
        if seed_socket:
            # A local wildcard bind is the negative control. It sends no network traffic.
            probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            probe.bind(('0.0.0.0', 0)); sampler.add(os.getpid()); stack.callback(probe.close)
        # Hold one real shim TCP connection open long enough for a rootless sample.
        # Only our synthetic collector is paused; it is always resumed in finally.
        cmd = [str(REPO / 'target/release/busyholm-hook'), 'hook', '--agent', 'claude', '--runtime', str(live.runtime)]
        held = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stack.callback(stop, held); sampler.add(held.pid)
        os.kill(live.child.pid, signal.SIGSTOP)
        try:
            held.stdin.write(json.dumps(dict(hook_event_name='UserPromptSubmit', session_id='synthetic-held-loopback')).encode())
            held.stdin.close(); held.stdin = None
            time.sleep(.3)
        finally:
            os.kill(live.child.pid, signal.SIGCONT)
        out, err = held.communicate(timeout=2)
        if held.returncode or out or err: sampler.errors.append('held real shim did not complete silently')
        invocations = 1
        for i in range(30):
            cmd = [str(REPO / 'target/release/busyholm-hook'), 'hook', '--agent', 'claude', '--runtime', str(live.runtime)]
            child = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            stack.callback(stop, child); sampler.add(child.pid)
            # Keep each real shim alive long enough for at least one pre-input sample.
            time.sleep(.06)
            out, err = child.communicate(json.dumps(dict(hook_event_name='UserPromptSubmit', session_id='synthetic-loopback')).encode(), timeout=2)
            if child.returncode or out or err: sampler.errors.append('shim was not silent and successful')
            invocations += 1
        time.sleep(.4)
        stop(live.child, True); sampler.close()
        if not sampler.observed: sampler.errors.append('no product socket was sampled')
        if str(held.pid) not in sampler.observed: sampler.errors.append('the real shim client socket was not sampled')
        records = read_outputs(live.logs / 'stdout.jsonl')
        if not any(v.get('type') == 'snapshot' and v['data'].get('agents') for v in records):
            sampler.errors.append('no evidence that shim delivered a hook')
    violations = [dict(item) for item in {tuple(sorted(v.items())) for v in sampler.violations}]
    return dict(check='runtime-network', passed=not (sampler.errors or violations),
                errors=sampler.errors, violations=violations, samples=sampler.samples,
                invocations=invocations, observed_pids=sorted(sampler.observed), root=str(base),
                limitation='lsof sampling cannot prove absence of a socket shorter than the sample interval')

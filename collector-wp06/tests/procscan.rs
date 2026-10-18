//! WP-06 acceptance test 4 (dynamic half): agent processes are found by name and start time,
//! and a start or a stop shows up within 6 s. The static half (no argument reads) is in
//! tests/static_checks.rs.
mod common;
use busyholm_contracts::{agent_event::{EventKind, EventSource}, common::{Confidence, Host, Tool}};
use collector::AdapterError;
use collector_wp06::procscan::{classify, filetime_to_unix_ms, normalize_name, parse_proc_stat, system_source, Match};
use collector_wp06::{process_raw, Identity, ProcInfo, ProcessScanner, ProcessSource, ProcessTracker};
use common::*;
use std::sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

const T0: u64 = 1_791_806_400_000;

fn p(pid: u32, start: u64, name: &str, path: &str) -> ProcInfo {
    ProcInfo { pid, start_ms: start, name: normalize_name(name), path: Some(path.to_string()) }
}
fn m(tool: Tool, host: Host) -> Option<Match> { Some(Match { tool, host }) }

#[test]
fn names_are_normalised() {
    assert_eq!(normalize_name("OpenCode.EXE"), "opencode");
    assert_eq!(normalize_name("agy"), "agy");
    assert_eq!(normalize_name("Claude Helper (Renderer)"), "claude helper (renderer)");
}

#[test]
fn classification_by_name_and_path_with_the_documented_exclusions() {
    let cases: Vec<(ProcInfo, Option<Match>)> = vec![
        (p(1, T0, "opencode", "/Users/u/.opencode/bin/opencode"), m(Tool::Opencode, Host::Cli)),
        (p(1, T0, "opencode.exe", r"C:\Users\u\.opencode\bin\opencode.exe"), m(Tool::Opencode, Host::Cli)),
        (p(1, T0, "opencode-notifier", "/x/opencode-notifier"), None),
        (p(2, T0, "agy", "/Users/u/.local/bin/agy"), m(Tool::Antigravity, Host::Cli)),
        (p(2, T0, "agy.exe", r"C:\Users\u\AppData\Local\agy\agy.exe"), m(Tool::Antigravity, Host::Cli)),
        (p(2, T0, "language_server", "/Applications/Antigravity.app/Contents/Resources/bin/language_server"), None),
        (p(2, T0, "antigravity", "/Applications/Antigravity.app/Contents/MacOS/Antigravity"), None),
        (p(3, T0, "claude", "/Users/u/.local/share/claude/versions/2.1.296/claude"), m(Tool::Claude, Host::Cli)),
        (p(3, T0, "claude", "/Users/u/Library/Application Support/Claude/claude-code/2.1.296/abc123/claude.app/Contents/MacOS/claude"), m(Tool::Claude, Host::Desktop)),
        (p(3, T0, "claude", "/Applications/Claude.app/Contents/MacOS/Claude"), None),
        (p(3, T0, "claude helper", "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper"), None),
        (p(3, T0, "chrome_crashpad_handler", "/Applications/Claude.app/Contents/Frameworks/x/chrome_crashpad_handler"), None),
        (p(3, T0, "claude.exe", r"C:\Users\u\AppData\Local\AnthropicClaude\app-1.2.3\claude.exe"), None),
        (p(3, T0, "claude.exe", r"C:\Users\u\.local\bin\claude.exe"), m(Tool::Claude, Host::Cli)),
        (p(4, T0, "codex", "/Users/u/.npm/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"), m(Tool::Codex, Host::Cli)),
        (p(4, T0, "codex", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"), m(Tool::Codex, Host::Desktop)),
        (p(4, T0, "codex-code-mode-host", "/x/codex-code-mode-host"), None),
        (p(4, T0, "updater", "/Applications/Codex.app/Contents/Frameworks/Sparkle.framework/Updater"), None),
        (p(5, T0, "node", "/usr/local/bin/node"), None),
        (p(5, T0, "python3", "/usr/bin/python3"), None),
        (ProcInfo { pid: 6, start_ms: T0, name: "agy".into(), path: None }, m(Tool::Antigravity, Host::Cli)),
    ];
    for (proc, want) in cases {
        assert_eq!(classify(&proc), want, "{:?}", proc);
    }
}

#[test]
fn the_tracker_reports_up_and_down_by_pid_and_start_time() {
    let ids = FakeIds;
    let mut t = ProcessTracker::new();
    let noise = p(9, T0 - 5, "node", "/usr/bin/node");
    let agy = p(10, T0, "agy", "/u/agy");
    let evs = t.scan(&[noise.clone(), agy.clone()], &ids, T0 + 1_000);
    check_events(&evs);
    assert_eq!(kinds(&evs), vec!["process_up"]);
    let e = &evs[0];
    assert_eq!((e.agent, e.host, e.source, e.confidence), (Tool::Antigravity, Host::Cli, EventSource::Process, Confidence::Exact));
    assert_eq!((e.t, e.et), (T0 + 1_000, Some(T0)));
    assert_eq!(e.instance, ids.instance(Tool::Antigravity, &process_raw(10, T0)));
    assert_eq!(e.parent, None);
    assert_eq!(t.live(Tool::Antigravity), vec![(10, T0)]);

    // unchanged: silent
    assert!(t.scan(&[noise.clone(), agy.clone()], &ids, T0 + 6_000).is_empty());

    // a second opencode appears, the agy exits
    let oc = p(11, T0 + 7_000, "opencode", "/u/opencode");
    let evs = t.scan(&[noise.clone(), oc.clone()], &ids, T0 + 11_000);
    check_events(&evs);
    assert_eq!(kinds(&evs), vec!["process_up", "process_down"]);
    let down = evs.iter().find(|e| e.kind == EventKind::ProcessDown).unwrap();
    assert_eq!((down.agent, down.instance.clone(), down.t), (Tool::Antigravity, ids.instance(Tool::Antigravity, &process_raw(10, T0)), T0 + 11_000));
    assert!(t.live(Tool::Antigravity).is_empty());
    assert_eq!(t.live(Tool::Opencode), vec![(11, T0 + 7_000)]);

    // pid reuse: the same pid with a different start time is a new process
    let reused = p(11, T0 + 20_000, "opencode", "/u/opencode");
    let evs = t.scan(&[reused], &ids, T0 + 21_000);
    assert_eq!(kinds(&evs), vec!["process_up", "process_down"]);
    let up = evs.iter().find(|e| e.kind == EventKind::ProcessUp).unwrap();
    let down = evs.iter().find(|e| e.kind == EventKind::ProcessDown).unwrap();
    assert_ne!(up.instance, down.instance);
}

#[test]
fn start_times_outside_the_contract_range_are_dropped_from_et_not_from_the_event() {
    let mut t = ProcessTracker::new();
    let evs = t.scan(&[p(1, 5, "agy", "/u/agy")], &FakeIds, T0);
    check_events(&evs);
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].et, None);
}

struct Counting { calls: Arc<Mutex<u32>>, procs: Vec<ProcInfo>, fail: bool }
impl ProcessSource for Counting {
    fn snapshot(&mut self) -> Result<Vec<ProcInfo>, AdapterError> {
        *self.calls.lock().unwrap() += 1;
        if self.fail { Err(AdapterError::Io) } else { Ok(self.procs.clone()) }
    }
}

#[test]
fn polling_is_every_five_seconds_and_a_failed_scan_keeps_everything_alive() {
    let calls = Arc::new(Mutex::new(0));
    let agy = p(10, T0, "agy", "/u/agy");
    let mut s = ProcessScanner::new(Box::new(Counting { calls: calls.clone(), procs: vec![agy], fail: false }));
    assert_eq!(kinds(&s.poll_at(&FakeIds, T0 + 100).unwrap()), vec!["process_up"]);
    assert!(s.poll_at(&FakeIds, T0 + 2_000).unwrap().is_empty());
    assert!(s.poll_at(&FakeIds, T0 + 4_999).unwrap().is_empty());
    assert_eq!(*calls.lock().unwrap(), 1, "no scan inside the 5 s interval");
    assert!(s.poll_at(&FakeIds, T0 + 5_100).unwrap().is_empty());
    assert_eq!(*calls.lock().unwrap(), 2);
    assert_eq!(s.live(Tool::Antigravity), vec![(10, T0)]);

    let mut failing = ProcessScanner::new(Box::new(Counting { calls: Arc::new(Mutex::new(0)), procs: vec![], fail: true }));
    assert_eq!(failing.poll_at(&FakeIds, T0), Err(AdapterError::Io));
}

#[test]
fn the_real_snapshot_sees_this_process_with_a_sane_start_time() {
    let mut src = system_source();
    let procs = src.snapshot().expect("snapshot");
    assert!(procs.len() > 20, "{} processes", procs.len());
    let me = std::process::id();
    let mine = procs.iter().find(|x| x.pid == me).expect("own pid is listed");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    assert!(mine.start_ms <= now + 1_000 && mine.start_ms + 3_600_000 > now, "start {} now {}", mine.start_ms, now);
    let exe = std::env::current_exe().unwrap();
    let want = normalize_name(exe.file_name().unwrap().to_str().unwrap());
    assert_eq!(mine.name, want);
    let future: Vec<_> = procs.iter().filter(|x| x.start_ms > now + 5_000).map(|x| (x.pid, x.name.clone(), x.start_ms as i64 - now as i64)).collect();
    // A machine whose clock was set back can hold a few processes that "started" later than now
    // (`ps` agrees on this one); the vast majority are in the past.
    assert!(future.len() * 50 < procs.len(), "too many processes start in the future: {future:?}");
    assert!(procs.iter().all(|x| x.name == x.name.to_lowercase() && !x.name.ends_with(".exe")));
}

/// Not a test: when run as a copy named `agy` it just sits there for the real-process test.
#[test]
#[ignore]
fn __sleeper() {
    std::thread::sleep(Duration::from_secs(60));
}

#[test]
fn a_real_agy_process_is_seen_starting_and_stopping_within_six_seconds() {
    let dir = tempfile::tempdir().unwrap();
    let name = if cfg!(windows) { "agy.exe" } else { "agy" };
    let fake = dir.path().join(name);
    std::fs::copy(std::env::current_exe().unwrap(), &fake).unwrap();

    let (tx, rx) = mpsc::channel::<(Instant, busyholm_contracts::AgentEvent)>();
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let handle = std::thread::spawn(move || {
        let mut s = ProcessScanner::new(system_source());
        s.run_loop(&FakeIds, &|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64, &stop2, &mut |e| { let _ = tx.send((Instant::now(), e)); });
    });
    std::thread::sleep(Duration::from_millis(1200)); // the loop has done its first scan: baseline taken

    let spawned = Instant::now();
    // The argument list carries a canary: the scanner must never read it.
    let mut child = std::process::Command::new(&fake)
        .args(["__sleeper", "--exact", "--ignored", "--nocapture", "BHCANARY_argv_probe_1"])
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .spawn().expect("spawn fake agy");
    let mut up = None;
    let deadline = spawned + Duration::from_secs(6);
    while Instant::now() < deadline {
        if let Ok((at, e)) = rx.recv_timeout(Duration::from_millis(100)) {
            // other agy processes may be running on this machine; ours is the one whose identity matches our pid
            let ours = e.et.map_or(false, |st| e.instance == FakeIds.instance(Tool::Antigravity, &process_raw(child.id(), st)));
            if e.kind == EventKind::ProcessUp && ours { up = Some((at, e)); break; }
        }
    }
    let (up_at, up_ev) = up.unwrap_or_else(|| { let _ = child.kill(); stop.store(true, Ordering::SeqCst); panic!("no process_up within 6 s") });
    println!("process_up seen {:?} after spawn", up_at - spawned);
    assert!(up_at - spawned <= Duration::from_secs(6));
    assert_eq!(up_ev.instance, FakeIds.instance(Tool::Antigravity, &process_raw(child.id(), up_ev.et.expect("start time known"))));

    let killed = Instant::now();
    child.kill().unwrap();
    child.wait().unwrap();
    let mut down = None;
    let deadline = killed + Duration::from_secs(6);
    while Instant::now() < deadline {
        if let Ok((at, e)) = rx.recv_timeout(Duration::from_millis(100)) {
            if e.kind == EventKind::ProcessDown && e.instance == up_ev.instance { down = Some(at); break; }
        }
    }
    stop.store(true, Ordering::SeqCst);
    handle.join().unwrap();
    let down_at = down.expect("no process_down within 6 s");
    println!("process_down seen {:?} after kill", down_at - killed);
    assert!(down_at - killed <= Duration::from_secs(6));
}

#[test]
fn linux_stat_parsing_survives_hostile_command_names() {
    // field 22 (starttime) is the 20th token after the closing parenthesis
    let line = |comm: &str| format!("4242 ({comm}) S 1 4242 4242 0 -1 4194560 1000 0 0 0 10 5 0 0 20 0 8 0 123456 99999 12 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0");
    for comm in ["agy", "a b", "x) S 1 2 3", "(((", "node (v22) worker"] {
        assert_eq!(parse_proc_stat(&line(comm)), Some((comm.to_string(), 123456)), "{comm}");
    }
    assert_eq!(parse_proc_stat("garbage"), None);
    assert_eq!(parse_proc_stat("1 (x) S 1 2"), None);
    assert_eq!(parse_proc_stat(") ("), None);
}

#[test]
fn windows_file_times_convert_to_unix_milliseconds() {
    // 2026-10-12T12:00:00Z is 1_791_806_400 s after the Unix epoch
    let ticks = (1_791_806_400u64 + 11_644_473_600) * 10_000_000;
    assert_eq!(filetime_to_unix_ms(ticks), 1_791_806_400_000);
    assert_eq!(filetime_to_unix_ms(0), 0, "no underflow for an unset time");
}

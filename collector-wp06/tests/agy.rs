//! WP-06 acceptance test 3: the agy log heartbeat. 3 s request lines read as `working`,
//! 90 s of quiet reads as `your_turn` (inferred). Timestamps only; content is never kept.
mod common;
use busyholm_contracts::{agent_event::{EventKind, EventSource}, common::{Confidence, Tool}};
use collector_wp06::agy::{agy_state, parse_glog_prefix, GlogLine};
use collector_wp06::{process_raw, AgyConfig, AgyReader, AgyState, Identity};
use common::*;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const A0: u64 = 1_791_806_400_000; // the collector clock when the last line of the first batch was written

fn hms(s: u64) -> String { format!("{:02}:{:02}:{:02}", s / 3600 % 24, s / 60 % 60, s % 60) }
fn req(sec: u64, frac: u32) -> String { format!("I1012 {}.{:06} 4242 http_helpers.go:88] URL: https://example.invalid/v1/models:streamGenerate\n", hms(sec), frac) }
fn other(sec: u64, tag: &str, rest: &str) -> String { format!("I1012 {}.250000 4242 {tag}:41] {rest}\n", hms(sec)) }
const NOON: u64 = 12 * 3600;

struct Env { _dir: tempfile::TempDir, root: PathBuf }
fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("antigravity-cli");
    fs::create_dir_all(root.join("log")).unwrap();
    Env { _dir: dir, root }
}
fn log(root: &Path, name: &str) -> PathBuf { root.join("log").join(name) }
fn set_mtime(p: &Path, ms: u64) {
    let f = fs::OpenOptions::new().write(true).open(p).unwrap();
    f.set_modified(UNIX_EPOCH + Duration::from_millis(ms)).unwrap();
}
fn write(p: &Path, s: &str, mtime_ms: u64) { fs::write(p, s).unwrap(); set_mtime(p, mtime_ms); }
fn append(p: &Path, s: &str, mtime_ms: u64) {
    let mut f = fs::OpenOptions::new().append(true).open(p).unwrap();
    f.write_all(s.as_bytes()).unwrap();
    drop(f);
    set_mtime(p, mtime_ms);
}
fn cfg(e: &Env) -> AgyConfig {
    let mut c = AgyConfig::new(e.root.clone());
    c.min_interval_ms = 0; // the throttle has its own test
    c
}

/// A session that started at 12:00:00, with request lines every 3 s until 12:00:30 and the
/// sensitive lines real logs also contain.
fn first_batch() -> String {
    let mut s = other(NOON, "server.go", "language server ready");
    for i in 0..10u64 { s += &req(NOON + 3 + 3 * i, 124_267 + 811 * i as u32); }
    s += &other(NOON + 31, "cli.go", "submitted prompt BHCANARY_antigravity_prompt_1 for /Users/someone/code/BHCANARY_antigravity_cwd_1");
    s += "}\n\"BHCANARY_continuation_line_of_a_json_dump\"\n";
    s
}

#[test]
fn the_glog_prefix_parser_keeps_only_the_time_and_whether_it_is_a_request() {
    let ok = parse_glog_prefix(b"I1012 12:00:03.124267 4242 http_helpers.go:88] URL: https://example.invalid/x\n");
    assert_eq!(ok, Some(GlogLine { micros_of_day: (12 * 3600 + 3) * 1_000_000 + 124_267, is_request: true }));
    assert_eq!(parse_glog_prefix(b"W1012 00:00:00.000001 1 http_helpers.go:1] URL: x\r\n").map(|l| (l.micros_of_day, l.is_request)), Some((1, true)), "CRLF and warnings");
    let not_req = [
        &b"I1012 12:00:03.124267 4242 http_helpers.go:88] Failed to dial BHCANARY\n"[..],
        b"I1012 12:00:03.124267 4242 cli.go:310] URL: looks like one but is the wrong file\n",
        b"E1012 12:00:03.124267 4242 server.go:41] language server ready\n",
    ];
    for l in not_req { assert_eq!(parse_glog_prefix(l).map(|g| g.is_request), Some(false), "{}", String::from_utf8_lossy(l)); }
    for junk in [&b"}\n"[..], b"", b"\"BHCANARY_continuation\"\n", b"X1012 12:00:03.124267 4242 a.go:1] URL:", b"I1012 25:00:03.124267 4242 a.go:1] x", b"I1012 12:00:03 4242 a.go:1] x", b"I1012 12:00:03.1242 4242", b"\xff\xfe\x00 garbage"] {
        assert_eq!(parse_glog_prefix(junk), None, "{junk:?}");
    }
}

#[test]
fn the_reducer_is_working_until_ninety_seconds_of_quiet() {
    assert_eq!(agy_state(1_000, 1_000, 90_000), AgyState::Working);
    assert_eq!(agy_state(1_000, 1_000 + 3_000, 90_000), AgyState::Working);
    assert_eq!(agy_state(1_000, 1_000 + 89_999, 90_000), AgyState::Working);
    assert_eq!(agy_state(1_000, 1_000 + 90_000, 90_000), AgyState::YourTurn);
    assert_eq!(agy_state(5_000, 1_000, 90_000), AgyState::Working, "a clock step backwards never flips to your_turn");
}

#[test]
fn three_second_request_lines_read_as_working_and_ninety_seconds_of_quiet_as_your_turn() {
    let e = env();
    let p = log(&e.root, "cli-20261012_120000.log");
    write(&p, &first_batch(), A0);
    let mut r = AgyReader::new(cfg(&e));

    let evs = r.poll_at(&FakeIds, A0 + 100);
    check_events(&evs);
    let ks = kinds(&evs);
    assert_eq!(&ks[..2], ["session_start", "turn_start"], "{ks:?}");
    assert_eq!(ks.iter().filter(|k| *k == "heartbeat").count(), 9, "ten request lines: the first is the turn start");
    assert_eq!(ks.len(), 11);
    for ev in &evs {
        assert_eq!((ev.source, ev.confidence, ev.agent), (EventSource::Log, Confidence::Inferred, Tool::Antigravity));
        assert_eq!(ev.t, A0 + 100);
    }
    assert!(evs.iter().all(|x| x.instance == evs[0].instance));
    // relative timing is exact: the first request is 28 s before the last line, the last 1 s before
    // microseconds before the last line (12:00:31.250000), truncated to ms
    assert_eq!(evs[1].et, Some(A0 - 28_125));
    assert_eq!(evs.last().unwrap().et, Some(A0 - 1_118));
    let gaps: Vec<u64> = evs[1..].windows(2).map(|w| w[1].et.unwrap() - w[0].et.unwrap()).collect();
    assert!(gaps.iter().all(|g| (2_900..=3_100).contains(g)), "{gaps:?}");

    let last_req = evs.last().unwrap().et.unwrap();
    assert_eq!(agy_state(last_req, A0 + 100, 90_000), AgyState::Working);
    // quiet: nothing for 89.9 s, then your_turn at 90 s
    assert!(r.poll_at(&FakeIds, last_req + 89_900).is_empty());
    let evs = r.poll_at(&FakeIds, last_req + 90_000);
    check_events(&evs);
    assert_eq!(kinds(&evs), vec!["turn_end"]);
    assert_eq!((evs[0].confidence, evs[0].source), (Confidence::Inferred, EventSource::Log));
    assert_eq!(evs[0].t, last_req + 90_000);
    assert_eq!(agy_state(last_req, last_req + 90_000, 90_000), AgyState::YourTurn);
    // and once only
    assert!(r.poll_at(&FakeIds, last_req + 120_000).is_empty());

    // a new request line starts a new turn
    append(&p, &req(NOON + 180, 500_000), A0 + 149_000);
    let evs = r.poll_at(&FakeIds, A0 + 149_500);
    assert_eq!(kinds(&evs), vec!["turn_start"]);
    assert_eq!(evs[0].et, Some(A0 + 149_000));
}

#[test]
fn partial_lines_wait_for_their_newline_and_huge_or_binary_lines_are_skipped() {
    let e = env();
    let p = log(&e.root, "cli-20261012_120000.log");
    write(&p, &other(NOON, "server.go", "ready"), A0);
    let mut r = AgyReader::new(cfg(&e));
    r.poll_at(&FakeIds, A0 + 10);
    let line = req(NOON + 3, 0);
    let (a, b) = line.split_at(30);
    append(&p, a, A0 + 3_000);
    assert!(r.poll_at(&FakeIds, A0 + 3_100).is_empty(), "no newline yet");
    append(&p, b, A0 + 3_000);
    assert_eq!(kinds(&r.poll_at(&FakeIds, A0 + 3_200)), vec!["turn_start"]);

    let mut junk = vec![b'z'; 1 << 20];
    junk.extend_from_slice(b" BHCANARY_huge\n\xff\xfe\x00\x01 binary BHCANARY\n");
    junk.extend_from_slice(req(NOON + 6, 0).as_bytes());
    let mut f = fs::OpenOptions::new().append(true).open(&p).unwrap();
    f.write_all(&junk).unwrap();
    drop(f);
    set_mtime(&p, A0 + 6_000);
    let evs = r.poll_at(&FakeIds, A0 + 6_100);
    check_events(&evs);
    assert_eq!(kinds(&evs), vec!["heartbeat"]);
}

#[test]
fn a_replaced_or_truncated_log_is_read_from_its_new_start() {
    let e = env();
    let p = log(&e.root, "cli-20261012_120000.log");
    write(&p, &first_batch(), A0);
    let mut r = AgyReader::new(cfg(&e));
    r.poll_at(&FakeIds, A0 + 100);
    let short = other(NOON, "server.go", "ready") + &req(NOON + 3, 0);
    write(&p, &short, A0 + 5_000);
    let evs = r.poll_at(&FakeIds, A0 + 5_100);
    assert!(kinds(&evs).contains(&"turn_start".to_string()) || kinds(&evs).contains(&"heartbeat".to_string()), "{:?}", kinds(&evs));
}

#[test]
fn old_logs_are_ignored_quiet_logs_are_present_not_working_and_logs_are_capped() {
    let e = env();
    write(&log(&e.root, "cli-20261012_090000.log"), &(other(NOON - 3 * 3600, "server.go", "x") + &req(NOON - 3 * 3600 + 3, 0)), A0 - 3 * 3600 * 1000);
    let mut r = AgyReader::new(cfg(&e));
    assert!(r.poll_at(&FakeIds, A0).is_empty(), "a log untouched for 3 h is not a live session");

    // quiet 5 minutes: the agy is there (session_start) but not working
    write(&log(&e.root, "cli-20261012_115500.log"), &(other(NOON - 300, "server.go", "x") + &req(NOON - 297, 0)), A0 - 297_000);
    let evs = r.poll_at(&FakeIds, A0 + 2_000);
    assert_eq!(kinds(&evs), vec!["session_start"]);

    // many logs: only the newest ones by name are followed
    for i in 0..12 {
        let name = format!("cli-20261012_12{:02}00.log", i);
        write(&log(&e.root, &name), &(other(NOON + 60 * i, "server.go", "x") + &req(NOON + 60 * i + 3, 0)), A0 + 3_000 + i * 1000);
    }
    let evs = r.poll_at(&FakeIds, A0 + 20_000);
    let mut instances: Vec<_> = evs.iter().map(|x| x.instance.clone()).collect();
    instances.sort(); instances.dedup();
    assert!(instances.len() <= 8, "{} logs followed", instances.len());
}

#[test]
fn two_live_agy_sessions_are_two_instances() {
    let e = env();
    write(&log(&e.root, "cli-20261012_120000.log"), &first_batch(), A0);
    write(&log(&e.root, "cli-20261012_120010.log"), &(other(NOON + 10, "server.go", "x") + &req(NOON + 14, 0) + &other(NOON + 31, "x.go", "y")), A0);
    let mut r = AgyReader::new(cfg(&e));
    let evs = r.poll_at(&FakeIds, A0 + 100);
    check_events(&evs);
    let mut inst: Vec<_> = evs.iter().map(|x| x.instance.clone()).collect();
    inst.sort(); inst.dedup();
    assert_eq!(inst.len(), 2);
}

#[test]
fn time_of_day_rolls_over_midnight() {
    let e = env();
    let p = log(&e.root, "cli-20261012_235900.log");
    let mut s = other(86_400 - 10, "server.go", "ready");
    s += &req(86_400 - 3, 0);
    s += &req(86_400, 0);   // 00:00:00
    s += &req(86_400 + 3, 0);
    s += &other(86_400 + 4, "x.go", "tail");
    write(&p, &s, A0);
    let mut r = AgyReader::new(cfg(&e));
    let evs = r.poll_at(&FakeIds, A0 + 50);
    let ets: Vec<u64> = evs.iter().filter(|x| x.kind != EventKind::SessionStart).map(|x| x.et.unwrap()).collect();
    assert_eq!(ets.len(), 3);
    assert_eq!(ets, vec![A0 - 7_250, A0 - 4_250, A0 - 1_250], "{ets:?}");
}

#[test]
fn a_live_process_binds_the_log_so_one_agy_is_one_resident() {
    let e = env();
    let p = log(&e.root, "cli-20261012_120000.log");
    write(&p, &first_batch(), A0);
    let mut r = AgyReader::new(cfg(&e));
    r.set_live_processes(vec![(4242, A0 - 40_000)]);
    let evs = r.poll_at(&FakeIds, A0 + 100);
    assert!(!evs.is_empty());
    let want = FakeIds.instance(Tool::Antigravity, &process_raw(4242, A0 - 40_000));
    assert!(evs.iter().all(|x| x.instance == want), "one live agy and one active log bind together");

    // with two live processes the log is bound to the one whose start is nearest to the log's creation
    let e2 = env();
    let p2 = log(&e2.root, "cli-20261012_120000.log");
    write(&p2, &first_batch(), A0);
    let created = fs::metadata(&p2).unwrap().created().ok().map(|c| c.duration_since(UNIX_EPOCH).unwrap().as_millis() as u64);
    if let Some(created) = created {
        let mut r2 = AgyReader::new(cfg(&e2));
        r2.set_live_processes(vec![(1, created - 3_600_000), (2, created - 2_000), (3, created - 900_000)]);
        let evs = r2.poll_at(&FakeIds, A0 + 100);
        let want = FakeIds.instance(Tool::Antigravity, &process_raw(2, created - 2_000));
        assert!(evs.iter().all(|x| x.instance == want));
    }
    // two processes and no way to tell: fall back to the log's own identity, never guess
    let e3 = env();
    write(&log(&e3.root, "cli-20261012_120000.log"), &first_batch(), A0);
    let mut r3 = AgyReader::new(cfg(&e3));
    r3.set_live_processes(vec![(1, 5), (2, 6)]);
    let evs = r3.poll_at(&FakeIds, A0 + 100);
    for pid in [1u32, 2] {
        let not = FakeIds.instance(Tool::Antigravity, &process_raw(pid, 5 + (pid as u64 - 1)));
        assert!(evs.iter().all(|x| x.instance != not));
    }
}

#[test]
fn the_wp01_fixture_log_with_its_prompt_canary_produces_clean_events() {
    let e = env();
    let src = repo_root().join("fixtures/agent-inputs/antigravity/log/cli.log");
    let text = fs::read(&src).unwrap();
    assert!(String::from_utf8_lossy(&text).contains("BHCANARY"), "fixture still carries its canary");
    let p = log(&e.root, "cli-20261012_120000.log");
    fs::write(&p, &text).unwrap();
    set_mtime(&p, A0);
    let mut r = AgyReader::new(cfg(&e));
    let evs = r.poll_at(&FakeIds, A0 + 100);
    assert!(evs.len() >= 3, "{}", evs.len());
    check_events(&evs);
}

#[test]
fn only_the_log_folder_is_listed_and_other_agy_files_are_never_touched() {
    let e = env();
    // stand-ins that would fail the test if opened: unreadable files and folders
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in ["antigravity-oauth-token", "history.jsonl"] {
            let f = e.root.join(name);
            fs::write(&f, "BHCANARY secret").unwrap();
            fs::set_permissions(&f, fs::Permissions::from_mode(0o000)).unwrap();
        }
        let d = e.root.join("conversations");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("x.db"), "BHCANARY").unwrap();
        fs::set_permissions(&d, fs::Permissions::from_mode(0o000)).unwrap();
        write(&log(&e.root, "cli-20261012_120000.log"), &first_batch(), A0);
        let mut r = AgyReader::new(cfg(&e));
        assert!(!r.poll_at(&FakeIds, A0 + 100).is_empty());
        fs::set_permissions(&d, fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[test]
fn missing_folder_is_quiet() {
    let dir = tempfile::tempdir().unwrap();
    let mut r = AgyReader::new(AgyConfig::new(dir.path().join("nope")));
    assert!(r.poll_at(&FakeIds, A0).is_empty());
    let _ = SystemTime::now();
}

#[test]
fn polling_is_throttled_to_one_look_per_second_by_default() {
    let e = env();
    let p = log(&e.root, "cli-20261012_120000.log");
    write(&p, &first_batch(), A0);
    let mut r = AgyReader::new(AgyConfig::new(e.root.clone()));
    assert!(!r.poll_at(&FakeIds, A0 + 100).is_empty());
    append(&p, &req(NOON + 33, 0), A0 + 1_600);
    assert!(r.poll_at(&FakeIds, A0 + 600).is_empty(), "inside the interval nothing is read");
    assert_eq!(kinds(&r.poll_at(&FakeIds, A0 + 1_700)), vec!["heartbeat"]);
}

/// Optional smoke run against a real agy folder, structure only (counts and timings).
/// `BUSYHOLM_REAL_AGY_ROOT=~/.gemini/antigravity-cli cargo test -- --ignored real_agy`.
#[test]
#[ignore]
fn real_agy_smoke() {
    let Ok(root) = std::env::var("BUSYHOLM_REAL_AGY_ROOT") else { return };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
    let mut r = AgyReader::new(AgyConfig::new(PathBuf::from(root)));
    let t = std::time::Instant::now();
    let evs = r.poll_at(&FakeIds, now);
    check_events(&evs);
    let mut counts = std::collections::BTreeMap::new();
    for k in kinds(&evs) { *counts.entry(k).or_insert(0) += 1; }
    println!("REAL AGY: {:?}, events by kind {counts:?}", t.elapsed());
}

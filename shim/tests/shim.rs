//! WP-07 acceptance tests for `busyholm-hook` (SPEC 9.1 WP-07 tests 4, 5 and 6, Revision 1).
//!
//! 4. exit 0 with empty stdout and stderr within 1.2 s when the receiver is down, hangs or returns 500;
//! 5. non-allowlisted fields are dropped on the wire (canaries at a test receiver);
//! 6. the status line wrap passes the prior command's stdout through byte-identical.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_busyholm-hook");
const SECRET: &str = "secret-path-0123456789";
const TOKEN: &str = "token-header-0123456789";

fn scratch(name: &str) -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let p = std::env::temp_dir().join(format!("bh-shim-{}-{}-{name}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(&p).unwrap();
    p
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Ok204,
    Status500,
    Hang,
    Drip,
    CloseAtOnce,
}

struct TestReceiver {
    port: u16,
    seen: Receiver<Vec<u8>>,
}

fn read_request(s: &mut TcpStream) -> Vec<u8> {
    s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => return buf,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if let Some(h) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..h]).to_lowercase();
                    let len = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                        .unwrap_or(0);
                    if buf.len() >= h + 4 + len {
                        return buf;
                    }
                }
            }
        }
    }
}

fn start_receiver(mode: Mode) -> TestReceiver {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = channel();
    thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut s) = conn else { continue };
            let tx = tx.clone();
            thread::spawn(move || {
                let req = read_request(&mut s);
                let _ = tx.send(req);
                match mode {
                    Mode::Ok204 => {
                        let _ = s.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
                    }
                    Mode::Status500 => {
                        let _ = s.write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    }
                    Mode::Hang => thread::sleep(Duration::from_secs(8)),
                    Mode::Drip => {
                        for b in b"HTTP/1.1 204 No Content\r\n\r\n" {
                            if s.write_all(&[*b]).is_err() {
                                return;
                            }
                            thread::sleep(Duration::from_millis(400));
                        }
                    }
                    Mode::CloseAtOnce => {}
                }
            });
        }
    });
    TestReceiver { port, seen: rx }
}

/// A port nothing listens on.
fn dead_port() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

fn write_runtime(dir: &Path, port: u16) -> PathBuf {
    let p = dir.join("runtime.json");
    std::fs::write(&p, format!(r#"{{"v":1,"port":{port},"secret":"{SECRET}","token":"{TOKEN}"}}"#)).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    p
}

struct Out {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    elapsed: Duration,
}

fn run(args: &[&str], stdin: &[u8]) -> Out {
    let start = Instant::now();
    let mut child = Command::new(BIN).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut sin = child.stdin.take().unwrap();
    let input = stdin.to_vec();
    let w = thread::spawn(move || {
        let _ = sin.write_all(&input);
    });
    let o = child.wait_with_output().unwrap();
    let _ = w.join();
    Out { code: o.status.code(), stdout: o.stdout, stderr: o.stderr, elapsed: start.elapsed() }
}

fn hook_args<'a>(agent: &'a str, runtime: &'a str) -> Vec<&'a str> {
    vec!["hook", "--agent", agent, "--runtime", runtime, "--owner", "abcdef0123456789"]
}

fn stop_body() -> Vec<u8> {
    br#"{"hook_event_name":"PermissionRequest","session_id":"sess-1","tool_name":"Bash","tool_input":{"command":"BHCANARY_cmd"},"cwd":"/x"}"#.to_vec()
}

fn assert_silent_ok(o: &Out) {
    assert_eq!(o.code, Some(0), "must exit 0");
    assert!(o.stdout.is_empty(), "stdout must be empty, got {:?}", String::from_utf8_lossy(&o.stdout));
    assert!(o.stderr.is_empty(), "stderr must be empty, got {:?}", String::from_utf8_lossy(&o.stderr));
    assert!(o.elapsed < Duration::from_millis(1200), "took {:?}", o.elapsed);
}

// ---- test 4: exit 0, silent, within 1.2 s -------------------------------------------------

#[test]
fn receiver_down_is_silent_and_fast() {
    let d = scratch("down");
    let rt = write_runtime(&d, dead_port());
    let o = run(&hook_args("claude", rt.to_str().unwrap()), &stop_body());
    assert_silent_ok(&o);
}

#[test]
fn receiver_hang_is_silent_and_within_budget() {
    let d = scratch("hang");
    let r = start_receiver(Mode::Hang);
    let rt = write_runtime(&d, r.port);
    let o = run(&hook_args("claude", rt.to_str().unwrap()), &stop_body());
    assert_silent_ok(&o);
    assert!(r.seen.recv_timeout(Duration::from_secs(1)).is_ok(), "the request should have been attempted");
}

#[test]
fn receiver_500_is_silent_and_fast() {
    let d = scratch("500");
    let r = start_receiver(Mode::Status500);
    let rt = write_runtime(&d, r.port);
    let o = run(&hook_args("claude", rt.to_str().unwrap()), &stop_body());
    assert_silent_ok(&o);
    assert!(r.seen.recv_timeout(Duration::from_secs(1)).is_ok());
}

#[test]
fn slow_drip_and_early_close_are_silent_and_within_budget() {
    for mode in [Mode::Drip, Mode::CloseAtOnce] {
        let d = scratch("drip");
        let r = start_receiver(mode);
        let rt = write_runtime(&d, r.port);
        let o = run(&hook_args("codex", rt.to_str().unwrap()), &stop_body());
        assert_silent_ok(&o);
    }
}

#[test]
fn stdin_that_never_closes_still_ends_in_time() {
    let d = scratch("stdin-open");
    let rt = write_runtime(&d, dead_port());
    let start = Instant::now();
    let mut child = Command::new(BIN)
        .args(hook_args("claude", rt.to_str().unwrap()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut sin = child.stdin.take().unwrap();
    sin.write_all(b"{\"hook_event_name\":\"Stop\"").unwrap(); // never finished, never closed
    let o = child.wait_with_output().unwrap();
    drop(sin);
    assert_eq!(o.status.code(), Some(0));
    assert!(o.stdout.is_empty() && o.stderr.is_empty());
    assert!(start.elapsed() < Duration::from_millis(1200), "took {:?}", start.elapsed());
}

#[test]
fn bad_inputs_and_bad_runtime_files_send_nothing_and_stay_silent() {
    let r = start_receiver(Mode::Ok204);
    let d = scratch("bad");
    let good = write_runtime(&d, r.port);
    let g = good.to_str().unwrap();

    // garbage, empty, array, no event name, over-long event name: no request
    for body in [&b"not json"[..], b"", b"[1,2]", br#"{"session_id":"x"}"#, br#"{"hook_event_name":"Stop Stop Stop Stop","session_id":"x"}"#] {
        let o = run(&hook_args("claude", g), body);
        assert_silent_ok(&o);
    }
    // unknown agent, unknown mode, no args
    assert_silent_ok(&run(&hook_args("evil", g), &stop_body()));
    assert_silent_ok(&run(&["frobnicate"], &stop_body()));
    assert_silent_ok(&run(&[], b""));

    // runtime file problems: missing, malformed, wrong version, loose permissions, symlink
    let e = scratch("rt");
    let missing = e.join("nope.json");
    assert_silent_ok(&run(&hook_args("claude", missing.to_str().unwrap()), &stop_body()));
    for (name, text) in [
        ("junk.json", "junk".to_string()),
        ("v2.json", format!(r#"{{"v":2,"port":{},"secret":"{SECRET}","token":"{TOKEN}"}}"#, r.port)),
        ("lowport.json", format!(r#"{{"v":1,"port":80,"secret":"{SECRET}","token":"{TOKEN}"}}"#)),
        ("shorttoken.json", format!(r#"{{"v":1,"port":{},"secret":"{SECRET}","token":"x"}}"#, r.port)),
    ] {
        let p = e.join(name);
        std::fs::write(&p, text).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_silent_ok(&run(&hook_args("claude", p.to_str().unwrap()), &stop_body()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let loose = e.join("loose.json");
        std::fs::write(&loose, format!(r#"{{"v":1,"port":{},"secret":"{SECRET}","token":"{TOKEN}"}}"#, r.port)).unwrap();
        std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_silent_ok(&run(&hook_args("claude", loose.to_str().unwrap()), &stop_body()));
        let link = e.join("link.json");
        std::os::unix::fs::symlink(&good, &link).unwrap();
        assert_silent_ok(&run(&hook_args("claude", link.to_str().unwrap()), &stop_body()));
    }
    assert!(r.seen.recv_timeout(Duration::from_millis(400)).is_err(), "no request may reach the receiver for any of these");
}

// ---- test 5: the wire carries only allowlisted fields ---------------------------------------

fn split_request(raw: &[u8]) -> (String, Vec<u8>) {
    let h = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("complete request");
    (String::from_utf8_lossy(&raw[..h]).to_string(), raw[h + 4..].to_vec())
}

fn header_of(head: &str, name: &str) -> Option<String> {
    head.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim().to_string())
    })
}

const CONTENT_FIELDS: [&str; 30] = [
    "prompt", "last_assistant_message", "tool_input", "tool_response", "tool_output", "output", "text", "content", "message",
    "title", "name", "summary", "error_details", "permission_suggestions", "user_email", "input-messages", "last-assistant-message",
    "creator_user_id", "creator_account_id", "ownerAccountUuid", "ownerOrganizationUuid", "toolUseResult", "cwd", "transcript_path",
    "agent_type", "model", "permission_mode", "background_tasks", "session_crons", "effort",
];

#[test]
fn only_allowlisted_fields_reach_the_receiver() {
    let r = start_receiver(Mode::Ok204);
    let d = scratch("wire");
    let rt = write_runtime(&d, r.port);

    let mut doc = serde_json::json!({
        "hook_event_name": "PermissionRequest",
        "session_id": "sess-1",
        "agent_id": "agent-9",
        "prompt_id": "p-1",
        "turn_id": "t-1",
        "tool_use_id": "tu-1",
        "request_id": "rq-1",
        "tool_name": "Bash",
        "is_interrupt": true,
        "invented_field_nobody_thought_of": "BHCANARY_invented",
    });
    for f in CONTENT_FIELDS {
        doc[f] = serde_json::json!(format!("BHCANARY_{f}"));
    }
    doc["tool_input"] = serde_json::json!({"command": "BHCANARY_nested_cmd", "file_path": "/Users/x/BHCANARY_path"});
    doc["nested"] = serde_json::json!({"deep": ["BHCANARY_deep"]});
    let o = run(&hook_args("claude", rt.to_str().unwrap()), doc.to_string().as_bytes());
    assert_silent_ok(&o);
    let raw = r.seen.recv_timeout(Duration::from_secs(2)).expect("request");
    let text = String::from_utf8_lossy(&raw).to_string();
    assert!(!text.contains("BHCANARY"), "a canary reached the wire: {text}");
    assert!(!text.contains("/Users/x"), "a path reached the wire");

    let (head, body) = split_request(&raw);
    assert!(head.starts_with(&format!("POST /e/{SECRET} HTTP/1.1")), "request line: {head}");
    assert_eq!(header_of(&head, "Host").as_deref(), Some(format!("127.0.0.1:{}", r.port).as_str()));
    assert_eq!(header_of(&head, "Content-Type").as_deref(), Some("application/json"));
    assert_eq!(header_of(&head, "X-Busyholm-Token").as_deref(), Some(TOKEN));
    assert_eq!(header_of(&head, "X-Busyholm-Agent").as_deref(), Some("claude"));
    assert_eq!(header_of(&head, "Origin"), None);
    assert_eq!(header_of(&head, "Content-Length").unwrap().parse::<usize>().unwrap(), body.len());

    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    // is_interrupt is only for PostToolUseFailure, so it must be absent on PermissionRequest.
    assert_eq!(keys, ["agent_id", "hook_event_name", "prompt_id", "request_id", "session_id", "tool_name", "tool_use_id", "turn_id"]);
    assert_eq!(v["tool_name"], "Bash");
    assert_eq!(v["session_id"], "sess-1");
}

#[test]
fn event_conditional_fields_and_free_text_never_pass() {
    let r = start_receiver(Mode::Ok204);
    let d = scratch("cond");
    let rt = write_runtime(&d, r.port);
    let rts = rt.to_str().unwrap();
    let send = |agent: &str, doc: serde_json::Value| -> serde_json::Value {
        let o = run(&hook_args(agent, rts), doc.to_string().as_bytes());
        assert_silent_ok(&o);
        let raw = r.seen.recv_timeout(Duration::from_secs(2)).expect("request");
        let (head, body) = split_request(&raw);
        assert_eq!(header_of(&head, "X-Busyholm-Agent").as_deref(), Some(agent));
        serde_json::from_slice(&body).unwrap()
    };

    // PermissionDenied: reason is free text in Claude Code and is never read.
    let v = send("claude", serde_json::json!({"hook_event_name":"PermissionDenied","session_id":"s","reason":"BHCANARY_denied because secret","tool_name":"Bash"}));
    assert!(v.get("reason").is_none());
    // PostToolUseFailure: error is free text; is_interrupt is kept.
    let v = send("claude", serde_json::json!({"hook_event_name":"PostToolUseFailure","session_id":"s","error":"BHCANARY_error text","is_interrupt":true}));
    assert!(v.get("error").is_none());
    assert_eq!(v["is_interrupt"], true);
    // SessionEnd: a closed vocabulary; anything else is "other".
    let v = send("claude", serde_json::json!({"hook_event_name":"SessionEnd","session_id":"s","reason":"logout"}));
    assert_eq!(v["reason"], "logout");
    let v = send("claude", serde_json::json!({"hook_event_name":"SessionEnd","session_id":"s","reason":"BHCANARY_reason"}));
    assert_eq!(v["reason"], "other");
    // Notification: only the type, never the message.
    let v = send("claude", serde_json::json!({"hook_event_name":"Notification","session_id":"s","notification_type":"permission_prompt","message":"BHCANARY_msg","title":"BHCANARY_t"}));
    assert_eq!(v["notification_type"], "permission_prompt");
    assert!(v.get("message").is_none() && v.get("title").is_none());
    let v = send("claude", serde_json::json!({"hook_event_name":"Notification","session_id":"s","notification_type":"BHCANARY_type"}));
    assert_eq!(v["notification_type"], "other");
    // StopFailure: the closed error vocabulary; unknown maps to "unknown".
    let v = send("claude", serde_json::json!({"hook_event_name":"StopFailure","session_id":"s","error":"rate_limit","error_details":"BHCANARY_d"}));
    assert_eq!(v["error"], "rate_limit");
    assert!(v.get("error_details").is_none());
    let v = send("claude", serde_json::json!({"hook_event_name":"StopFailure","session_id":"s","error":"BHCANARY_e"}));
    assert_eq!(v["error"], "unknown");
    // SessionStart source is closed too.
    let v = send("claude", serde_json::json!({"hook_event_name":"SessionStart","session_id":"s","source":"compact"}));
    assert_eq!(v["source"], "compact");
    let v = send("claude", serde_json::json!({"hook_event_name":"SessionStart","session_id":"s","source":"BHCANARY_source"}));
    assert!(v.get("source").is_none());
    // A tool name with spaces or slashes (not an identifier) is dropped, never sent.
    let v = send("claude", serde_json::json!({"hook_event_name":"PreToolUse","session_id":"s","tool_name":"BHCANARY run this"}));
    assert!(v.get("tool_name").is_none());
    // Over-long and control-character ids are dropped.
    let v = send("claude", serde_json::json!({"hook_event_name":"Stop","session_id":"x".repeat(300),"turn_id":"a\u{0007}b"}));
    assert!(v.get("session_id").is_none() && v.get("turn_id").is_none());
    // Codex adds its own host and timestamp, both validated.
    let v = send("codex", serde_json::json!({"hook_event_name":"Stop","session_id":"s","turn_id":"t","host":"desktop","timestamp":"2026-10-12T10:00:00Z","model":"BHCANARY_model","cwd":"/x"}));
    assert_eq!((v["host"].as_str(), v["timestamp"].as_str()), (Some("desktop"), Some("2026-10-12T10:00:00Z")));
    assert!(v.get("model").is_none() && v.get("cwd").is_none());
    let v = send("codex", serde_json::json!({"hook_event_name":"Stop","session_id":"s","host":"BHCANARY_host","timestamp":"BHCANARY free text"}));
    assert!(v.get("host").is_none() && v.get("timestamp").is_none());
}

#[test]
fn huge_hook_bodies_are_filtered_not_forwarded() {
    let r = start_receiver(Mode::Ok204);
    let d = scratch("huge");
    let rt = write_runtime(&d, r.port);
    let big = "BHCANARY_".to_string() + &"a".repeat(6 * 1024 * 1024);
    let doc = serde_json::json!({"hook_event_name":"PostToolUse","session_id":"s","tool_name":"Write","tool_response": big});
    let o = run(&hook_args("claude", rt.to_str().unwrap()), doc.to_string().as_bytes());
    assert_silent_ok(&o);
    let raw = r.seen.recv_timeout(Duration::from_secs(2)).expect("request");
    assert!(raw.len() < 1024, "wire body must be tiny, was {}", raw.len());
    assert!(!String::from_utf8_lossy(&raw).contains("BHCANARY"));
}

#[test]
fn p95_latency_with_a_healthy_receiver_is_far_below_the_budget() {
    let r = start_receiver(Mode::Ok204);
    let d = scratch("lat");
    let rt = write_runtime(&d, r.port);
    let mut times = Vec::new();
    for _ in 0..20 {
        let o = run(&hook_args("claude", rt.to_str().unwrap()), &stop_body());
        assert_silent_ok(&o);
        times.push(o.elapsed);
    }
    times.sort();
    assert!(times[18] < Duration::from_millis(400), "p95 was {:?}", times[18]);
}

// ---- test 6: status line wrapper -----------------------------------------------------------

fn statusline_doc() -> serde_json::Value {
    serde_json::json!({
        "session_id": "sess-1",
        "cwd": "/Users/x/BHCANARY_cwd",
        "model": {"display_name": "BHCANARY_model"},
        "workspace": {"current_dir": "/Users/x/BHCANARY_dir"},
        "cost": {"total_cost_usd": 12.5},
        "rate_limits": {
            "five_hour": {"used_percentage": 23.5, "resets_at": 1791810000, "note": "BHCANARY_note"},
            "seven_day": {"used_percentage": 41.0, "resets_at": 1792300000}
        }
    })
}

fn write_prev(dir: &Path, command: &str) -> PathBuf {
    let p = dir.join("prev.json");
    std::fs::write(&p, serde_json::json!({"type":"command","command":command,"padding":0}).to_string()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    p
}

fn statusline_args<'a>(rt: &'a str, prev: Option<&'a str>) -> Vec<&'a str> {
    let mut a = vec!["statusline", "--runtime", rt, "--owner", "abcdef0123456789"];
    if let Some(p) = prev {
        a.extend(["--prev-file", p]);
    }
    a
}

#[cfg(unix)]
#[test]
fn statusline_passes_prior_stdout_through_byte_identical() {
    let r = start_receiver(Mode::Ok204);
    let d = scratch("sl");
    let rt = write_runtime(&d, r.port);
    // CRLF, a NUL, a 0xFF byte, a multi-byte character and NO trailing newline.
    let prev = write_prev(&d, r#"printf 'line1\r\nnul:\000\377 caf\303\251 end'"#);
    let o = run(&statusline_args(rt.to_str().unwrap(), Some(prev.to_str().unwrap())), statusline_doc().to_string().as_bytes());
    assert_eq!(o.code, Some(0));
    assert_eq!(o.stdout, b"line1\r\nnul:\x00\xff caf\xc3\xa9 end".to_vec(), "stdout must be byte-identical");
    assert!(o.stderr.is_empty());

    // The receiver got only the session id and the two windows' numbers.
    let raw = r.seen.recv_timeout(Duration::from_secs(2)).expect("status line post");
    assert!(!String::from_utf8_lossy(&raw).contains("BHCANARY"));
    let (head, body) = split_request(&raw);
    assert_eq!(header_of(&head, "X-Busyholm-Agent").as_deref(), Some("claude"));
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        v,
        serde_json::json!({"session_id":"sess-1","rate_limits":{
            "five_hour":{"used_percentage":23.5,"resets_at":1791810000},
            "seven_day":{"used_percentage":41.0,"resets_at":1792300000}}})
    );
}

#[cfg(unix)]
#[test]
fn statusline_gives_the_prior_command_the_same_stdin_and_its_exit_code() {
    let d = scratch("sl-stdin");
    let rt = write_runtime(&d, dead_port());
    let input = statusline_doc().to_string();
    let prev = write_prev(&d, "cat; exit 3");
    let o = run(&statusline_args(rt.to_str().unwrap(), Some(prev.to_str().unwrap())), input.as_bytes());
    assert_eq!(o.stdout, input.as_bytes(), "the prior command must see the original stdin untouched");
    assert_eq!(o.code, Some(3), "the prior command's exit code is passed on");
}

#[cfg(unix)]
#[test]
fn statusline_output_is_complete_even_when_the_receiver_hangs_or_is_down() {
    let d = scratch("sl-hang");
    let prev = write_prev(&d, "printf 'steady'");
    for port in [start_receiver(Mode::Hang).port, start_receiver(Mode::Status500).port, dead_port()] {
        let rt = write_runtime(&d, port);
        let o = run(&statusline_args(rt.to_str().unwrap(), Some(prev.to_str().unwrap())), statusline_doc().to_string().as_bytes());
        assert_eq!(o.stdout, b"steady");
        assert_eq!(o.code, Some(0));
        assert!(o.stderr.is_empty());
        assert!(o.elapsed < Duration::from_millis(1200), "took {:?}", o.elapsed);
    }
}

#[cfg(unix)]
#[test]
fn statusline_large_input_and_output_do_not_deadlock() {
    let d = scratch("sl-big");
    let rt = write_runtime(&d, dead_port());
    let mut doc = statusline_doc();
    doc["cost"]["blob"] = serde_json::json!("z".repeat(2 * 1024 * 1024));
    let prev = write_prev(&d, "cat");
    let input = doc.to_string();
    let o = run(&statusline_args(rt.to_str().unwrap(), Some(prev.to_str().unwrap())), input.as_bytes());
    assert_eq!(o.stdout.len(), input.len());
    assert_eq!(o.stdout, input.as_bytes());
}

#[cfg(unix)]
#[test]
fn p2_5_statusline_falls_back_to_prev_cmd_when_prev_file_is_missing() {
    let r = start_receiver(Mode::Ok204);
    let d = scratch("sl-fallback");
    let rt = write_runtime(&d, r.port);
    let missing = d.join("deleted.bak");
    let args = [
        "statusline",
        "--runtime",
        rt.to_str().unwrap(),
        "--prev-file",
        missing.to_str().unwrap(),
        "--prev-cmd",
        "printf 'fallback-output'; exit 4",
        "--owner",
        "abcdef0123456789",
    ];
    let o = run(&args, statusline_doc().to_string().as_bytes());
    assert_eq!(o.stdout, b"fallback-output", "must fall back to --prev-cmd when --prev-file is missing");
    assert_eq!(o.code, Some(4), "must preserve exit code from fallback command");
    assert!(r.seen.recv_timeout(Duration::from_secs(2)).is_ok(), "still reports rate limits");
}

#[test]
fn statusline_without_a_prior_command_prints_nothing_and_sends_only_complete_windows() {
    let r = start_receiver(Mode::Ok204);
    let d = scratch("sl-none");
    let rt = write_runtime(&d, r.port);
    let o = run(&statusline_args(rt.to_str().unwrap(), None), statusline_doc().to_string().as_bytes());
    assert_eq!(o.code, Some(0));
    assert!(o.stdout.is_empty() && o.stderr.is_empty());
    assert!(r.seen.recv_timeout(Duration::from_secs(2)).is_ok());

    // No rate limits (API-key users), a window with only one number, out of range: nothing is sent.
    for doc in [
        serde_json::json!({"session_id":"s","cost":{"total_cost_usd":1}}),
        serde_json::json!({"session_id":"s","rate_limits":{"five_hour":{"used_percentage":50}}}),
        serde_json::json!({"session_id":"s","rate_limits":{"five_hour":{"used_percentage":150,"resets_at":1791810000}}}),
        serde_json::json!({"session_id":"s","rate_limits":{"five_hour":null}}),
    ] {
        let o = run(&statusline_args(rt.to_str().unwrap(), None), doc.to_string().as_bytes());
        assert_eq!(o.code, Some(0));
    }
    assert!(r.seen.recv_timeout(Duration::from_millis(400)).is_err(), "an incomplete window must never produce a sample");
}

// ---- allowlist unit checks (library level) -------------------------------------------------

#[test]
fn allowlist_is_a_whitelist_of_fresh_keys() {
    use busyholm_shim::allowlist::{filter_hook, filter_statusline};
    assert!(filter_hook(b"{}").is_none());
    let out = filter_hook(br#"{"hook_event_name":"Stop","session_id":"s","last_assistant_message":"BHCANARY"}"#).unwrap();
    assert_eq!(String::from_utf8(out).unwrap(), r#"{"hook_event_name":"Stop","session_id":"s"}"#);
    // P3: path-shaped session_id containing '/' must not pass through id_ok unhashed.
    let path_id = filter_hook(br#"{"hook_event_name":"Stop","session_id":"/Users/alice/secret/project"}"#).unwrap();
    assert_eq!(String::from_utf8(path_id).unwrap(), r#"{"hook_event_name":"Stop"}"#);
    assert!(filter_statusline(br#"{"session_id":"/Users/alice/secret","rate_limits":{"five_hour":{"used_percentage":10,"resets_at":1791810000}}}"#).is_none());
    assert!(filter_statusline(br#"{"session_id":"s"}"#).is_none());
}


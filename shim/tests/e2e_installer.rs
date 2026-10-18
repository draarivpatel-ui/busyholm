//! End to end: the entries the INSTALLER writes are run exactly as the agents would run them, against the
//! real `busyholm-hook` binary and a test receiver. This is what proves the written command lines work with
//! a data folder that has a space in its name, and that the wrapped status line is byte-identical.
#![cfg(unix)]

use busyholm_installer::{Component, Installer, Layout, Sources};
use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::thread;
use std::time::Duration;

const BIN: &str = env!("CARGO_BIN_EXE_busyholm-hook");

struct Rig {
    _tmp: tempfile::TempDir,
    layout: Layout,
    seen: Receiver<Vec<u8>>,
}

fn rig() -> Rig {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let layout = Layout {
        data_dir: root.join("Application Support").join("Busyholm"),
        claude_dir: root.join("claude"),
        codex_dir: root.join("codex"),
        opencode_dir: root.join("opencode"),
    };
    for d in [&layout.claude_dir, &layout.codex_dir, &layout.opencode_dir] {
        std::fs::create_dir_all(d).unwrap();
    }
    // a receiver that answers 204
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = channel();
    thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut s) = conn else { continue };
            let tx = tx.clone();
            thread::spawn(move || {
                s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let Ok(n) = s.read(&mut chunk) else { break };
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(h) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..h]).to_lowercase();
                        let len = head.lines().find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                        if buf.len() >= h + 4 + len {
                            break;
                        }
                    }
                }
                let _ = tx.send(buf);
                let _ = s.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
            });
        }
    });
    std::fs::create_dir_all(&layout.data_dir).unwrap();
    let rt = layout.runtime_path();
    std::fs::write(&rt, format!(r#"{{"v":1,"port":{port},"secret":"secret-path-0123456789","token":"token-header-0123456789"}}"#)).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&rt, std::fs::Permissions::from_mode(0o600)).unwrap();
    Rig { _tmp: tmp, layout, seen: rx }
}

fn install(rig: &Rig, comps: &[Component]) {
    let inst = Installer::new(rig.layout.clone());
    let sources = Sources { shim_binary: BIN.into(), opencode_plugin: String::new() };
    let plan = inst.plan_install(comps, &sources).unwrap();
    inst.apply(&plan).unwrap();
}

fn body_of(raw: &[u8]) -> Value {
    let h = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    serde_json::from_slice(&raw[h + 4..]).unwrap()
}

fn run_stdin(mut cmd: Command, stdin: &[u8]) -> (std::process::Output, Duration) {
    let start = std::time::Instant::now();
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut sin = child.stdin.take().unwrap();
    let input = stdin.to_vec();
    let w = thread::spawn(move || {
        let _ = sin.write_all(&input);
    });
    let out = child.wait_with_output().unwrap();
    let _ = w.join();
    (out, start.elapsed())
}

#[test]
fn claude_hook_entry_runs_as_written_and_sends_only_allowlisted_fields() {
    let rig = rig();
    std::fs::write(rig.layout.claude_settings(), "{}\n").unwrap();
    install(&rig, &[Component::ClaudeHooks]);
    let settings: Value = serde_json::from_slice(&std::fs::read(rig.layout.claude_settings()).unwrap()).unwrap();
    for event in ["PermissionRequest", "Stop", "PostToolUse"] {
        let h = &settings["hooks"][event][0]["hooks"][0];
        let mut cmd = Command::new(h["command"].as_str().unwrap());
        cmd.args(h["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()));
        let doc = serde_json::json!({
            "hook_event_name": event, "session_id": "sess-e2e", "tool_name": "Bash",
            "tool_input": {"command": "BHCANARY_cmd"}, "prompt": "BHCANARY_prompt", "cwd": "/Users/x/BHCANARY",
            "transcript_path": "/Users/x/BHCANARY.jsonl", "last_assistant_message": "BHCANARY_reply",
        });
        let (out, took) = run_stdin(cmd, doc.to_string().as_bytes());
        assert_eq!(out.status.code(), Some(0));
        assert!(out.stdout.is_empty() && out.stderr.is_empty());
        assert!(took < Duration::from_millis(1200));
        let raw = rig.seen.recv_timeout(Duration::from_secs(2)).expect("the receiver must get the event");
        assert!(!String::from_utf8_lossy(&raw).contains("BHCANARY"), "{event}: a canary reached the wire");
        let head = String::from_utf8_lossy(&raw[..raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap()]).to_string();
        assert!(head.contains("X-Busyholm-Agent: claude") && head.contains("X-Busyholm-Token: token-header-0123456789"));
        let v = body_of(&raw);
        assert_eq!(v["hook_event_name"], event);
        assert_eq!(v["session_id"], "sess-e2e");
    }
}

#[test]
fn codex_hook_command_runs_through_a_shell_with_a_space_in_the_path() {
    let rig = rig();
    install(&rig, &[Component::CodexHooks]);
    let hooks: Value = serde_json::from_slice(&std::fs::read(rig.layout.codex_hooks()).unwrap()).unwrap();
    let command = hooks["hooks"]["PermissionRequest"][0]["hooks"][0]["command"].as_str().unwrap().to_string();
    assert!(command.contains("Application Support"));
    let mut cmd = Command::new("sh");
    cmd.arg("-c").arg(&command);
    let doc = serde_json::json!({"hook_event_name": "PermissionRequest", "session_id": "thr_1", "turn_id": "t1",
        "tool_name": "shell", "tool_input": {"cmd": "BHCANARY"}, "model": "BHCANARY_model", "cwd": "/Users/x"});
    let (out, _) = run_stdin(cmd, doc.to_string().as_bytes());
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stdout.is_empty() && out.stderr.is_empty());
    let raw = rig.seen.recv_timeout(Duration::from_secs(2)).expect("event");
    assert!(!String::from_utf8_lossy(&raw).contains("BHCANARY"));
    assert!(String::from_utf8_lossy(&raw).contains("X-Busyholm-Agent: codex"));
    assert_eq!(body_of(&raw)["turn_id"], "t1");
}

#[test]
fn wrapped_status_line_output_is_byte_identical_to_the_prior_command() {
    let rig = rig();
    // the prior command prints CRLF, NUL, a stray 0xFF and no trailing newline, and reads its stdin
    let prior = r#"cat >/dev/null; printf 'one\r\ntwo\000\377 end'"#;
    std::fs::write(rig.layout.claude_settings(), serde_json::json!({"statusLine": {"type": "command", "command": prior, "padding": 0}}).to_string()).unwrap();
    let direct = {
        let mut c = Command::new("sh");
        c.arg("-c").arg(prior);
        run_stdin(c, b"{}").0.stdout
    };
    install(&rig, &[Component::ClaudeStatusline]);
    let settings: Value = serde_json::from_slice(&std::fs::read(rig.layout.claude_settings()).unwrap()).unwrap();
    let wrapped = settings["statusLine"]["command"].as_str().unwrap().to_string();
    assert_eq!(settings["statusLine"]["padding"], 0);
    let doc = serde_json::json!({"session_id": "s-sl", "cost": {"total_cost_usd": 3}, "cwd": "/Users/x/BHCANARY",
        "rate_limits": {"five_hour": {"used_percentage": 12.0, "resets_at": 1791810000}}});
    let mut c = Command::new("sh");
    c.arg("-c").arg(&wrapped);
    let (out, _) = run_stdin(c, doc.to_string().as_bytes());
    assert_eq!(out.stdout, direct, "stdout must be byte-identical to the prior command's");
    assert_eq!(out.status.code(), Some(0));
    let raw = rig.seen.recv_timeout(Duration::from_secs(2)).expect("usage numbers");
    assert!(!String::from_utf8_lossy(&raw).contains("BHCANARY"));
    let v = body_of(&raw);
    assert_eq!(v["rate_limits"]["five_hour"]["used_percentage"], 12.0);
    assert!(v.get("cost").is_none() && v.get("cwd").is_none());

    // disconnect puts the user's own status line back, and the data folder holds the kept copy for recovery
    let inst = Installer::new(rig.layout.clone());
    let plan = inst.plan_disconnect(&[]).unwrap();
    inst.apply(&plan).unwrap();
    let after: Value = serde_json::from_slice(&std::fs::read(rig.layout.claude_settings()).unwrap()).unwrap();
    assert_eq!(after["statusLine"]["command"], prior);
}

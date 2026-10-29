//! WP-04 acceptance 5 (status line), plus registry, transcript, process, dedup and root goldens.
mod common;
use common::*;

use busyholm_contracts::agent_event::EventKind;
use busyholm_contracts::common::Host;
use collector_claude::dedup::Dedup;
use collector_claude::hooks::map_hook;
use collector_claude::process::{match_claude_process, ProcInfo, ProcessTracker};
use collector_claude::registry::{parse_registry_entry, registry_file_pid, RegStatus, RegistryTracker, WaitKind};
use collector_claude::statusline::map_statusline;
use collector_claude::transcript::{FileRole, TranscriptReader, STALE_MS};
use serde_json::json;

// ---- 5: status line -------------------------------------------------------------------

fn sl(body: serde_json::Value) -> Vec<busyholm_contracts::AgentEvent> {
    with_env(NOW, |env| map_statusline(body.to_string().as_bytes(), env).unwrap())
}

#[test]
fn both_windows_give_two_samples_in_milliseconds() {
    let ev = with_env(NOW, |env| map_statusline(&read_fixture("claude/statusline/statusline-both-windows.json"), env).unwrap());
    assert_valid(&ev);
    let u: Vec<_> = ev.iter().map(|e| serde_json::to_value(e.usage.as_ref().unwrap()).unwrap()).collect();
    assert_eq!(u[0], json!({"provider":"claude","window":"5h","used_pct":37.5,"resets_at":1791817200000_u64,"observed_at":NOW}));
    assert_eq!(u[1], json!({"provider":"claude","window":"weekly","used_pct":12.0,"resets_at":1792065600000_u64,"observed_at":NOW}));
    assert_eq!(summs(&ev), vec!["usage_sample/hook/exact", "usage_sample/hook/exact"]);
    assert_eq!(ev[0].instance, test_id("bca1a700-0000-4000-8000-000000000035"));
}

#[test]
fn a_missing_window_yields_no_sample_never_zero_percent() {
    let ev = with_env(NOW, |env| map_statusline(&read_fixture("claude/statusline/statusline-five-hour-only.json"), env).unwrap());
    assert_eq!(ev.len(), 1);
    assert_eq!(serde_json::to_value(ev[0].usage.as_ref().unwrap()).unwrap()["window"], "5h");

    let ev = with_env(NOW, |env| map_statusline(&read_fixture("claude/statusline/statusline-no-rate-limits.json"), env).unwrap());
    assert!(ev.is_empty());

    for rl in [
        json!({"five_hour": null}),
        json!({"five_hour": {}}),
        json!({"five_hour": {"resets_at": 1791817200}}),                       // no percentage
        json!({"five_hour": {"used_percentage": 40}}),                          // no reset time
        json!({"five_hour": {"used_percentage": "40", "resets_at": 1791817200}}),
        json!({"five_hour": {"used_percentage": 140, "resets_at": 1791817200}}),
        json!({"five_hour": {"used_percentage": -1, "resets_at": 1791817200}}),
        json!({"seven_day": 12}),
        json!({}),
    ] {
        assert!(sl(json!({"session_id":"s-1","rate_limits":rl})).is_empty(), "{rl}");
    }
}

#[test]
fn a_real_zero_percent_is_a_sample() {
    let ev = sl(json!({"session_id":"s-1","rate_limits":{"five_hour":{"used_percentage":0,"resets_at":1791817200}}}));
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].usage.as_ref().unwrap().used_pct, 0.0);
}

// ---- registry --------------------------------------------------------------------------

#[test]
fn only_pid_dot_json_names_are_registry_files() {
    assert_eq!(registry_file_pid("41001.json"), Some(41001));
    for n in ["41001.abcdef.key", "41001.key", ".credentials.json", "auth.json", "x.json", "41001.json.bak", "41001.JSON.key", "", ".json", "-5.json", "4100a.json"] {
        assert_eq!(registry_file_pid(n), None, "{n}");
    }
}

fn entry(rel: &str) -> collector_claude::registry::RegistryEntry {
    parse_registry_entry(&read_fixture(rel)).unwrap()
}

#[test]
fn registry_fixtures_parse_to_allowlisted_fields() {
    let busy = entry("claude/registry/registry-busy.json");
    assert_eq!((busy.pid, busy.status, busy.host), (41001, RegStatus::Busy, Host::Cli));
    assert_eq!(busy.proc_start, "Mon Oct 12 11:50:00 2026");
    assert_eq!(entry("claude/registry/registry-idle.json").status, RegStatus::Idle);
    assert_eq!(entry("claude/registry/registry-waiting.json").status, RegStatus::Waiting(Some(WaitKind::Permission)));
    assert_eq!(entry("claude/registry/registry-desktop.json").host, Host::Desktop);
    let dbg = format!("{busy:?}");
    assert!(!dbg.contains("BHCANARY") && !dbg.contains("bca1a700"), "Debug must not print ids or content");
}

#[test]
fn registry_first_scan_golden() {
    let cases = [
        ("claude/registry/registry-busy.json", vec!["session_start/registry/exact", "turn_start/registry/exact"]),
        ("claude/registry/registry-idle.json", vec!["session_start/registry/exact"]),
        ("claude/registry/registry-waiting.json", vec!["session_start/registry/exact", "needs_permission/registry/inferred"]),
        ("claude/registry/registry-desktop.json", vec!["session_start/registry/exact"]),
    ];
    for (rel, expected) in cases {
        let mut t = RegistryTracker::new();
        let out = with_env(NOW, |env| t.observe(&[entry(rel)], &|_, _| true, env));
        assert_valid(&out.events);
        assert_eq!(summs(&out.events), expected, "{rel}");
        assert_eq!(out.events[0].et, Some(1_791_805_800_000), "session_start et = startedAt");
        assert_eq!(out.learned.len(), 1);
        let (inst, host, account) = &out.learned[0];
        assert_eq!(*inst, out.events[0].instance);
        assert!(matches!(host, Host::Cli | Host::Desktop));
        assert!(account.is_some());
    }
    let mut t = RegistryTracker::new();
    let out = with_env(NOW, |env| t.observe(&[entry("claude/registry/registry-desktop.json")], &|_, _| true, env));
    assert_eq!(out.events[0].host, Host::Desktop);
    let sid = "bca1a700-0000-4000-8000-00000000003d";
    assert_eq!(out.events[0].instance, test_id(sid));
}

#[test]
fn registry_status_changes_and_exit() {
    let mut t = RegistryTracker::new();
    let mut e = entry("claude/registry/registry-idle.json");
    let alive = |_: u32, _: &str| true;
    with_env(NOW, |env| t.observe(&[e.clone()], &alive, env));

    e.status = RegStatus::Busy;
    let out = with_env(NOW + 1000, |env| t.observe(&[e.clone()], &alive, env));
    assert_eq!(summs(&out.events), vec!["turn_start/registry/exact"]);

    // Unchanged status: nothing.
    let out = with_env(NOW + 2000, |env| t.observe(&[e.clone()], &alive, env));
    assert!(out.events.is_empty() && out.left_busy.is_empty());

    e.status = RegStatus::Waiting(Some(WaitKind::Permission));
    let out = with_env(NOW + 3000, |env| t.observe(&[e.clone()], &alive, env));
    assert_eq!(summs(&out.events), vec!["needs_permission/registry/inferred"]);

    e.status = RegStatus::Busy;
    let out = with_env(NOW + 4000, |env| t.observe(&[e.clone()], &alive, env));
    assert_eq!(summs(&out.events), vec!["answered/registry/inferred"]);

    e.status = RegStatus::Idle;
    let out = with_env(NOW + 5000, |env| t.observe(&[e.clone()], &alive, env));
    assert!(out.events.is_empty(), "leaving busy is not an event by itself");
    assert_eq!(out.left_busy, vec![test_id("bca1a700-0000-4000-8000-000000000039")]);

    // File removed and process dead: a clean end. File removed but process alive: wait.
    let out = with_env(NOW + 6000, |env| t.observe(&[], &|_, _| true, env));
    assert!(out.events.is_empty());
    let out = with_env(NOW + 7000, |env| t.observe(&[], &|_, _| false, env));
    assert_eq!(summs(&out.events), vec!["session_end/registry/exact;end=exit"]);
    let out = with_env(NOW + 8000, |env| t.observe(&[], &|_, _| false, env));
    assert!(out.events.is_empty(), "the end is reported once");
}

#[test]
fn a_crash_leftover_file_with_a_dead_process_ends_the_session() {
    let mut t = RegistryTracker::new();
    let e = entry("claude/registry/registry-busy.json");
    with_env(NOW, |env| t.observe(&[e.clone()], &|_, _| true, env));
    let out = with_env(NOW + 1000, |env| t.observe(&[e.clone()], &|_, _| false, env));
    assert_eq!(summs(&out.events), vec!["session_end/registry/exact;end=process_gone"]);
}

#[test]
fn pid_reuse_is_a_new_identity() {
    let mut t = RegistryTracker::new();
    let mut e = entry("claude/registry/registry-idle.json");
    with_env(NOW, |env| t.observe(&[e.clone()], &|_, _| true, env));
    e.proc_start = "Mon Oct 12 12:30:00 2026".into();
    e.session_id = "bca1a700-0000-4000-8000-0000000000aa".into();
    let out = with_env(NOW + 1000, |env| t.observe(&[e.clone()], &|_, _| true, env));
    assert_eq!(summs(&out.events), vec!["session_end/registry/exact;end=process_gone", "session_start/registry/exact"]);
}

#[test]
fn daemon_registry_entries_are_not_sessions() {
    let mut t = RegistryTracker::new();
    let mut e = entry("claude/registry/registry-idle.json");
    e.kind = "daemon".into();
    let out = with_env(NOW, |env| t.observe(&[e], &|_, _| true, env));
    assert!(out.events.is_empty());
}

// ---- transcript -------------------------------------------------------------------------

fn run_transcript(file: &str, role: FileRole) -> (Vec<busyholm_contracts::AgentEvent>, TranscriptReader) {
    let mut r = TranscriptReader::new();
    let text = read_fixture(&format!("claude/transcript/{file}"));
    let mut out = Vec::new();
    with_env(NOW, |env| {
        for line in text.split(|b| *b == b'\n') {
            if line.is_empty() {
                continue;
            }
            out.extend(r.on_line(line, &role, env));
        }
    });
    (out, r)
}

#[test]
fn transcript_goldens() {
    let (ev, _) = run_transcript("transcript-main.jsonl", FileRole::Main);
    assert_valid(&ev);
    assert_eq!(
        summs(&ev),
        vec![
            "turn_start/log/exact",
            "heartbeat/log/exact;act=shell",
            "tool_end/log/exact",
            "turn_end/log/exact;stop=end_turn",
        ]
    );
    assert_eq!(ev[0].instance, test_id("bca1a700-0000-4000-8000-00000000003e"));
    assert_eq!(ev[0].turn_id, Some(scoped("turn", "bca1a700-0000-4000-8000-000000000040")));
    assert_eq!(ev[3].turn_id, ev[0].turn_id, "the end_turn record belongs to the open turn");
    assert_eq!(ev[0].et, Some(1_791_806_401_000));
    assert_eq!(ev[1].tokens_delta, Some(1280));

    let (ev, r) = run_transcript("transcript-api-errors.jsonl", FileRole::Main);
    assert_valid(&ev);
    assert_eq!(summs(&ev), vec!["turn_start/log/exact", "error/log/exact;err=overloaded"], "retry 3 of 10 is a warning; the synthetic reply repeats the error and is not a second event");
    assert_eq!(r.stats.bad_lines, 0);

    let (ev, _) = run_transcript("transcript-quota-limit.jsonl", FileRole::Main);
    assert_valid(&ev);
    assert_eq!(summs(&ev), vec!["turn_start/log/exact", "limit_hit/log/exact"]);
    assert_eq!(
        serde_json::to_value(ev[1].limit.as_ref().unwrap()).unwrap(),
        json!({"provider":"claude","window":"5h","resets_at":1791817200000_u64})
    );

    let (ev, _) = run_transcript("transcript-u2028.jsonl", FileRole::Main);
    assert_eq!(summs(&ev), vec!["turn_start/log/exact", "turn_end/log/exact;stop=end_turn"]);
}

#[test]
fn transcript_tokens_count_once_per_message_id() {
    let mut r = TranscriptReader::new();
    let mk = |id: &str, ts: &str| {
        json!({"type":"assistant","sessionId":"s-1","timestamp":ts,"message":{"id":id,"role":"assistant",
            "content":[{"type":"text","text":"x"}],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":2,"cache_read_input_tokens":9999}}})
        .to_string()
    };
    let ev = with_env(NOW, |env| {
        let mut v = Vec::new();
        v.extend(r.on_line(mk("m1", "2026-10-12T12:00:00.000Z").as_bytes(), &FileRole::Main, env));
        v.extend(r.on_line(mk("m1", "2026-10-12T12:00:01.000Z").as_bytes(), &FileRole::Main, env));
        v.extend(r.on_line(mk("m2", "2026-10-12T12:00:02.000Z").as_bytes(), &FileRole::Main, env));
        v
    });
    let total: u32 = ev.iter().filter_map(|e| e.tokens_delta).sum();
    assert_eq!(total, 17 * 2, "cache reads are excluded; each message id counts once");
}

#[test]
fn history_collapses_to_the_last_state_bearing_event() {
    let (ev, _) = run_transcript("transcript-main.jsonl", FileRole::Main);
    // The fixture records are about 100 s old at NOW: live. Move the clock far ahead.
    let later = NOW + STALE_MS + 60_000;
    let reduced = TranscriptReader::reduce_history(ev.clone(), later);
    assert_eq!(summs(&reduced), vec!["turn_end/log/exact;stop=end_turn"]);
    let kept = TranscriptReader::reduce_history(ev.clone(), NOW);
    assert_eq!(kept.len(), ev.len(), "recent events are all kept");
}

#[test]
fn subagent_transcripts_are_children_of_their_session() {
    let role = FileRole::Subagent { agent_id: "bca1a700-0000-4000-8000-0000000000bb".into() };
    let mut r = TranscriptReader::new();
    let line = json!({"type":"user","sessionId":"bca1a700-0000-4000-8000-00000000003e","isSidechain":true,
        "timestamp":"2026-10-12T12:00:01.000Z","promptId":"p-1","origin":{"kind":"human"},"message":{"role":"user","content":"x"}})
        .to_string();
    let ev = with_env(NOW, |env| r.on_line(line.as_bytes(), &role, env));
    assert_valid(&ev);
    assert_eq!(summs(&ev), vec!["session_start/log/exact;child", "turn_start/log/exact;child"]);
    assert_eq!(ev[0].instance, test_id("bca1a700-0000-4000-8000-0000000000bb"));
    assert_eq!(ev[0].parent, Some(test_id("bca1a700-0000-4000-8000-00000000003e")));
}

#[test]
fn log_records_never_raise_needs_you_alerts() {
    let line = json!({"type":"assistant","sessionId":"s-1","timestamp":"2026-10-12T12:00:00.000Z",
        "message":{"id":"m","role":"assistant","content":[{"type":"tool_use","id":"t","name":"AskUserQuestion","input":{}}],"stop_reason":"tool_use","usage":{"input_tokens":1,"output_tokens":1}}})
        .to_string();
    let mut r = TranscriptReader::new();
    let ev = with_env(NOW, |env| r.on_line(line.as_bytes(), &FileRole::Main, env));
    assert!(ev.iter().all(|e| !matches!(e.kind, EventKind::NeedsPermission | EventKind::NeedsAnswer)));
}

#[test]
fn garbage_lines_are_counted_not_fatal() {
    let mut r = TranscriptReader::new();
    with_env(NOW, |env| {
        assert!(r.on_line(b"not json", &FileRole::Main, env).is_empty());
        assert!(r.on_line(b"[1,2]", &FileRole::Main, env).is_empty());
        assert!(r.on_line(br#"{"type":"future-record-type","sessionId":"s"}"#, &FileRole::Main, env).is_empty());
    });
    assert_eq!(r.stats.bad_lines, 2);
    assert_eq!(r.stats.unknown_types, 1);
}

// ---- dedup (SPEC Revision 1) --------------------------------------------------------------

fn hook(name: &str, extra: serde_json::Value, now: u64) -> Vec<busyholm_contracts::AgentEvent> {
    let mut body = json!({"session_id":"s-1","hook_event_name":name});
    for (k, v) in extra.as_object().unwrap() {
        body[k] = v.clone();
    }
    with_env(now, |env| map_hook(body.to_string().as_bytes(), env).unwrap().events)
}

fn log_turn_end(prompt: Option<&str>, now: u64) -> busyholm_contracts::AgentEvent {
    let mut r = TranscriptReader::new();
    let mut lines = Vec::new();
    if let Some(p) = prompt {
        lines.push(json!({"type":"user","sessionId":"s-1","timestamp":"2026-10-12T12:00:00.000Z","promptId":p,"origin":{"kind":"human"},"message":{"role":"user","content":"x"}}).to_string());
    }
    lines.push(json!({"type":"assistant","sessionId":"s-1","timestamp":"2026-10-12T12:00:01.000Z","message":{"id":"m","role":"assistant","content":[{"type":"text","text":"x"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}}).to_string());
    let mut last = None;
    with_env(now, |env| {
        for l in &lines {
            for e in r.on_line(l.as_bytes(), &FileRole::Main, env) {
                if e.kind == EventKind::TurnEnd {
                    last = Some(e);
                }
            }
        }
    });
    last.expect("turn_end from the log")
}

#[test]
fn hook_and_log_copies_of_a_turn_give_one_turn_end_in_either_order() {
    for hook_first in [true, false] {
        let mut d = Dedup::new();
        let h = hook("Stop", json!({"prompt_id":"P1"}), NOW).remove(0);
        let l = log_turn_end(Some("P1"), NOW + 80);
        let (a, b) = if hook_first { (h, l) } else { (l, h) };
        assert!(d.admit(&a), "first copy passes");
        if hook_first {
            assert!(!d.admit(&b), "the transcript copy after the hook is dropped");
            assert_eq!(d.stats.turn_dupes, 1);
        } else {
            // The collector may have refused the transcript copy, so the hook copy goes out too; the collector
            // counts the turn once either way (tests/turn_end_order.rs).
            assert!(d.admit(&b), "the hook copy after the transcript passes");
            assert!(!d.admit(&b), "a second hook copy is dropped");
            assert_eq!(d.stats.turn_dupes, 1);
        }
    }
}

#[test]
fn a_new_turn_is_not_a_duplicate_and_unkeyed_copies_dedup_by_source_and_window() {
    let mut d = Dedup::new();
    assert!(d.admit(&hook("Stop", json!({"prompt_id":"P1"}), NOW).remove(0)));
    assert!(d.admit(&hook("Stop", json!({"prompt_id":"P2"}), NOW + 60_000).remove(0)), "different turn id");

    // Without a turn id on the log side, a different-source copy within 10 s is a duplicate.
    let mut d = Dedup::new();
    assert!(d.admit(&hook("Stop", json!({"prompt_id":"P9"}), NOW).remove(0)));
    assert!(!d.admit(&log_turn_end(None, NOW + 100)));
    // ... but not 30 s later.
    let mut d = Dedup::new();
    assert!(d.admit(&hook("Stop", json!({"prompt_id":"P9"}), NOW).remove(0)));
    assert!(d.admit(&log_turn_end(None, NOW + 30_000)));
}

#[test]
fn late_notification_for_an_answered_request_is_ignored() {
    let mut d = Dedup::new();
    let pr = hook("PermissionRequest", json!({"tool_name":"Bash","tool_use_id":"tu-1"}), NOW).remove(0);
    assert!(d.admit(&pr));
    let post = hook("PostToolUse", json!({"tool_name":"Bash","tool_use_id":"tu-1"}), NOW + 1_000).remove(0);
    assert!(d.admit(&post));
    let late = hook("Notification", json!({"notification_type":"permission_prompt"}), NOW + 6_000).remove(0);
    assert!(!d.admit(&late), "answered before the notification arrived");
    assert_eq!(d.stats.late_notifications, 1);

    // The same notification while the request is still pending is a duplicate of the alert.
    let mut d = Dedup::new();
    assert!(d.admit(&hook("PermissionRequest", json!({"tool_use_id":"tu-2"}), NOW).remove(0)));
    assert!(!d.admit(&hook("Notification", json!({"notification_type":"permission_prompt"}), NOW + 6_000).remove(0)));
    assert_eq!(d.stats.request_dupes, 1);

    // With no PermissionRequest hook at all, the notification is the alert.
    let mut d = Dedup::new();
    assert!(d.admit(&hook("Notification", json!({"notification_type":"permission_prompt"}), NOW).remove(0)));

    // A genuinely new request later still alerts.
    let mut d = Dedup::new();
    assert!(d.admit(&hook("PermissionRequest", json!({"tool_use_id":"a"}), NOW).remove(0)));
    assert!(d.admit(&hook("PostToolUse", json!({"tool_name":"Bash","tool_use_id":"a"}), NOW + 500).remove(0)));
    assert!(d.admit(&hook("PermissionRequest", json!({"tool_use_id":"b"}), NOW + 60_000).remove(0)));
}

#[test]
fn an_unrelated_tool_finishing_does_not_answer_a_pending_request() {
    let mut d = Dedup::new();
    assert!(d.admit(&hook("PermissionRequest", json!({"tool_use_id":"tu-1"}), NOW).remove(0)));
    assert!(d.admit(&hook("PostToolUse", json!({"tool_name":"Read","tool_use_id":"other"}), NOW + 500).remove(0)));
    let late = hook("Notification", json!({"notification_type":"permission_prompt"}), NOW + 6_000).remove(0);
    assert!(!d.admit(&late), "still pending: the notification is a duplicate of the live alert");
    assert_eq!(d.stats.request_dupes, 1);
}

#[test]
fn an_exact_hook_after_an_inferred_registry_wait_still_raises_the_alert() {
    // The registry's waiting status is inferred and never raises an alert in the collector, so the exact
    // hook for the same request must not be dropped as its duplicate.
    for (name, kind) in [("PermissionRequest", EventKind::NeedsPermission), ("Notification", EventKind::NeedsPermission)] {
        let mut d = Dedup::new();
        let exact = hook(name, json!({"tool_use_id":"tu-1","notification_type":"permission_prompt"}), NOW + 500).remove(0);
        assert_eq!(exact.kind, kind);
        let mut registry = exact.clone();
        registry.source = busyholm_contracts::agent_event::EventSource::Registry;
        registry.confidence = busyholm_contracts::common::Confidence::Inferred;
        registry.request_id = None;
        registry.detail = None;
        assert!(d.admit(&registry));
        assert!(d.admit(&exact), "{name}: the exact hook is the alert");
        assert!(!d.admit(&exact), "{name}: a second exact copy is still a duplicate");
    }
}

#[test]
fn open_turn_tracking_follows_all_sources() {
    let mut d = Dedup::new();
    let inst = test_id("s-1");
    assert!(!d.has_open_turn(&inst));
    d.admit(&hook("UserPromptSubmit", json!({"prompt_id":"P1"}), NOW).remove(0));
    assert!(d.has_open_turn(&inst));
    d.admit(&hook("Stop", json!({"prompt_id":"P1"}), NOW + 10).remove(0));
    assert!(!d.has_open_turn(&inst));
}

#[test]
fn a_second_session_end_for_the_same_instance_is_dropped() {
    let mut d = Dedup::new();
    assert!(d.admit(&hook("SessionEnd", json!({"reason":"clear"}), NOW).remove(0)));
    assert!(!d.admit(&hook("SessionEnd", json!({"reason":"other"}), NOW + 10).remove(0)));
    assert!(d.admit(&hook("SessionStart", json!({"source":"startup"}), NOW + 20).remove(0)), "a restart revives the id");
}

// ---- process matcher ------------------------------------------------------------------

#[test]
fn process_matcher_table() {
    let cli = [
        "/Users/a/.local/share/claude/versions/2.1.296",
        "C:\\Users\\a\\.local\\share\\claude\\versions\\2.1.296.exe",
        "/home/a/.local/bin/claude",
    ];
    let desktop = [
        "/Users/a/Library/Application Support/Claude/claude-code/2.1.295/abc123/claude.app/Contents/MacOS/claude",
    ];
    let no = [
        "/Applications/Claude.app/Contents/MacOS/Claude",
        "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)",
        "/Applications/Claude.app/Contents/Frameworks/chrome_crashpad_handler",
        "/Applications/Claude.app/Contents/Helpers/disclaimer",
        "/usr/bin/node",
        "/Users/a/.local/share/claude/versions",
        "/Users/a/project/claude",
        "/Users/a/.opencode/bin/opencode",
        "",
    ];
    for p in cli {
        assert_eq!(match_claude_process(p), Some(Host::Cli), "{p}");
    }
    for p in desktop {
        assert_eq!(match_claude_process(p), Some(Host::Desktop), "{p}");
    }
    for p in no {
        assert_eq!(match_claude_process(p), None, "{p}");
    }
}

#[test]
fn process_tracker_reports_up_and_down_and_retires_ghosts() {
    let mut t = ProcessTracker::new();
    let p = |pid: u32| ProcInfo { pid, start: "Mon Oct 12 11:50:00 2026".into(), exe: "/Users/a/.local/share/claude/versions/2.1.296".into() };
    let noise = ProcInfo { pid: 7, start: "x".into(), exe: "/usr/bin/node".into() };
    let sess = test_id("sess-a");

    let none = |_: u32, _: &str| None;
    let ev = with_env(NOW, |env| t.observe(&[p(100), noise.clone()], &none, env));
    assert_eq!(summs(&ev), vec!["process_up/process/exact"]);
    let ghost = ev[0].instance.clone();
    assert_ne!(ghost, sess);

    // The registry now knows the pid: the ghost is retired and the session gets the up.
    let known = |pid: u32, _: &str| if pid == 100 { Some(test_id("sess-a")) } else { None };
    let ev = with_env(NOW + 5_000, |env| t.observe(&[p(100)], &known, env));
    assert_eq!(summs(&ev), vec!["process_down/process/inferred", "process_up/process/exact"]);
    assert_eq!(ev[0].instance, ghost);
    assert_eq!(ev[1].instance, sess);

    let ev = with_env(NOW + 10_000, |env| t.observe(&[], &known, env));
    assert_eq!(summs(&ev), vec!["process_down/process/exact"]);
    assert_eq!(ev[0].instance, sess);
    assert_valid(&ev);
}

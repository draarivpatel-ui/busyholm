//! WP-11 acceptance tests: the notification dedupe state machine (SPEC 4.3, 5.7 rule 9, 6.9,
//! Revision 1 item 3). SPEC 9.1 WP-11 test 2: "3 needs-you episodes give exactly 3 notifications,
//! re-notifying after 5 min".
//!
//! Times: `now` is the caller's monotonic clock in ms; `t` inside a Snapshot or Moment is the
//! collector's wall clock. The two are unrelated on purpose.
use busyholm_app::notify::*;
use busyholm_contracts::{from_value, Moment, Settings, Snapshot};
use serde_json::{json, Value};

const T0: u64 = 1_791_806_400_000;
const ON: Prefs = Prefs { needs_you: true, renotify: true, long_turn: true, errors: true };

fn id(n: u32) -> String {
    format!("{n:032x}")
}

/// A snapshot agent. `req` is the pending request number (needs_you only).
fn agent(n: u32, tool: &str, ordinal: u16, state: &str, req: Option<u32>, reason: &str, conf: &str) -> Value {
    let mut a = json!({
        "id": id(n), "tool": tool, "host": "cli", "ordinal": ordinal, "parent": null,
        "root_id": id(900), "account_id": null, "session_id": id(5000 + n), "turn_id": null,
        "request_id": null, "state": state, "confidence": conf,
        "since": T0, "started_at": T0 - 3_600_000
    });
    if state == "needs_you" {
        a["request_id"] = req.map_or(Value::Null, |r| json!(id(7000 + r)));
        a["reason"] = json!(reason);
    }
    a
}
fn working(n: u32, tool: &str, ordinal: u16) -> Value {
    agent(n, tool, ordinal, "working", None, "", "exact")
}
fn asking(n: u32, tool: &str, ordinal: u16, req: Option<u32>) -> Value {
    agent(n, tool, ordinal, "needs_you", req, "permission", "exact")
}

fn snap_with(t: u64, demo: bool, agents: Vec<Value>) -> Snapshot {
    let waiting = agents.iter().filter(|a| a["state"] == "needs_you").count();
    let oldest = if waiting > 0 { json!(T0) } else { Value::Null };
    from_value(json!({
        "schema_version": 2, "t": t, "demo": demo, "agents": agents, "tools": [], "limits": [],
        "attention": { "needs_you": waiting, "oldest_since": oldest }
    }))
    .expect("snapshot matches the contract")
}
fn snap(t: u64, agents: Vec<Value>) -> Snapshot {
    snap_with(t, false, agents)
}

fn moment(kind: &str, t: u64, n: u32, tool: &str, extra: Value) -> Moment {
    let mut m = json!({ "schema_version": 1, "kind": kind, "t": t, "agent": id(n), "tool": tool });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    from_value(m).expect("moment matches the contract")
}
fn needs(t: u64, n: u32, tool: &str, req: Option<u32>, reason: &str) -> Moment {
    let mut extra = json!({ "reason": reason });
    if let Some(r) = req {
        extra["request_id"] = json!(id(7000 + r));
    }
    moment("needs_you", t, n, tool, extra)
}
fn answered(t: u64, n: u32, tool: &str, req: Option<u32>) -> Moment {
    let extra = req.map_or(json!({}), |r| json!({ "request_id": id(7000 + r) }));
    moment("answered", t, n, tool, extra)
}
fn turn_end(t: u64, n: u32, tool: &str, turn_ms: Option<u32>) -> Moment {
    moment("turn_end", t, n, tool, turn_ms.map_or(json!({}), |m| json!({ "turn_ms": m })))
}
fn error(t: u64, n: u32, tool: &str) -> Moment {
    moment("error", t, n, tool, json!({}))
}

fn kinds(v: &[Notice]) -> Vec<NoticeKind> {
    v.iter().map(|n| n.kind).collect()
}
fn count(v: &[Notice], k: NoticeKind) -> usize {
    v.iter().filter(|n| n.kind == k).count()
}

// ---------------------------------------------------------------- (a) three episodes, three notices

#[test]
fn a_three_episodes_give_exactly_three_notifications() {
    let mut nf = Notifier::new();
    let tools = [(1u32, "claude", 1u16), (2, "codex", 1), (3, "opencode", 1)];
    let mut all: Vec<Notice> = Vec::new();
    let mut now = 1_000u64;
    let mut t = T0;
    for (i, (n, tool, ord)) in tools.iter().enumerate() {
        let req = 10 + i as u32;
        let others: Vec<Value> = tools
            .iter()
            .filter(|(m, _, _)| m != n)
            .map(|(m, tl, o)| working(*m, tl, *o))
            .collect();
        let with = |mine: Value| -> Vec<Value> {
            let mut v = others.clone();
            v.push(mine);
            v
        };
        // Working snapshot first.
        t += 1_000;
        now += 1_000;
        all.extend(nf.on_snapshot(&snap(t, with(working(*n, tool, *ord))), now, &ON));
        // Hook copy, then a duplicate log copy without a request id.
        t += 1_000;
        now += 1_000;
        let opened_t = t;
        all.extend(nf.on_moment(&needs(t, *n, tool, Some(req), "permission"), now, &ON));
        t += 5;
        now += 5;
        all.extend(nf.on_moment(&needs(t, *n, tool, None, "permission"), now, &ON));
        // Ten identical snapshots all showing the same ask.
        for _ in 0..10 {
            t += 100;
            now += 100;
            all.extend(nf.on_snapshot(&snap(t, with(asking(*n, tool, *ord, Some(req)))), now, &ON));
        }
        // The user answers: Moment, then a working snapshot.
        t += 100;
        now += 100;
        all.extend(nf.on_moment(&answered(t, *n, tool, Some(req)), now, &ON));
        t += 100;
        now += 100;
        all.extend(nf.on_snapshot(&snap(t, with(working(*n, tool, *ord))), now, &ON));
        // A late repeat of the old alert after the answer opens nothing.
        all.extend(nf.on_moment(&needs(opened_t, *n, tool, Some(req), "permission"), now, &ON));
        all.extend(nf.tick(now, &ON));
        now += 2_000;
        t += 2_000;
    }
    assert_eq!(count(&all, NoticeKind::NeedsYou), 3, "{all:?}");
    assert_eq!(all.len(), 3, "no other notices: {all:?}");
    let agents: Vec<_> = all.iter().map(|n| n.agent.clone()).collect();
    assert_eq!(agents, vec![id(1), id(2), id(3)]);
}

#[test]
fn a2_three_overlapping_episodes_three_notices_and_three_reminders() {
    let mut nf = Notifier::new();
    let mut all = Vec::new();
    let a = |req: [Option<u32>; 3]| {
        vec![
            asking(1, "claude", 1, req[0]),
            asking(2, "codex", 1, req[1]),
            asking(3, "gemini", 1, req[2]),
        ]
    };
    all.extend(nf.on_moment(&needs(T0, 1, "claude", Some(1), "permission"), 0, &ON));
    all.extend(nf.on_moment(&needs(T0 + 10, 2, "codex", Some(2), "question"), 10_000, &ON));
    all.extend(nf.on_snapshot(&snap(T0 + 20, a([Some(1), Some(2), Some(3)])), 20_000, &ON));
    for s in 0..400u64 {
        let now = 20_000 + s * 1_000;
        all.extend(nf.on_snapshot(&snap(T0 + 30 + s, a([Some(1), Some(2), Some(3)])), now, &ON));
        all.extend(nf.tick(now, &ON));
    }
    assert_eq!(count(&all, NoticeKind::NeedsYou), 3, "{all:?}");
    assert_eq!(count(&all, NoticeKind::Reminder), 3, "{all:?}");
}

// ---------------------------------------------------------------- (b) re-notify after 5 minutes

#[test]
fn b_reminder_fires_exactly_once_at_five_minutes_ticking_every_second() {
    let mut nf = Notifier::new();
    let first = nf.on_moment(&needs(T0, 1, "claude", Some(1), "permission"), 10_000, &ON);
    assert_eq!(kinds(&first), vec![NoticeKind::NeedsYou]);
    assert_eq!(nf.next_due(), Some(10_000 + RENOTIFY_AFTER_MS));
    let mut fired: Vec<(u64, Notice)> = Vec::new();
    for sec in 1..=360u64 {
        let now = 10_000 + sec * 1_000;
        for n in nf.tick(now, &ON) {
            fired.push((now, n));
        }
    }
    assert_eq!(fired.len(), 1, "{fired:?}");
    assert_eq!(fired[0].0, 10_000 + 300_000);
    assert_eq!(fired[0].1.kind, NoticeKind::Reminder);
    assert_eq!(nf.next_due(), None, "no second reminder is pending");
}

#[test]
fn b2_reminder_boundary_299_999_no_300_000_yes_never_twice() {
    let mut nf = Notifier::new();
    nf.on_moment(&needs(T0, 1, "claude", Some(1), "question"), 0, &ON);
    assert!(nf.tick(299_999, &ON).is_empty());
    assert_eq!(kinds(&nf.tick(300_000, &ON)), vec![NoticeKind::Reminder]);
    assert!(nf.tick(300_001, &ON).is_empty());
    assert!(nf.tick(900_000, &ON).is_empty());
}

#[test]
fn b3_renotify_off_gives_no_reminder_and_nothing_pending() {
    let off = Prefs { renotify: false, ..ON };
    let mut nf = Notifier::new();
    let first = nf.on_moment(&needs(T0, 1, "claude", Some(1), "permission"), 0, &off);
    assert_eq!(kinds(&first), vec![NoticeKind::NeedsYou]);
    assert_eq!(nf.next_due(), None);
    for sec in 0..=400u64 {
        assert!(nf.tick(sec * 1_000, &off).is_empty());
    }
}

#[test]
fn b4_answered_episode_never_reminds() {
    let mut nf = Notifier::new();
    nf.on_moment(&needs(T0, 1, "claude", Some(1), "permission"), 0, &ON);
    nf.on_moment(&answered(T0 + 1_000, 1, "claude", Some(1)), 1_000, &ON);
    assert_eq!(nf.next_due(), None);
    assert!(nf.tick(400_000, &ON).is_empty());
}

#[test]
fn b5_reminder_clock_starts_at_first_notice_not_at_later_copies() {
    let mut nf = Notifier::new();
    nf.on_moment(&needs(T0, 1, "claude", Some(1), "permission"), 0, &ON);
    // Copies and snapshots 4 minutes later do not restart the clock.
    nf.on_moment(&needs(T0 + 240_000, 1, "claude", None, "permission"), 240_000, &ON);
    nf.on_snapshot(&snap(T0 + 240_001, vec![asking(1, "claude", 1, Some(1))]), 240_001, &ON);
    assert_eq!(nf.next_due(), Some(300_000));
    assert_eq!(kinds(&nf.tick(300_000, &ON)), vec![NoticeKind::Reminder]);
}

// ---------------------------------------------------------------- (c) late signals for answered requests

#[test]
fn c_late_needs_you_moment_for_an_answered_request_opens_nothing() {
    let mut nf = Notifier::new();
    assert_eq!(nf.on_moment(&needs(T0 + 100, 1, "claude", Some(1), "permission"), 0, &ON).len(), 1);
    nf.on_moment(&answered(T0 + 200, 1, "claude", Some(1)), 100, &ON);
    // The log copy of the same alert shows up late, with and without the request id.
    assert!(nf.on_moment(&needs(T0 + 150, 1, "claude", Some(1), "permission"), 200, &ON).is_empty());
    assert!(nf.on_moment(&needs(T0 + 150, 1, "claude", None, "permission"), 200, &ON).is_empty());
    assert!(nf.on_moment(&needs(T0 + 200, 1, "claude", None, "permission"), 200, &ON).is_empty());
    // A stale coalesced snapshot still showing the ask.
    let stale = snap(T0 + 160, vec![asking(1, "claude", 1, Some(1))]);
    assert!(nf.on_snapshot(&stale, 300, &ON).is_empty());
    assert_eq!(nf.next_due(), None);
    assert!(nf.tick(500_000, &ON).is_empty());
}

#[test]
fn c2_a_genuinely_new_ask_after_an_answer_still_notifies() {
    let mut nf = Notifier::new();
    nf.on_moment(&needs(T0 + 100, 1, "claude", Some(1), "permission"), 0, &ON);
    nf.on_moment(&answered(T0 + 200, 1, "claude", Some(1)), 100, &ON);
    // New request id.
    assert_eq!(count(&nf.on_moment(&needs(T0 + 300, 1, "claude", Some(2), "question"), 200, &ON), NoticeKind::NeedsYou), 1);
    nf.on_moment(&answered(T0 + 400, 1, "claude", None), 300, &ON);
    // No request id, but strictly newer than the answer.
    assert_eq!(count(&nf.on_moment(&needs(T0 + 401, 1, "claude", None, "question"), 400, &ON), NoticeKind::NeedsYou), 1);
}

#[test]
fn c3_answered_without_request_id_ignores_older_signals_with_ids_too() {
    let mut nf = Notifier::new();
    nf.on_moment(&needs(T0 + 100, 1, "claude", None, "permission"), 0, &ON);
    nf.on_moment(&answered(T0 + 200, 1, "claude", None), 100, &ON);
    assert!(nf.on_moment(&needs(T0 + 150, 1, "claude", Some(1), "permission"), 200, &ON).is_empty());
}

#[test]
fn c4_answered_arriving_before_any_needs_you_still_blocks_the_late_copy() {
    let mut nf = Notifier::new();
    nf.on_moment(&answered(T0 + 200, 1, "claude", Some(4)), 0, &ON);
    assert!(nf.on_moment(&needs(T0 + 100, 1, "claude", Some(4), "permission"), 10, &ON).is_empty());
}

#[test]
fn c5_answered_for_a_different_request_does_not_close_the_open_one() {
    let mut nf = Notifier::new();
    nf.on_moment(&needs(T0 + 100, 1, "claude", Some(2), "permission"), 0, &ON);
    nf.on_moment(&answered(T0 + 150, 1, "claude", Some(1)), 10, &ON);
    assert_eq!(nf.next_due(), Some(RENOTIFY_AFTER_MS), "request 2 is still open");
    nf.on_moment(&answered(T0 + 160, 1, "claude", Some(2)), 20, &ON);
    assert_eq!(nf.next_due(), None);
}

#[test]
fn c6_answered_memory_is_forgotten_after_thirty_minutes() {
    let mut nf = Notifier::new();
    nf.on_moment(&answered(T0 + 200, 1, "claude", Some(1)), 0, &ON);
    let later = 31 * 60_000;
    assert_eq!(count(&nf.on_moment(&needs(T0 + 300, 1, "claude", Some(1), "permission"), later, &ON), NoticeKind::NeedsYou), 1);
}

// ---------------------------------------------------------------- (d) late older snapshots do not close

#[test]
fn d_older_working_snapshot_after_the_moment_keeps_the_episode_open() {
    let mut nf = Notifier::new();
    let opened = nf.on_moment(&needs(T0 + 5_000, 1, "claude", Some(1), "permission"), 0, &ON);
    assert_eq!(opened.len(), 1);
    // Coalesced snapshot built before the ask, delivered after the Moment.
    assert!(nf.on_snapshot(&snap(T0 + 4_000, vec![working(1, "claude", 1)]), 10, &ON).is_empty());
    // Equal t does not close either.
    assert!(nf.on_snapshot(&snap(T0 + 5_000, vec![working(1, "claude", 1)]), 20, &ON).is_empty());
    // The first fresh needs-you snapshot is the same episode: no second notice.
    let fresh = snap(T0 + 6_000, vec![asking(1, "claude", 1, Some(1))]);
    assert!(nf.on_snapshot(&fresh, 30, &ON).is_empty());
    assert_eq!(nf.next_due(), Some(RENOTIFY_AFTER_MS), "still one open episode");
}

#[test]
fn d2_older_working_snapshot_without_request_ids_keeps_the_episode_open() {
    let mut nf = Notifier::new();
    nf.on_moment(&needs(T0 + 5_000, 1, "claude", None, "question"), 0, &ON);
    nf.on_snapshot(&snap(T0 + 1_000, vec![working(1, "claude", 1)]), 10, &ON);
    assert!(nf.on_snapshot(&snap(T0 + 6_000, vec![asking(1, "claude", 1, None)]), 20, &ON).is_empty());
}

#[test]
fn d3_a_strictly_newer_snapshot_without_the_ask_closes_it_and_a_new_ask_notifies() {
    let mut nf = Notifier::new();
    nf.on_moment(&needs(T0 + 5_000, 1, "claude", Some(1), "permission"), 0, &ON);
    assert!(nf.on_snapshot(&snap(T0 + 5_001, vec![working(1, "claude", 1)]), 10, &ON).is_empty());
    assert_eq!(nf.next_due(), None, "closed");
    let again = nf.on_snapshot(&snap(T0 + 9_000, vec![asking(1, "claude", 1, Some(2))]), 20, &ON);
    assert_eq!(kinds(&again), vec![NoticeKind::NeedsYou]);
}

#[test]
fn d4_a_newer_snapshot_with_the_agent_absent_closes_it() {
    let mut nf = Notifier::new();
    nf.on_moment(&needs(T0 + 5_000, 1, "claude", None, "permission"), 0, &ON);
    nf.on_snapshot(&snap(T0 + 5_001, vec![]), 10, &ON);
    assert_eq!(nf.next_due(), None);
    assert!(nf.tick(400_000, &ON).is_empty());
}

#[test]
fn d5_snapshot_closed_ask_is_not_reopened_by_its_late_log_copy() {
    let mut nf = Notifier::new();
    nf.on_moment(&needs(T0 + 5_000, 1, "claude", Some(1), "permission"), 0, &ON);
    nf.on_snapshot(&snap(T0 + 6_000, vec![working(1, "claude", 1)]), 10, &ON);
    assert!(nf.on_moment(&needs(T0 + 5_500, 1, "claude", Some(1), "permission"), 20, &ON).is_empty());
    assert!(nf.on_moment(&needs(T0 + 5_500, 1, "claude", None, "permission"), 20, &ON).is_empty());
}

// ---------------------------------------------------------------- rule 2: adopt and replace

#[test]
fn r2_request_none_then_some_is_the_same_episode() {
    let mut nf = Notifier::new();
    assert_eq!(nf.on_moment(&needs(T0, 1, "claude", None, "permission"), 0, &ON).len(), 1);
    assert!(nf.on_moment(&needs(T0 + 1, 1, "claude", Some(1), "permission"), 1, &ON).is_empty());
    assert!(nf.on_snapshot(&snap(T0 + 2, vec![asking(1, "claude", 1, Some(1))]), 2, &ON).is_empty());
    // After adopting, a different id is a new episode.
    assert_eq!(nf.on_moment(&needs(T0 + 3, 1, "claude", Some(2), "permission"), 3, &ON).len(), 1);
}

#[test]
fn r2_snapshot_none_then_some_is_the_same_episode() {
    let mut nf = Notifier::new();
    assert_eq!(nf.on_snapshot(&snap(T0, vec![asking(1, "claude", 1, None)]), 0, &ON).len(), 1);
    assert!(nf.on_snapshot(&snap(T0 + 1, vec![asking(1, "claude", 1, Some(1))]), 1, &ON).is_empty());
}

#[test]
fn r2_a_different_request_replaces_the_episode_with_a_new_notice_and_a_fresh_reminder() {
    let mut nf = Notifier::new();
    nf.on_moment(&needs(T0, 1, "claude", Some(1), "permission"), 0, &ON);
    let second = nf.on_moment(&needs(T0 + 100_000, 1, "claude", Some(2), "question"), 100_000, &ON);
    assert_eq!(kinds(&second), vec![NoticeKind::NeedsYou]);
    assert_eq!(second[0].body, "A question is waiting for your answer");
    // Only the new episode is pending, due 5 min after ITS notice.
    assert_eq!(nf.next_due(), Some(100_000 + RENOTIFY_AFTER_MS));
    assert!(nf.tick(300_000, &ON).is_empty());
    assert_eq!(kinds(&nf.tick(400_000, &ON)), vec![NoticeKind::Reminder]);
    // The superseded request does not come back.
    assert!(nf.on_moment(&needs(T0 + 200_000, 1, "claude", Some(1), "permission"), 400_001, &ON).is_empty());
}

#[test]
fn r3_each_agent_has_its_own_episode() {
    let mut nf = Notifier::new();
    nf.on_moment(&needs(T0, 1, "claude", Some(1), "permission"), 0, &ON);
    assert_eq!(nf.on_moment(&needs(T0, 2, "claude", Some(1), "permission"), 0, &ON).len(), 1);
    nf.on_moment(&answered(T0 + 10, 1, "claude", Some(1)), 10, &ON);
    assert_eq!(nf.next_due(), Some(RENOTIFY_AFTER_MS), "agent 2 is still waiting");
}

// ---------------------------------------------------------------- (e) demo

#[test]
fn e_demo_snapshot_emits_nothing_at_all() {
    let mut nf = Notifier::new();
    let demo = snap_with(T0, true, vec![asking(1, "claude", 1, Some(1)), asking(2, "codex", 1, None)]);
    assert!(nf.on_snapshot(&demo, 0, &ON).is_empty());
    let demo2 = snap_with(T0 + 1_000, true, vec![asking(1, "claude", 1, Some(1))]);
    assert!(nf.on_snapshot(&demo2, 1_000, &ON).is_empty());
    // Moments, long turns and errors are silent while the newest snapshot is demo.
    assert!(nf.on_moment(&needs(T0 + 1_500, 3, "gemini", Some(3), "permission"), 1_500, &ON).is_empty());
    assert!(nf.on_moment(&turn_end(T0 + 1_600, 3, "gemini", Some(500_000)), 1_600, &ON).is_empty());
    assert!(nf.on_moment(&error(T0 + 1_700, 3, "gemini"), 1_700, &ON).is_empty());
    // No reminders either.
    for sec in 0..=400u64 {
        assert!(nf.tick(2_000 + sec * 1_000, &ON).is_empty());
    }
}

#[test]
fn e2_before_any_snapshot_is_not_demo_and_leaving_demo_notifies_again() {
    let mut nf = Notifier::new();
    assert_eq!(nf.on_moment(&needs(T0, 1, "claude", Some(1), "permission"), 0, &ON).len(), 1);
    let mut nf = Notifier::new();
    nf.on_snapshot(&snap_with(T0, true, vec![]), 0, &ON);
    // First real snapshot ends demo; a real ask afterwards notifies.
    nf.on_snapshot(&snap(T0 + 1_000, vec![working(1, "claude", 1)]), 1_000, &ON);
    assert_eq!(nf.on_moment(&needs(T0 + 2_000, 1, "claude", Some(1), "permission"), 2_000, &ON).len(), 1);
}

#[test]
fn e3_demo_state_is_still_tracked_so_the_same_ask_does_not_notify_after_demo_ends() {
    // Documented choice: an episode opened silently (demo) stays silent and never reminds.
    let mut nf = Notifier::new();
    nf.on_snapshot(&snap_with(T0, true, vec![asking(1, "claude", 1, Some(1))]), 0, &ON);
    assert!(nf.on_snapshot(&snap(T0 + 1_000, vec![asking(1, "claude", 1, Some(1))]), 1_000, &ON).is_empty());
    assert_eq!(nf.next_due(), None);
    assert!(nf.tick(400_000, &ON).is_empty());
}

// ---------------------------------------------------------------- (f) inferred

#[test]
fn f_inferred_needs_you_never_notifies() {
    let mut nf = Notifier::new();
    let inferred = agent(1, "claude", 1, "needs_you", Some(1), "permission", "inferred");
    for i in 0..5u64 {
        assert!(nf.on_snapshot(&snap(T0 + i, vec![inferred.clone()]), i, &ON).is_empty());
    }
    assert_eq!(nf.next_due(), None, "no reminder for something never announced");
    assert!(nf.tick(400_000, &ON).is_empty());
}

#[test]
fn f2_tracked_silently_so_a_later_exact_copy_of_the_same_request_stays_quiet() {
    let mut nf = Notifier::new();
    let inferred = agent(1, "claude", 1, "needs_you", Some(1), "permission", "inferred");
    nf.on_snapshot(&snap(T0, vec![inferred]), 0, &ON);
    assert!(nf.on_snapshot(&snap(T0 + 1, vec![asking(1, "claude", 1, Some(1))]), 1, &ON).is_empty());
    assert!(nf.on_moment(&needs(T0 + 2, 1, "claude", Some(1), "permission"), 2, &ON).is_empty());
    assert_eq!(nf.next_due(), None);
}

#[test]
fn f3_a_live_signal_for_a_different_or_unidentified_request_still_notifies() {
    let mut nf = Notifier::new();
    let inferred = agent(1, "claude", 1, "needs_you", Some(1), "permission", "inferred");
    nf.on_snapshot(&snap(T0, vec![inferred.clone()]), 0, &ON);
    assert_eq!(nf.on_moment(&needs(T0 + 1, 1, "claude", Some(2), "permission"), 1, &ON).len(), 1);
    let mut nf = Notifier::new();
    nf.on_snapshot(&snap(T0, vec![inferred]), 0, &ON);
    assert_eq!(nf.on_moment(&needs(T0 + 1, 1, "claude", None, "permission"), 1, &ON).len(), 1);
}

#[test]
fn f4_an_inferred_snapshot_never_downgrades_or_duplicates_an_exact_episode() {
    let mut nf = Notifier::new();
    assert_eq!(nf.on_moment(&needs(T0, 1, "claude", Some(1), "permission"), 0, &ON).len(), 1);
    let inferred = agent(1, "claude", 1, "needs_you", Some(1), "permission", "inferred");
    assert!(nf.on_snapshot(&snap(T0 + 1, vec![inferred]), 1, &ON).is_empty());
    assert_eq!(kinds(&nf.tick(RENOTIFY_AFTER_MS, &ON)), vec![NoticeKind::Reminder]);
}

// ---------------------------------------------------------------- (g) privacy

fn read_fixture(rel: &str) -> Value {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/contracts").join(rel);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

#[test]
fn g_notices_carry_tool_and_state_only_never_project_label_or_ids() {
    let mut v = read_fixture("snapshot.v2/valid/032-project-label-opt-in.json");
    let label = v["agents"][0]["project_label"].as_str().unwrap().to_string();
    assert!(!label.is_empty());
    // Two claude agents (so the ordinal shows too), both asking.
    let mut second = v["agents"][0].clone();
    second["id"] = json!(id(77));
    second["ordinal"] = json!(2);
    second["project_label"] = json!("secret-project-canary");
    v["agents"].as_array_mut().unwrap().push(second);
    for a in v["agents"].as_array_mut().unwrap() {
        a["state"] = json!("needs_you");
        a["request_id"] = json!(id(8800 + a["ordinal"].as_u64().unwrap() as u32));
        a["reason"] = json!("permission");
    }
    v["attention"] = json!({ "needs_you": 2, "oldest_since": T0 });
    let s: Snapshot = from_value(v.clone()).expect("fixture-derived snapshot is valid");
    let ids: Vec<String> = s
        .agents
        .iter()
        .flat_map(|a| {
            [Some(a.id.clone()), Some(a.root_id.clone()), a.account_id.clone(), a.session_id.clone(), a.turn_id.clone(), a.request_id.clone()]
        })
        .flatten()
        .collect();
    assert!(ids.len() >= 8);

    let mut nf = Notifier::new();
    let mut all = nf.on_snapshot(&s, 0, &ON);
    all.extend(nf.tick(RENOTIFY_AFTER_MS, &ON));
    all.extend(nf.on_moment(&turn_end(T0 + 10, 77, "claude", Some(500_000)), 1, &ON));
    all.extend(nf.on_moment(&error(T0 + 11, 77, "claude"), 2, &ON));
    assert_eq!(count(&all, NoticeKind::NeedsYou), 2, "{all:?}");
    assert_eq!(count(&all, NoticeKind::Reminder), 2, "{all:?}");
    assert_eq!(count(&all, NoticeKind::LongTurn), 1);
    assert_eq!(count(&all, NoticeKind::Error), 1);
    for n in &all {
        let text = format!("{}\n{}", n.title, n.body);
        for secret in [label.as_str(), "secret-project-canary", "busyholm"].into_iter().chain(ids.iter().map(String::as_str)) {
            assert!(!text.contains(secret), "{secret:?} leaked into {text:?}");
        }
        assert!(n.title.starts_with("Claude Code 1") || n.title.starts_with("Claude Code 2"), "{}", n.title);
    }
}

// ---------------------------------------------------------------- exact strings

#[test]
fn text_needs_you_reminder_long_turn_and_error_strings_are_exact() {
    let mut nf = Notifier::new();
    let p = nf.on_moment(&needs(T0, 1, "claude", Some(1), "permission"), 0, &ON);
    assert_eq!((p[0].title.as_str(), p[0].body.as_str()), ("Claude Code needs you", "Permission requested"));
    assert_eq!(p[0].tool, busyholm_contracts::common::Tool::Claude);
    assert_eq!(p[0].agent, id(1));
    let q = nf.on_moment(&needs(T0, 2, "codex", Some(2), "question"), 0, &ON);
    assert_eq!((q[0].title.as_str(), q[0].body.as_str()), ("Codex needs you", "A question is waiting for your answer"));
    let r = nf.tick(RENOTIFY_AFTER_MS, &ON);
    assert_eq!(r.len(), 2);
    assert_eq!((r[0].title.as_str(), r[0].body.as_str()), ("Claude Code is still waiting", "Permission requested 5 minutes ago"));
    assert_eq!((r[1].title.as_str(), r[1].body.as_str()), ("Codex is still waiting", "A question has waited 5 minutes"));
    assert!(r.iter().all(|n| n.kind == NoticeKind::Reminder));
    let l = nf.on_moment(&turn_end(T0, 3, "gemini", Some(120_001)), 0, &ON);
    assert_eq!(l[0].kind, NoticeKind::LongTurn);
    assert_eq!((l[0].title.as_str(), l[0].body.as_str()), ("Gemini CLI finished a long turn", "Your turn"));
    let e = nf.on_moment(&error(T0, 4, "cursor"), 0, &ON);
    assert_eq!(e[0].kind, NoticeKind::Error);
    assert_eq!((e[0].title.as_str(), e[0].body.as_str()), ("Cursor stopped with an error", "Check its terminal or editor"));
}

// ---------------------------------------------------------------- (h) long turn and error cooldown

#[test]
fn h_long_turn_threshold_is_strictly_greater_than_two_minutes() {
    let mut nf = Notifier::new();
    assert_eq!(LONG_TURN_MS, 120_000);
    assert!(nf.on_moment(&turn_end(T0, 1, "claude", Some(119_999)), 0, &ON).is_empty());
    assert!(nf.on_moment(&turn_end(T0 + 1, 1, "claude", Some(120_000)), 0, &ON).is_empty());
    assert_eq!(kinds(&nf.on_moment(&turn_end(T0 + 2, 1, "claude", Some(120_001)), 0, &ON)), vec![NoticeKind::LongTurn]);
    // Missing turn_ms: nothing.
    assert!(nf.on_moment(&turn_end(T0 + 3, 1, "claude", None), 0, &ON).is_empty());
}

#[test]
fn h2_long_turn_is_once_per_agent_and_t_and_respects_the_pref() {
    let mut nf = Notifier::new();
    assert_eq!(nf.on_moment(&turn_end(T0, 1, "claude", Some(300_000)), 0, &ON).len(), 1);
    assert!(nf.on_moment(&turn_end(T0, 1, "claude", Some(300_000)), 1, &ON).is_empty(), "duplicate copy");
    assert_eq!(nf.on_moment(&turn_end(T0 + 1, 1, "claude", Some(300_000)), 2, &ON).len(), 1, "new turn");
    assert_eq!(nf.on_moment(&turn_end(T0, 2, "claude", Some(300_000)), 3, &ON).len(), 1, "other agent");
    let off = Prefs { long_turn: false, ..ON };
    assert!(nf.on_moment(&turn_end(T0 + 9, 3, "claude", Some(300_000)), 4, &off).is_empty());
}

#[test]
fn h3_error_is_limited_to_one_per_agent_per_sixty_seconds() {
    let mut nf = Notifier::new();
    assert_eq!(ERROR_COOLDOWN_MS, 60_000);
    assert_eq!(kinds(&nf.on_moment(&error(T0, 1, "claude"), 1_000, &ON)), vec![NoticeKind::Error]);
    assert!(nf.on_moment(&error(T0 + 1, 1, "claude"), 1_001, &ON).is_empty());
    assert!(nf.on_moment(&error(T0 + 2, 1, "claude"), 60_999, &ON).is_empty());
    assert_eq!(nf.on_moment(&error(T0 + 3, 1, "claude"), 61_000, &ON).len(), 1);
    // Another agent has its own cooldown.
    assert_eq!(nf.on_moment(&error(T0 + 4, 2, "claude"), 61_001, &ON).len(), 1);
    // The cooldown restarted at 61_000.
    assert!(nf.on_moment(&error(T0 + 5, 1, "claude"), 120_999, &ON).is_empty());
    assert_eq!(nf.on_moment(&error(T0 + 6, 1, "claude"), 121_000, &ON).len(), 1);
}

#[test]
fn h4_errors_pref_off_emits_nothing_and_does_not_start_a_cooldown() {
    let off = Prefs { errors: false, ..ON };
    let mut nf = Notifier::new();
    assert!(nf.on_moment(&error(T0, 1, "claude"), 0, &off).is_empty());
    assert_eq!(nf.on_moment(&error(T0 + 1, 1, "claude"), 1, &ON).len(), 1);
}

// ---------------------------------------------------------------- rule 8: prefs

#[test]
fn p_needs_you_pref_off_tracks_but_emits_nothing_and_turning_it_on_does_not_fire() {
    let off = Prefs { needs_you: false, ..ON };
    let mut nf = Notifier::new();
    assert!(nf.on_moment(&needs(T0, 1, "claude", Some(1), "permission"), 0, &off).is_empty());
    // Pref switched on mid-episode: the open episode does not fire, from any copy.
    assert!(nf.on_moment(&needs(T0 + 1, 1, "claude", None, "permission"), 1, &ON).is_empty());
    assert!(nf.on_snapshot(&snap(T0 + 2, vec![asking(1, "claude", 1, Some(1))]), 2, &ON).is_empty());
    assert!(nf.tick(RENOTIFY_AFTER_MS + 5, &ON).is_empty(), "no first notice, so no reminder");
    assert_eq!(nf.next_due(), None);
    // A new episode does.
    nf.on_moment(&answered(T0 + 3, 1, "claude", Some(1)), 3, &ON);
    assert_eq!(nf.on_moment(&needs(T0 + 4, 1, "claude", Some(2), "permission"), 4, &ON).len(), 1);
}

#[test]
fn p2_renotify_turned_on_mid_episode_does_not_fire_and_turned_off_before_due_consumes_it() {
    let no_re = Prefs { renotify: false, ..ON };
    let mut nf = Notifier::new();
    nf.on_moment(&needs(T0, 1, "claude", Some(1), "permission"), 0, &no_re);
    assert!(nf.tick(RENOTIFY_AFTER_MS, &ON).is_empty());
    let mut nf = Notifier::new();
    nf.on_moment(&needs(T0, 1, "claude", Some(1), "permission"), 0, &ON);
    assert!(nf.tick(RENOTIFY_AFTER_MS, &no_re).is_empty());
    assert_eq!(nf.next_due(), None);
    assert!(nf.tick(RENOTIFY_AFTER_MS + 1_000, &ON).is_empty(), "a missed reminder is not fired late");
}

#[test]
fn p3_prefs_from_settings_reads_the_notifications_block() {
    let mut v = read_fixture("settings.v1/valid/001-defaults-full.json");
    v["notifications"] = json!({ "needs_you": true, "renotify": false, "long_turn": true, "errors": false });
    let s: Settings = from_value(v).unwrap();
    assert_eq!(Prefs::from(&s), Prefs { needs_you: true, renotify: false, long_turn: true, errors: false });
}

// ---------------------------------------------------------------- (i) names and ordinals

#[test]
fn i_ordinal_shown_only_when_two_agents_of_the_same_tool() {
    let mut nf = Notifier::new();
    nf.on_snapshot(&snap(T0, vec![working(1, "claude", 1), working(2, "codex", 1)]), 0, &ON);
    let one = nf.on_moment(&needs(T0 + 1, 1, "claude", Some(1), "permission"), 1, &ON);
    assert_eq!(one[0].title, "Claude Code needs you");
    let cx = nf.on_moment(&needs(T0 + 1, 2, "codex", Some(2), "permission"), 1, &ON);
    assert_eq!(cx[0].title, "Codex needs you");
    // A second Claude session appears.
    nf.on_snapshot(
        &snap(T0 + 10, vec![asking(1, "claude", 1, Some(1)), working(2, "codex", 1), working(3, "claude", 2)]),
        10,
        &ON,
    );
    let two = nf.on_moment(&needs(T0 + 20, 3, "claude", Some(3), "question"), 20, &ON);
    assert_eq!(two[0].title, "Claude Code 2 needs you");
    let first = nf.on_moment(&error(T0 + 21, 1, "claude"), 21, &ON);
    assert_eq!(first[0].title, "Claude Code 1 stopped with an error");
    // Codex still has one agent: still no number.
    let cx2 = nf.on_moment(&error(T0 + 22, 2, "codex"), 22, &ON);
    assert_eq!(cx2[0].title, "Codex stopped with an error");
    // The second Claude leaves; the number goes away again.
    nf.on_snapshot(&snap(T0 + 30, vec![working(1, "claude", 1), working(2, "codex", 1)]), 30, &ON);
    let back = nf.on_moment(&turn_end(T0 + 31, 1, "claude", Some(999_999)), 31, &ON);
    assert_eq!(back[0].title, "Claude Code finished a long turn");
}

#[test]
fn i2_snapshot_opened_episode_uses_the_agents_ordinal_when_two_share_a_tool() {
    let mut nf = Notifier::new();
    let out = nf.on_snapshot(&snap(T0, vec![working(1, "codex", 1), asking(2, "codex", 2, Some(2))]), 0, &ON);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].title, "Codex 2 needs you");
    assert_eq!(out[0].agent, id(2));
}

#[test]
fn i3_moment_for_an_unknown_agent_uses_the_plain_tool_name_and_every_tool_has_its_display_name() {
    let expect = [
        ("claude", "Claude Code"),
        ("codex", "Codex"),
        ("opencode", "OpenCode"),
        ("antigravity", "Antigravity"),
        ("gemini", "Gemini CLI"),
        ("cursor", "Cursor"),
        ("aider", "Aider"),
        ("other", "Agent"),
    ];
    for (i, (tool, name)) in expect.iter().enumerate() {
        let mut nf = Notifier::new();
        // Even with two agents of this tool in the newest snapshot, an unknown agent id is plain.
        nf.on_snapshot(&snap(T0, vec![working(100, tool, 1), working(101, tool, 2)]), 0, &ON);
        let n = nf.on_moment(&needs(T0 + 1, i as u32 + 1, tool, Some(1), "permission"), 1, &ON);
        assert_eq!(n[0].title, format!("{name} needs you"), "{tool}");
    }
}

// ---------------------------------------------------------------- rule 12: bounded memory

#[test]
fn m_many_episodes_and_answers_stay_functional() {
    let mut nf = Notifier::new();
    let mut notices = 0;
    for i in 0..1_500u32 {
        let now = i as u64 * 10;
        notices += nf.on_moment(&needs(T0 + i as u64, i, "claude", Some(i), "permission"), now, &ON).len();
        if i % 2 == 0 {
            nf.on_moment(&answered(T0 + i as u64 + 1, i, "claude", Some(i)), now, &ON);
        }
    }
    assert_eq!(notices, 1_500);
    // Still responsive, and still deduping a fresh duplicate.
    assert_eq!(nf.on_moment(&needs(T0 + 9_999, 1_501, "codex", Some(1), "permission"), 20_000, &ON).len(), 1);
    assert!(nf.on_moment(&needs(T0 + 9_999, 1_501, "codex", Some(1), "permission"), 20_001, &ON).is_empty());
    let _ = nf.tick(1_000_000, &ON);
    assert!(nf.next_due().is_none() || nf.next_due().unwrap() > 0);
}

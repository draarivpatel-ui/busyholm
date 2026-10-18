//! FIX-A finding H6 (red). A Codex child thread whose own hooks arrive BEFORE its rollout
//! `session_meta` is first created with `parent: None` and its own session scope. When the metadata
//! later names the parent, the collector must reconcile: the child becomes a subagent of the parent,
//! its finished turn counts as a subagent turn (not a main turn), and it is not a main session.
//!
//! A real `CodexAdapter` feeds a real `Collector`. Synthetic ids only; no files are touched.
use std::sync::Arc;
use collector::{Adapter, AdapterContext, Collector, FakeClock, IdentityHasher};
use collector::contracts::{common::Tool, ledger::Counts, snapshot::SnapshotAgent};
use collector::ledger::FixedCalendar;
use collector_codex::{CodexAdapter, RolloutStream};
use serde_json::{json, Value};

const NOW: u64 = 1_791_806_400_000;
const PARENT_RAW: &str = "H6-SYNTHETIC-PARENT-THREAD";
const CHILD_RAW: &str = "H6-SYNTHETIC-CHILD-THREAD";
const TURN_RAW: &str = "H6-SYNTHETIC-CHILD-TURN";
/// Longer than the collector's 5 s window in which a lower-ranked source cannot override a hook.
const SLOW_MS: u64 = 5_001;
/// Metadata arrives while the hook evidence is still fresh (a hook outranks a log line in that window).
const FAST_MS: u64 = 100;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Order { HookFirst, LogFirst }

struct Outcome {
    parent_id: String,
    child: SnapshotAgent,
    parent_agent: SnapshotAgent,
    counts: Counts,
    /// turn_id of the child's `Stop` hook sent after the metadata was decoded.
    hook_turn: Option<String>,
    /// turn_id of the child's rollout `task_complete` decoded after the metadata.
    log_turn: Option<String>,
    expected_turn: String,
}

fn envelope(kind: &str, payload: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"timestamp": NOW, "type": kind, "payload": payload})).unwrap()
}
fn parent_meta() -> Vec<u8> { envelope("session_meta", json!({"id": PARENT_RAW, "source": "cli"})) }
fn child_meta() -> Vec<u8> {
    envelope("session_meta", json!({"id": CHILD_RAW,
        "source": {"subagent": {"thread_spawn": {"parent_thread_id": PARENT_RAW}}}}))
}
fn child_log(kind: &str) -> Vec<u8> { envelope("event_msg", json!({"type": kind, "turn_id": TURN_RAW})) }
fn child_hook(kind: &str, with_turn: bool) -> Vec<u8> {
    let mut body = json!({"hook_event_name": kind, "session_id": CHILD_RAW});
    if with_turn { body["turn_id"] = json!(TURN_RAW); }
    serde_json::to_vec(&body).unwrap()
}

struct Rig {
    clock: Arc<FakeClock>,
    ctx: AdapterContext,
    core: Collector,
    adapter: CodexAdapter,
    streams: Vec<RolloutStream>,
}
impl Rig {
    fn new() -> Self {
        let clock = Arc::new(FakeClock::new(NOW));
        let ctx = AdapterContext { clock: clock.clone(), identities: IdentityHasher::new([61; 32]) };
        let core = Collector::with_calendar(clock.clone(), 1, Arc::new(FixedCalendar(0)));
        Self { clock, ctx, core, adapter: CodexAdapter::new(), streams: vec![RolloutStream::default(), RolloutStream::default()] }
    }
    /// Decode one rollout line of file `file` (0 = parent, 1 = child) and ingest every emitted event.
    fn log(&mut self, file: usize, line: &[u8]) -> Vec<collector::contracts::AgentEvent> {
        let events = self.adapter.decode_record(&mut self.streams[file], line, &self.ctx).unwrap();
        for event in events.clone() { self.core.ingest(event).expect("collector accepts a decoded log event"); }
        events
    }
    fn hook(&mut self, body: &[u8]) -> Vec<collector::contracts::AgentEvent> {
        let events = self.adapter.map_hook(body, &self.ctx).unwrap();
        for event in events.clone() { self.core.ingest(event).expect("collector accepts a hook event"); }
        events
    }
    fn wait(&self, ms: u64) { self.clock.advance(ms); }
}

/// The same child events in two orders. `gap` is the clock step between events.
fn run(order: Order, gap: u64) -> Outcome {
    let mut rig = Rig::new();
    rig.log(0, &parent_meta());
    rig.wait(SLOW_MS);
    match order {
        Order::HookFirst => {
            rig.hook(&child_hook("SessionStart", false)); rig.wait(gap);
            rig.hook(&child_hook("UserPromptSubmit", true)); rig.wait(gap);
            rig.log(1, &child_meta()); rig.wait(gap);
            rig.log(1, &child_log("task_started"));
        },
        Order::LogFirst => {
            rig.log(1, &child_meta()); rig.wait(gap);
            rig.hook(&child_hook("SessionStart", false)); rig.wait(gap);
            rig.hook(&child_hook("UserPromptSubmit", true)); rig.wait(gap);
            rig.log(1, &child_log("task_started"));
        },
    }
    rig.wait(SLOW_MS);
    // The metadata is known now: the hook and the rollout must scope the raw turn id the same way.
    let stop = rig.hook(&child_hook("Stop", true));
    rig.wait(SLOW_MS);
    let complete = rig.log(1, &child_log("task_complete"));
    rig.wait(SLOW_MS);

    let parent_id = rig.ctx.instance(Tool::Codex, PARENT_RAW);
    let child_id = rig.ctx.instance(Tool::Codex, CHILD_RAW);
    let snapshot = rig.core.snapshot();
    let find = |id: &str| snapshot.agents.iter().find(|a| a.id == id).cloned().unwrap_or_else(|| panic!("agent {id} missing from snapshot"));
    let counts = rig.core.ledger().days.values().next().expect("a day was counted")
        .get(&Tool::Codex).expect("codex counted").clone();
    Outcome {
        child: find(&child_id), parent_agent: find(&parent_id), parent_id: parent_id.clone(), counts,
        hook_turn: stop.first().and_then(|e| e.turn_id.clone()),
        log_turn: complete.first().and_then(|e| e.turn_id.clone()),
        expected_turn: rig.ctx.instance(Tool::Codex, &format!("turn:{parent_id}:{TURN_RAW}")),
    }
}

fn check(order: Order, gap: u64) {
    let o = run(order, gap);
    let label = format!("{order:?} gap={gap}ms");
    // 1. The child is a subagent of the parent, in the parent's session scope.
    assert!(o.parent_agent.parent.is_none(), "{label}: the parent stays a main session");
    assert_eq!(o.child.parent.as_deref(), Some(o.parent_id.as_str()), "{label}: child parent in snapshot");
    assert_eq!(o.child.session_id.as_deref(), Some(o.parent_id.as_str()), "{label}: child session scope is the parent's");
    // 2. Ledger: one subagent turn, no main turn, and only the parent counted as a main session.
    assert_eq!(o.counts.subagent_turns, 1, "{label}: subagent_turns ({:?})", o.counts);
    assert_eq!(o.counts.turns, 0, "{label}: turns must not include the child ({:?})", o.counts);
    assert_eq!(o.counts.sessions, 1, "{label}: only the parent is a main session ({:?})", o.counts);
    // 3. After the metadata is known, hook and rollout turn ids for the same raw turn agree (parent scope).
    assert!(o.hook_turn.is_some(), "{label}: Stop hook carries a turn id");
    assert_eq!(o.hook_turn, o.log_turn, "{label}: hook and rollout turn ids agree");
    assert_eq!(o.hook_turn.as_deref(), Some(o.expected_turn.as_str()), "{label}: turn id is parent scoped");
}

#[test] fn log_first_slow_child_is_a_subagent() { check(Order::LogFirst, SLOW_MS); }
#[test] fn log_first_fast_child_is_a_subagent() { check(Order::LogFirst, FAST_MS); }
#[test] fn hook_first_slow_child_is_reconciled_to_a_subagent() { check(Order::HookFirst, SLOW_MS); }
// Here the metadata arrives while the child's hook evidence is fresh (rank 4 hook vs rank 2 log, 5 s window);
// the reconciliation must not be dropped by that rank rule.
#[test] fn hook_first_fast_child_is_reconciled_to_a_subagent() { check(Order::HookFirst, FAST_MS); }

// Both orderings must leave the same codex day counts. working_seconds is compared only in the fast
// variant: with a slow gap the child legitimately ran as a main session for a few seconds before its
// metadata arrived, and the ledger cannot take those seconds back.
#[test]
fn both_orderings_leave_identical_codex_day_counts() {
    for gap in [FAST_MS, SLOW_MS] {
        let (mut hook_first, mut log_first) = (run(Order::HookFirst, gap).counts, run(Order::LogFirst, gap).counts);
        if gap == SLOW_MS { hook_first.working_seconds = 0; log_first.working_seconds = 0; }
        assert_eq!(hook_first, log_first, "codex day counts differ between orderings (gap {gap}ms)");
    }
}

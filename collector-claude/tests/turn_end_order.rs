//! A finished turn counts exactly once whichever of its two copies (the transcript line and the Stop hook)
//! arrives first, including when the collector refuses the transcript copy because a hook spoke moments ago.
mod common;
use common::*;

use std::io::Write;
use std::sync::Arc;

use busyholm_contracts::moment::MomentKind;
use busyholm_contracts::snapshot::AgentState;
use collector::{Adapter, AdapterContext, Collector, CollectorOutput, FakeClock, IdentityHasher};
use collector_claude::{ClaudeAdapter, ClaudeConfig};
use collector_claude::fsx::Fsx;
use serde_json::json;

fn turn_ends(out: Vec<CollectorOutput>) -> usize {
    out.into_iter().filter(|o| matches!(o, CollectorOutput::Moment(m) if m.kind == MomentKind::TurnEnd)).count()
}

#[test]
fn a_turn_counts_once_in_either_order_and_after_any_gap() {
    for (transcript_first, gap_ms) in [(true, 1_000), (true, 6_000), (false, 1_000)] {
        let scratch = Scratch::new("turn-end-order");
        let transcript = scratch.join("projects/synthetic/synthetic-session.jsonl");
        std::fs::write(&transcript, b"").unwrap();
        let clock = Arc::new(FakeClock::new(NOW));
        let ctx = AdapterContext { clock: clock.clone(), identities: IdentityHasher::new([7; 32]) };
        let mut adapter = ClaudeAdapter::new(ClaudeConfig { root: scratch.path().into() }, Fsx::real());
        let mut collector = Collector::new(clock.clone(), 17);
        assert!(adapter.poll(&ctx).unwrap().is_empty());
        let mut ends = 0;
        let hook = |adapter: &mut ClaudeAdapter, collector: &mut Collector, body: serde_json::Value| {
            let mut n = 0;
            for event in adapter.map_hook(body.to_string().as_bytes(), &ctx).unwrap() { n += turn_ends(collector.ingest(event).unwrap()); }
            n
        };
        let log = |adapter: &mut ClaudeAdapter, collector: &mut Collector| {
            let mut f = std::fs::OpenOptions::new().append(true).open(&transcript).unwrap();
            writeln!(f, "{}", json!({"type":"user","sessionId":"synthetic-session","promptId":"turn-a","origin":{"kind":"human"},"message":{"role":"user","content":"x"}})).unwrap();
            writeln!(f, "{}", json!({"type":"assistant","sessionId":"synthetic-session","message":{"id":"m","role":"assistant","content":[{"type":"text","text":"x"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}})).unwrap();
            let mut n = 0;
            for event in adapter.poll(&ctx).unwrap() { n += turn_ends(collector.ingest(event).unwrap()); }
            n
        };
        let stop = json!({"hook_event_name":"Stop","session_id":"synthetic-session","prompt_id":"turn-a"});
        ends += hook(&mut adapter, &mut collector, json!({"hook_event_name":"UserPromptSubmit","session_id":"synthetic-session","prompt_id":"turn-a"}));
        clock.advance(gap_ms);
        if transcript_first {
            ends += log(&mut adapter, &mut collector);
            clock.advance(80);
            ends += hook(&mut adapter, &mut collector, stop);
        } else {
            ends += hook(&mut adapter, &mut collector, stop);
            clock.advance(80);
            ends += log(&mut adapter, &mut collector);
        }
        let label = format!("transcript_first={transcript_first} gap={gap_ms}");
        assert_eq!(ends, 1, "{label}: one finished turn");
        assert_eq!(collector.snapshot().agents[0].state, AgentState::YourTurn, "{label}");
    }
}

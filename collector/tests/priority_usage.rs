use std::sync::Arc;
use collector::{Collector, FakeClock, UsageStore, contracts::{AgentEvent, agent_event::EventUsage}};
use serde_json::json;
const BASE:u64=1791806400000;
fn event(kind:&str,source:&str,t:u64)->AgentEvent {
    serde_json::from_value(json!({"v":1,"agent":"claude","instance":"00000000000000000000000000000001","parent":null,"host":"cli",
        "root_id":"00000000000000000000000000000003","account_id":null,"session_id":null,"turn_id":null,"request_id":null,
        "kind":kind,"source":source,"confidence":"exact","t":t})).unwrap()
}
#[test]
fn fresh_priority_fixtures_and_expiry() {
    for (high,low) in [("hook","registry"),("hook","log"),("hook","process"),("registry","log"),("registry","process"),("log","process"),("plugin","registry"),("poll","process")] {
        let clock=Arc::new(FakeClock::new(BASE)); let mut c=Collector::new(clock.clone(),1);
        c.ingest(event("turn_start",high,BASE)).unwrap(); clock.advance(1000);
        c.ingest(event("turn_end",low,clock.now_ms())).unwrap();
        assert_eq!(serde_json::to_value(c.snapshot().agents[0].state).unwrap(),"working","{high} beats {low}");
        clock.advance(5000); c.ingest(event("turn_end",low,clock.now_ms())).unwrap();
        assert_eq!(serde_json::to_value(c.snapshot().agents[0].state).unwrap(),"your_turn","{high} expires");
    }
}
use collector::Clock;
#[test]
fn usage_keeps_newest_good_value_and_marks_age_without_guessing() {
    let mut store=UsageStore::default();
    let sample:EventUsage=serde_json::from_value(json!({"provider":"codex","window":"5h","used_pct":43.0,"resets_at":BASE+18000000,"observed_at":BASE})).unwrap();
    assert!(store.insert(sample.clone(),BASE));
    let mut old=sample.clone(); old.observed_at-=1; old.used_pct=1.0; assert!(!store.insert(old,BASE));
    let mut bad=sample.clone(); bad.used_pct=f64::NAN; assert!(!store.insert(bad,BASE));
    let mut bad=sample.clone(); bad.used_pct=101.0; assert!(!store.insert(bad,BASE));
    let mut future=sample; future.observed_at+=1; assert!(!store.insert(future,BASE));
    assert_eq!(store.snapshot(BASE)[0].used_pct,43.0);
    assert!(!store.snapshot(BASE+1799999)[0].stale);
    assert!(store.snapshot(BASE+1800000)[0].stale);
    assert_eq!(store.snapshot(BASE+1800000).len(),1);
}
#[test]
fn snapshots_coalesce_and_moments_are_immediate() {
    let clock=Arc::new(FakeClock::new(BASE)); let mut c=Collector::new(clock.clone(),1);
    let first=c.ingest(event("turn_start","hook",BASE)).unwrap();
    assert!(first.iter().any(|o|matches!(o,collector::CollectorOutput::Snapshot(_))));
    clock.advance(1); let output=c.ingest(event("needs_permission","hook",clock.now_ms())).unwrap();
    assert!(output.iter().any(|o|matches!(o,collector::CollectorOutput::Moment(_))));
    assert!(!output.iter().any(|o|matches!(o,collector::CollectorOutput::Snapshot(_))));
    clock.set(BASE+249); assert!(c.tick().is_empty()); clock.advance(1);
    assert!(c.tick().iter().any(|o|matches!(o,collector::CollectorOutput::Snapshot(_))));
}

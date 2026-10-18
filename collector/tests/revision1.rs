use std::sync::Arc;
use collector::{Clock,Collector,CollectorInput,CollectorOutput,EventBus,FakeClock,IdentityHasher,UsageStore,
    contracts::{AgentEvent,Validate,common::Tool,agent_event::EventUsage},ledger::FixedCalendar};
use serde_json::json;
const BASE:u64=1791806400000;
fn event(kind:&str,id:u8,at:u64)->AgentEvent {
    serde_json::from_value(json!({"v":1,"agent":"claude","instance":format!("{id:032x}"),"parent":null,
        "root_id":format!("{:032x}",3),"account_id":null,"session_id":null,"turn_id":null,"request_id":null,
        "host":"cli","kind":kind,"source":"hook","confidence":"exact","t":at})).unwrap()
}
fn state(c:&Collector)->String {serde_json::to_value(c.snapshot().agents[0].state).unwrap().as_str().unwrap().into()}
#[test]
fn queue_prioritizes_other_instance_permissions_and_preserves_same_timestamp_order() {
    let bus=EventBus::bounded(8);
    bus.sender().send(event("heartbeat",1,BASE)).unwrap();
    bus.sender().send(event("needs_permission",2,BASE)).unwrap();
    assert!(matches!(bus.receiver.try_recv().unwrap(),CollectorInput::Event(e) if e.instance.ends_with("02")));
    bus.receiver.try_recv().unwrap();
    bus.sender().send(event("turn_start",1,BASE)).unwrap();
    bus.sender().send(event("needs_permission",1,BASE)).unwrap();
    bus.sender().send(event("turn_end",1,BASE)).unwrap();
    let kinds:Vec<_>=(0..3).map(|_|match bus.receiver.try_recv().unwrap(){CollectorInput::Event(e)=>serde_json::to_value(e.kind).unwrap(),_=>panic!("event expected")}).collect();
    assert_eq!(json!(kinds),json!(["turn_start","needs_permission","turn_end"]));
}
#[test]
fn wall_clock_changes_do_not_trigger_timeouts() {
    let clock=Arc::new(FakeClock::new(BASE));let mut c=Collector::new(clock.clone(),1);
    c.ingest(event("turn_start",1,BASE)).unwrap();
    clock.set_wall(BASE+3600000);c.tick();assert_eq!(state(&c),"working");
    clock.set_wall(BASE-3600000);c.tick();assert_eq!(state(&c),"working");
    clock.advance(90000);c.tick();assert_eq!(state(&c),"your_turn");
    assert!(c.snapshot().agents[0].since>=c.snapshot().agents[0].started_at);
}
#[test]
fn concurrent_sessions_accrue_union_wall_time_and_split_local_midnight() {
    let base=chrono::DateTime::parse_from_rfc3339("2026-10-12T05:59:59+00:00").unwrap().timestamp_millis() as u64;
    let clock=Arc::new(FakeClock::new(base));let mut c=Collector::with_calendar(clock.clone(),1,Arc::new(FixedCalendar(-21600)));
    c.ingest(event("turn_start",1,base)).unwrap();c.ingest(event("turn_start",2,base)).unwrap();
    clock.advance(4000);c.tick();
    assert_eq!(c.ledger().days["2026-10-11"][&Tool::Claude].working_seconds,1);
    assert_eq!(c.ledger().days["2026-10-12"][&Tool::Claude].working_seconds,3);
    c.ledger().validate().unwrap();
}
#[test]
fn answered_request_cannot_raise_late_notification_or_another_reward() {
    let clock=Arc::new(FakeClock::new(BASE));let mut c=Collector::new(clock.clone(),1);
    c.ingest(event("turn_start",1,BASE)).unwrap();
    let mut waiting=event("needs_permission",1,BASE);waiting.request_id=Some(format!("{:032x}",9));c.ingest(waiting.clone()).unwrap();
    clock.advance(1000);let mut answer=event("answered",1,clock.now_ms());answer.request_id=waiting.request_id.clone();c.ingest(answer).unwrap();
    clock.advance(10000);waiting.t=clock.now_ms();let outputs=c.ingest(waiting).unwrap();
    assert_eq!(state(&c),"working");assert_eq!(c.quick_answers(),1);
    assert!(!outputs.iter().any(|o|matches!(o,CollectorOutput::Moment(_))));
}
#[test]
fn hook_and_log_turn_copies_are_deduplicated_after_priority_expires() {
    let clock=Arc::new(FakeClock::new(BASE));let mut c=Collector::new(clock.clone(),1);
    let mut start=event("turn_start",1,BASE);start.turn_id=Some(format!("{:032x}",7));c.ingest(start.clone()).unwrap();
    let mut end=event("turn_end",1,BASE);end.turn_id=start.turn_id.clone();c.ingest(end.clone()).unwrap();
    clock.advance(10000);start.t=clock.now_ms();start.source=collector::contracts::agent_event::EventSource::Log;c.ingest(start).unwrap();
    end.t=clock.now_ms();end.source=collector::contracts::agent_event::EventSource::Log;c.ingest(end).unwrap();
    assert_eq!(state(&c),"your_turn");let count:u32=c.ledger().days.values().map(|d|d.get(&Tool::Claude).map_or(0,|c|c.turns)).sum();assert_eq!(count,1);
}
#[test]
fn pending_alert_restores_uncertainty_without_earning_history() {
    let clock=Arc::new(FakeClock::new(BASE));let mut original=Collector::new(clock.clone(),1);
    original.ingest(event("turn_start",1,BASE)).unwrap();original.ingest(event("needs_permission",1,BASE)).unwrap();
    let pending=original.pending_alerts();pending.validate().unwrap();clock.advance(3600000);
    let mut c=Collector::new(clock.clone(),1);c.restore_pending(pending).unwrap();assert_eq!(state(&c),"needs_you");
    assert_eq!(serde_json::to_value(c.snapshot().agents[0].confidence).unwrap(),"inferred");
    assert!(c.ledger().days.is_empty());clock.advance(3600000);c.tick();assert_eq!(state(&c),"needs_you");
    c.ingest(event("answered",1,clock.now_ms())).unwrap();assert_eq!(state(&c),"working");assert_eq!(c.quick_answers(),0);assert!(c.pending_alerts().alerts.is_empty());
}
#[test]
fn newest_usage_stays_separate_for_accounts_and_roots() {
    let mut store=UsageStore::default();
    let a:EventUsage=serde_json::from_value(json!({"provider":"codex","window":"5h","used_pct":10,"resets_at":BASE+18000000,"observed_at":BASE})).unwrap();
    for (account,root) in [(Some(format!("{:032x}",1)),3),(Some(format!("{:032x}",2)),3),(None,3),(None,4)] {
        assert!(store.insert_scoped(a.clone(),account,format!("{root:032x}"),BASE));
    }
    assert_eq!(store.snapshot(BASE).len(),4);
}
#[test]
fn a_good_fresh_usage_signal_clears_limit_but_clock_and_stale_samples_do_not() {
    let clock=Arc::new(FakeClock::new(BASE));let mut c=Collector::new(clock.clone(),1);
    let mut hit=event("limit_hit",1,BASE);hit.limit=Some(serde_json::from_value(json!({"provider":"claude","window":"5h","resets_at":BASE+1000})).unwrap());c.ingest(hit).unwrap();
    clock.advance(70000);c.tick();assert_eq!(state(&c),"limited");
    let mut sample=event("usage_sample",1,clock.now_ms());sample.usage=Some(serde_json::from_value(json!({"provider":"claude","window":"5h","used_pct":12,"resets_at":BASE+18000000,"observed_at":BASE})).unwrap());
    c.ingest(sample.clone()).unwrap();assert_eq!(state(&c),"limited");
    sample.usage.as_mut().unwrap().observed_at=clock.now_ms();let outputs=c.ingest(sample).unwrap();
    assert_eq!(state(&c),"idle");assert!(outputs.iter().any(|o|matches!(o,CollectorOutput::Moment(m) if serde_json::to_value(m.kind).unwrap()=="limit_reset")));
}
#[test]
fn agy_heartbeat_resumes_after_quiet_inference() {
    let clock=Arc::new(FakeClock::new(BASE));let mut c=Collector::new(clock.clone(),1);
    let mut e=event("heartbeat",1,BASE);e.agent=Tool::Antigravity;e.source=collector::contracts::agent_event::EventSource::Log;e.confidence=collector::contracts::common::Confidence::Inferred;c.ingest(e.clone()).unwrap();
    clock.advance(90000);c.tick();assert_eq!(state(&c),"your_turn");clock.advance(3000);e.t=clock.now_ms();c.ingest(e).unwrap();assert_eq!(state(&c),"working");
}
#[test]
fn identity_is_hmac_domain_separated_and_has_no_raw_id() {
    let h=IdentityHasher::new([0x42;32]);let id=h.instance(Tool::Claude,"bca1a700-0000-4000-8000-000000000001");
    assert_eq!(id,"03162af9cc97389ef1463738066dd7d6");
    assert_ne!(id,h.instance(Tool::Codex,"bca1a700-0000-4000-8000-000000000001"));
}

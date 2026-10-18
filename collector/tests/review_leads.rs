//! Leads from an unverified external code review. Each one is checked
//! with a test against the real code before anything is changed; the rejected ones are listed in
//! collector/DECISIONS.md with the reason.
use std::sync::Arc;
use collector::{Clock,Collector,FakeClock,CollectorOutput,contracts::{AgentEvent,Validate,common::Tool,agent_event::EventSource,pending_alerts::PendingAlerts},ledger::{Calendar,FixedCalendar,LocalCalendar}};
use serde_json::json;
const BASE:u64=1791806400000;
fn event(kind:&str,at:u64)->AgentEvent {
    serde_json::from_value(json!({"v":1,"agent":"claude","instance":format!("{:032x}",1),"parent":null,
        "root_id":format!("{:032x}",3),"account_id":null,"session_id":null,"turn_id":null,"request_id":null,
        "host":"cli","kind":kind,"source":"hook","confidence":"exact","t":at})).unwrap()
}
fn with(mut e:AgentEvent,turn:Option<u128>,request:Option<u128>)->AgentEvent {e.turn_id=turn.map(|t|format!("{t:032x}"));e.request_id=request.map(|r|format!("{r:032x}"));e}
fn state(c:&Collector)->String {serde_json::to_value(c.snapshot().agents[0].state).unwrap().as_str().unwrap().into()}
fn turns(c:&Collector)->u32 {c.ledger().days.values().map(|d|d.get(&Tool::Claude).map_or(0,|c|c.turns)).sum()}

// lead 9
#[test]
fn a_long_silent_turn_still_counts_when_its_real_end_arrives_after_the_inferred_one() {
    let clock=Arc::new(FakeClock::new(BASE));let mut c=Collector::new(clock.clone(),1);
    c.ingest(with(event("turn_start",BASE),Some(7),None)).unwrap();
    clock.advance(95000);c.tick();assert_eq!(state(&c),"your_turn");
    let out=c.ingest(with(event("turn_end",clock.now_ms()),Some(7),None)).unwrap();
    assert_eq!(turns(&c),1,"the 95 s turn finished and must be counted");
    assert!(out.iter().any(|o|matches!(o,CollectorOutput::Moment(m) if serde_json::to_value(m.kind).unwrap()=="turn_end")));
    // a duplicate copy of the same end (a log copy after the hook) is not counted again
    let mut dup=with(event("turn_end",clock.now_ms()),Some(7),None);dup.source=EventSource::Log;c.ingest(dup).unwrap();
    assert_eq!(turns(&c),1);
}
// lead 12
#[test]
fn an_interrupted_request_cannot_be_raised_again_by_a_late_copy() {
    let clock=Arc::new(FakeClock::new(BASE));let mut c=Collector::new(clock.clone(),1);
    c.ingest(with(event("turn_start",BASE),Some(1),None)).unwrap();
    let waiting=with(event("needs_permission",BASE),Some(1),Some(9));c.ingest(waiting.clone()).unwrap();assert_eq!(state(&c),"needs_you");
    clock.advance(1000);c.ingest(with(event("turn_interrupted",clock.now_ms()),Some(1),None)).unwrap();assert_eq!(state(&c),"your_turn");
    clock.advance(1000);c.ingest(with(event("turn_start",clock.now_ms()),Some(2),None)).unwrap();assert_eq!(state(&c),"working");
    clock.advance(1000);c.ingest(with(event("needs_permission",clock.now_ms()),Some(2),Some(9))).unwrap();
    assert_eq!(state(&c),"working","a late duplicate of the interrupted request must not ring the bell again");
}
// lead 13
#[test]
fn a_fresh_good_usage_sample_clears_a_limit_that_had_no_reset_time() {
    let clock=Arc::new(FakeClock::new(BASE));let mut c=Collector::new(clock.clone(),1);
    let mut hit=event("limit_hit",BASE);hit.limit=Some(serde_json::from_value(json!({"provider":"claude","window":"5h","resets_at":null})).unwrap());
    c.ingest(hit).unwrap();assert_eq!(state(&c),"limited");
    clock.advance(70000);
    let mut s=event("usage_sample",clock.now_ms());
    s.usage=Some(serde_json::from_value(json!({"provider":"claude","window":"5h","used_pct":20,"resets_at":clock.now_ms()+18000000,"observed_at":clock.now_ms()})).unwrap());
    c.ingest(s).unwrap();
    assert_eq!(state(&c),"idle","limited clears on a fresh good signal even when the limit carried no reset time");
}
// lead 15
#[test]
fn a_usage_sample_without_usage_is_an_error_not_a_panic() {
    let clock=Arc::new(FakeClock::new(BASE));let mut c=Collector::new(clock,1);
    let bare=event("usage_sample",BASE);
    assert!(c.ingest(bare.clone()).is_err());
    assert!(c.rebuild(vec![bare]).is_err());
}
// lead 16
#[test]
fn huge_timestamps_cannot_panic_the_calendar() {
    for ms in [u64::MAX,u64::MAX-1000,9_007_199_254_740_991,8_640_000_000_000_001] {
        let _=FixedCalendar(-21600).day(ms);let _=FixedCalendar(0).next_day(ms);let _=LocalCalendar.day(ms);let _=LocalCalendar.next_day(ms);
    }
}
// lead 8
#[test]
fn a_clock_set_back_across_a_restart_still_restores_the_pending_alert() {
    let clock=Arc::new(FakeClock::new(BASE));let mut original=Collector::new(clock.clone(),1);
    original.ingest(event("turn_start",BASE)).unwrap();original.ingest(event("needs_permission",BASE)).unwrap();
    let pending:PendingAlerts=original.pending_alerts();pending.validate().unwrap();
    let back=Arc::new(FakeClock::new(BASE-5000)); // NTP stepped the wall clock back
    let mut restarted=Collector::new(back,1);
    restarted.restore_pending(pending).expect("a backward clock step must not lose the alert");
    assert_eq!(state(&restarted),"needs_you");
}
// lead 10, pinned as a rejected lead: a late LOG copy of an earlier event must not clear a live hook alert
#[test]
fn a_late_log_copy_of_an_earlier_event_does_not_clear_a_fresh_hook_alert() {
    let clock=Arc::new(FakeClock::new(BASE));let mut c=Collector::new(clock.clone(),1);
    c.ingest(with(event("turn_start",BASE),Some(1),None)).unwrap();
    c.ingest(with(event("needs_permission",BASE),Some(1),Some(4))).unwrap();
    clock.advance(1000);
    let mut copy=with(event("turn_start",clock.now_ms()),Some(1),None);copy.source=EventSource::Log;
    c.ingest(copy).unwrap();
    assert_eq!(state(&c),"needs_you");
}

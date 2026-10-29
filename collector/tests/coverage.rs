//! INT-1: coverage states (SPEC Revision 1 item 2). `verified` only after a real hook event arrived; a connector
//! with only log or registry activity is `degraded`; a tool without an adapter is `unsupported`. Verified survives a
//! restart and decays when the hooks are disconnected or stop arriving while log activity continues.
use std::sync::Arc;
use collector::{Collector,CoverageFile,FakeClock,Clock,
    contracts::{AgentEvent,Validate,common::Tool,snapshot::{Coverage,CoverageReason,HooksStatus,Presence,ToolStatus}}};
use serde_json::json;

const BASE:u64=1791806400000;
fn root(n:u32)->String {format!("{n:032x}")}
fn event(tool:&str,kind:&str,source:&str,id:u8,rootn:u32,at:u64)->AgentEvent {
    serde_json::from_value(json!({"v":1,"agent":tool,"instance":format!("{id:032x}"),"parent":null,
        "root_id":root(rootn),"account_id":null,"session_id":null,"turn_id":null,"request_id":null,
        "host":"cli","kind":kind,"source":source,"confidence":"exact","t":at})).unwrap()
}
fn setup()->(Arc<FakeClock>,Collector) {
    let clock=Arc::new(FakeClock::new(BASE));
    let c=Collector::new(clock.clone(),1);(clock,c)
}
fn tool(c:&Collector,t:Tool,rootn:u32)->ToolStatus {
    let snap=c.snapshot();snap.validate().expect("every snapshot validates");
    snap.tools.into_iter().find(|s|s.tool==t&&s.root_id==root(rootn)).expect("the connector is in the snapshot")
}
fn log_turn(c:&mut Collector,clock:&FakeClock,id:u8) {
    let now=clock.now_ms();c.ingest(event("claude","turn_start","log",id,3,now)).unwrap();
}
/// One log turn that no hook ever matches: the grace period passes with no hook event.
fn missed_turn(c:&mut Collector,clock:&FakeClock,id:u8) {
    log_turn(c,clock,id);clock.advance(31_000);c.tick();
}

#[test]
fn a_real_hook_event_verifies_the_connector_and_a_log_event_does_not() {
    let (clock,mut c)=setup();
    c.ingest(event("claude","turn_start","log",1,3,BASE)).unwrap();
    let t=tool(&c,Tool::Claude,3);
    assert_eq!((t.coverage,t.coverage_reason),(Coverage::Degraded,Some(CoverageReason::HooksMissing)),"log activity alone is degraded");
    c.ingest(event("claude","turn_start","registry",1,3,BASE)).unwrap();
    assert_eq!(tool(&c,Tool::Claude,3).coverage,Coverage::Degraded,"registry activity alone is degraded");
    clock.advance(1000);
    c.ingest(event("claude","heartbeat","hook",1,3,clock.now_ms())).unwrap();
    let t=tool(&c,Tool::Claude,3);
    assert_eq!((t.coverage,t.coverage_reason,t.hooks),(Coverage::Verified,None,HooksStatus::Installed));
    assert!(c.ledger().hooks_first_connected_day.is_some(),"the first verified connector is a ledger milestone");
}

#[test]
fn verification_is_per_connector_and_a_usage_sample_does_not_verify() {
    let (clock,mut c)=setup();
    c.ingest(event("claude","turn_start","log",1,3,BASE)).unwrap();
    c.ingest(event("claude","turn_start","log",2,4,BASE)).unwrap();
    c.ingest(event("codex","turn_start","log",3,5,BASE)).unwrap();
    // The statusline wrap posts usage through the shim; that proves the wrap, not the alert hooks.
    let mut usage=event("claude","usage_sample","hook",1,3,BASE);
    usage.usage=Some(serde_json::from_value(json!({"provider":"claude","window":"5h","used_pct":10.0,"resets_at":BASE+3_600_000,"observed_at":BASE})).unwrap());
    c.ingest(usage).unwrap();
    assert_eq!(tool(&c,Tool::Claude,3).coverage,Coverage::Degraded);
    clock.advance(10);
    c.ingest(event("claude","turn_start","hook",1,3,clock.now_ms())).unwrap();
    assert_eq!(tool(&c,Tool::Claude,3).coverage,Coverage::Verified);
    assert_eq!(tool(&c,Tool::Claude,4).coverage,Coverage::Degraded,"another folder of the same tool stays unverified");
    assert_eq!(tool(&c,Tool::Codex,5).coverage,Coverage::Degraded,"another tool stays unverified");
}

#[test]
fn a_restored_pending_alert_is_not_a_hook_event() {
    let (clock,mut c)=setup();
    c.ingest(event("claude","turn_start","log",1,3,BASE)).unwrap();
    c.ingest(event("claude","needs_permission","hook",1,3,BASE)).unwrap();
    let pending=c.pending_alerts();
    let mut fresh=Collector::new(clock.clone(),1);
    fresh.restore_pending(pending).unwrap();
    let t=tool(&fresh,Tool::Claude,3);
    assert_eq!(t.coverage,Coverage::Degraded,"the synthetic restored event proves nothing");
}

#[test]
fn a_tool_without_an_adapter_is_unsupported() {
    let (_clock,mut c)=setup();
    c.set_adapters([Tool::Claude]);
    c.ingest(event("claude","turn_start","log",1,3,BASE)).unwrap();
    c.ingest(event("codex","turn_start","log",2,5,BASE)).unwrap();
    c.ingest(event("opencode","turn_start","log",3,6,BASE)).unwrap();
    assert_eq!(tool(&c,Tool::Claude,3).coverage,Coverage::Degraded);
    for (t,r) in [(Tool::Codex,5),(Tool::Opencode,6)] {
        let s=tool(&c,t,r);
        assert_eq!((s.coverage,s.hooks),(Coverage::Unsupported,HooksStatus::Unsupported),"{t:?}");
        assert!(s.coverage_reason.is_some());
    }
    // Registering an adapter later (a symlinked folder fixed) lifts it.
    c.set_adapters([Tool::Claude,Tool::Codex]);
    assert_eq!(tool(&c,Tool::Codex,5).coverage,Coverage::Degraded);
}

#[test]
fn what_the_installer_reported_before_the_first_event_is_remembered() {
    let (_clock,mut c)=setup();
    c.set_hooks(Tool::Claude,HooksStatus::Installed);
    c.set_hooks(Tool::Codex,HooksStatus::PendingReview);
    c.ingest(event("claude","turn_start","log",1,3,BASE)).unwrap();
    c.ingest(event("codex","turn_start","log",2,5,BASE)).unwrap();
    let s=tool(&c,Tool::Claude,3);
    assert_eq!((s.coverage,s.hooks,s.coverage_reason),(Coverage::Degraded,HooksStatus::Installed,Some(CoverageReason::RoundTripPending)));
    let s=tool(&c,Tool::Codex,5);
    assert_eq!((s.hooks,s.coverage_reason),(HooksStatus::PendingReview,Some(CoverageReason::HooksPendingReview)));
}

#[test]
fn disconnecting_the_hooks_ends_verified_and_a_stale_session_cannot_bring_it_back() {
    let (clock,mut c)=setup();
    c.ingest(event("claude","turn_start","hook",1,3,BASE)).unwrap();
    assert_eq!(tool(&c,Tool::Claude,3).coverage,Coverage::Verified);
    c.set_hooks(Tool::Claude,HooksStatus::Installed);
    assert_eq!(tool(&c,Tool::Claude,3).coverage,Coverage::Verified,"a repeated Installed report (app start) keeps it");
    c.set_hooks(Tool::Claude,HooksStatus::PendingReview);
    assert_eq!(tool(&c,Tool::Claude,3).coverage,Coverage::Verified,"observed delivery beats a config guess");
    c.set_hooks(Tool::Claude,HooksStatus::Missing);
    let s=tool(&c,Tool::Claude,3);
    assert_eq!((s.coverage,s.coverage_reason,s.hooks),(Coverage::Degraded,Some(CoverageReason::HooksMissing),HooksStatus::Missing));
    assert!(c.coverage_record().entries.is_empty(),"the persisted record drops it too");
    // A session started before the disconnect still has its hooks loaded; its events prove nothing now.
    clock.advance(1000);
    c.ingest(event("claude","heartbeat","hook",1,3,clock.now_ms())).unwrap();
    assert_eq!(tool(&c,Tool::Claude,3).coverage,Coverage::Degraded);
    // Connecting again starts a fresh round trip.
    c.set_hooks(Tool::Claude,HooksStatus::Installed);
    assert_eq!(tool(&c,Tool::Claude,3).coverage_reason,Some(CoverageReason::RoundTripPending));
    clock.advance(1000);
    c.ingest(event("claude","heartbeat","hook",1,3,clock.now_ms())).unwrap();
    assert_eq!(tool(&c,Tool::Claude,3).coverage,Coverage::Verified);
}

#[test]
fn verified_decays_when_log_turns_keep_coming_without_hook_events_and_a_hook_brings_it_back() {
    let (clock,mut c)=setup();
    c.ingest(event("claude","turn_start","hook",1,3,BASE)).unwrap();
    assert_eq!(tool(&c,Tool::Claude,3).coverage,Coverage::Verified);
    clock.advance(60_000);c.tick();
    // Two log turns with no hook are not enough.
    missed_turn(&mut c,&clock,1);missed_turn(&mut c,&clock,1);
    assert_eq!(tool(&c,Tool::Claude,3).coverage,Coverage::Verified,"two misses");
    missed_turn(&mut c,&clock,1);
    let s=tool(&c,Tool::Claude,3);
    assert_eq!((s.coverage,s.coverage_reason),(Coverage::Degraded,Some(CoverageReason::RoundTripFailed)),"third miss");
    assert!(c.coverage_record().entries.is_empty());
    clock.advance(1000);
    c.ingest(event("claude","turn_start","hook",1,3,clock.now_ms())).unwrap();
    assert_eq!(tool(&c,Tool::Claude,3).coverage,Coverage::Verified,"the next hook event verifies again");
}

#[test]
fn a_log_turn_that_a_hook_matches_is_not_a_miss_and_idle_time_never_decays() {
    let (clock,mut c)=setup();
    c.ingest(event("claude","turn_start","hook",1,3,BASE)).unwrap();
    for _ in 0..5 {
        // The hook arrives with the turn (before or after the log copy), so nothing is missed.
        clock.advance(120_000);
        let now=clock.now_ms();
        c.ingest(event("claude","turn_start","hook",1,3,now)).unwrap();
        log_turn(&mut c,&clock,1);
    }
    clock.advance(31_000);c.tick();
    assert_eq!(tool(&c,Tool::Claude,3).coverage,Coverage::Verified);
    // A log turn followed by a late hook inside the grace period is matched too.
    for _ in 0..4 {
        clock.advance(600_000);log_turn(&mut c,&clock,1);
        clock.advance(5_000);let now=clock.now_ms();
        c.ingest(event("claude","turn_start","hook",1,3,now)).unwrap();
    }
    clock.advance(31_000);c.tick();
    assert_eq!(tool(&c,Tool::Claude,3).coverage,Coverage::Verified);
    // A week with no activity at all is not evidence against the hooks.
    clock.advance(7*86_400_000);c.tick();
    assert_eq!(tool(&c,Tool::Claude,3).coverage,Coverage::Verified);
}

#[test]
fn an_installed_connector_that_never_gets_a_hook_while_logs_continue_reports_a_failed_round_trip() {
    let (clock,mut c)=setup();
    c.set_hooks(Tool::Claude,HooksStatus::Installed);
    for _ in 0..3 {missed_turn(&mut c,&clock,1);}
    let s=tool(&c,Tool::Claude,3);
    assert_eq!((s.coverage,s.coverage_reason),(Coverage::Degraded,Some(CoverageReason::RoundTripFailed)));
    // Without an install report the honest reason stays "hooks missing".
    let (clock,mut c)=setup();
    for _ in 0..3 {missed_turn(&mut c,&clock,1);}
    assert_eq!(tool(&c,Tool::Claude,3).coverage_reason,Some(CoverageReason::HooksMissing));
}

#[test]
fn the_wake_up_time_covers_the_grace_period_so_a_decay_is_not_left_to_the_next_event() {
    let (clock,mut c)=setup();
    c.ingest(event("claude","turn_start","hook",1,3,BASE)).unwrap();
    clock.advance(60_000);c.tick();
    log_turn(&mut c,&clock,1);
    clock.advance(20_000);c.tick();
    assert!(c.next_wake_ms()<=10_001,"the service must wake when the grace period ends, not 30 s later");
}

#[test]
fn the_record_restores_verified_with_the_connector_offline_and_ignores_another_os_or_a_bad_file() {
    let (clock,mut c)=setup();
    c.ingest(event("claude","turn_start","hook",1,3,BASE)).unwrap();
    c.ingest(event("codex","turn_start","log",2,5,BASE)).unwrap();
    let record=c.coverage_record();
    assert_eq!(record.entries.len(),1,"only the verified connector is recorded");
    assert_eq!((record.entries[0].tool,record.entries[0].root_id.as_str(),record.entries[0].verified_at),(Tool::Claude,root(3).as_str(),BASE));
    assert_eq!(record.os,std::env::consts::OS);
    // Through JSON, as the service stores it.
    let record:CoverageFile=serde_json::from_str(&serde_json::to_string(&record).unwrap()).unwrap();

    let mut restarted=Collector::new(clock.clone(),1);
    restarted.restore_coverage(record.clone()).unwrap();
    let s=tool(&restarted,Tool::Claude,3);
    assert_eq!((s.coverage,s.coverage_reason,s.presence),(Coverage::Verified,None,Presence::Offline));
    // The session that comes back keeps the verified connector.
    restarted.ingest(event("claude","turn_start","log",1,3,clock.now_ms())).unwrap();
    let s=tool(&restarted,Tool::Claude,3);
    assert_eq!((s.coverage,s.presence),(Coverage::Verified,Presence::Present));
    assert_eq!(restarted.coverage_record(),record);
    // The installer later says the hooks are gone: it ends.
    restarted.set_hooks(Tool::Claude,HooksStatus::Missing);
    assert_eq!(tool(&restarted,Tool::Claude,3).coverage,Coverage::Degraded);

    let mut other_os=record.clone();other_os.os="plan9".into();
    let mut c2=Collector::new(clock.clone(),1);
    c2.restore_coverage(other_os).unwrap();
    assert!(c2.snapshot().tools.is_empty(),"another OS proves nothing here");

    let mut bad_id=record.clone();bad_id.entries[0].root_id="not-an-id".into();
    assert!(Collector::new(clock.clone(),1).restore_coverage(bad_id).is_err());
    let mut bad_version=record.clone();bad_version.schema_version=2;
    assert!(Collector::new(clock.clone(),1).restore_coverage(bad_version).is_err());
    let mut too_many=record.clone();
    too_many.entries=(0..17).map(|n|collector::CoverageEntry{tool:Tool::Claude,root_id:root(n),verified_at:BASE}).collect();
    assert!(Collector::new(clock.clone(),1).restore_coverage(too_many).is_err());
    // A restored connector for a tool that has no adapter now is unsupported, not verified.
    let mut c3=Collector::new(clock.clone(),1);
    c3.set_adapters([Tool::Codex]);
    c3.restore_coverage(record).unwrap();
    assert_eq!(tool(&c3,Tool::Claude,3).coverage,Coverage::Unsupported);
}

#[test]
fn disconnecting_the_hooks_ends_their_alert_and_a_stale_session_cannot_raise_a_new_one() {
    use collector::{CollectorOutput,contracts::{moment::MomentKind,snapshot::AgentState}};
    let state=|c:&Collector|c.snapshot().agents[0].state;
    let alerts=|out:Vec<CollectorOutput>|out.iter().filter(|o|matches!(o,CollectorOutput::Moment(m) if m.kind==MomentKind::NeedsYou)).count();
    let (clock,mut c)=setup();
    c.set_hooks(Tool::Claude,HooksStatus::Installed);
    c.ingest(event("claude","turn_start","hook",1,3,BASE)).unwrap();
    clock.advance(1000);
    assert_eq!(alerts(c.ingest(event("claude","needs_permission","hook",1,3,clock.now_ms())).unwrap()),1);
    assert_eq!(state(&c),AgentState::NeedsYou);
    // The disconnect dialog promises the bell and flag stop: the open alert ends with the hooks.
    c.set_hooks(Tool::Claude,HooksStatus::Missing);
    assert_ne!(state(&c),AgentState::NeedsYou);
    // A session started before the disconnect still has its hooks loaded; it cannot raise a new alert.
    clock.advance(1000);
    assert_eq!(alerts(c.ingest(event("claude","needs_answer","hook",1,3,clock.now_ms())).unwrap()),0);
    assert_ne!(state(&c),AgentState::NeedsYou);
    // Connected again, alerts work again.
    c.set_hooks(Tool::Claude,HooksStatus::Installed);
    clock.advance(1000);
    assert_eq!(alerts(c.ingest(event("claude","needs_answer","hook",1,3,clock.now_ms())).unwrap()),1);
}

#[test]
fn an_agent_still_blocked_after_the_disconnect_earns_no_working_time_until_it_moves_again() {
    use collector::contracts::snapshot::AgentState;
    let state=|c:&Collector|c.snapshot().agents[0].state;
    let worked=|c:&Collector|c.ledger().days.values().filter_map(|d|d.get(&Tool::Claude)).map(|t|t.working_seconds).sum::<u32>();
    let (clock,mut c)=setup();
    c.set_hooks(Tool::Claude,HooksStatus::Installed);
    c.ingest(event("claude","turn_start","hook",1,3,BASE)).unwrap();
    clock.advance(1000);
    c.ingest(event("claude","needs_permission","hook",1,3,clock.now_ms())).unwrap();
    let before=worked(&c);
    c.set_hooks(Tool::Claude,HooksStatus::Missing);
    assert_ne!(state(&c),AgentState::Working,"no evidence it resumed");
    // Still waiting on the user: a minute passes with no activity.
    clock.advance(60_000);c.tick();
    assert_eq!(worked(&c),before,"no working time while it may still be blocked");
    assert_ne!(state(&c),AgentState::Working);
    // New activity resumes the work accounting.
    c.ingest(event("claude","turn_start","log",1,3,clock.now_ms())).unwrap();
    assert_eq!(state(&c),AgentState::Working);
    clock.advance(10_000);c.tick();
    assert_eq!(worked(&c),before+10);
}

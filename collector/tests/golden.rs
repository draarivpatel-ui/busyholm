use std::sync::Arc;
use collector::{Collector, FakeClock, CollectorOutput, contracts::{AgentEvent, Validate}};
use serde_json::{Value, json};

const BASE: u64 = 1791806400000;

pub fn event(tool: &str, spec: &Value, at: u64) -> AgentEvent {
    let mut v = json!({"v":1,"agent":tool,"instance":"00000000000000000000000000000001","parent":null,
        "root_id":"00000000000000000000000000000003","account_id":null,"session_id":null,"turn_id":null,"request_id":null,
        "host":"cli","kind":spec["kind"],"source":spec["source"],"confidence":spec["confidence"],"t":at});
    if spec["kind"] == "limit_hit" { v["limit"] = json!({"provider":tool,"window":"5h","resets_at":null}); }
    serde_json::from_value(v).unwrap()
}

#[test]
fn at_least_forty_golden_spec_timelines() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("golden.json")).unwrap();
    assert!(cases.len() >= 40);
    for case in cases {
        let clock = Arc::new(FakeClock::new(BASE));
        let mut core = Collector::new(clock.clone(), 7);
        for s in case["steps"].as_array().unwrap() {
            let now = BASE + s["at"].as_u64().unwrap(); clock.set(now);
            let mut outputs = if s.get("event").is_some() {
                let mut e = event(case["tool"].as_str().unwrap(), &s["event"], now);
                if let Some(reset) = s.get("reset") { e.limit.as_mut().unwrap().resets_at = reset.as_u64().map(|r|BASE+r); }
                if let Some(n) = s.get("notification") {
                    e.detail = Some(serde_json::from_value(json!({"notification":n})).unwrap());
                }
                if s["child"] == true { e.parent = Some("00000000000000000000000000000002".into()); }
                if s["rebuild"] == true {
                    e.et = Some(now-s["age"].as_u64().unwrap());
                    let mut events = vec![e];
                    if s["alive"] == true {
                        events.push(event(case["tool"].as_str().unwrap(),&json!({"kind":"process_up","source":"process","confidence":"inferred"}),now));
                    }
                    core.rebuild(events).unwrap()
                } else { core.ingest(e).unwrap() }
            } else { core.tick() };
            outputs.extend(core.tick());
            let snap = core.snapshot(); snap.validate().unwrap();
            let agent = snap.agents.iter().find(|a| a.id.ends_with("01"));
            let state = agent.map(|a|serde_json::to_value(a.state).unwrap()).unwrap_or(json!("ended"));
            assert_eq!(state,s["state"],"{} at {}",case["name"],s["at"]);
            if let Some(reason)=s.get("reason") { assert_eq!(serde_json::to_value(agent.unwrap().reason).unwrap(),*reason,"{}",case["name"]); }
            if let Some(confidence)=s.get("expected_confidence") { assert_eq!(serde_json::to_value(agent.unwrap().confidence).unwrap(),*confidence,"{}",case["name"]); }
            if let Some(wanted)=s.get("moments") {
                let got: Vec<Value> = outputs.iter().filter_map(|o| if let CollectorOutput::Moment(m)=o {m.validate().unwrap();Some(serde_json::to_value(m.kind).unwrap())} else {None}).collect();
                assert_eq!(json!(got),*wanted,"{} at {} moments",case["name"],s["at"]);
            }
            assert_eq!(snap.attention.needs_you as usize,snap.agents.iter().filter(|a|serde_json::to_value(a.state).unwrap()=="needs_you").count());
            for a in &snap.agents {
                assert!(a.since >= a.started_at);
                if let Some(p)=&a.parent { assert_ne!(p,&a.id); assert!(snap.agents.iter().any(|x|&x.id==p)); }
            }
        }
        let ledger = core.ledger(); ledger.validate().unwrap();
        let serialized = serde_json::to_value(ledger).unwrap();
        for (counter,wanted) in case["counts"].as_object().unwrap() {
            if counter == "quick_answers" {
                assert_eq!(u64::from(core.quick_answers()),wanted.as_u64().unwrap(),"{} internal quick_answers",case["name"]);
                continue;
            }
            let sum: u64 = serialized["days"].as_object().unwrap().values().map(|d|d[case["tool"].as_str().unwrap()][counter].as_u64().unwrap_or(0)).sum();
            assert_eq!(sum,wanted.as_u64().unwrap(),"{} counter {}",case["name"],counter);
        }
    }
}

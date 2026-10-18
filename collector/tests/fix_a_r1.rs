//! FIX-A, review round 1 (code review, round 1): each finding owned by the collector core,
//! reproduced first. Synthetic ids only; no content anywhere.
use std::{path::PathBuf,sync::{Arc,mpsc},time::{Duration,Instant}};
use collector::{Adapter,AdapterContext,AdapterError,AdapterRouter,Clock,CollectorInput,CollectorOutput,EventBus,HookMapper,IdentityHasher,
    NormalizedMapper,SendError,ServiceConfig,SystemClock,Waker,contracts::{AgentEvent,common::Tool,pending_alerts::PendingAlerts}};
use std::sync::{Mutex,atomic::{AtomicUsize,Ordering}};
use serde_json::{json,Value};

fn scratch(name:&str)->PathBuf {
    let p=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("test-output").join(format!("{}-fixa-{name}",std::process::id()));
    let _=std::fs::remove_dir_all(&p);std::fs::create_dir_all(&p).unwrap();p
}
fn event(kind:&str,id:u8,turn:Option<u8>)->AgentEvent {
    serde_json::from_value(json!({"v":1,"agent":"claude","instance":format!("{id:032x}"),"parent":null,"root_id":format!("{:032x}",3),
        "account_id":null,"session_id":null,"turn_id":turn.map(|t|format!("{t:032x}")),"request_id":null,"host":"cli","kind":kind,
        "source":"log","confidence":"exact","t":1791806400000_u64})).unwrap()
}
/// Runs the service on its own thread; outputs arrive as JSON values. `done` fires when `run_service` returns.
struct Service {outputs:mpsc::Receiver<Value>,done:mpsc::Receiver<std::io::Result<()>>}
fn start(config:ServiceConfig,bus:EventBus,clock:Arc<dyn Clock>,mapper:Arc<dyn HookMapper>)->Service {
    let (tx,outputs)=mpsc::channel();let (done_tx,done)=mpsc::channel();
    std::thread::spawn(move||{
        let r=collector::run_service(config,bus,clock,mapper,move|o:CollectorOutput|{let _=tx.send(serde_json::to_value(&o).unwrap());Ok(())});
        let _=done_tx.send(r);
    });
    Service{outputs,done}
}
fn normalized(clock:&Arc<dyn Clock>)->Arc<dyn HookMapper> {Arc::new(NormalizedMapper{clock:clock.clone()})}

// ---------------------------------------------------------------------------------------------------------------
// H2: a full event queue must not lose the stop signal (Quit would hang in Hub::shutdown).
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn h2_shutdown_is_accepted_when_the_queue_is_full() {
    let bus=EventBus::bounded(2);let sender=bus.sender();
    sender.send(event("heartbeat",1,None)).unwrap();sender.send(event("heartbeat",2,None)).unwrap();
    assert_eq!(sender.send(event("heartbeat",3,None)),Err(SendError::Full),"the data queue is bounded");
    assert_eq!(sender.shutdown(),Ok(()),"the stop signal does not compete with data for queue space");
    // Events queued before the stop are still delivered, then the stop; nothing queued after it gets in.
    assert_eq!(sender.send(event("heartbeat",4,None)),Err(SendError::Closed),"no new data once a stop was requested");
    let mut got=Vec::new();
    while let Ok(input)=bus.receiver.recv_timeout(Duration::from_millis(100)) {
        let stop=matches!(input,CollectorInput::Shutdown);got.push(input);if stop {break;}
    }
    assert_eq!(got.len(),3,"two queued events, then the stop");
    assert!(matches!(got[0],CollectorInput::Event(_))&&matches!(got[1],CollectorInput::Event(_)));
    assert!(matches!(got[2],CollectorInput::Shutdown));
}

#[test]
fn h2_a_service_whose_queue_was_full_at_quit_still_stops() {
    let data=scratch("h2-full");let clock:Arc<dyn Clock>=Arc::new(SystemClock);
    let bus=EventBus::bounded(3);let sender=bus.sender();
    // Duplicate observations that change nothing: the queue is full when the stop bridge fires.
    for _ in 0..3 {sender.send(event("heartbeat",1,None)).unwrap();}
    let _=sender.shutdown();
    let service=start(ServiceConfig::new(data.clone()),bus,clock.clone(),normalized(&clock));
    let result=service.done.recv_timeout(Duration::from_secs(5));
    assert!(result.is_ok(),"the service must stop: a stop sent while the queue was full was lost");
    result.unwrap().unwrap();
    assert!(!data.join("runtime.json").exists(),"a clean stop removes runtime.json");
    let _=service.outputs;
}

// ---------------------------------------------------------------------------------------------------------------
// H3: the startup rebuild must not erase a restored, unanswered alert with an observation older than the alert.
// ---------------------------------------------------------------------------------------------------------------

fn hex(n:u32)->String {format!("{n:032x}")}
/// A log or registry observation of instance `id` at source time `et`, optionally keyed to a request.
fn observed(kind:&str,id:u32,et:u64,request:Option<u32>)->AgentEvent {
    serde_json::from_value(json!({"v":1,"agent":"claude","instance":hex(id),"parent":null,"root_id":hex(3),"account_id":null,
        "session_id":null,"turn_id":null,"request_id":request.map(hex),"host":"cli","kind":kind,"source":"log","confidence":"exact",
        "t":et,"et":et})).unwrap()
}
/// An adapter whose startup rebuild returns a fixed list of observations and nothing else.
struct Rebuilds(Vec<AgentEvent>);
impl Adapter for Rebuilds {
    fn tool(&self)->Tool {Tool::Claude}
    fn rebuild(&mut self,_:&AdapterContext)->Result<Vec<AgentEvent>,AdapterError> {Ok(self.0.clone())}
}
/// Writes a pending-alerts file with one permission alert for instance 5 (request 0x77), starts the service with a
/// router that rebuilds `events`, stops it at once and returns the alerts the service left on disk.
fn restart_with(name:&str,since:u64,confirmed:u64,events:Vec<AgentEvent>)->PendingAlerts {
    let data=scratch(name);let clock:Arc<dyn Clock>=Arc::new(SystemClock);let now=clock.now_ms();
    let pending=json!({"schema_version":1,"privacy":{"containsText":false},"saved_at":confirmed.max(now-20_000),"alerts":[{
        "agent":hex(5),"tool":"claude","host":"cli","root_id":hex(3),"account_id":null,"session_id":null,"request_id":hex(0x77),
        "reason":"permission","since":since,"last_confirmed_at":confirmed}]});
    std::fs::write(data.join("pending-alerts.json"),serde_json::to_vec(&pending).unwrap()).unwrap();
    let ctx=AdapterContext{clock:clock.clone(),identities:IdentityHasher::new([1;32])};
    let mut router=AdapterRouter::new(ctx);router.register(Box::new(Rebuilds(events))).unwrap();
    let router=Arc::new(router);let mapper:Arc<dyn HookMapper>=router.clone();
    let mut config=ServiceConfig::new(data.clone());config.router=Some(router);
    let bus=EventBus::bounded(64);bus.sender().shutdown().unwrap();
    let service=start(config,bus,clock,mapper);
    service.done.recv_timeout(Duration::from_secs(10)).expect("service stops").unwrap();
    serde_json::from_slice(&std::fs::read(data.join("pending-alerts.json")).unwrap()).unwrap()
}

#[test]
fn h3_an_older_recent_turn_start_does_not_erase_a_restored_alert() {
    let now=SystemClock.now_ms();
    // Alert raised 60 s ago, last confirmed 30 s ago; the transcript's turn start is from 120 s ago (younger than 10 min).
    let left=restart_with("h3-turn",now-60_000,now-30_000,vec![observed("turn_start",5,now-120_000,None)]);
    assert_eq!(left.alerts.len(),1,"an observation older than the alert cannot answer it");
    let left=restart_with("h3-tool",now-60_000,now-30_000,vec![observed("tool_end",5,now-90_000,None)]);
    assert_eq!(left.alerts.len(),1,"an older tool end cannot answer it either");
}

#[test]
fn h3_an_old_stale_observation_does_not_erase_a_restored_alert() {
    let now=SystemClock.now_ms();
    // Alert confirmed an hour ago; the newest observation is two hours old (the stale rebuild branch).
    let left=restart_with("h3-stale",now-3_700_000,now-3_600_000,vec![observed("turn_start",5,now-7_200_000,None)]);
    assert_eq!(left.alerts.len(),1,"a stale observation from before the alert proves nothing about it");
}

#[test]
fn h3_newer_relevant_evidence_still_closes_a_restored_alert_but_another_request_does_not() {
    let now=SystemClock.now_ms();
    let left=restart_with("h3-newer",now-60_000,now-30_000,vec![observed("turn_end",5,now-10_000,None)]);
    assert!(left.alerts.is_empty(),"a turn end after the alert closes it");
    let left=restart_with("h3-other",now-60_000,now-30_000,vec![observed("tool_end",5,now-10_000,Some(0x78))]);
    assert_eq!(left.alerts.len(),1,"a newer tool result for a different request does not answer this one");
    let left=restart_with("h3-same",now-60_000,now-30_000,vec![observed("tool_end",5,now-10_000,Some(0x77))]);
    assert!(left.alerts.is_empty(),"a newer tool result for this request answers it");
}

// ---------------------------------------------------------------------------------------------------------------
// H7: a corrupt ledger is replaced by the newest valid backup (SPEC 6.8), and the service keeps rolling backups.
// ---------------------------------------------------------------------------------------------------------------

fn ledger_with(seed:u32,turns:u32)->Value {
    json!({"schema_version":1,"privacy":{"containsText":false},"seed":seed,"founded_day":"2026-09-01","hooks_first_connected_day":null,
        "days":{"2026-10-08":{"claude":{"turns":turns,"interrupted_turns":0,"sessions":1,"working_seconds":600,"needs_you":0,"errors":0,
        "recovered":0,"limit_hits":0,"subagent_turns":0}}},"backfill":null})
}
fn turns_in(v:&Value)->u64 {v["days"]["2026-10-08"]["claude"]["turns"].as_u64().unwrap_or(0)}
/// Starts and at once stops the plain service on `data`; returns the ledger outputs it emitted.
fn start_and_stop(data:&PathBuf)->Vec<Value> {
    let clock:Arc<dyn Clock>=Arc::new(SystemClock);
    let bus=EventBus::bounded(8);bus.sender().shutdown().unwrap();
    let service=start(ServiceConfig::new(data.clone()),bus,clock.clone(),normalized(&clock));
    service.done.recv_timeout(Duration::from_secs(10)).expect("service stops").unwrap();
    service.outputs.try_iter().filter(|v|v["type"]=="ledger").map(|v|v["data"].clone()).collect()
}
fn backups(data:&PathBuf)->Vec<String> {
    let mut names:Vec<String>=std::fs::read_dir(data.join("backups")).map(|d|d.flatten().map(|e|e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    names.sort();names
}

#[test]
fn h7_a_corrupt_ledger_is_replaced_by_the_newest_valid_backup() {
    let data=scratch("h7-restore");
    std::fs::write(data.join("ledger.json"),b"{\"schema_version\":1,\"privacy\":").unwrap();      // torn
    std::fs::create_dir_all(data.join("backups")).unwrap();
    std::fs::write(data.join("backups/ledger-2026-10-09.json"),serde_json::to_vec(&ledger_with(41,5)).unwrap()).unwrap();
    std::fs::write(data.join("backups/ledger-2026-10-10.json"),serde_json::to_vec(&ledger_with(42,9)).unwrap()).unwrap();
    std::fs::write(data.join("backups/ledger-2026-10-11.json"),b"not json").unwrap();               // newest, but bad
    let ledgers=start_and_stop(&data);
    let first=ledgers.first().expect("the loaded ledger is emitted at start");
    assert_eq!(first["seed"],42,"the newest VALID backup is restored (the newer file is not valid)");
    assert_eq!(turns_in(first),9,"progress comes back from the backup instead of a fresh ledger");
    assert!(data.join("ledger.json.corrupt").exists(),"the bad file is kept aside");
    let on_disk:Value=serde_json::from_slice(&std::fs::read(data.join("ledger.json")).unwrap()).unwrap();
    assert_eq!((on_disk["seed"].clone(),turns_in(&on_disk)),(json!(42),9),"the restored ledger is written back at once");
}

#[test]
fn p2_2_a_missing_ledger_with_valid_backups_restores_the_newest_valid_backup() {
    let data=scratch("p2-2-missing");
    // ledger.json does not exist at all, but backups/ has valid daily copies.
    std::fs::create_dir_all(data.join("backups")).unwrap();
    std::fs::write(data.join("backups/ledger-2026-10-09.json"),serde_json::to_vec(&ledger_with(41,5)).unwrap()).unwrap();
    std::fs::write(data.join("backups/ledger-2026-10-10.json"),serde_json::to_vec(&ledger_with(42,9)).unwrap()).unwrap();
    let ledgers=start_and_stop(&data);
    let first=ledgers.first().expect("the loaded ledger is emitted at start");
    assert_eq!(first["seed"],42,"missing ledger.json must restore from the newest valid backup");
    assert_eq!(turns_in(first),9,"progress comes back from the backup instead of starting a fresh ledger");
    let on_disk:Value=serde_json::from_slice(&std::fs::read(data.join("ledger.json")).unwrap()).unwrap();
    assert_eq!((on_disk["seed"].clone(),turns_in(&on_disk)),(json!(42),9),"the restored ledger is written back to ledger.json at once");
}

#[test]
fn h7_the_service_keeps_daily_rolling_backups_of_the_ledger_for_fourteen_days() {
    let data=scratch("h7-rolling");
    std::fs::write(data.join("ledger.json"),serde_json::to_vec(&ledger_with(7,3)).unwrap()).unwrap();
    std::fs::create_dir_all(data.join("backups")).unwrap();
    for day in 1..=16 {std::fs::write(data.join(format!("backups/ledger-2026-09-{day:02}.json")),serde_json::to_vec(&ledger_with(7,day)).unwrap()).unwrap();}
    start_and_stop(&data);
    let names=backups(&data);
    let today=chrono_free_today(&data);
    assert!(names.contains(&format!("ledger-{today}.json")),"today's copy is written: {names:?}");
    assert_eq!(names.len(),14,"fourteen daily copies are kept: {names:?}");
    assert!(!names.contains(&"ledger-2026-09-01.json".to_string())&&!names.contains(&"ledger-2026-09-03.json".to_string()),"the oldest go first");
    let copy:Value=serde_json::from_slice(&std::fs::read(data.join(format!("backups/ledger-{today}.json"))).unwrap()).unwrap();
    assert_eq!(turns_in(&copy),3,"the copy is the current ledger");
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(data.join("backups")).unwrap().permissions().mode()&0o777,0o700);
        assert_eq!(std::fs::metadata(data.join(format!("backups/ledger-{today}.json"))).unwrap().permissions().mode()&0o777,0o600);
    }
}
/// Today's local date as the service names it, read from the ledger the service just wrote (founded today when fresh).
fn chrono_free_today(_data:&PathBuf)->String {
    let fresh=scratch("h7-today");let ledgers=start_and_stop(&fresh);
    ledgers.last().unwrap()["founded_day"].as_str().unwrap().to_string()
}

// ---------------------------------------------------------------------------------------------------------------
// M5: a file notice must get its adapter polled at once, not at the next one-second period (first-prompt
// registration has a 200 ms budget). The polling period stays long, so an idle collector still sleeps.
// ---------------------------------------------------------------------------------------------------------------

/// An adapter that keeps the waker it is given and counts its polls.
struct Notices {waker:Arc<Mutex<Option<Waker>>>,polls:Arc<AtomicUsize>}
impl Adapter for Notices {
    fn tool(&self)->Tool {Tool::Codex}
    fn set_waker(&mut self,waker:Waker) {*self.waker.lock().unwrap()=Some(waker);}
    fn poll(&mut self,_:&AdapterContext)->Result<Vec<AgentEvent>,AdapterError> {self.polls.fetch_add(1,Ordering::SeqCst);Ok(Vec::new())}
}

#[test]
fn m5_a_wake_polls_the_adapters_at_once_and_a_storm_of_wakes_stays_bounded() {
    let data=scratch("m5");let clock:Arc<dyn Clock>=Arc::new(SystemClock);
    let waker=Arc::new(Mutex::new(None));let polls=Arc::new(AtomicUsize::new(0));
    let ctx=AdapterContext{clock:clock.clone(),identities:IdentityHasher::new([1;32])};
    let mut router=AdapterRouter::new(ctx);router.register(Box::new(Notices{waker:waker.clone(),polls:polls.clone()})).unwrap();
    let router=Arc::new(router);let mapper:Arc<dyn HookMapper>=router.clone();
    let mut config=ServiceConfig::new(data);config.router=Some(router);config.poll_ms=10_000;
    let bus=EventBus::bounded(64);let sender=bus.sender();
    let service=start(config,bus,clock,mapper);
    let end=Instant::now()+Duration::from_secs(5);
    while waker.lock().unwrap().is_none()&&Instant::now()<end {std::thread::sleep(Duration::from_millis(5));}
    let w=waker.lock().unwrap().clone().expect("the service hands the adapter a waker");
    std::thread::sleep(Duration::from_millis(100));
    let before=polls.load(Ordering::SeqCst);
    let woke=Instant::now();w.wake();
    while polls.load(Ordering::SeqCst)==before&&woke.elapsed()<Duration::from_secs(2) {std::thread::sleep(Duration::from_millis(2));}
    assert!(polls.load(Ordering::SeqCst)>before,"a wake must trigger a poll");
    assert!(woke.elapsed()<Duration::from_millis(200),"polled {:?} after the wake (budget 200 ms)",woke.elapsed());
    // A storm of notices (a busy rollout) is coalesced: at most one poll per 25 ms.
    let before=polls.load(Ordering::SeqCst);let storm=Instant::now();
    while storm.elapsed()<Duration::from_millis(500) {w.wake();std::thread::sleep(Duration::from_millis(1));}
    let during=polls.load(Ordering::SeqCst)-before;
    assert!(during>=5&&during<=25,"{during} polls in 500 ms of continuous wakes");
    sender.shutdown().unwrap();service.done.recv_timeout(Duration::from_secs(5)).expect("stops").unwrap();
}

// ---------------------------------------------------------------------------------------------------------------
// FIX-B follow-up (H4c at the collector boundary): a tool result without a request id says nothing about a keyed
// request, from any adapter. Only a matching id, an unkeyed alert, a new prompt or the end of the turn answers it.
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn h4c_an_idless_tool_end_does_not_close_a_keyed_alert() {
    use collector::{Collector,FakeClock,ledger::FixedCalendar};
    let clock=Arc::new(FakeClock::new(1791806400000));
    let mut c=Collector::with_calendar(clock.clone(),1,Arc::new(FixedCalendar(0)));
    let with=|kind:&str,source:&str,request:Option<u32>|->AgentEvent {
        serde_json::from_value(json!({"v":1,"agent":"codex","instance":hex(9),"parent":null,"root_id":hex(3),"account_id":null,
            "session_id":null,"turn_id":null,"request_id":request.map(hex),"host":"cli","kind":kind,"source":source,"confidence":"exact",
            "t":1791806400000_u64})).unwrap()
    };
    let state=|c:&Collector|serde_json::to_value(c.snapshot().agents[0].state).unwrap();
    c.ingest(with("turn_start","hook",None)).unwrap();
    clock.advance(1000);c.ingest(with("needs_permission","hook",Some(0x51))).unwrap();
    assert_eq!(state(&c),"needs_you");
    // A parallel tool's result, seen in a log after the hook's authority window, carries no request id.
    clock.advance(6000);c.ingest(with("tool_end","log",None)).unwrap();
    assert_eq!(state(&c),"needs_you","an uncorrelated tool result must not answer a keyed request");
    clock.advance(1000);c.ingest(with("tool_end","hook",Some(0x51))).unwrap();
    assert_eq!(state(&c),"working","the matching tool result answers it");
}

// ---------------------------------------------------------------------------------------------------------------
// M2: concurrent tools must not earn summed working time. The collector writes the day-level union (Ledger v1's
// optional `day_totals`, accepted in contracts/CHANGES.md) next to the per-tool wall times.
// ---------------------------------------------------------------------------------------------------------------

/// Claude and/or Codex working (registry busy, a heartbeat a minute) for the given minute ranges of one day.
fn work_day(ranges:&[(&str,u64,u64)],loaded:Option<Value>)->Value {
    use collector::{Collector,FakeClock,ledger::FixedCalendar};
    let base=1791806400000u64-12*3600000; // 2026-10-12 00:00 UTC
    let clock=Arc::new(FakeClock::new(base+3600000));
    let mut c=Collector::with_calendar(clock.clone(),1,Arc::new(FixedCalendar(0)));
    if let Some(l)=loaded {c.load_ledger(serde_json::from_value(l).unwrap()).unwrap();}
    let ev=|tool:&str,kind:&str,id:u32|->AgentEvent {serde_json::from_value(json!({"v":1,"agent":tool,"instance":hex(id),"parent":null,
        "root_id":hex(3),"account_id":null,"session_id":null,"turn_id":null,"request_id":null,"host":"cli","kind":kind,"source":"registry",
        "confidence":"exact","t":base})).unwrap()};
    let end=ranges.iter().map(|r|r.2).max().unwrap();
    for minute in 0..=end {
        for (i,(tool,from,to)) in ranges.iter().enumerate() {
            let id=10+i as u32;
            if minute==*from {c.ingest(ev(tool,"turn_start",id)).unwrap();}
            else if minute==*to {c.ingest(ev(tool,"turn_end",id)).unwrap();}
            else if minute>*from&&minute<*to {c.ingest(ev(tool,"heartbeat",id)).unwrap();}
        }
        clock.advance(60_000);
    }
    c.tick();
    serde_json::to_value(c.ledger()).unwrap()
}
fn union_of(l:&Value)->u64 {l["day_totals"]["2026-10-12"]["working_seconds"].as_u64().unwrap_or(0)}
fn tool_secs(l:&Value,tool:&str)->u64 {l["days"]["2026-10-12"][tool]["working_seconds"].as_u64().unwrap_or(0)}

#[test]
fn m2_two_tools_working_side_by_side_record_their_union_once() {
    let l=work_day(&[("claude",0,180),("codex",0,180)],None);
    assert_eq!((tool_secs(&l,"claude"),tool_secs(&l,"codex")),(10800,10800),"per tool wall time is unchanged");
    assert_eq!(union_of(&l),10800,"three hours side by side is three hours of the day, not six");
    let l=work_day(&[("claude",0,120),("codex",60,180)],None);
    assert_eq!(union_of(&l),10800,"partial overlap: 0 to 3 h");
    let l=work_day(&[("claude",0,60),("codex",60,120)],None);
    assert_eq!(union_of(&l),7200,"one after the other adds up");
}

#[test]
fn m2_a_ledger_from_before_the_field_is_seeded_with_its_largest_tool_time() {
    // Upgraded mid-day: two hours already on Codex's wall time, no day_totals yet. The union can only be at least that.
    let mut old=ledger_with(1,0);
    old["days"]=json!({"2026-10-12":{"codex":{"turns":0,"interrupted_turns":0,"sessions":0,"working_seconds":7200,"needs_you":0,
        "errors":0,"recovered":0,"limit_hits":0,"subagent_turns":0}}});
    let l=work_day(&[("claude",0,60)],Some(old));
    assert_eq!(union_of(&l),10800);
}

// ---------------------------------------------------------------------------------------------------------------
// R3 P1-B: "Delete everything" stops the collector without writing anything, while normal quit still flushes.
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn p1_b_skip_flush_stop_writes_no_ledger_pending_alerts_or_coverage_after_folder_deleted() {
    let data=scratch("p1b-skip-flush");let clock:Arc<dyn Clock>=Arc::new(SystemClock);
    let bus=EventBus::bounded(64);let sender=bus.sender();
    let mut cfg=ServiceConfig::new(data.clone());cfg.seed=777;
    let service=start(cfg,bus,clock.clone(),normalized(&clock));
    let end=Instant::now()+Duration::from_secs(5);
    while !data.join("runtime.json").exists()&&Instant::now()<end {std::thread::sleep(Duration::from_millis(5));}
    sender.send(event("turn_start",1,Some(1))).unwrap();
    sender.send(event("needs_permission",1,Some(1))).unwrap();
    sender.send(event("turn_end",1,Some(1))).unwrap();
    while !data.join("ledger.json").exists()&&Instant::now()<end {std::thread::sleep(Duration::from_millis(5));}
    assert!(data.join("ledger.json").exists());
    assert!(data.join("pending-alerts.json").exists());
    assert!(data.join("coverage.json").exists());

    std::fs::remove_dir_all(&data).unwrap();
    assert!(!data.exists());
    sender.shutdown_without_flush().unwrap();
    service.done.recv_timeout(Duration::from_secs(5)).expect("service stops").unwrap();
    assert!(!data.exists(),"skip-flush stop must not recreate the deleted data folder");
    assert!(!data.join("ledger.json").exists());
    assert!(!data.join("pending-alerts.json").exists());
    assert!(!data.join("coverage.json").exists());
}

#[test]
fn p1_b_normal_shutdown_still_flushes_ledger_pending_alerts_and_coverage() {
    let data=scratch("p1b-normal-flush");let clock:Arc<dyn Clock>=Arc::new(SystemClock);
    let bus=EventBus::bounded(64);let sender=bus.sender();
    let mut cfg=ServiceConfig::new(data.clone());cfg.seed=777;
    let service=start(cfg,bus,clock.clone(),normalized(&clock));
    let end=Instant::now()+Duration::from_secs(5);
    while !data.join("runtime.json").exists()&&Instant::now()<end {std::thread::sleep(Duration::from_millis(5));}
    sender.send(event("turn_start",1,Some(1))).unwrap();
    sender.send(event("needs_permission",1,Some(1))).unwrap();
    sender.send(event("turn_end",1,Some(1))).unwrap();
    while !data.join("ledger.json").exists()&&Instant::now()<end {std::thread::sleep(Duration::from_millis(5));}

    // Remove the three files while the folder still exists; a normal shutdown must flush all three back.
    for name in ["ledger.json","pending-alerts.json","coverage.json"] {
        std::fs::remove_file(data.join(name)).unwrap();
    }
    sender.shutdown().unwrap();
    service.done.recv_timeout(Duration::from_secs(5)).expect("service stops").unwrap();
    assert!(data.join("ledger.json").exists(),"normal shutdown must flush ledger.json");
    assert!(data.join("pending-alerts.json").exists(),"normal shutdown must flush pending-alerts.json");
    assert!(data.join("coverage.json").exists(),"normal shutdown must flush coverage.json");
}

#[test]
fn p2_1_normal_shutdown_writes_ledger_pending_alerts_and_coverage_when_output_fails() {
    use collector::FakeClock;
    use std::sync::atomic::AtomicBool;
    let data=scratch("p2-1-closed-hub");
    let fake=Arc::new(FakeClock::new(1791806400000));
    let clock:Arc<dyn Clock>=fake.clone();
    let bus=EventBus::bounded(64);let sender=bus.sender();
    let mut cfg=ServiceConfig::new(data.clone());cfg.seed=777;
    let closed=Arc::new(AtomicBool::new(false));
    let closed_cb=closed.clone();
    let (ledger_tx,ledger_rx)=mpsc::channel();
    let (done_tx,done_rx)=mpsc::channel();
    let mapper=normalized(&clock);
    std::thread::spawn(move||{
        let r=collector::run_service(cfg,bus,clock,mapper,move|o:CollectorOutput|{
            if closed_cb.load(Ordering::SeqCst) {
                return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe,"hub closed"));
            }
            if matches!(o,CollectorOutput::Ledger(_)) {
                let _=ledger_tx.send(());
            }
            Ok(())
        });
        let _=done_tx.send(r);
    });
    // 1. Initial startup Ledger output (at mono = 0, last_snapshot = Some(0)).
    ledger_rx.recv_timeout(Duration::from_secs(5)).expect("initial ledger output emitted");
    // 2. At mono = 50 ms (inside the 250 ms snapshot coalescing window), send turn_start + turn_end.
    //    turn_end emits a Moment (and therefore a Ledger output), while `core.dirty` stays true because mono < 250.
    fake.advance(50);
    sender.send(event("session_start",1,None)).unwrap();
    sender.send(event("turn_start",1,Some(1))).unwrap();
    sender.send(event("turn_end",1,Some(1))).unwrap();
    ledger_rx.recv_timeout(Duration::from_secs(5)).expect("turn_end ledger output emitted");
    for name in ["ledger.json","pending-alerts.json","coverage.json"] {
        std::fs::remove_file(data.join(name)).unwrap();
    }
    std::fs::remove_dir_all(data.join("backups")).unwrap();
    // 3. Advance to the next day (and past the 250 ms coalescing window) so `core.tick()` on shutdown emits
    //    a Snapshot and `roll_backup` writes the new day's backup, then close the hub before shutting down.
    fake.advance(86_400_000);
    closed.store(true,Ordering::SeqCst);
    sender.shutdown().unwrap();
    let res=done_rx.recv_timeout(Duration::from_secs(5)).expect("service stops");
    assert!(res.is_ok(),"shutdown flush must succeed even when output callback fails: {res:?}");
    assert!(data.join("ledger.json").exists(),"ledger.json must be written before emitting outputs");
    assert!(data.join("pending-alerts.json").exists(),"pending-alerts.json must be written before emitting outputs");
    assert!(data.join("coverage.json").exists(),"coverage.json must be written before emitting outputs");
    assert!(!backups(&data).is_empty(),"rolling backup must be written before emitting outputs");
    let on_disk:Value=serde_json::from_slice(&std::fs::read(data.join("ledger.json")).unwrap()).unwrap();
    let day=on_disk["founded_day"].as_str().unwrap();
    assert_eq!(on_disk["days"][day]["claude"]["sessions"],1);
    assert_eq!(on_disk["days"][day]["claude"]["turns"],1);
}



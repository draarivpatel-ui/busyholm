//! Review r1 M5, end to end: a Codex rollout that appears in the middle of the service's one-second polling period
//! reaches a snapshot within the 200 ms first-prompt budget, because the watch's file notice wakes the service.
//! Real sidecar, real notify watcher, synthetic rollout lines only.
use std::{io::Write, sync::{Arc, mpsc}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use collector::{Clock, CollectorOutput, EventBus, SystemClock};
use serde_json::{json, Value};
use sidecar::Roots;

fn line(kind: &str, payload: Value) -> String {
    let at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
    format!("{}\n", json!({"timestamp": at, "type": kind, "payload": payload}))
}
fn codex_agents(v: &Value) -> usize {
    v["data"]["agents"].as_array().map_or(0, |a| a.iter().filter(|x| x["tool"] == "codex").count())
}

#[test]
fn m5_a_new_codex_rollout_registers_within_200_ms_mid_period() {
    let base = std::env::temp_dir().canonicalize().unwrap().join(format!("bh-fixa-m5-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let day = base.join("codex/sessions/2026/10/12");
    std::fs::create_dir_all(&day).unwrap();
    let roots = Roots { claude: None, codex_sessions: Some(base.join("codex/sessions")) };
    let (data, clock): (_, Arc<dyn Clock>) = (base.join("data"), Arc::new(SystemClock));
    let bus = EventBus::bounded(256);
    let sender = bus.sender();
    let (tx, rx) = mpsc::channel::<(Instant, Value)>();
    let handle = std::thread::spawn(move || sidecar::run(data, 1, &roots, clock, bus, move |o: CollectorOutput| {
        let _ = tx.send((Instant::now(), serde_json::to_value(&o).unwrap()));
        Ok(())
    }));
    // Let the service start and go quiet.
    while rx.recv_timeout(Duration::from_millis(600)).is_ok() {}
    let mut worst = Duration::ZERO;
    for n in 0..3u32 {
        // Somewhere in the middle of a one-second period, never right after a poll.
        std::thread::sleep(Duration::from_millis(230 + 170 * n as u64));
        let before = Instant::now();
        let mut f = std::fs::File::create(day.join(format!("rollout-m5-{n}.jsonl"))).unwrap();
        f.write_all(line("session_meta", json!({"id": format!("m5-session-{n}"), "source": "cli"})).as_bytes()).unwrap();
        f.write_all(line("event_msg", json!({"type": "task_started", "turn_id": "t1"})).as_bytes()).unwrap();
        f.sync_all().unwrap();
        drop(f);
        let seen = loop {
            let (at, v) = rx.recv_timeout(Duration::from_secs(3)).expect("the new session reaches a snapshot");
            if v["type"] == "snapshot" && codex_agents(&v) as u32 > n { break at; }
        };
        worst = worst.max(seen.duration_since(before));
        while rx.recv_timeout(Duration::from_millis(300)).is_ok() {}
    }
    sender.shutdown().unwrap();
    handle.join().unwrap().unwrap();
    eprintln!("m5: worst rollout-to-snapshot latency {worst:?}");
    assert!(worst < Duration::from_millis(200), "worst {worst:?} (budget 200 ms)");
}

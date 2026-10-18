//! IPC hub: Snapshot v2 at most 4 per second with the newest always delivered, Moment v1 at once,
//! collector supervision with backoff (SPEC 6.2, 6.11).
mod common;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use busyholm_app::hub::*;
use busyholm_contracts::{Moment, Snapshot};

#[derive(Default)]
struct Rec { snaps: Mutex<Vec<(Instant, u64)>>, moments: Mutex<Vec<(Instant, u64)>>, notes: Mutex<Vec<String>> }
impl Outlet for Rec {
    fn snapshot(&self, s: &Snapshot) { self.snaps.lock().unwrap().push((Instant::now(), s.t)); }
    fn moment(&self, m: &Moment) { self.moments.lock().unwrap().push((Instant::now(), m.t)); }
    fn note(&self, e: &str, _d: serde_json::Value) { self.notes.lock().unwrap().push(e.to_string()); }
}

fn cfg() -> HubConfig { HubConfig { min_interval: Duration::from_millis(250), backoff_initial: Duration::from_millis(10), backoff_max: Duration::from_millis(40) } }

fn snap(t: u64) -> Snapshot { let mut s = common::snapshots().remove(0); s.t = t; s }
fn moment(t: u64) -> Moment { let mut m = common::moments().remove(0); m.t = t; m }

const T0: u64 = 1_760_270_400_000;

/// Sends `items` with a pause between each, then idles until stopped.
struct Script { items: Vec<(Duration, Feed)>, sent_at: Arc<Mutex<Vec<Instant>>> }
impl Collector for Script {
    fn name(&self) -> &'static str { "script" }
    fn run(&mut self, out: &FeedSender, stop: &AtomicBool) -> Result<(), String> {
        for (pause, f) in self.items.drain(..) {
            std::thread::sleep(pause);
            self.sent_at.lock().unwrap().push(Instant::now());
            out.send(f);
        }
        while !stop.load(Ordering::SeqCst) { std::thread::sleep(Duration::from_millis(5)); }
        Ok(())
    }
}

fn start(items: Vec<(Duration, Feed)>) -> (Hub, Arc<Rec>, Arc<Mutex<Vec<Instant>>>) {
    let rec = Arc::new(Rec::default());
    let sent = Arc::new(Mutex::new(Vec::new()));
    let hub = Hub::start(Box::new(Script { items, sent_at: sent.clone() }), rec.clone(), cfg());
    (hub, rec, sent)
}

#[test]
fn snapshots_are_coalesced_to_4_per_second_and_the_newest_arrives() {
    let items: Vec<_> = (0..100).map(|i| (Duration::from_millis(10), Feed::Snapshot(snap(T0 + i)))).collect();
    let (hub, rec, _) = start(items);
    std::thread::sleep(Duration::from_millis(1700));
    let snaps = rec.snaps.lock().unwrap().clone();
    hub.shutdown();
    assert!(!snaps.is_empty(), "something was delivered");
    assert!(snaps.len() <= 7, "at most about 4 per second over ~1.2 s, got {}", snaps.len());
    for w in snaps.windows(2) {
        assert!(w[1].0 - w[0].0 >= Duration::from_millis(240), "deliveries at least 250 ms apart");
    }
    assert_eq!(snaps.last().unwrap().1, T0 + 99, "the newest snapshot is always delivered");
    assert_eq!(hub.latest().map(|s| s.t), Some(T0 + 99));
}

#[test]
fn moments_are_relayed_immediately_and_in_order() {
    let mut items = vec![(Duration::from_millis(5), Feed::Snapshot(snap(T0)))];
    for i in 0..5 { items.push((Duration::from_millis(5), Feed::Snapshot(snap(T0 + 10 + i)))); items.push((Duration::ZERO, Feed::Moment(moment(T0 + 100 + i)))); }
    let (hub, rec, sent) = start(items);
    std::thread::sleep(Duration::from_millis(600));
    hub.shutdown();
    let moments = rec.moments.lock().unwrap().clone();
    assert_eq!(moments.iter().map(|m| m.1).collect::<Vec<_>>(), (0..5).map(|i| T0 + 100 + i).collect::<Vec<_>>());
    let sent = sent.lock().unwrap().clone();
    // Moment i was the (2 + 2i)-th item sent.
    for (i, m) in moments.iter().enumerate() {
        let lat = m.0 - sent[2 + 2 * i];
        assert!(lat < Duration::from_millis(50), "moment {i} waited {lat:?} behind the snapshot throttle");
    }
}

#[test]
fn invalid_contract_values_are_dropped_not_forwarded() {
    let items = vec![(Duration::ZERO, Feed::Snapshot(snap(5))), (Duration::ZERO, Feed::Moment(moment(7)))];
    let (hub, rec, _) = start(items);
    std::thread::sleep(Duration::from_millis(400));
    hub.shutdown();
    assert!(rec.snaps.lock().unwrap().is_empty());
    assert!(rec.moments.lock().unwrap().is_empty());
    assert!(rec.notes.lock().unwrap().iter().filter(|n| n.as_str() == "hub_rejected").count() >= 2);
    assert!(hub.latest().is_none());
}

struct Flaky { runs: Arc<AtomicU32> }
impl Collector for Flaky {
    fn name(&self) -> &'static str { "flaky" }
    fn run(&mut self, out: &FeedSender, stop: &AtomicBool) -> Result<(), String> {
        let n = self.runs.fetch_add(1, Ordering::SeqCst);
        if n == 0 { panic!("collector thread panicked (test)"); }
        if n == 1 { return Err("transient failure (test)".into()); }
        out.send(Feed::Snapshot(snap(T0 + 1)));
        while !stop.load(Ordering::SeqCst) { std::thread::sleep(Duration::from_millis(5)); }
        Ok(())
    }
}

#[test]
fn a_panicking_or_failing_collector_is_restarted_with_backoff() {
    let rec = Arc::new(Rec::default());
    let runs = Arc::new(AtomicU32::new(0));
    let hub = Hub::start(Box::new(Flaky { runs: runs.clone() }), rec.clone(), cfg());
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(runs.load(Ordering::SeqCst), 3);
    assert_eq!(hub.restarts(), 2);
    assert_eq!(rec.snaps.lock().unwrap().last().map(|s| s.1), Some(T0 + 1));
    let t = Instant::now();
    hub.shutdown();
    assert!(t.elapsed() < Duration::from_millis(500), "shutdown stops the collector promptly");
}

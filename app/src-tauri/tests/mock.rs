//! Mock collector: replays contract fixtures with timestamps moved to now.
mod common;

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use busyholm_app::hub::*;
use busyholm_app::mock::*;
use busyholm_contracts::{Moment, Snapshot, Validate};

#[test]
fn shift_times_moves_only_integer_timestamps() {
    let mut v = serde_json::json!({ "t": 1000, "agents": [{ "since": 900, "started_at": 800, "ordinal": 1, "limited_until": null }],
        "limits": [{ "resets_at": 2000, "observed_at": 990, "used_pct": 40.5 }], "attention": { "needs_you": 0, "oldest_since": null } });
    shift_times(&mut v, 5);
    assert_eq!(v["t"], 1005);
    assert_eq!(v["agents"][0]["since"], 905);
    assert_eq!(v["agents"][0]["started_at"], 805);
    assert_eq!(v["agents"][0]["ordinal"], 1);
    assert!(v["agents"][0]["limited_until"].is_null());
    assert_eq!(v["limits"][0]["resets_at"], 2005);
    assert_eq!(v["limits"][0]["used_pct"], 40.5);
    assert!(v["attention"]["oldest_since"].is_null());
    assert!(v["t"].is_u64(), "stays an integer");
}

#[derive(Default)]
struct Rec { snaps: Mutex<Vec<Snapshot>>, moments: Mutex<Vec<Moment>> }
impl Outlet for Rec {
    fn snapshot(&self, s: &Snapshot) { self.snaps.lock().unwrap().push(s.clone()); }
    fn moment(&self, m: &Moment) { self.moments.lock().unwrap().push(m.clone()); }
}

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 }

#[test]
fn static_mode_sends_one_current_valid_snapshot() {
    let rec = Arc::new(Rec::default());
    let hub = Hub::start(Box::new(MockCollector::new(common::fixtures_dir(), MockMode::Static)), rec.clone(), HubConfig::default());
    std::thread::sleep(Duration::from_millis(900));
    hub.shutdown();
    let snaps = rec.snaps.lock().unwrap();
    assert_eq!(snaps.len(), 1, "exactly one snapshot in static mode");
    let s = &snaps[0];
    assert!(s.validate().is_ok());
    assert!(now_ms().abs_diff(s.t) < 5_000, "timestamps moved to now");
    assert!(!s.agents.is_empty(), "static mode picks a scene with residents");
}

#[test]
fn cycle_mode_replays_snapshots_and_moments() {
    let rec = Arc::new(Rec::default());
    let hub = Hub::start(Box::new(MockCollector::new(common::fixtures_dir(), MockMode::Cycle { period: Duration::from_millis(100) })),
        rec.clone(), HubConfig::default());
    std::thread::sleep(Duration::from_millis(1600));
    hub.shutdown();
    let snaps = rec.snaps.lock().unwrap();
    let moments = rec.moments.lock().unwrap();
    assert!(snaps.len() >= 3, "got {} snapshots", snaps.len());
    assert!(!moments.is_empty(), "moments are replayed too");
    for s in snaps.iter() { assert!(s.validate().is_ok()); assert!(now_ms().abs_diff(s.t) < 5_000); }
    for m in moments.iter() { assert!(m.validate().is_ok()); }
}

#[test]
fn a_missing_fixture_folder_is_an_error_not_a_panic() {
    let rec = Arc::new(Rec::default());
    let hub = Hub::start(Box::new(MockCollector::new("/nonexistent/busyholm".into(), MockMode::Static)), rec.clone(),
        HubConfig { backoff_initial: Duration::from_millis(10), backoff_max: Duration::from_millis(20), ..HubConfig::default() });
    std::thread::sleep(Duration::from_millis(200));
    assert!(hub.restarts() >= 1);
    hub.shutdown();
}

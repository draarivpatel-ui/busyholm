//! Mock collector: replays the WP-01 contract fixtures (Snapshot v2, Moment v1) with timestamps
//! shifted to now, until the WP-03 collector is wired in. Reads fixtures at runtime from a folder;
//! nothing is embedded in release builds. Fixtures the current contract types reject are skipped,
//! so the mock follows contract revisions without edits.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use busyholm_contracts::{Moment, Snapshot};
use serde::de::DeserializeOwned;

use crate::hub::{Collector, Feed, FeedSender};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MockMode {
    /// Cycle through every valid snapshot fixture, one per period, with a moment every third step.
    Cycle { period: Duration },
    /// Send one snapshot with residents, then stay quiet (stable scenes for scripted tests).
    Static,
}

pub struct MockCollector {
    pub dir: PathBuf,
    pub mode: MockMode,
    /// Static mode: use the first snapshot fixture whose file name contains this text.
    pub pick: Option<String>,
}

impl MockCollector {
    pub fn new(dir: PathBuf, mode: MockMode) -> Self {
        MockCollector { dir, mode, pick: None }
    }
    pub fn with_pick(mut self, pick: Option<String>) -> Self {
        self.pick = pick;
        self
    }
}

/// Timestamp fields shifted by the mock (all integer ms).
pub const TIME_KEYS: &[&str] = &["t", "since", "started_at", "limited_until", "resets_at", "observed_at", "oldest_since"];

/// Adds `delta_ms` to every integer value under a key in `TIME_KEYS`, at any depth. Nulls, floats
/// and other keys are left alone; results stay integers (contract convention 3).
pub fn shift_times(v: &mut serde_json::Value, delta_ms: i64) {
    match v {
        serde_json::Value::Object(map) => {
            for (k, val) in map.iter_mut() {
                if TIME_KEYS.contains(&k.as_str()) {
                    if let Some(n) = val.as_u64() {
                        *val = serde_json::Value::from((n as i64 + delta_ms).max(0) as u64);
                        continue;
                    }
                }
                shift_times(val, delta_ms);
            }
        }
        serde_json::Value::Array(a) => a.iter_mut().for_each(|x| shift_times(x, delta_ms)),
        _ => {}
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn load_raw(dir: &Path, contract: &str) -> Result<Vec<(String, serde_json::Value)>, String> {
    let d = dir.join(contract).join("valid");
    let rd = std::fs::read_dir(&d).map_err(|_| format!("mock: no fixtures for {contract}"))?;
    let mut paths: Vec<PathBuf> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false) && p.file_name().map(|n| n != "manifest.json").unwrap_or(false))
        .collect();
    paths.sort();
    Ok(paths
        .iter()
        .filter_map(|p| {
            let name = p.file_name()?.to_string_lossy().to_string();
            let v = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
            Some((name, v))
        })
        .collect())
}

/// Shift a fixture so its `t` is now, then parse and validate it.
fn current<T: DeserializeOwned + busyholm_contracts::Validate>(raw: &serde_json::Value) -> Option<T> {
    let t = raw.get("t")?.as_u64()?;
    let mut v = raw.clone();
    shift_times(&mut v, now_ms() as i64 - t as i64);
    busyholm_contracts::from_value::<T>(v).ok()
}

fn sleep_until(stop: &AtomicBool, d: Duration) -> bool {
    let end = Instant::now() + d;
    while Instant::now() < end {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        // 250 ms slices: few wakeups when idle, and the hub still stops the mock within 250 ms.
        std::thread::sleep(Duration::from_millis(250).min(end.saturating_duration_since(Instant::now())));
    }
    !stop.load(Ordering::SeqCst)
}

impl Collector for MockCollector {
    fn name(&self) -> &'static str {
        "mock"
    }

    fn run(&mut self, out: &FeedSender, stop: &AtomicBool) -> Result<(), String> {
        let snaps = load_raw(&self.dir, "snapshot.v2")?;
        let moments = load_raw(&self.dir, "moment.v1")?;
        // Keep only fixtures the current contract types accept.
        let snaps: Vec<_> = snaps.into_iter().filter(|(_, r)| current::<Snapshot>(r).is_some()).collect();
        let moments: Vec<_> = moments.into_iter().filter(|(_, r)| current::<Moment>(r).is_some()).map(|(_, r)| r).collect();
        if snaps.is_empty() {
            return Err("mock: no valid snapshot fixtures".into());
        }
        // One ledger, so pages get world inputs: the first valid fixture with counted days.
        let ledgers = load_raw(&self.dir, "ledger.v1").unwrap_or_default();
        let ledger = ledgers
            .iter()
            .filter_map(|(_, r)| busyholm_contracts::from_value::<busyholm_contracts::Ledger>(r.clone()).ok())
            .find(|l| !l.days.is_empty());
        if let Some(l) = ledger {
            out.send(Feed::Ledger(l));
        }
        match self.mode {
            MockMode::Static => {
                // The richest small scene: the first fixture with 2 to 6 residents, else any with residents.
                let has = |r: &serde_json::Value, ok: &dyn Fn(usize) -> bool| r["agents"].as_array().map(|a| ok(a.len())).unwrap_or(false);
                let chosen = self.pick.as_ref().and_then(|p| snaps.iter().find(|(n, _)| n.contains(p.as_str())));
                let pick = &chosen
                    .or_else(|| snaps.iter().find(|(_, r)| has(r, &|n| (2..=6).contains(&n))))
                    .or_else(|| snaps.iter().find(|(_, r)| has(r, &|n| n > 0)))
                    .unwrap_or(&snaps[0])
                    .1;
                if let Some(s) = current::<Snapshot>(pick) {
                    out.send(Feed::Snapshot(s));
                }
                while sleep_until(stop, Duration::from_millis(500)) {}
                Ok(())
            }
            MockMode::Cycle { period } => {
                let mut i = 0usize;
                loop {
                    if let Some(s) = current::<Snapshot>(&snaps[i % snaps.len()].1) {
                        if !out.send(Feed::Snapshot(s)) {
                            return Ok(());
                        }
                    }
                    if !moments.is_empty() && i % 3 == 2 {
                        if let Some(m) = current::<Moment>(&moments[(i / 3) % moments.len()]) {
                            out.send(Feed::Moment(m));
                        }
                    }
                    i += 1;
                    if !sleep_until(stop, period) {
                        return Ok(());
                    }
                }
            }
        }
    }
}

//! IPC hub (SPEC 6.2): runs a collector behind the `Collector` trait, supervises it (restart with
//! backoff after an error or panic, SPEC 6.11), coalesces Snapshot v2 to at most 4 per second
//! (newest wins) and relays Moment v1 immediately. Everything it forwards is validated against the
//! contract first; invalid values are dropped and counted, never forwarded and never logged.
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use busyholm_contracts::{Ledger, Moment, Snapshot, Validate};

#[derive(Debug, Clone)]
pub enum Feed {
    Snapshot(Snapshot),
    Moment(Moment),
    Ledger(Ledger),
}

#[derive(Clone)]
pub struct FeedSender(pub(crate) mpsc::Sender<Feed>);
impl FeedSender {
    /// False once the hub has shut down.
    pub fn send(&self, f: Feed) -> bool {
        self.0.send(f).is_ok()
    }
}

/// What the shell needs from a collector. The WP-03 crate is adapted to this; the shell never
/// depends on collector internals.
pub trait Collector: Send + 'static {
    fn name(&self) -> &'static str;
    /// Blocking: produce until `stop` is set (return Ok) or fail (return Err). The hub calls it
    /// again after an error or a panic, with exponential backoff.
    fn run(&mut self, out: &FeedSender, stop: &AtomicBool) -> Result<(), String>;
    /// Optional flag set by [`Hub::shutdown_without_flush`] before `stop` is stored.
    fn set_skip_flush(&mut self, _skip_flush: Arc<AtomicBool>) {}
}

/// Where the hub delivers. The Tauri implementation emits `bh:snapshot` / `bh:moment`.
pub trait Outlet: Send + Sync + 'static {
    fn snapshot(&self, s: &Snapshot);
    fn moment(&self, m: &Moment);
    fn ledger(&self, _l: &Ledger) {}
    fn note(&self, _event: &str, _data: serde_json::Value) {}
}

#[derive(Debug, Clone, Copy)]
pub struct HubConfig {
    pub min_interval: Duration,
    pub backoff_initial: Duration,
    pub backoff_max: Duration,
}
impl Default for HubConfig {
    fn default() -> Self {
        HubConfig { min_interval: Duration::from_millis(250), backoff_initial: Duration::from_secs(1), backoff_max: Duration::from_secs(60) }
    }
}

struct Shared {
    stop: AtomicBool,
    restarts: AtomicU64,
    latest: Mutex<Option<Snapshot>>,
    /// Wakes the supervisor out of a backoff sleep on shutdown.
    wake: (Mutex<()>, Condvar),
}

pub struct Hub {
    shared: Arc<Shared>,
    skip_flush: Arc<AtomicBool>,
    threads: Mutex<Vec<JoinHandle<()>>>,
    tx: Mutex<Option<mpsc::Sender<Feed>>>,
}

impl Hub {
    pub fn start(mut collector: Box<dyn Collector>, outlet: Arc<dyn Outlet>, cfg: HubConfig) -> Hub {
        let skip_flush = Arc::new(AtomicBool::new(false));
        collector.set_skip_flush(skip_flush.clone());
        let shared = Arc::new(Shared {
            stop: AtomicBool::new(false),
            restarts: AtomicU64::new(0),
            latest: Mutex::new(None),
            wake: (Mutex::new(()), Condvar::new()),
        });
        let (tx, rx) = mpsc::channel::<Feed>();

        let d_shared = shared.clone();
        let d_outlet = outlet.clone();
        let dispatcher = std::thread::Builder::new()
            .name("bh-hub-dispatch".into())
            .spawn(move || dispatch(rx, d_outlet, d_shared, cfg))
            .expect("spawn hub dispatcher");

        let s_shared = shared.clone();
        let sender = FeedSender(tx.clone());
        let supervisor = std::thread::Builder::new()
            .name("bh-hub-collector".into())
            .spawn(move || supervise(collector, sender, outlet, s_shared, cfg))
            .expect("spawn collector supervisor");

        Hub { shared, skip_flush, threads: Mutex::new(vec![dispatcher, supervisor]), tx: Mutex::new(Some(tx)) }
    }

    pub fn latest(&self) -> Option<Snapshot> {
        self.shared.latest.lock().unwrap().clone()
    }

    pub fn restarts(&self) -> u64 {
        self.shared.restarts.load(Ordering::SeqCst)
    }

    /// Stops the collector and the dispatcher and waits for both threads.
    pub fn shutdown(&self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        self.shared.wake.1.notify_all();
        self.tx.lock().unwrap().take();
        let threads: Vec<_> = self.threads.lock().unwrap().drain(..).collect();
        for t in threads {
            let _ = t.join();
        }
    }

    /// Stops the collector without its final disk flush ("Delete everything") and waits for both threads.
    pub fn shutdown_without_flush(&self) {
        self.skip_flush.store(true, Ordering::SeqCst);
        self.shutdown();
    }
}

impl Drop for Hub {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        self.shared.wake.1.notify_all();
    }
}

fn supervise(mut c: Box<dyn Collector>, out: FeedSender, outlet: Arc<dyn Outlet>, shared: Arc<Shared>, cfg: HubConfig) {
    let mut backoff = cfg.backoff_initial;
    loop {
        let started = Instant::now();
        let r = catch_unwind(AssertUnwindSafe(|| c.run(&out, &shared.stop)));
        if shared.stop.load(Ordering::SeqCst) {
            break;
        }
        let why = match r {
            Ok(Ok(())) => "returned",
            Ok(Err(_)) => "error",
            Err(_) => "panic",
        };
        // A collector that ran fine for a while starts again from the initial backoff.
        if started.elapsed() > cfg.backoff_max {
            backoff = cfg.backoff_initial;
        }
        outlet.note("collector_restart", serde_json::json!({ "collector": c.name(), "why": why, "backoff_ms": backoff.as_millis() as u64 }));
        shared.restarts.fetch_add(1, Ordering::SeqCst);
        let guard = shared.wake.0.lock().unwrap();
        let _ = shared.wake.1.wait_timeout_while(guard, backoff, |_| !shared.stop.load(Ordering::SeqCst));
        if shared.stop.load(Ordering::SeqCst) {
            break;
        }
        backoff = (backoff * 2).min(cfg.backoff_max);
    }
}

fn dispatch(rx: mpsc::Receiver<Feed>, outlet: Arc<dyn Outlet>, shared: Arc<Shared>, cfg: HubConfig) {
    let mut last_emit: Option<Instant> = None;
    let mut pending = false;
    loop {
        // Block indefinitely when nothing is pending (no idle wakeups); otherwise wake for the flush.
        let msg = if pending {
            let due = last_emit.map(|t| t + cfg.min_interval).unwrap_or_else(Instant::now);
            let wait = due.saturating_duration_since(Instant::now());
            match rx.recv_timeout(wait) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => break,
            }
        };
        match msg {
            Some(Feed::Moment(m)) => {
                if m.validate().is_ok() {
                    outlet.moment(&m);
                } else {
                    outlet.note("hub_rejected", serde_json::json!({ "kind": "moment" }));
                }
            }
            Some(Feed::Snapshot(s)) => {
                if s.validate().is_ok() {
                    *shared.latest.lock().unwrap() = Some(s);
                    pending = true;
                } else {
                    outlet.note("hub_rejected", serde_json::json!({ "kind": "snapshot" }));
                }
            }
            Some(Feed::Ledger(l)) => {
                if l.validate().is_ok() {
                    outlet.ledger(&l);
                } else {
                    outlet.note("hub_rejected", serde_json::json!({ "kind": "ledger" }));
                }
            }
            None => {}
        }
        if pending && last_emit.map(|t| t.elapsed() >= cfg.min_interval).unwrap_or(true) {
            let snap = shared.latest.lock().unwrap().clone();
            if let Some(s) = snap {
                outlet.snapshot(&s);
            }
            last_emit = Some(Instant::now());
            pending = false;
        }
        if shared.stop.load(Ordering::SeqCst) {
            break;
        }
    }
}

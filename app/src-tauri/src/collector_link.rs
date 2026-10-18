//! The real WP-03 collector behind the shell's `Collector` trait (cargo feature `collector`).
//!
//! The shell only uses the sidecar crate's published entry point, `sidecar::run` (the collector service:
//! receiver, state machine, usage store, ledger accrual, with the Claude and Codex hook adapters behind an
//! `AdapterRouter`), on a thread the hub owns. The collector
//! persists `ledger.json` and `pending-alerts.json` itself, in the same SPEC 6.8 data folder; the
//! shell writes neither file, so there is still exactly one writer per file.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use collector::{Clock, CollectorOutput, EventBus, SystemClock};
use sidecar::Roots;

use crate::hub::{Collector, Feed, FeedSender};

pub struct RealCollector {
    pub data_dir: PathBuf,
    pub seed: u32,
    /// INT-2: where the installer's hook state comes from; attached to each run's event bus.
    pub hooks: Option<crate::hooks_link::HooksLink>,
    pub skip_flush: Arc<AtomicBool>,
}

impl RealCollector {
    pub fn new(data_dir: PathBuf) -> Self {
        // Only used when no ledger exists yet (the collector loads the stored seed otherwise).
        use std::hash::{BuildHasher, Hasher};
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        RealCollector { data_dir, seed: h.finish() as u32, hooks: None, skip_flush: Arc::new(AtomicBool::new(false)) }
    }

    pub fn with_hooks(mut self, hooks: crate::hooks_link::HooksLink) -> Self {
        self.hooks = Some(hooks);
        self
    }
}

impl Collector for RealCollector {
    fn name(&self) -> &'static str {
        "collector"
    }

    fn set_skip_flush(&mut self, skip_flush: Arc<AtomicBool>) {
        self.skip_flush = skip_flush;
    }

    fn run(&mut self, out: &FeedSender, stop: &AtomicBool) -> Result<(), String> {
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let bus = EventBus::bounded(4096);
        let sender = bus.sender();
        // CLAUDE_CONFIG_DIR or ~/.claude; CODEX_HOME or ~/.codex. The sidecar router maps the hook BODY the
        // shim posts (a NormalizedMapper would answer every real hook with 400, INTEGRATION.md section 2).
        let roots = Roots::from_environment();
        let done = AtomicBool::new(false);
        let skip_flush = self.skip_flush.clone();
        // INT-2: the installer's hook state goes to this run's bus; the link replays the newest reports now.
        if let Some(link) = &self.hooks {
            let hooks_sender = sender.clone();
            link.attach(Box::new(move |tool, status| !matches!(hooks_sender.hooks(tool, status), Err(collector::SendError::Closed))));
        }
        std::thread::scope(|s| {
            // Turn the hub's stop flag into the collector's own shutdown message.
            s.spawn(|| {
                while !stop.load(Ordering::SeqCst) && !done.load(Ordering::SeqCst) {
                    // Two wakeups a second; the collector's own budget is 10 per second (SPEC 6.7).
                    std::thread::sleep(Duration::from_millis(500));
                }
                if skip_flush.load(Ordering::SeqCst) {
                    let _ = sender.shutdown_without_flush();
                } else {
                    let _ = sender.shutdown();
                }
            });
            let r = sidecar::run(self.data_dir.clone(), self.seed, &roots, clock, bus, |o| {
                let ok = match o {
                    CollectorOutput::Snapshot(s) => out.send(Feed::Snapshot(s)),
                    CollectorOutput::Moment(m) => out.send(Feed::Moment(m)),
                    CollectorOutput::Ledger(l) => out.send(Feed::Ledger(l)),
                };
                if ok { Ok(()) } else { Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "hub closed")) }
            });
            done.store(true, Ordering::SeqCst);
            if let Some(link) = &self.hooks {
                link.detach();
            }
            r.map_err(|e| format!("collector: {}", e.kind()))
        })
    }
}

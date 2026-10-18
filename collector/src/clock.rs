use std::sync::atomic::{AtomicU64, Ordering};
use std::{sync::OnceLock, time::{Instant, SystemTime, UNIX_EPOCH}};

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
    /// Elapsed monotonic time, independent of wall-clock adjustments.
    fn monotonic_ms(&self) -> u64 { self.now_ms() }
}

#[derive(Default)]
pub struct SystemClock;
impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
    }
    fn monotonic_ms(&self) -> u64 {
        static START: OnceLock<Instant> = OnceLock::new();
        START.get_or_init(Instant::now).elapsed().as_millis() as u64
    }
}

pub struct FakeClock { wall: AtomicU64, monotonic: AtomicU64 }
impl FakeClock {
    pub fn new(now: u64) -> Self { Self { wall: AtomicU64::new(now), monotonic: AtomicU64::new(0) } }
    pub fn set(&self, now: u64) {
        let old=self.wall.swap(now, Ordering::SeqCst);
        self.monotonic.fetch_add(now.saturating_sub(old), Ordering::SeqCst);
    }
    pub fn set_wall(&self, now: u64) { self.wall.store(now, Ordering::SeqCst); }
    pub fn advance(&self, ms: u64) { self.wall.fetch_add(ms, Ordering::SeqCst); self.monotonic.fetch_add(ms, Ordering::SeqCst); }
}
impl Clock for FakeClock {
    fn now_ms(&self) -> u64 { self.wall.load(Ordering::SeqCst) }
    fn monotonic_ms(&self) -> u64 { self.monotonic.load(Ordering::SeqCst) }
}

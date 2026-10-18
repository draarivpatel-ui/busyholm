//! The idle trigger as a pure state machine (SPEC 6.4, Revision 1 item 5). No clock, no window
//! system: the caller feeds it the idle reading and an `Environment`, and acts on the `Step`.
//!
//! Skip rules, in the order they are asked (each only once the user is idle past the threshold):
//! ambient already open, strip switched off, a fullscreen app on the strip's display (unknown
//! counts as fullscreen: the trigger never starts over something it cannot see), a call or video
//! playing (only where the OS exposes it), battery saver. The user's opt-out is
//! `idle_minutes == None`, and the per-OS verification gate is `fullscreen_check_verified`.
use std::time::Duration;

/// Seconds since the user's last input, or `None` when this OS or session has no idle source.
pub trait IdleSource: Send + Sync {
    fn idle_seconds(&self) -> Option<f64>;
}

/// Why the trigger declined to start ambient although the user is idle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    AmbientOpen,
    StripDisabled,
    Fullscreen,
    FullscreenUnknown,
    MediaOrCall,
    BatterySaver,
}
impl SkipReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            SkipReason::AmbientOpen => "ambient is already open",
            SkipReason::StripDisabled => "the strip is switched off",
            SkipReason::Fullscreen => "a fullscreen app or presentation is on the strip's display",
            SkipReason::FullscreenUnknown => "cannot tell whether a fullscreen app is on the strip's display",
            SkipReason::MediaOrCall => "a call or video is playing",
            SkipReason::BatterySaver => "battery saver is on",
        }
    }
}

/// What the trigger needs to know about the machine. Probes are asked only once the user is idle
/// past the threshold, and in the order below, so they cost nothing the rest of the time.
pub trait Environment: Send + Sync {
    fn ambient_open(&self) -> bool;
    fn strip_disabled(&self) -> bool;
    fn fullscreen_on_strip_display(&self) -> Option<bool>;
    fn media_or_call_active(&self) -> Option<bool>;
    fn battery_saver(&self) -> Option<bool>;
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TriggerConfig {
    pub idle_minutes: Option<u8>,
    pub fullscreen_check_verified: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Step {
    Disabled(&'static str),
    Wait(Duration),
    Skipped(SkipReason, Duration),
    Enter,
    Exit,
}

/// How soon to look again while a skip condition holds.
const RECHECK: Duration = Duration::from_secs(5);
/// How often to look while an idle-started scene is open (it ends on fresh input).
const OPEN_POLL: Duration = Duration::from_millis(250);

#[derive(Debug)]
pub struct Trigger {
    /// True while the open scene was started by this trigger (so it also ends it).
    started_by_idle: bool,
    /// False after a scene closed until the user has been active again (idle below the threshold).
    armed: bool,
}

impl Default for Trigger {
    fn default() -> Self {
        Trigger::new()
    }
}

impl Trigger {
    pub fn new() -> Self {
        Trigger { started_by_idle: false, armed: true }
    }

    pub fn step(&mut self, cfg: &TriggerConfig, idle: Option<f64>, env: &dyn Environment) -> Step {
        if let Some(why) = crate::idle::disabled_reason(cfg.fullscreen_check_verified, cfg.idle_minutes, idle.is_some()) {
            self.started_by_idle = false;
            return Step::Disabled(why);
        }
        let (Some(minutes), Some(idle)) = (cfg.idle_minutes, idle) else { return Step::Disabled("no idle reading") };
        let threshold = minutes as f64 * 60.0;
        let open = env.ambient_open();

        if self.started_by_idle {
            if !open {
                // Closed by input (page, guard, tray). Wait for real activity before starting again.
                self.started_by_idle = false;
                self.armed = false;
            } else if crate::idle::should_exit(idle) {
                self.started_by_idle = false;
                self.armed = false;
                return Step::Exit;
            } else {
                return Step::Wait(OPEN_POLL);
            }
        }
        if idle < threshold {
            self.armed = true;
        }
        if !self.armed || idle < threshold {
            return Step::Wait(crate::idle::next_check(idle, threshold));
        }
        // Idle past the threshold: ask the skip conditions, cheapest first.
        let skip = if open {
            Some(SkipReason::AmbientOpen)
        } else if env.strip_disabled() {
            Some(SkipReason::StripDisabled)
        } else if let Some(r) = match env.fullscreen_on_strip_display() {
            Some(false) => None,
            Some(true) => Some(SkipReason::Fullscreen),
            None => Some(SkipReason::FullscreenUnknown),
        } {
            Some(r)
        } else if env.media_or_call_active() == Some(true) {
            Some(SkipReason::MediaOrCall)
        } else if env.battery_saver() == Some(true) {
            Some(SkipReason::BatterySaver)
        } else {
            None
        };
        match skip {
            Some(r) => Step::Skipped(r, RECHECK),
            None => {
                self.started_by_idle = true;
                self.armed = false;
                Step::Enter
            }
        }
    }
}

/// Settable fakes for tests and for the debug-only test hooks.
pub mod fake {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicI8, AtomicU64, Ordering::SeqCst};

    /// An idle source you move by hand.
    #[derive(Default)]
    pub struct FakeIdle(AtomicU64, AtomicBool);
    impl FakeIdle {
        pub fn new(s: f64) -> Self {
            let f = FakeIdle::default();
            f.set(Some(s));
            f
        }
        pub fn set(&self, s: Option<f64>) {
            self.0.store(s.unwrap_or(0.0).to_bits(), SeqCst);
            self.1.store(s.is_some(), SeqCst);
        }
    }
    impl IdleSource for FakeIdle {
        fn idle_seconds(&self) -> Option<f64> {
            self.1.load(SeqCst).then(|| f64::from_bits(self.0.load(SeqCst)))
        }
    }

    fn tri(v: &AtomicI8) -> Option<bool> {
        match v.load(SeqCst) {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        }
    }
    fn set_tri(v: &AtomicI8, x: Option<bool>) {
        v.store(x.map(|b| b as i8).unwrap_or(-1), SeqCst);
    }

    /// An environment you set by hand; counts how often each probe was asked.
    pub struct FakeEnv {
        pub open: AtomicBool,
        pub disabled: AtomicBool,
        fullscreen: AtomicI8,
        media: AtomicI8,
        battery: AtomicI8,
        pub asked: AtomicU64,
    }
    impl Default for FakeEnv {
        fn default() -> Self {
            FakeEnv {
                open: AtomicBool::new(false),
                disabled: AtomicBool::new(false),
                fullscreen: AtomicI8::new(0),
                media: AtomicI8::new(0),
                battery: AtomicI8::new(0),
                asked: AtomicU64::new(0),
            }
        }
    }
    impl FakeEnv {
        pub fn set_fullscreen(&self, v: Option<bool>) {
            set_tri(&self.fullscreen, v)
        }
        pub fn set_media(&self, v: Option<bool>) {
            set_tri(&self.media, v)
        }
        pub fn set_battery(&self, v: Option<bool>) {
            set_tri(&self.battery, v)
        }
    }
    impl Environment for FakeEnv {
        fn ambient_open(&self) -> bool {
            self.open.load(SeqCst)
        }
        fn strip_disabled(&self) -> bool {
            self.disabled.load(SeqCst)
        }
        fn fullscreen_on_strip_display(&self) -> Option<bool> {
            self.asked.fetch_add(1, SeqCst);
            tri(&self.fullscreen)
        }
        fn media_or_call_active(&self) -> Option<bool> {
            self.asked.fetch_add(1, SeqCst);
            tri(&self.media)
        }
        fn battery_saver(&self) -> Option<bool> {
            self.asked.fetch_add(1, SeqCst);
            tri(&self.battery)
        }
    }
}

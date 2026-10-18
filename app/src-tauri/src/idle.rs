//! Ambient-on-idle decisions (SPEC 6.4, Revision 1 item 5). Ambient mode is manual by default; the
//! idle trigger runs only when the user sets `ambient.idle_minutes` AND this OS's per-display
//! fullscreen check is verified (`platform::IDLE_TRIGGER_VERIFIED`, false everywhere today).
use std::time::Duration;

/// Why the trigger is not running, or `None` when it may run.
pub fn disabled_reason(verified_on_this_os: bool, idle_minutes: Option<u8>, idle_source: bool) -> Option<&'static str> {
    if idle_minutes.is_none() {
        Some("off in settings (ambient is manual by default)")
    } else if !verified_on_this_os {
        Some("per-display fullscreen check not verified on this OS")
    } else if !idle_source {
        Some("no idle source on this OS or session")
    } else {
        None
    }
}

/// Enter ambient once idle reaches the threshold, never while blocked (another app fullscreen on
/// the strip's display, ambient already open, strip disabled).
pub fn should_enter(idle_s: f64, threshold_s: f64, blocked: bool) -> bool {
    !blocked && idle_s >= threshold_s
}

/// An idle-started ambient scene ends on fresh input (the page also exits on input itself).
pub fn should_exit(idle_s: f64) -> bool {
    idle_s < 1.0
}

/// Sleep until the threshold could first be reached, between 1 s and 60 s (60 s keeps settings
/// changes visible without many wakeups).
pub fn next_check(idle_s: f64, threshold_s: f64) -> Duration {
    Duration::from_secs_f64((threshold_s - idle_s).clamp(1.0, 60.0))
}

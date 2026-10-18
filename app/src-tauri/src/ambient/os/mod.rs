//! Per-OS idle sources and skip probes for ambient mode. Each OS file exports the same functions;
//! `mod.rs` picks one and adds the debug-only test hooks.
//!
//! | | idle | call or video | battery saver | input held |
//! |---|---|---|---|---|
//! | macOS | `platform::idle_seconds` (CGEventSource) | display-sleep assertions of other apps | Low Power Mode | yes |
//! | Windows | `platform::idle_seconds` (GetLastInputInfo) | `SystemExecutionState` display flag | battery saver flag | yes |
//! | Linux X11 | `XScreenSaverQueryInfo`; GNOME Mutter IdleMonitor via `gdbus` | not exposed | not exposed | no |
//! | Wayland | GNOME Mutter only; other compositors: none (manual) | not exposed | not exposed | no |
use std::path::PathBuf;
use std::sync::Arc;

use super::trigger::IdleSource;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
use mac as imp;
#[cfg(target_os = "macos")]
pub use mac::{display_assertions, Held};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use self::windows as imp;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as imp;

#[cfg(target_os = "linux")]
pub use linux::parse_gdbus_uint;

/// Call or video active (the OS exposes it) or `None` (it does not, or the call failed).
pub fn media_or_call_active() -> Option<bool> {
    // Debug builds only: pretend a call or video is (on) or is not (off) active, so the end-to-end
    // test does not depend on whatever keep-awake app happens to run on the machine.
    #[cfg(debug_assertions)]
    match std::env::var("BUSYHOLM_FAKE_MEDIA").as_deref() {
        Ok("on") => return Some(true),
        Ok("off") => return Some(false),
        _ => {}
    }
    imp::media_or_call_active()
}

/// Battery saver on, or `None` when the OS does not expose it.
pub fn battery_saver() -> Option<bool> {
    imp::battery_saver()
}

/// Is a mouse button or key physically held? (Not implemented on Linux: reports false.)
pub fn input_held() -> bool {
    imp::input_held()
}

/// The real idle clock of this OS and session.
pub struct SystemIdle;
impl IdleSource for SystemIdle {
    fn idle_seconds(&self) -> Option<f64> {
        imp::idle_seconds()
    }
}

/// Debug builds only: a file holding the idle seconds as a number, re-read on every call, so the
/// acceptance tests can move the idle clock without waiting. Set `BUSYHOLM_FAKE_IDLE_FILE`.
#[cfg(debug_assertions)]
pub struct FileIdle(pub PathBuf);
#[cfg(debug_assertions)]
impl IdleSource for FileIdle {
    fn idle_seconds(&self) -> Option<f64> {
        std::fs::read_to_string(&self.0).ok()?.trim().parse().ok()
    }
}

/// The idle source to use: the fake file in debug builds when `BUSYHOLM_FAKE_IDLE_FILE` is set
/// (the second value tells the log), else the system clock.
pub fn idle_source() -> (Arc<dyn IdleSource>, &'static str) {
    #[cfg(debug_assertions)]
    if let Some(p) = std::env::var_os("BUSYHOLM_FAKE_IDLE_FILE").filter(|v| !v.is_empty()) {
        return (Arc::new(FileIdle(PathBuf::from(p))), "fake file");
    }
    (Arc::new(SystemIdle), "system")
}

/// Debug builds only: `BUSYHOLM_IDLE_TRIGGER=on` opens the per-OS verification gate so the trigger
/// can be exercised end to end. Release builds ignore it; the gate stays a compile-time constant.
pub fn gate_override() -> bool {
    #[cfg(debug_assertions)]
    {
        std::env::var("BUSYHOLM_IDLE_TRIGGER").map(|v| v == "on").unwrap_or(false)
    }
    #[cfg(not(debug_assertions))]
    {
        false
    }
}

//! Per-OS window code behind one interface. Every OS module exports the same free functions; the
//! Tauri glue (`crate::shell`) never uses `cfg` itself except through this module.
//!
//! Threading: functions marked "main thread" touch AppKit, Win32 window state or GTK and must run
//! on the event-loop thread (use `AppHandle::run_on_main_thread`). The others are safe anywhere.
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layer {
    /// Above ordinary windows (floating level on macOS, topmost on Windows, keep-above on X11).
    OnTop,
    /// Below ordinary windows, above the desktop.
    Behind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StripSupport {
    Supported,
    /// The strip cannot be shown in this session (for example GNOME on Wayland); the tray and the
    /// details window still work (SPEC Revision 1 item 5).
    Unsupported(&'static str),
}

/// A callback the OS layer fires on a notification (display change, app activation, ...).
pub type Notify = Arc<dyn Fn() + Send + Sync + 'static>;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
pub use mac::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

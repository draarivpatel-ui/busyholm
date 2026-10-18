//! Per-display "another app is fullscreen" decisions (review r1 M15), as pure functions so the rules run
//! and are tested on any host. The OS modules in `platform` only gather the window lists and pass them in.
//!
//! The question is always about ONE display (the strip's), answered from evidence about that display:
//! - Windows: any visible, uncloaked window of another process that exactly covers the monitor counts, not
//!   only the foreground one; the shell's busy/fullscreen notification state is global, so it counts for a
//!   monitor only when the foreground window is on it (or when that is unknown).
//! - macOS: a window that spans the display and reaches its bottom edge is certainly fullscreen when it
//!   extends beyond the display's work area (a zoomed window never does). When it equals the work area it
//!   is ambiguous (a zoomed window with an auto-hidden Dock looks the same) and is resolved by one more
//!   fact: whether the Dock's window is still on screen.

/// A rectangle in points (macOS).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A rectangle in physical pixels (Windows).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

// ---------------------------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------------------------

/// One display in points: its full bounds and its work area (menu bar and Dock removed).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MacDisplay {
    pub bounds: FRect,
    pub work: FRect,
}

/// One entry of the on-screen window list.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MacWindow {
    pub rect: FRect,
    pub layer: i32,
    pub pid: u32,
    pub alpha: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    No,
    Yes,
    /// Spans the display exactly like a zoomed window could; needs more evidence.
    Ambiguous,
}

const TOL: f64 = 1.0;

/// Classify one window's bounds against one display.
pub fn classify_mac_window(d: &MacDisplay, w: &FRect) -> Verdict {
    let (b, k) = (&d.bounds, &d.work);
    let menu_bar = (k.y - b.y).max(0.0);
    let full_width = (w.x - b.x).abs() <= TOL && (w.w - b.w).abs() <= TOL;
    let to_bottom = (w.y + w.h - (b.y + b.h)).abs() <= TOL;
    let from_top = w.y <= b.y + menu_bar + TOL;
    if !(full_width && to_bottom && from_top) {
        return Verdict::No;
    }
    // A zoomed window is confined to the work area; reaching past it is only possible when fullscreen.
    let beyond_top = w.y < k.y - TOL;
    let beyond_bottom = w.y + w.h > k.y + k.h + TOL;
    if beyond_top || beyond_bottom {
        Verdict::Yes
    } else {
        Verdict::Ambiguous
    }
}

/// Is another app fullscreen on this display? `dock_window_present` says whether the Dock's window (layer 20)
/// is in the on-screen list at all: measured gone during a native fullscreen Space (macOS, notched MacBook),
/// present otherwise. It only decides the ambiguous case.
pub fn mac_display_fullscreen(d: &MacDisplay, windows: &[MacWindow], own_pid: u32, dock_window_present: bool) -> bool {
    let mut ambiguous = false;
    for w in windows {
        if w.layer != 0 || w.pid == own_pid || w.alpha <= 0.0 {
            continue;
        }
        match classify_mac_window(d, &w.rect) {
            Verdict::Yes => return true,
            Verdict::Ambiguous => ambiguous = true,
            Verdict::No => {}
        }
    }
    ambiguous && !dock_window_present
}

// ---------------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------------

/// One top-level window.
#[derive(Debug, Clone, PartialEq)]
pub struct WinWindow {
    pub rect: IRect,
    pub class: String,
    pub pid: u32,
    pub visible: bool,
    pub minimized: bool,
    pub cloaked: bool,
}

/// The shell's `SHQueryUserNotificationState` verdict and where the foreground window is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Notification {
    /// Busy, Direct3D fullscreen or presentation mode: something owns the screen, but not which monitor.
    pub busy: bool,
    /// The monitor holding the foreground window, when known.
    pub foreground_monitor: Option<IRect>,
}

const SHELL_CLASSES: [&str; 4] = ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

fn covers(m: &IRect, r: &IRect) -> bool {
    let near = |a: i32, b: i32| (a - b).abs() <= 1;
    near(r.x, m.x) && near(r.y, m.y) && near(r.x + r.w, m.x + m.w) && near(r.y + r.h, m.y + m.h)
}

fn same_rect(a: &IRect, b: &IRect) -> bool {
    covers(a, b)
}

/// Is another app fullscreen on this monitor?
pub fn windows_display_fullscreen(monitor: IRect, n: &Notification, windows: &[WinWindow], own_pid: u32) -> bool {
    if n.busy && n.foreground_monitor.map_or(true, |fg| same_rect(&fg, &monitor)) {
        return true;
    }
    windows.iter().any(|w| {
        w.visible
            && !w.minimized
            && !w.cloaked
            && w.pid != own_pid
            && !SHELL_CLASSES.contains(&w.class.as_str())
            && covers(&monitor, &w.rect)
    })
}

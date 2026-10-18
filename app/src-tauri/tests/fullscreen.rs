//! FIX-C M15: per-display fullscreen evidence. The decisions are pure functions, so the Windows and macOS
//! rules run here on any host; the OS modules only gather the window lists they are given.
use busyholm_app::fullscreen::*;

// ---------------------------------------------------------------------------------------------
// macOS (points). Display and numbers follow the measurement on the notched MacBook: display 1512x982,
// menu bar 33, native fullscreen window at 0,33 1512x949.
// ---------------------------------------------------------------------------------------------

fn rect(x: f64, y: f64, w: f64, h: f64) -> FRect {
    FRect { x, y, w, h }
}
const ME: u32 = 100;
fn win(r: FRect) -> MacWindow {
    MacWindow { rect: r, layer: 0, pid: 555, alpha: 1.0 }
}
fn display(work: FRect) -> MacDisplay {
    MacDisplay { bounds: rect(0.0, 0.0, 1512.0, 982.0), work }
}
fn with_dock() -> MacDisplay {
    display(rect(0.0, 33.0, 1512.0, 865.0)) // Dock reserves the bottom
}
fn dock_hidden() -> MacDisplay {
    display(rect(0.0, 33.0, 1512.0, 949.0)) // nothing reserved at the bottom
}

#[test]
fn mac_native_fullscreen_with_the_dock_visible_is_fullscreen() {
    let w = [win(rect(0.0, 33.0, 1512.0, 949.0))];
    assert!(mac_display_fullscreen(&with_dock(), &w, ME, true));
}

#[test]
fn mac_borderless_game_over_the_menu_bar_is_fullscreen() {
    let w = [win(rect(0.0, 0.0, 1512.0, 982.0))];
    assert!(mac_display_fullscreen(&with_dock(), &w, ME, true));
}

#[test]
fn mac_zoomed_window_beside_a_visible_dock_is_not_fullscreen() {
    let w = [win(rect(0.0, 33.0, 1512.0, 865.0))];
    assert!(!mac_display_fullscreen(&with_dock(), &w, ME, true));
}

#[test]
fn mac_zoomed_window_with_an_auto_hidden_dock_is_ambiguous_and_not_hidden_while_the_dock_window_exists() {
    let zoomed = win(rect(0.0, 33.0, 1512.0, 949.0));
    assert_eq!(classify_mac_window(&dock_hidden(), &zoomed.rect), Verdict::Ambiguous);
    assert!(!mac_display_fullscreen(&dock_hidden(), &[zoomed], ME, true), "the Dock process still has its window: this is a maximised window");
}

#[test]
fn mac_the_same_bounds_count_as_fullscreen_once_the_dock_window_is_gone() {
    // Measured: during a native fullscreen Space the Dock's layer-20 window leaves the on-screen list.
    let w = [win(rect(0.0, 33.0, 1512.0, 949.0))];
    assert!(mac_display_fullscreen(&dock_hidden(), &w, ME, false));
}

#[test]
fn mac_secondary_display_without_menu_bar_or_dock_is_ambiguous_and_stays_visible() {
    // "Displays have separate Spaces" off: no menu bar, no Dock. A zoomed window equals the display bounds.
    let d = MacDisplay { bounds: rect(1512.0, 0.0, 1920.0, 1080.0), work: rect(1512.0, 0.0, 1920.0, 1080.0) };
    let w = [win(rect(1512.0, 0.0, 1920.0, 1080.0))];
    assert_eq!(classify_mac_window(&d, &w[0].rect), Verdict::Ambiguous);
    assert!(!mac_display_fullscreen(&d, &w, ME, true), "the Dock lives on the other display");
}

#[test]
fn mac_own_overlays_and_other_layers_are_ignored() {
    let full = rect(0.0, 0.0, 1512.0, 982.0);
    let own = MacWindow { rect: full, layer: 0, pid: ME, alpha: 1.0 };
    let floating = MacWindow { rect: full, layer: 3, pid: 555, alpha: 1.0 };
    let clear = MacWindow { rect: full, layer: 0, pid: 555, alpha: 0.0 };
    assert!(!mac_display_fullscreen(&with_dock(), &[own, floating, clear], ME, true));
}

#[test]
fn mac_a_window_on_another_display_does_not_hide_this_one() {
    let w = [win(rect(1512.0, 0.0, 1512.0, 982.0))];
    assert!(!mac_display_fullscreen(&with_dock(), &w, ME, true));
}

// ---------------------------------------------------------------------------------------------
// Windows (physical pixels). Two monitors: A at 0,0 1920x1080 and B at 1920,0 2560x1440.
// ---------------------------------------------------------------------------------------------

const A: IRect = IRect { x: 0, y: 0, w: 1920, h: 1080 };
const B: IRect = IRect { x: 1920, y: 0, w: 2560, h: 1440 };

fn cover(m: IRect) -> WinWindow {
    WinWindow { rect: m, class: "GameWindow".into(), pid: 777, visible: true, minimized: false, cloaked: false }
}
fn small(x: i32, y: i32) -> WinWindow {
    WinWindow { rect: IRect { x, y, w: 800, h: 600 }, class: "Notepad".into(), pid: 888, visible: true, minimized: false, cloaked: false }
}
fn notif(busy: bool, fg: Option<IRect>) -> Notification {
    Notification { busy, foreground_monitor: fg }
}

#[test]
fn windows_a_fullscreen_window_on_b_is_seen_while_the_foreground_is_on_a() {
    let wins = [small(100, 100), cover(B)];
    let n = notif(false, Some(A));
    assert!(windows_display_fullscreen(B, &n, &wins, 1), "visible fullscreen window on B, not the foreground");
    assert!(!windows_display_fullscreen(A, &n, &wins, 1), "A has no fullscreen window");
}

#[test]
fn windows_busy_notification_state_applies_to_the_foreground_monitor_only() {
    let wins = [small(100, 100)];
    let n = notif(true, Some(B));
    assert!(windows_display_fullscreen(B, &n, &wins, 1));
    assert!(!windows_display_fullscreen(A, &n, &wins, 1), "the busy state must not hide the strip on the other monitor");
}

#[test]
fn windows_busy_state_with_an_unknown_foreground_monitor_stays_conservative() {
    let n = notif(true, None);
    assert!(windows_display_fullscreen(A, &n, &[], 1));
    assert!(windows_display_fullscreen(B, &n, &[], 1));
}

#[test]
fn windows_ignores_own_shell_hidden_minimized_and_cloaked_windows() {
    let mut own = cover(A);
    own.pid = 1;
    let mut desktop = cover(A);
    desktop.class = "Progman".into();
    let mut worker = cover(A);
    worker.class = "WorkerW".into();
    let mut hidden = cover(A);
    hidden.visible = false;
    let mut min = cover(A);
    min.minimized = true;
    let mut cloaked = cover(A);
    cloaked.cloaked = true;
    let n = notif(false, Some(A));
    for w in [own, desktop, worker, hidden, min, cloaked] {
        assert!(!windows_display_fullscreen(A, &n, &[w], 1));
    }
}

#[test]
fn windows_a_maximised_window_that_leaves_the_taskbar_is_not_fullscreen() {
    let mut w = cover(A);
    w.rect = IRect { x: 0, y: 0, w: 1920, h: 1040 }; // taskbar strip left over
    assert!(!windows_display_fullscreen(A, &notif(false, Some(A)), &[w], 1));
}

#[test]
fn windows_one_pixel_of_slop_is_allowed() {
    let mut w = cover(A);
    w.rect = IRect { x: -1, y: 0, w: 1922, h: 1080 };
    assert!(windows_display_fullscreen(A, &notif(false, Some(A)), &[w], 1));
}

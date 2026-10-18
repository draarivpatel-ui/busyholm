//! WP-02 acceptance test 3 (pure part): the strip's bottom equals the work-area bottom (within 1 px)
//! across the SPEC 9.1 matrix: Dock bottom, left and auto-hidden; taskbar bottom and top; 100%,
//! 150% and 200% scale; plus display choice (SPEC 6.5). The live part runs on real screens in
//! tests/macos, tests/windows and tests/linux.
use busyholm_app::geometry::*;

fn r(x: i32, y: i32, w: u32, h: u32) -> PRect { PRect { x, y, w, h } }
fn mon(name: &str, bounds: PRect, work: PRect, scale: f64, primary: bool) -> MonitorInfo {
    MonitorInfo { name: Some(name.into()), bounds, work, scale, primary }
}

/// (case, os, monitors, expected monitor index)
fn matrix() -> Vec<(&'static str, Os, Vec<MonitorInfo>, usize)> {
    // macOS built-in 1512x982 pt at 2x; menu bar 33 pt; Dock 84 pt (bottom) or 70 pt (left).
    let mac_b = r(0, 0, 3024, 1964);
    vec![
        ("mac dock bottom 2x", Os::MacOs, vec![mon("Built-in", mac_b, r(0, 66, 3024, 1730), 2.0, true)], 0),
        ("mac dock left 2x", Os::MacOs, vec![mon("Built-in", mac_b, r(140, 66, 2884, 1898), 2.0, true)], 0),
        ("mac dock right 2x", Os::MacOs, vec![mon("Built-in", mac_b, r(0, 66, 2884, 1898), 2.0, true)], 0),
        ("mac dock auto-hide 2x", Os::MacOs, vec![mon("Built-in", mac_b, r(0, 66, 3024, 1898), 2.0, true)], 0),
        ("mac dock auto-hide 4pt reserve", Os::MacOs, vec![mon("Built-in", mac_b, r(0, 66, 3024, 1890), 2.0, true)], 0),
        ("mac 1x external", Os::MacOs, vec![mon("Studio", r(0, 0, 2560, 1440), r(0, 25, 2560, 1335), 1.0, true)], 0),
        // External primary (menu bar only) plus built-in with the Dock: the strip follows the Dock.
        ("mac two displays, dock on secondary", Os::MacOs, vec![
            mon("Studio", r(0, 0, 2560, 1440), r(0, 25, 2560, 1415), 1.0, true),
            mon("Built-in", r(5120, 800, 3024, 1964), r(5120, 866, 3024, 1730), 2.0, false)], 1),
        ("mac two displays, dock hidden: primary", Os::MacOs, vec![
            mon("Studio", r(0, 0, 2560, 1440), r(0, 25, 2560, 1415), 1.0, true),
            mon("Built-in", r(5120, 800, 3024, 1964), r(5120, 866, 3024, 1898), 2.0, false)], 0),
        ("win taskbar bottom 100%", Os::Windows, vec![mon("\\\\.\\DISPLAY1", r(0, 0, 1920, 1080), r(0, 0, 1920, 1032), 1.0, true)], 0),
        ("win taskbar bottom 150%", Os::Windows, vec![mon("\\\\.\\DISPLAY1", r(0, 0, 1920, 1080), r(0, 0, 1920, 1008), 1.5, true)], 0),
        ("win taskbar bottom 200%", Os::Windows, vec![mon("\\\\.\\DISPLAY1", r(0, 0, 3840, 2160), r(0, 0, 3840, 2064), 2.0, true)], 0),
        ("win taskbar top 100%", Os::Windows, vec![mon("\\\\.\\DISPLAY1", r(0, 0, 1920, 1080), r(0, 48, 1920, 1032), 1.0, true)], 0),
        ("win taskbar top 150%", Os::Windows, vec![mon("\\\\.\\DISPLAY1", r(0, 0, 2560, 1440), r(0, 72, 2560, 1368), 1.5, true)], 0),
        ("win taskbar top 200%", Os::Windows, vec![mon("\\\\.\\DISPLAY1", r(0, 0, 3840, 2160), r(0, 96, 3840, 2064), 2.0, true)], 0),
        ("win 125% odd height", Os::Windows, vec![mon("\\\\.\\DISPLAY1", r(0, 0, 1920, 1080), r(0, 0, 1920, 1020), 1.25, true)], 0),
        ("win taskbar on secondary left of primary", Os::Windows, vec![
            mon("\\\\.\\DISPLAY1", r(0, 0, 1920, 1080), r(0, 0, 1920, 1080), 1.0, true),
            mon("\\\\.\\DISPLAY2", r(-2560, 0, 2560, 1440), r(-2560, 0, 2560, 1392), 1.0, false)], 1),
        ("linux x11 panel bottom", Os::Linux, vec![mon("eDP-1", r(0, 0, 1920, 1080), r(0, 0, 1920, 1044), 1.0, true)], 0),
        ("linux xvfb no panel", Os::Linux, vec![mon("screen", r(0, 0, 1280, 800), r(0, 0, 1280, 800), 1.0, true)], 0),
    ]
}

#[test]
fn strip_bottom_matches_work_area_bottom_across_matrix() {
    for height in [72u8, 112, 113, 160] {
        for (case, os, ms, want) in matrix() {
            let p = place(&ms, None, os, height, None).unwrap_or_else(|| panic!("{case}: no placement"));
            assert_eq!(p.monitor, want, "{case}: monitor");
            let m = &ms[want];
            let rect = p.rect;
            assert!((rect.bottom() - m.work.bottom()).abs() <= 1, "{case} h={height}: bottom {} vs work {}", rect.bottom(), m.work.bottom());
            assert_eq!(rect.x, m.work.x, "{case}: x");
            assert_eq!(rect.w, m.work.w, "{case}: width spans the work area");
            let want_h = (height as f64 * m.scale).round() as i64;
            assert!((rect.h as i64 - want_h).abs() <= 1, "{case} h={height}: height {} vs {}", rect.h, want_h);
            assert_eq!(p.scale, m.scale, "{case}: scale");
            assert!(rect.y >= m.work.y, "{case}: inside the work area");
        }
    }
}

#[test]
fn height_is_clamped_to_the_settings_range() {
    let w = r(0, 0, 1920, 1032);
    assert_eq!(strip_rect(w, 1.0, 10).h, MIN_HEIGHT as u32);
    assert_eq!(strip_rect(w, 1.0, 255).h, MAX_HEIGHT as u32);
    assert_eq!(strip_rect(w, 2.0, 112).h, 224);
}

#[test]
fn dock_detection_per_os() {
    let mac_b = r(0, 0, 3024, 1964);
    // macOS: the top inset is the menu bar, not the Dock.
    assert!(!has_dock(&mon("a", mac_b, r(0, 66, 3024, 1898), 2.0, true), Os::MacOs));
    assert!(has_dock(&mon("a", mac_b, r(0, 66, 3024, 1730), 2.0, true), Os::MacOs));
    assert!(has_dock(&mon("a", mac_b, r(140, 66, 2884, 1898), 2.0, true), Os::MacOs));
    // Windows: a top taskbar counts.
    assert!(has_dock(&mon("a", r(0, 0, 1920, 1080), r(0, 48, 1920, 1032), 1.0, true), Os::Windows));
    assert!(!has_dock(&mon("a", r(0, 0, 1920, 1080), r(0, 0, 1920, 1080), 1.0, true), Os::Windows));
}

#[test]
fn named_display_wins_and_unknown_name_falls_back() {
    let ms = vec![
        mon("Studio", r(0, 0, 2560, 1440), r(0, 25, 2560, 1415), 1.0, true),
        mon("Built-in", r(5120, 800, 3024, 1964), r(5120, 866, 3024, 1730), 2.0, false),
    ];
    assert_eq!(pick_monitor(&ms, Some("Studio"), Os::MacOs), Some(0));
    assert_eq!(pick_monitor(&ms, Some("Gone"), Os::MacOs), Some(1));
    assert_eq!(pick_monitor(&[], None, Os::MacOs), None);
    let none_primary = vec![mon("x", r(0, 0, 800, 600), r(0, 0, 800, 600), 1.0, false)];
    assert_eq!(pick_monitor(&none_primary, None, Os::Linux), Some(0));
}

#[test]
fn reserve_mode_does_not_creep_upwards() {
    // Windows AppBar / X11 strut: once our own reservation is in place the work area shrinks by the
    // strip; placing again must land in the same spot, not one strip higher.
    let bounds = r(0, 0, 1920, 1080);
    let before = vec![mon("d", bounds, r(0, 0, 1920, 1032), 1.0, true)];
    let first = place(&before, None, Os::Windows, 112, None).unwrap();
    let after = vec![mon("d", bounds, r(0, 0, 1920, 1032 - 112), 1.0, true)];
    let again = place(&after, None, Os::Windows, 112, Some(first.rect)).unwrap();
    assert_eq!(again.rect, first.rect);
    // An unrelated work-area change is not mistaken for our reservation.
    assert_eq!(without_own_reservation(r(0, 0, 1920, 900), Some(first.rect)), r(0, 0, 1920, 900));
    assert_eq!(without_own_reservation(r(0, 0, 1920, 1032), None), r(0, 0, 1920, 1032));
}

#[test]
fn distance_outside_a_rect() {
    let s = r(0, 900, 1920, 112);
    assert_eq!(distance_outside(s, 10.0, 950.0), 0.0);
    assert_eq!(distance_outside(s, 10.0, 890.0), 10.0);
    assert_eq!(distance_outside(s, -30.0, 950.0), 30.0);
    assert!((distance_outside(s, -3.0, 896.0) - 5.0).abs() < 1e-9);
}

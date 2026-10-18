//! Click-through and hover-fade logic behind WP-02 acceptance test 2 and SPEC 6.3: the strip is
//! click-through except over HitRects; hover-fade after 400 ms over empty strip; 30 Hz near the
//! strip, 4 Hz elsewhere.
use std::time::Duration;

use busyholm_app::clickthrough::*;

const SIZE: (f64, f64) = (1512.0, 112.0);
fn ms(n: u64) -> Duration { Duration::from_millis(n) }
fn at(t: u64, c: Option<(f64, f64)>) -> Sample { Sample { now: ms(t), cursor: c, size: SIZE } }
fn rects() -> Vec<HitRect> { vec![HitRect { x: 747.0, y: 64.0, w: 18.0, h: 18.0 }] }

#[test]
fn starts_click_through_and_toggles_only_on_change() {
    let mut c = ClickThrough::new(Config::default());
    assert!(c.ignoring());
    let a = c.step(&at(0, Some((750.0, 70.0))), &rects());
    assert_eq!(a.set_ignore, Some(false), "over a rect: clickable");
    assert_eq!(c.step(&at(33, Some((751.0, 70.0))), &rects()).set_ignore, None, "no repeat toggles");
    assert_eq!(c.step(&at(66, Some((100.0, 70.0))), &rects()).set_ignore, Some(true), "empty strip: click-through");
    assert_eq!(c.step(&at(99, Some((100.0, -200.0))), &rects()).set_ignore, None, "still click-through outside");
    assert!(c.ignoring());
}

#[test]
fn hover_fade_after_400ms_and_stays_click_through_until_leave() {
    let mut c = ClickThrough::new(Config::default());
    assert_eq!(c.step(&at(0, Some((100.0, 50.0))), &rects()).set_fade, None);
    assert_eq!(c.step(&at(399, Some((120.0, 50.0))), &rects()).set_fade, None, "not yet");
    let a = c.step(&at(400, Some((140.0, 50.0))), &rects());
    assert_eq!(a.set_fade, Some(true));
    assert!(c.faded());
    // While faded, moving over a resident keeps the strip click-through (text below stays readable).
    let a = c.step(&at(450, Some((750.0, 70.0))), &rects());
    assert_eq!(a.set_ignore, None);
    assert!(c.ignoring());
    // Leaving the strip ends the fade.
    let a = c.step(&at(500, Some((750.0, -10.0))), &rects());
    assert_eq!(a.set_fade, Some(false));
    assert!(!c.faded());
    // Coming back straight onto a resident is clickable again.
    assert_eq!(c.step(&at(533, Some((750.0, 70.0))), &rects()).set_ignore, Some(false));
}

#[test]
fn dwell_timer_restarts_after_visiting_a_rect() {
    let mut c = ClickThrough::new(Config::default());
    c.step(&at(0, Some((100.0, 50.0))), &rects());
    c.step(&at(300, Some((750.0, 70.0))), &rects());
    assert_eq!(c.step(&at(350, Some((100.0, 50.0))), &rects()).set_fade, None);
    assert_eq!(c.step(&at(700, Some((100.0, 50.0))), &rects()).set_fade, None, "only 350 ms on empty strip");
    assert_eq!(c.step(&at(750, Some((100.0, 50.0))), &rects()).set_fade, Some(true));
}

#[test]
fn hover_fade_can_be_disabled() {
    let mut c = ClickThrough::new(Config { hover_fade: false, ..Config::default() });
    c.step(&at(0, Some((100.0, 50.0))), &rects());
    assert_eq!(c.step(&at(5000, Some((100.0, 50.0))), &rects()).set_fade, None);
    assert!(!c.faded());
}

#[test]
fn poll_rate_is_fast_near_the_strip_and_slow_elsewhere() {
    let c = ClickThrough::new(Config::default());
    let fast = Duration::from_micros(33_333);
    let slow = Duration::from_millis(250);
    assert_eq!(c.interval(&at(0, Some((10.0, 50.0)))), fast, "inside");
    assert_eq!(c.interval(&at(0, Some((10.0, -47.0)))), fast, "47 px above");
    assert_eq!(c.interval(&at(0, Some((10.0, -49.0)))), slow, "49 px above");
    assert_eq!(c.interval(&at(0, Some((-60.0, 50.0)))), slow, "60 px to the left");
    assert_eq!(c.interval(&at(0, None)), slow, "no cursor");
}

#[test]
fn reset_on_hide_returns_to_click_through_and_unfades() {
    let mut c = ClickThrough::new(Config::default());
    c.step(&at(0, Some((750.0, 70.0))), &rects());
    assert!(!c.ignoring());
    let a = c.reset();
    assert_eq!(a.set_ignore, Some(true));
    assert!(c.ignoring());
    let mut c = ClickThrough::new(Config::default());
    c.step(&at(0, Some((100.0, 50.0))), &rects());
    c.step(&at(500, Some((100.0, 50.0))), &rects());
    assert!(c.faded());
    assert_eq!(c.reset().set_fade, Some(false));
}

#[test]
fn hit_testing_edges() {
    let r = rects();
    assert!(hit(&r, 747.0, 64.0));
    assert!(hit(&r, 764.9, 81.9));
    assert!(!hit(&r, 765.0, 70.0));
    assert!(!hit(&r, 746.9, 70.0));
    assert!(!hit(&[], 0.0, 0.0));
}

#[test]
fn contract_rects_scale_to_the_window() {
    let msg: busyholm_contracts::HitRects = busyholm_contracts::from_json(r#"{
        "schema_version": 1, "t": 1760270400000, "surface": "strip",
        "viewport": { "w": 756, "h": 56 }, "scale": 2,
        "rects": [ { "x": 373.5, "y": 32, "w": 9, "h": 9, "kind": "resident" } ] }"#).unwrap();
    // The page measured at half the window's CSS size (for example mid-resize): scale up.
    let got = rects_from_contract(&msg, 1512.0, 112.0);
    assert_eq!(got, vec![HitRect { x: 747.0, y: 64.0, w: 18.0, h: 18.0 }]);
    let same = rects_from_contract(&msg, 756.0, 56.0);
    assert_eq!(same, vec![HitRect { x: 373.5, y: 32.0, w: 9.0, h: 9.0 }]);
}

// ---- FIX-C L1 (shell part): rectangles published for an old geometry must not outlive it ----

mod hit_store {
    use busyholm_app::clickthrough::{GeomKey, HitStore};
    use busyholm_contracts::HitRects;
    use serde_json::json;

    fn msg(vw: f64, vh: f64, x: f64) -> HitRects {
        busyholm_contracts::from_value(json!({ "schema_version": 1, "t": 1791806400000u64, "surface": "strip", "scale": 2, "viewport": { "w": vw, "h": vh }, "rects": [{ "x": x, "y": 10.0, "w": 20.0, "h": 20.0, "kind": "resident" }] }))
            .expect("valid HitRects v1")
    }
    fn key(w: i32, scale: f64) -> GeomKey {
        GeomKey { x: 0, y: 0, w: (w as f64 * scale) as u32, h: (112.0 * scale) as u32, scale, css: (w as f64, 112.0) }
    }

    #[test]
    fn rects_are_dropped_when_the_geometry_changes() {
        let mut s = HitStore::default();
        s.set_geometry(key(1512, 2.0));
        assert!(s.publish(&msg(1512.0, 112.0, 700.0)));
        assert_eq!(s.rects().len(), 1);
        assert!(s.set_geometry(key(1280, 2.0)), "a changed width reports that rects were invalidated");
        assert!(s.rects().is_empty(), "stale rectangles must not stay clickable");
    }

    #[test]
    fn an_unchanged_geometry_keeps_the_rects() {
        let mut s = HitStore::default();
        s.set_geometry(key(1512, 2.0));
        s.publish(&msg(1512.0, 112.0, 700.0));
        assert!(!s.set_geometry(key(1512, 2.0)));
        assert_eq!(s.rects().len(), 1);
    }

    #[test]
    fn a_scale_change_alone_invalidates() {
        let mut s = HitStore::default();
        s.set_geometry(key(1512, 2.0));
        s.publish(&msg(1512.0, 112.0, 700.0));
        assert!(s.set_geometry(key(1512, 1.0)));
        assert!(s.rects().is_empty());
    }

    #[test]
    fn a_message_for_the_old_viewport_that_arrives_late_is_ignored_until_the_page_catches_up() {
        let mut s = HitStore::default();
        s.set_geometry(key(1512, 2.0));
        s.set_geometry(key(1280, 2.0));
        assert!(!s.publish(&msg(1512.0, 112.0, 700.0)), "viewport 1512 is not the strip's 1280 any more");
        assert!(s.rects().is_empty());
        assert!(s.publish(&msg(1280.0, 112.0, 600.0)), "the page's republish for the new size is accepted");
        assert_eq!(s.rects().len(), 1);
        // once caught up, ordinary scaling of a slightly different viewport is accepted again (existing behaviour)
        assert!(s.publish(&msg(1500.0, 112.0, 600.0)));
    }

    #[test]
    fn publishing_before_any_geometry_is_ignored_as_before() {
        let mut s = HitStore::default();
        assert!(!s.publish(&msg(1512.0, 112.0, 700.0)));
        assert!(s.rects().is_empty());
    }

    #[test]
    fn relayout_invalidates_stale_rects_and_scales_republished_rects_to_new_geometry() {
        use busyholm_app::geometry::{PRect, Placement};
        use busyholm_app::shell::PollShared;

        let poll = PollShared::default();
        let p1 = Placement { monitor: 0, rect: PRect { x: 0, y: 1756, w: 3024, h: 224 }, scale: 2.0 };
        assert!(!poll.apply_create_placement(p1, Some(1)));
        assert!(poll.publish_hits(&msg(1512.0, 112.0, 700.0)));
        assert_eq!(poll.hit_rects().len(), 1);

        // Relayout to a narrower display or taller strip (P2-1): stale rects must be dropped immediately,
        // late messages for the old viewport must be ignored, and republished rects must use the new CSS size.
        let p2 = Placement { monitor: 0, rect: PRect { x: 0, y: 1200, w: 2560, h: 224 }, scale: 2.0 };
        assert!(poll.apply_relayout_placement(p2, Some(1)), "relayout must tell HitStore the geometry changed");
        assert!(poll.hit_rects().is_empty(), "stale rectangles must be cleared on relayout");
        assert!(!poll.publish_hits(&msg(1512.0, 112.0, 700.0)), "late old-viewport publish must be rejected");
        assert!(poll.publish_hits(&msg(1280.0, 112.0, 600.0)), "republish for new viewport must be accepted");
        assert_eq!(poll.hit_rects()[0].x, 600.0, "must not rescale onto the old 1512 width");
    }
}

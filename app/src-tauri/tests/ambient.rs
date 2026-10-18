//! WP-12 acceptance tests 1 and 2 (pure parts), SPEC 9.1: the idle trigger against a fake idle
//! source and fake skip conditions, and the native exit guard (8 px, any input, grace period).
use std::sync::atomic::Ordering::SeqCst;
use std::time::Duration;

use busyholm_app::ambient::guard::{ExitGuard, ExitReason, GRACE_S};
use busyholm_app::ambient::trigger::fake::{FakeEnv, FakeIdle};
use busyholm_app::ambient::trigger::{IdleSource, SkipReason, Step, Trigger, TriggerConfig};

const CFG: TriggerConfig = TriggerConfig { idle_minutes: Some(5), fullscreen_check_verified: true };
const THRESHOLD: f64 = 300.0;

fn step(t: &mut Trigger, idle: &FakeIdle, env: &FakeEnv) -> Step {
    t.step(&CFG, idle.idle_seconds(), env)
}

// ---- test 1: the trigger -------------------------------------------------------------------

#[test]
fn enters_exactly_at_the_threshold_and_not_before() {
    let (idle, env, mut t) = (FakeIdle::new(0.0), FakeEnv::default(), Trigger::new());
    for s in [0.0, 1.0, 120.0, 299.0, 299.9] {
        idle.set(Some(s));
        assert!(!matches!(step(&mut t, &idle, &env), Step::Enter), "entered early at {s}");
    }
    idle.set(Some(THRESHOLD));
    assert_eq!(step(&mut t, &idle, &env), Step::Enter);
}

#[test]
fn never_enters_under_any_single_skip_condition_and_enters_once_it_lifts() {
    type Set = fn(&FakeEnv, bool);
    let conds: [(&str, SkipReason, Set); 6] = [
        ("ambient already open", SkipReason::AmbientOpen, |e, on| e.open.store(on, SeqCst)),
        ("strip disabled", SkipReason::StripDisabled, |e, on| e.disabled.store(on, SeqCst)),
        ("fullscreen app on the strip's display", SkipReason::Fullscreen, |e, on| e.set_fullscreen(Some(on))),
        ("fullscreen unknown (cannot tell)", SkipReason::FullscreenUnknown, |e, on| e.set_fullscreen(if on { None } else { Some(false) })),
        ("call or video active", SkipReason::MediaOrCall, |e, on| e.set_media(Some(on))),
        ("battery saver", SkipReason::BatterySaver, |e, on| e.set_battery(Some(on))),
    ];
    for (name, reason, set) in conds {
        let (idle, env, mut t) = (FakeIdle::new(0.0), FakeEnv::default(), Trigger::new());
        set(&env, true);
        for s in [300.0, 301.0, 900.0, 3600.0, 40_000.0] {
            idle.set(Some(s));
            match step(&mut t, &idle, &env) {
                Step::Skipped(r, wait) => {
                    assert_eq!(r, reason, "{name}");
                    assert!(wait <= Duration::from_secs(5) && wait >= Duration::from_secs(1), "{name}: recheck {wait:?}");
                }
                other => panic!("{name}: expected a skip at {s}s, got {other:?}"),
            }
        }
        set(&env, false);
        assert_eq!(step(&mut t, &idle, &env), Step::Enter, "{name}: enters once the condition lifts");
    }
}

#[test]
fn unknown_media_and_battery_probes_do_not_block_but_unknown_fullscreen_does() {
    let (idle, env, mut t) = (FakeIdle::new(THRESHOLD), FakeEnv::default(), Trigger::new());
    env.set_media(None);
    env.set_battery(None);
    assert_eq!(step(&mut t, &idle, &env), Step::Enter);
    let (mut t, env) = (Trigger::new(), FakeEnv::default());
    env.set_fullscreen(None);
    assert_eq!(step(&mut t, &idle, &env), Step::Skipped(SkipReason::FullscreenUnknown, Duration::from_secs(5)));
}

#[test]
fn user_opt_out_unverified_gate_and_missing_source_never_enter() {
    let (idle, env) = (FakeIdle::new(99_999.0), FakeEnv::default());
    let off = TriggerConfig { idle_minutes: None, ..CFG };
    let unverified = TriggerConfig { fullscreen_check_verified: false, ..CFG };
    for cfg in [off, unverified] {
        let mut t = Trigger::new();
        for _ in 0..20 {
            assert!(matches!(t.step(&cfg, idle.idle_seconds(), &env), Step::Disabled(_)), "{cfg:?}");
        }
    }
    let mut t = Trigger::new();
    assert!(matches!(t.step(&CFG, None, &env), Step::Disabled(_)));
    assert_eq!(env.asked.load(SeqCst), 0, "no probe is asked while disabled");
}

#[test]
fn probes_are_not_asked_before_the_threshold() {
    let (idle, env, mut t) = (FakeIdle::new(10.0), FakeEnv::default(), Trigger::new());
    for s in [10.0, 100.0, 299.0] {
        idle.set(Some(s));
        let _ = step(&mut t, &idle, &env);
    }
    assert_eq!(env.asked.load(SeqCst), 0);
}

#[test]
fn waits_are_bounded_and_aim_at_the_threshold() {
    let (idle, env, mut t) = (FakeIdle::new(0.0), FakeEnv::default(), Trigger::new());
    assert_eq!(step(&mut t, &idle, &env), Step::Wait(Duration::from_secs(60)));
    idle.set(Some(280.0));
    assert_eq!(step(&mut t, &idle, &env), Step::Wait(Duration::from_secs(20)));
    idle.set(Some(299.8));
    assert_eq!(step(&mut t, &idle, &env), Step::Wait(Duration::from_secs(1)));
}

#[test]
fn an_idle_started_scene_exits_when_input_resumes_and_does_not_reenter_until_rearmed() {
    let (idle, env, mut t) = (FakeIdle::new(THRESHOLD), FakeEnv::default(), Trigger::new());
    assert_eq!(step(&mut t, &idle, &env), Step::Enter);
    env.open.store(true, SeqCst);
    idle.set(Some(400.0));
    assert!(matches!(step(&mut t, &idle, &env), Step::Wait(_)), "stays while idle");
    idle.set(Some(0.4));
    assert_eq!(step(&mut t, &idle, &env), Step::Exit);
    // The scene closed. Idle is still above the threshold (a warped cursor moves nothing in the
    // idle clock), but one exit must not bounce straight back in.
    env.open.store(false, SeqCst);
    idle.set(Some(500.0));
    assert!(matches!(step(&mut t, &idle, &env), Step::Wait(_)), "no immediate re-entry");
    idle.set(Some(2.0));
    assert!(matches!(step(&mut t, &idle, &env), Step::Wait(_)));
    idle.set(Some(THRESHOLD));
    assert_eq!(step(&mut t, &idle, &env), Step::Enter, "re-armed after real activity");
}

#[test]
fn a_manually_started_scene_is_left_alone_by_the_trigger() {
    let (idle, env, mut t) = (FakeIdle::new(0.0), FakeEnv::default(), Trigger::new());
    env.open.store(true, SeqCst);
    for s in [0.0, 0.5, 2.0, 50.0] {
        idle.set(Some(s));
        assert!(!matches!(step(&mut t, &idle, &env), Step::Exit | Step::Enter), "at {s}");
    }
}

// ---- test 2 (pure part): the native exit guard ---------------------------------------------

const PX: f64 = 8.0;
const T0: f64 = 100.0;

fn armed() -> ExitGuard {
    let mut g = ExitGuard::new(T0, PX);
    // Inside the grace period nothing counts, not even a big jump.
    assert_eq!(g.observe(T0 + 0.1, Some((500.0, 500.0)), Some(0.0)), None);
    assert_eq!(g.observe(T0 + 0.4, Some((900.0, 100.0)), Some(0.0)), None);
    // First sample after the grace period is the baseline.
    assert_eq!(g.observe(T0 + GRACE_S + 0.05, Some((700.0, 400.0)), Some(1.0)), None);
    g
}

#[test]
fn the_guard_ignores_the_opening_gesture_then_exits_on_a_move_over_8_px() {
    let mut g = armed();
    let t = T0 + GRACE_S + 0.1;
    assert_eq!(g.observe(t, Some((705.0, 400.0)), Some(1.05)), None, "5 px is jitter");
    assert_eq!(g.observe(t + 0.04, Some((707.9, 400.0)), Some(1.09)), None, "7.9 px is still under 8");
    assert_eq!(g.observe(t + 0.08, Some((709.0, 400.0)), Some(1.13)), Some(ExitReason::Moved), "9 px exits");
}

#[test]
fn the_move_is_measured_from_the_baseline_not_from_the_last_sample() {
    let mut g = armed();
    let mut t = T0 + GRACE_S + 0.1;
    let mut x = 700.0;
    let mut got = None;
    for _ in 0..10 {
        x += 2.0; // slow drift of 2 px per sample
        t += 0.04;
        got = got.or(g.observe(t, Some((x, 400.0)), Some(1.0 + (t - T0))));
    }
    assert_eq!(got, Some(ExitReason::Moved));
}

#[test]
fn a_key_or_click_without_cursor_movement_exits() {
    let mut g = armed();
    let t = T0 + GRACE_S + 0.1;
    // Idle was 1.0 at the baseline; a key press resets it to 0.01 although 0.1 s passed.
    assert_eq!(g.observe(t, Some((700.0, 400.0)), Some(0.01)), Some(ExitReason::Input));
}

#[test]
fn an_input_right_after_the_previous_poll_is_not_missed() {
    // A poll every 40 ms; the key lands 3 ms after the previous poll, so the idle clock reads 37 ms
    // at the next one. A slack near the poll period would hide this input for good.
    let mut g = armed();
    let t = T0 + GRACE_S + 0.1;
    assert_eq!(g.observe(t, Some((700.0, 400.0)), Some(0.9 + 0.1)), None); // quiet poll, idle 1.0 at the baseline + 0.1
    assert_eq!(g.observe(t + 0.04, Some((700.0, 400.0)), Some(0.037)), Some(ExitReason::Input));
}

#[test]
fn an_idle_reset_with_cursor_jitter_is_not_a_key_or_click() {
    let mut g = armed();
    let t = T0 + GRACE_S + 0.1;
    // The cursor moved 3 px (a nudged mouse resets the idle clock too): under 8 px, no exit.
    assert_eq!(g.observe(t, Some((703.0, 400.0)), Some(0.01)), None);
}

#[test]
fn a_quiet_idle_clock_that_just_keeps_growing_never_exits() {
    let mut g = armed();
    let mut t = T0 + GRACE_S + 0.05;
    let mut idle = 1.0;
    for _ in 0..500 {
        t += 0.04;
        idle += 0.04;
        assert_eq!(g.observe(t, Some((700.0, 400.0)), Some(idle)), None);
    }
}

#[test]
fn missing_cursor_or_idle_readings_are_ignored_not_treated_as_input() {
    let mut g = armed();
    let t = T0 + GRACE_S + 0.1;
    assert_eq!(g.observe(t, None, None), None);
    assert_eq!(g.observe(t + 0.04, Some((700.0, 400.0)), None), None);
    assert_eq!(g.observe(t + 0.08, None, Some(1.2)), None);
}

#[test]
fn a_stalled_poll_does_not_invent_input() {
    let mut g = armed();
    // The thread slept 5 s (laptop lid, debugger); the idle clock kept counting, so no input.
    assert_eq!(g.observe(T0 + GRACE_S + 5.0, Some((700.0, 400.0)), Some(6.0)), None);
}

// ---- the real probes answer on this OS (they are read-only; what they report depends on the machine) ----

#[cfg(target_os = "macos")]
#[test]
fn macos_probes_answer_and_the_idle_clock_runs() {
    use busyholm_app::ambient::os;
    let held = os::display_assertions().expect("IOPMCopyAssertionsByProcess works without permission");
    eprintln!("display-sleep assertions held by other processes: {held:?}");
    assert_eq!(os::media_or_call_active(), Some(!held.is_empty()));
    assert!(os::battery_saver().is_some(), "isLowPowerModeEnabled is public on macOS 12+");
    let (src, name) = os::idle_source();
    assert!(src.idle_seconds().is_some());
    eprintln!("battery saver: {:?}, idle source: {name}, input held: {}", os::battery_saver(), os::input_held());
}

#[cfg(target_os = "linux")]
#[test]
fn gdbus_idle_output_parses() {
    assert_eq!(busyholm_app::ambient::os::parse_gdbus_uint("(uint64 12345,)\n"), Some(12345));
    assert_eq!(busyholm_app::ambient::os::parse_gdbus_uint("(12,)"), Some(12));
    assert_eq!(busyholm_app::ambient::os::parse_gdbus_uint("Error"), None);
}

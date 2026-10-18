//! Ambient-on-idle decisions: off by default and off where the fullscreen check is unverified
//! (SPEC Revision 1 item 5); enters at the threshold only when nothing blocks it.
use std::time::Duration;

use busyholm_app::idle::*;

#[test]
fn off_unless_set_and_verified() {
    assert!(disabled_reason(true, None, true).is_some(), "manual by default");
    assert!(disabled_reason(false, Some(15), true).is_some(), "unverified OS stays off");
    assert!(disabled_reason(true, Some(15), false).is_some(), "no idle source");
    assert_eq!(disabled_reason(true, Some(15), true), None);
}

#[test]
fn enters_at_threshold_unless_blocked() {
    assert!(!should_enter(899.0, 900.0, false));
    assert!(should_enter(900.0, 900.0, false));
    assert!(!should_enter(5000.0, 900.0, true), "never over a fullscreen app");
    assert!(should_exit(0.2));
    assert!(!should_exit(3.0));
}

#[test]
fn sleeps_until_the_threshold_could_be_reached() {
    assert_eq!(next_check(0.0, 900.0), Duration::from_secs(60));
    assert_eq!(next_check(870.0, 900.0), Duration::from_secs(30));
    assert_eq!(next_check(899.5, 900.0), Duration::from_secs(1));
    assert_eq!(next_check(2000.0, 900.0), Duration::from_secs(1));
}

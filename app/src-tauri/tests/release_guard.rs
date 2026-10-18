//! H1: a release build without the real collector must be refused at build time.
#[path = "../build_guard.rs"]
mod build_guard;

#[test]
fn release_without_collector_is_refused() {
    let e = build_guard::check("release", false, false).unwrap_err();
    assert!(e.contains("collector"), "{e}");
}

#[test]
fn release_with_collector_passes() {
    assert!(build_guard::check("release", true, false).is_ok());
}

#[test]
fn debug_builds_never_need_it() {
    assert!(build_guard::check("debug", false, false).is_ok());
}

#[test]
fn explicit_override_allows_a_measurement_build() {
    assert!(build_guard::check("release", false, true).is_ok());
}

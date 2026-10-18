//! Build-time rule (review H1): a release build must link the real collector, or the shipped app
//! would run with no integration at all. Included by `build.rs` and tested by `tests/release_guard.rs`.

/// `Err(message)` when a release build lacks the `collector` feature and no explicit opt-out is set.
pub fn check(profile: &str, collector_feature: bool, allow_override: bool) -> Result<(), String> {
    if profile == "release" && !collector_feature && !allow_override {
        return Err("a release build of busyholm-app must enable the `collector` feature, otherwise the app ships without \
live agent integration (it would run a null collector). Build with `--features collector` (npm run build in app/ does \
this), or set BUSYHOLM_ALLOW_NO_COLLECTOR=1 for a deliberate measurement-only build."
            .to_string());
    }
    Ok(())
}

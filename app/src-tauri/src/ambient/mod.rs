//! Ambient mode (WP-12): the idle trigger, its skip rules, and the native exit guard. Everything in
//! `trigger` and `guard` is pure (no window system, no clock) so it is tested with fakes; `os` holds
//! the per-OS idle sources and skip probes; the Tauri glue lives in `shell/ambient_glue.rs`.
//!
//! Power: ambient mode never holds a power assertion of any kind (SPEC 6.4). Nothing in this
//! module calls IOPMAssertionCreate*, SetThreadExecutionState, `Inhibit` or similar; the macOS
//! probe only READS other apps' assertions.
pub mod guard;
pub mod os;
pub mod trigger;

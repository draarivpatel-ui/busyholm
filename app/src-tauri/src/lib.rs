//! Busyholm shell (WP-02). Pure logic lives in `geometry`, `clickthrough`, `hub`, `mock`, `settings`
//! and `paths` (unit tested without a window system); the Tauri glue is in `shell`, per-OS code in
//! `platform`.
pub mod ambient;
pub mod clickthrough;
#[cfg(feature = "collector")]
pub mod collector_link;
pub mod connect;
pub mod fullscreen;
pub mod geometry;
pub mod hooks_link;
pub mod hub;
pub mod idle;
pub mod mock;
pub mod notify;
pub mod onboarding;
pub mod opts;
pub mod paths;
pub mod platform;
pub mod renderer_stats;
pub mod settings;
pub mod shell;
pub mod testlog;
pub mod world_inputs;

pub fn run() {
    shell::run();
}

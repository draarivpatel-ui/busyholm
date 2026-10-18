#[allow(dead_code)]
mod build_guard;

fn main() {
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let collector = std::env::var_os("CARGO_FEATURE_COLLECTOR").is_some();
    let allow = std::env::var_os("BUSYHOLM_ALLOW_NO_COLLECTOR").is_some_and(|v| !v.is_empty() && v != "0");
    if let Err(message) = build_guard::check(&profile, collector, allow) {
        panic!("{message}");
    }
    println!("cargo:rerun-if-env-changed=BUSYHOLM_ALLOW_NO_COLLECTOR");
    println!("cargo:rerun-if-changed=build_guard.rs");
    tauri_build::build()
}
